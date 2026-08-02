"""CallRecorder is the single emission point for InferenceLogEvent (see
CLAUDE.md "LLM calls and the logging SDK") — every model call must produce
exactly one log, structurally, even when a describe_* hook or an event
processor misbehaves. These tests exercise that guarantee directly against
CallRecorder, without a provider adapter or HTTP layer in the loop.
"""

import asyncio

from app.logging_sdk import recorder as recorder_module
from app.logging_sdk.contract import CallContext, CallFailure, CallOutcome, InstrumentedProvider
from app.logging_sdk.events import LogStatus
from app.logging_sdk.publisher import EventPublisher
from app.logging_sdk.recorder import CallRecorder


class FakePublisher(EventPublisher):
    def __init__(self) -> None:
        self.events: list = []

    async def publish(self, event) -> None:
        self.events.append(event)


class FakeProvider(InstrumentedProvider):
    provider_name = "fake"

    def __init__(
        self,
        *,
        send_result=None,
        send_exc: BaseException | None = None,
        stream_chunks: list | None = None,
        stream_exc: BaseException | None = None,
        stream_exc_after: int = 0,
        describe_call_exc: BaseException | None = None,
        describe_outcome_exc: BaseException | None = None,
        describe_stream_outcome_exc: BaseException | None = None,
        describe_failure_exc: BaseException | None = None,
    ) -> None:
        self._send_result = send_result
        self._send_exc = send_exc
        self._stream_chunks = stream_chunks or []
        self._stream_exc = stream_exc
        self._stream_exc_after = stream_exc_after
        self._describe_call_exc = describe_call_exc
        self._describe_outcome_exc = describe_outcome_exc
        self._describe_stream_outcome_exc = describe_stream_outcome_exc
        self._describe_failure_exc = describe_failure_exc

    async def send_message(self, **kwargs):
        if self._send_exc is not None:
            raise self._send_exc
        return self._send_result

    async def stream_message(self, **kwargs):
        for i, chunk in enumerate(self._stream_chunks):
            if self._stream_exc is not None and i == self._stream_exc_after:
                raise self._stream_exc
            yield chunk
        if self._stream_exc is not None and self._stream_exc_after >= len(self._stream_chunks):
            raise self._stream_exc

    def describe_call(self, **kwargs) -> CallContext:
        if self._describe_call_exc is not None:
            raise self._describe_call_exc
        return CallContext(
            provider="fake",
            model="fake-model",
            system_prompt="be helpful",
            input_messages=[{"role": "user", "content": "hi"}],
            request_params={"temperature": 0.5},
            conversation_id=7,
        )

    def describe_outcome(self, result) -> CallOutcome:
        if self._describe_outcome_exc is not None:
            raise self._describe_outcome_exc
        return CallOutcome(output_text=str(result), input_tokens=10, output_tokens=20)

    def describe_stream_outcome(self, chunks) -> CallOutcome:
        if self._describe_stream_outcome_exc is not None:
            raise self._describe_stream_outcome_exc
        return CallOutcome(output_text="".join(chunks), input_tokens=1, output_tokens=len(chunks))

    def describe_failure(self, exc: BaseException) -> CallFailure:
        if self._describe_failure_exc is not None:
            raise self._describe_failure_exc
        return CallFailure(error_type=type(exc).__name__, error_message=str(exc))


async def _invoke_and_drain(recorder: CallRecorder, provider: FakeProvider, **kwargs):
    """Runs recorder.invoke() and lets its fire-and-forget publish task
    finish before the event loop tears down, since asyncio.run() cancels
    any task that hasn't had a chance to start yet.
    """
    result = None
    exc = None
    try:
        result = await recorder.invoke(provider, **kwargs)
    except BaseException as e:  # noqa: BLE001 - re-raised to the caller, not swallowed
        exc = e
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    return result, exc


async def _invoke_stream_and_drain(recorder: CallRecorder, provider: FakeProvider, **kwargs):
    chunks = []
    exc = None
    try:
        async for chunk in recorder.invoke_stream(provider, **kwargs):
            chunks.append(chunk)
    except BaseException as e:  # noqa: BLE001
        exc = e
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    return chunks, exc


