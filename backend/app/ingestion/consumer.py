import asyncio
import json
import logging
from collections.abc import Callable

from aiokafka import AIOKafkaConsumer, ConsumerRecord, TopicPartition
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import setup_logging
from app.db import SessionLocal
from app.ingestion.service import build_log
from app.models import InferenceLog
from app.repositories.ingest import InferenceLogRepository
from app.schemas import InferenceLogEventIn

logger = logging.getLogger(__name__)

_MIN_BACKOFF_SECONDS = 1.0
_MAX_BACKOFF_SECONDS = 30.0


class InferenceLogConsumer:
    """Batch-consumes `topic` into `inference_logs`. Host code, not SDK code:
    it imports app schemas/repositories and opens its own DB sessions per
    batch (never the request-scoped `get_db`) — see spec 017.

    Runnable both as the FastAPI lifespan's background task and standalone
    via `uv run python -m app.ingestion.consumer`.
    """

    def __init__(
        self,
        *,
        bootstrap_servers: str,
        topic: str,
        group_id: str,
        max_records: int,
        batch_timeout_ms: int,
        session_factory: Callable[[], Session] = SessionLocal,
    ) -> None:
        self._bootstrap_servers = bootstrap_servers
        self._topic = topic
        self._group_id = group_id
        self._max_records = max_records
        self._batch_timeout_ms = batch_timeout_ms
        self._session_factory = session_factory
        self._consumer: AIOKafkaConsumer | None = None

    async def run(self) -> None:
        """Connects (retrying with backoff) then polls forever. Cancelling
        this task is the shutdown path — the consumer is stopped in
        `finally`, and any batch not yet committed simply redelivers on the
        next start (FR8, edge case 7)."""
        await self._connect_with_backoff()
        try:
            while True:
                await self._poll_once()
        finally:
            if self._consumer is not None:
                await self._consumer.stop()
                self._consumer = None

    async def _connect_with_backoff(self) -> None:
        delay = _MIN_BACKOFF_SECONDS
        while True:
            consumer = AIOKafkaConsumer(
                self._topic,
                bootstrap_servers=self._bootstrap_servers,
                group_id=self._group_id,
                enable_auto_commit=False,
                auto_offset_reset="earliest",
            )
            try:
                await consumer.start()
            except Exception as exc:
                logger.error(
                    "Kafka consumer failed to start (bootstrap_servers=%s topic=%s); "
                    "retrying in %.0fs: %s",
                    self._bootstrap_servers,
                    self._topic,
                    delay,
                    exc,
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, _MAX_BACKOFF_SECONDS)
                continue
            self._consumer = consumer
            return

    async def _poll_once(self) -> None:
        assert self._consumer is not None
        try:
            batches = await self._consumer.getmany(
                timeout_ms=self._batch_timeout_ms, max_records=self._max_records
            )
        except Exception as exc:
            logger.error("Error polling Kafka topic %s: %s", self._topic, exc)
            await asyncio.sleep(_MIN_BACKOFF_SECONDS)
            return

        for topic_partition, messages in batches.items():
            if messages:
                await self._process_batch(topic_partition, messages)

    async def _process_batch(
        self, topic_partition: TopicPartition, messages: list[ConsumerRecord]
    ) -> None:
        logs = [
            log for log in (self._parse(message) for message in messages) if log is not None
        ]

        if logs:
            delay = _MIN_BACKOFF_SECONDS
            while not self._write_logs(topic_partition, logs):
                await asyncio.sleep(delay)
                delay = min(delay * 2, _MAX_BACKOFF_SECONDS)

        assert self._consumer is not None
        next_offset = messages[-1].offset + 1
        try:
            await self._consumer.commit({topic_partition: next_offset})
        except Exception as exc:
            logger.error(
                "Failed to commit Kafka offset for %s (next_offset=%d): %s",
                topic_partition,
                next_offset,
                exc,
            )

    def _write_logs(self, topic_partition: TopicPartition, logs: list[InferenceLog]) -> bool:
        """Returns True once the batch's DB commit has succeeded. False
        means the caller must retry (after a backoff) without advancing
        offsets — no swallowing, no offset loss (FR8, edge case 6)."""
        db = self._session_factory()
        try:
            repo = InferenceLogRepository(db)
            inserted, skipped = repo.create_many_skip_duplicates(logs)
        except Exception:
            db.rollback()
            logger.error(
                "DB error writing Kafka batch for %s (offset not committed, will retry)",
                topic_partition,
                exc_info=True,
            )
            return False
        else:
            logger.info(
                "Kafka batch for %s: inserted=%d skipped_duplicates=%d",
                topic_partition,
                inserted,
                skipped,
            )
            return True
        finally:
            db.close()

    def _parse(self, message: ConsumerRecord) -> InferenceLog | None:
        try:
            payload = json.loads(message.value)
        except (TypeError, ValueError) as exc:
            logger.error(
                "Malformed Kafka message (invalid JSON): topic=%s partition=%s offset=%s "
                "error=%s",
                message.topic,
                message.partition,
                message.offset,
                exc,
            )
            return None

        try:
            event = InferenceLogEventIn.model_validate(payload)
        except ValidationError as exc:
            logger.error(
                "Malformed Kafka message (schema validation failed): topic=%s partition=%s "
                "offset=%s error=%s",
                message.topic,
                message.partition,
                message.offset,
                exc,
            )
            return None

        return build_log(event)


async def _main() -> None:
    setup_logging()
    consumer = InferenceLogConsumer(
        bootstrap_servers=settings.KAFKA_BOOTSTRAP_SERVERS,
        topic=settings.KAFKA_TOPIC,
        group_id=settings.KAFKA_CONSUMER_GROUP,
        max_records=settings.KAFKA_CONSUMER_MAX_RECORDS,
        batch_timeout_ms=settings.KAFKA_CONSUMER_BATCH_TIMEOUT_MS,
    )
    logger.info(
        "Starting standalone inference log consumer: bootstrap_servers=%s topic=%s group_id=%s",
        settings.KAFKA_BOOTSTRAP_SERVERS,
        settings.KAFKA_TOPIC,
        settings.KAFKA_CONSUMER_GROUP,
    )
    await consumer.run()


if __name__ == "__main__":
    asyncio.run(_main())
