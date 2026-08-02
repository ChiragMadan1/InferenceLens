"""redact_event is the app-layer PII scrubber registered into
EVENT_PROCESSORS (spec 021). Its contract, per app/core/redaction.py's
docstring, is what matters here: only input_messages[*].content and
output_text are touched, every other field passes through byte-identical,
and a scrubadub failure on one field degrades to the original text instead
of raising out of the processor chain (which would otherwise cost the
whole event, per CallRecorder._apply_processors).
"""

from datetime import UTC, datetime

import pytest

from app.core import redaction
from app.core.redaction import redact_event
from app.logging_sdk.events import InferenceLogEvent, LogStatus


def _make_event(**overrides) -> InferenceLogEvent:
    defaults = dict(
        request_id="req-1",
        conversation_id=1,
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status=LogStatus.SUCCESS,
        latency_ms=100,
        input_messages=[{"role": "user", "content": "hi"}],
        output_text="hello",
        requested_at=datetime.now(UTC),
    )
    defaults.update(overrides)
    return InferenceLogEvent(**defaults)


def test_redact_event_scrubs_email_from_message_content():
    event = _make_event(
        input_messages=[{"role": "user", "content": "reach me at john.smith@example.com"}]
    )

    redacted = redact_event(event)

    assert "john.smith@example.com" not in redacted.input_messages[0]["content"]


def test_redact_event_scrubs_output_text():
    event = _make_event(output_text="my email is john.smith@example.com")

    redacted = redact_event(event)

    assert "john.smith@example.com" not in redacted.output_text


def test_redact_event_leaves_clean_text_unchanged():
    event = _make_event(
        input_messages=[{"role": "user", "content": "no pii here"}], output_text="also clean"
    )

    redacted = redact_event(event)

    assert redacted.input_messages[0]["content"] == "no pii here"
    assert redacted.output_text == "also clean"


def test_redact_event_passes_through_non_string_content():
    event = _make_event(input_messages=[{"role": "user", "content": {"parts": ["a"]}}])

    redacted = redact_event(event)

    assert redacted.input_messages[0]["content"] == {"parts": ["a"]}


def test_redact_event_passes_through_none_output_text():
    event = _make_event(output_text=None)

    redacted = redact_event(event)

    assert redacted.output_text is None


def test_redact_event_only_touches_content_and_output_text():
    event = _make_event()

    redacted = redact_event(event)

    assert redacted.request_id == event.request_id
    assert redacted.conversation_id == event.conversation_id
    assert redacted.call_type == event.call_type
    assert redacted.model == event.model
    assert redacted.status == event.status
    assert redacted.latency_ms == event.latency_ms


def test_redact_event_keeps_original_text_when_scrubber_raises(monkeypatch):
    def _raise(text: str) -> str:
        raise RuntimeError("scrubadub exploded")

    monkeypatch.setattr(redaction._scrubber, "clean", _raise)
    event = _make_event(
        input_messages=[{"role": "user", "content": "keep me"}], output_text="keep me too"
    )

    redacted = redact_event(event)

    assert redacted.input_messages[0]["content"] == "keep me"
    assert redacted.output_text == "keep me too"


@pytest.mark.parametrize("role", ["user", "assistant"])
def test_redact_event_scrubs_every_message_role(role):
    event = _make_event(
        input_messages=[{"role": role, "content": "contact john.smith@example.com"}]
    )

    redacted = redact_event(event)

    assert "john.smith@example.com" not in redacted.input_messages[0]["content"]