def test_invoke_success_publishes_event_and_returns_result():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(send_result="assistant reply")

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert exc is None
    assert result == "assistant reply"
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.status == LogStatus.SUCCESS
    assert event.call_type == "chat"
    assert event.model == "fake-model"
    assert event.provider == "fake"
    assert event.conversation_id == 7
    assert event.output_text == "assistant reply"
    assert event.input_tokens == 10
    assert event.output_tokens == 20
    assert event.error_type is None
    assert event.config_hash is not None


def test_invoke_error_publishes_event_and_reraises():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(send_exc=ValueError("boom"))

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert isinstance(exc, ValueError)
    assert result is None
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.status == LogStatus.ERROR
    assert event.error_type == "ValueError"
    assert event.error_message == "boom"
    assert event.output_text is None


def test_invoke_cancelled_publishes_cancelled_event_and_reraises():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(send_exc=asyncio.CancelledError())

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert isinstance(exc, asyncio.CancelledError)
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.status == LogStatus.CANCELLED
    assert event.error_type is None
    assert event.output_text is None


def test_invoke_describe_call_failure_publishes_nothing_but_still_calls_provider():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(
        send_result="reply", describe_call_exc=RuntimeError("describe_call exploded")
    )

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert exc is None
    assert result == "reply"
    assert publisher.events == []


def test_invoke_describe_outcome_failure_publishes_degraded_success_event():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(
        send_result="reply", describe_outcome_exc=RuntimeError("describe_outcome exploded")
    )

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert exc is None
    assert result == "reply"
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.status == LogStatus.SUCCESS
    assert event.output_text is None
    assert event.input_tokens is None
    assert event.output_tokens is None


def test_invoke_describe_failure_failure_falls_back_to_exception_class_name():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(
        send_exc=ValueError("boom"), describe_failure_exc=RuntimeError("describe_failure blew up")
    )

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert isinstance(exc, ValueError)
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.error_type == "ValueError"
    assert event.error_message == "boom"


def test_invoke_event_processor_failure_publishes_unprocessed_event(monkeypatch):
    def bad_processor(event):
        raise RuntimeError("processor exploded")

    monkeypatch.setattr(recorder_module, "EVENT_PROCESSORS", [bad_processor])

    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(send_result="reply")

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert exc is None
    assert len(publisher.events) == 1
    assert publisher.events[0].output_text == "reply"


def test_invoke_no_publisher_configured_defaults_to_null_publisher_and_does_not_raise():
    recorder = CallRecorder()
    provider = FakeProvider(send_result="reply")

    result, exc = asyncio.run(
        _invoke_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert exc is None
    assert result == "reply"


def test_invoke_stream_success_captures_ttft_and_concatenated_outcome():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(stream_chunks=["Hel", "lo"])

    chunks, exc = asyncio.run(
        _invoke_stream_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert exc is None
    assert chunks == ["Hel", "lo"]
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.status == LogStatus.SUCCESS
    assert event.output_text == "Hello"
    assert event.time_to_first_token_ms is not None


def test_invoke_stream_error_mid_stream_publishes_error_event_and_reraises():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(
        stream_chunks=["Hel"], stream_exc=ValueError("stream broke"), stream_exc_after=1
    )

    chunks, exc = asyncio.run(
        _invoke_stream_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert isinstance(exc, ValueError)
    assert chunks == ["Hel"]
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.status == LogStatus.ERROR
    assert event.error_type == "ValueError"


def test_invoke_stream_cancelled_publishes_cancelled_event_and_reraises():
    publisher = FakePublisher()
    recorder = CallRecorder(publisher)
    provider = FakeProvider(
        stream_chunks=[], stream_exc=asyncio.CancelledError(), stream_exc_after=0
    )

    chunks, exc = asyncio.run(
        _invoke_stream_and_drain(recorder, provider, call_type="chat", messages=[])
    )

    assert isinstance(exc, asyncio.CancelledError)
    assert len(publisher.events) == 1
    assert publisher.events[0].status == LogStatus.CANCELLED
