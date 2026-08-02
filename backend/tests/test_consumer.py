"""InferenceLogConsumer is the Kafka-side half of ingestion (spec 017). The
critical behaviors are reliability ones: a malformed message must be
dropped (logged, not raised) rather than wedging the consumer group, and a
DB failure must signal "retry without advancing the offset" rather than
silently losing the batch. _parse and _write_logs are both synchronous, so
they're tested directly without an event loop or a real Kafka broker.
"""

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.ingestion.consumer import InferenceLogConsumer
from app.models import InferenceLog


def _make_record(
    value: bytes, *, topic: str = "inference-logs", partition: int = 0, offset: int = 0
):
    return SimpleNamespace(value=value, topic=topic, partition=partition, offset=offset)


def _valid_payload(**overrides) -> dict:
    payload = dict(
        schema_version=1,
        request_id="r1",
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status="success",
        latency_ms=100,
        input_messages=[{"role": "user", "content": "hi"}],
        requested_at=datetime.now(UTC).isoformat(),
    )
    payload.update(overrides)
    return payload


@pytest.fixture
def consumer():
    return InferenceLogConsumer(
        bootstrap_servers="localhost:9092",
        topic="inference-logs",
        group_id="ingestion",
        max_records=100,
        batch_timeout_ms=1000,
    )


def test_parse_valid_message_returns_inference_log(consumer: InferenceLogConsumer):
    record = _make_record(json.dumps(_valid_payload()).encode())

    log = consumer._parse(record)

    assert log is not None
    assert log.request_id == "r1"
    assert log.model == "gpt-5.6-terra"
    assert log.status == "success"


def test_parse_invalid_json_returns_none(consumer: InferenceLogConsumer):
    record = _make_record(b"not json{{{")

    assert consumer._parse(record) is None


def test_parse_schema_validation_failure_returns_none(consumer: InferenceLogConsumer):
    record = _make_record(json.dumps(_valid_payload(latency_ms=-1)).encode())

    assert consumer._parse(record) is None


def test_parse_missing_required_field_returns_none(consumer: InferenceLogConsumer):
    payload = _valid_payload()
    del payload["request_id"]
    record = _make_record(json.dumps(payload).encode())

    assert consumer._parse(record) is None


def test_parse_computes_cost_via_build_log(consumer: InferenceLogConsumer):
    record = _make_record(
        json.dumps(_valid_payload(input_tokens=1_000_000, output_tokens=1_000_000)).encode()
    )

    log = consumer._parse(record)

    assert log is not None
    assert log.cost_usd is not None


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _make_log(request_id: str) -> InferenceLog:
    return InferenceLog(
        request_id=request_id,
        schema_version=1,
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status="success",
        latency_ms=100,
        input_messages=[{"role": "user", "content": "hi"}],
        requested_at=datetime.now(UTC),
    )


def test_write_logs_success_returns_true(session_factory):
    consumer = InferenceLogConsumer(
        bootstrap_servers="localhost:9092",
        topic="inference-logs",
        group_id="ingestion",
        max_records=100,
        batch_timeout_ms=1000,
        session_factory=session_factory,
    )
    topic_partition = SimpleNamespace(topic="inference-logs", partition=0)

    result = consumer._write_logs(topic_partition, [_make_log("a"), _make_log("b")])

    assert result is True
    session = session_factory()
    try:
        assert session.query(InferenceLog).count() == 2
    finally:
        session.close()


def test_write_logs_db_error_returns_false_without_raising(session_factory, monkeypatch):
    consumer = InferenceLogConsumer(
        bootstrap_servers="localhost:9092",
        topic="inference-logs",
        group_id="ingestion",
        max_records=100,
        batch_timeout_ms=1000,
        session_factory=session_factory,
    )
    topic_partition = SimpleNamespace(topic="inference-logs", partition=0)

    import app.ingestion.consumer as consumer_module

    def _raise(self, logs):
        raise RuntimeError("db is down")

    monkeypatch.setattr(
        consumer_module.InferenceLogRepository, "create_many_skip_duplicates", _raise
    )

    result = consumer._write_logs(topic_partition, [_make_log("a")])

    assert result is False
