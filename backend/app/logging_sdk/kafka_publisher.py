import asyncio
import logging

from aiokafka import AIOKafkaProducer

from app.logging_sdk.events import InferenceLogEvent
from app.logging_sdk.publisher import EventPublisher

logger = logging.getLogger(__name__)


class KafkaEventPublisher(EventPublisher):
    """Produces each event as JSON to `topic`, keyed by conversation_id (or
    unkeyed round-robin when absent).

    The producer is started lazily, on the first publish (or via `start()`
    from the lifespan). Every failure path — start, serialize, send — is
    caught, logged at ERROR with event context, and swallowed: `publish()`
    never raises. A start failure at boot does not prevent the app from
    serving; the next publish retries starting the producer.
    """

    def __init__(
        self,
        bootstrap_servers: str,
        topic: str,
        *,
        request_timeout_ms: int = 10_000,
    ) -> None:
        self._bootstrap_servers = bootstrap_servers
        self._topic = topic
        self._request_timeout_ms = request_timeout_ms
        self._producer: AIOKafkaProducer | None = None
        self._start_lock = asyncio.Lock()

    async def start(self) -> None:
        """Called once from the lifespan. Never raises."""
        try:
            await self._ensure_started()
        except Exception as exc:
            logger.error(
                "Kafka producer failed to start at boot (bootstrap_servers=%s topic=%s); "
                "app will continue and retry on the next publish: %s",
                self._bootstrap_servers,
                self._topic,
                exc,
            )

    async def aclose(self) -> None:
        async with self._start_lock:
            if self._producer is not None:
                await self._producer.stop()
                self._producer = None

    async def publish(self, event: InferenceLogEvent) -> None:
        try:
            producer = await self._ensure_started()
        except Exception as exc:
            logger.error(
                "Kafka producer unavailable; dropping inference log event: request_id=%s "
                "conversation_id=%s call_type=%s error=%s",
                event.request_id,
                event.conversation_id,
                event.call_type,
                exc,
            )
            return

        try:
            value = event.model_dump_json().encode("utf-8")
        except Exception as exc:
            logger.error(
                "Failed to serialize inference log event; dropping: request_id=%s error=%s",
                event.request_id,
                exc,
            )
            return

        key = (
            str(event.conversation_id).encode("utf-8")
            if event.conversation_id is not None
            else None
        )

        try:
            await producer.send_and_wait(self._topic, value=value, key=key)
        except Exception as exc:
            logger.error(
                "Failed to publish inference log event to Kafka: request_id=%s "
                "conversation_id=%s call_type=%s topic=%s error=%s",
                event.request_id,
                event.conversation_id,
                event.call_type,
                self._topic,
                exc,
            )

    async def _ensure_started(self) -> AIOKafkaProducer:
        if self._producer is not None:
            return self._producer
        async with self._start_lock:
            if self._producer is None:
                producer = AIOKafkaProducer(
                    bootstrap_servers=self._bootstrap_servers,
                    request_timeout_ms=self._request_timeout_ms,
                )
                await producer.start()
                self._producer = producer
            return self._producer
