"""HTTPEventPublisher's whole contract is in its docstring: "Never raises —
every failure path is caught, logged at ERROR with event context, and
swallowed." That is what keeps a flaky ingestion endpoint from ever
becoming a broken chat response (CLAUDE.md: "Logging must never break
chat"). Each of these tests would fail loudly (an uncaught exception from
asyncio.run) if that contract regressed.
"""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx

from app.logging_sdk.events import InferenceLogEvent, LogStatus
from app.logging_sdk.publisher import HTTPEventPublisher, NullEventPublisher


def _make_event() -> InferenceLogEvent:
    return InferenceLogEvent(
        request_id="req-1",
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status=LogStatus.SUCCESS,
        latency_ms=100,
        input_messages=[{"role": "user", "content": "hi"}],
        requested_at=datetime.now(UTC),
    )


def test_publish_201_success_does_not_raise():
    publisher = HTTPEventPublisher(url="http://ingest.example/logs")
    publisher._client.post = AsyncMock(return_value=SimpleNamespace(status_code=201, text=""))

    asyncio.run(publisher.publish(_make_event()))

    publisher._client.post.assert_awaited_once()
    _, kwargs = publisher._client.post.call_args
    assert kwargs["json"]["request_id"] == "req-1"


def test_publish_409_duplicate_treated_as_success():
    publisher = HTTPEventPublisher(url="http://ingest.example/logs")
    publisher._client.post = AsyncMock(
        return_value=SimpleNamespace(status_code=409, text="already stored")
    )

    asyncio.run(publisher.publish(_make_event()))


def test_publish_unexpected_status_does_not_raise():
    publisher = HTTPEventPublisher(url="http://ingest.example/logs")
    publisher._client.post = AsyncMock(
        return_value=SimpleNamespace(status_code=500, text="server error")
    )

    asyncio.run(publisher.publish(_make_event()))


def test_publish_http_error_is_swallowed():
    publisher = HTTPEventPublisher(url="http://ingest.example/logs")
    publisher._client.post = AsyncMock(side_effect=httpx.ConnectError("connection refused"))

    asyncio.run(publisher.publish(_make_event()))


def test_publish_unexpected_exception_is_swallowed():
    publisher = HTTPEventPublisher(url="http://ingest.example/logs")
    publisher._client.post = AsyncMock(side_effect=RuntimeError("something else broke"))

    asyncio.run(publisher.publish(_make_event()))


def test_null_publisher_does_not_raise():
    asyncio.run(NullEventPublisher().publish(_make_event()))
