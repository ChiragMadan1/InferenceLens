"""Pure helpers and validators in app/schemas.py that sit on critical
paths: percentile() backs every latency/TTFT stat the analytics endpoints
report, the preview helpers back the log list view, and the field
validators are the only thing standing between a blank/whitespace request
body and a stored row.
"""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.models import InferenceLog
from app.schemas import (
    ConversationCreate,
    InferenceLogEventIn,
    InferenceLogSummary,
    MessageCreate,
    percentile,
)


def test_percentile_empty_list_returns_none():
    assert percentile([], 50) is None


def test_percentile_p50_nearest_rank():
    # nearest-rank, not interpolated: ceil(0.50 * 4) - 1 = 1 -> values[1]
    assert percentile([10, 20, 30, 40], 50) == 20


def test_percentile_p100_returns_max():
    assert percentile([10, 20, 30, 40], 100) == 40


def test_percentile_single_value():
    assert percentile([42], 95) == 42


def test_conversation_create_blank_title_becomes_none():
    conversation = ConversationCreate(title="   ")

    assert conversation.title is None


def test_conversation_create_strips_title_whitespace():
    conversation = ConversationCreate(title="  My Chat  ")

    assert conversation.title == "My Chat"


def test_message_create_rejects_whitespace_only_content():
    with pytest.raises(ValidationError):
        MessageCreate(content="   ")


def test_message_create_strips_content():
    message = MessageCreate(content="  hello  ")

    assert message.content == "hello"


def test_inference_log_event_in_truncates_long_error_message():
    event = InferenceLogEventIn(
        schema_version=1,
        request_id="r1",
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status="error",
        latency_ms=10,
        error_message="x" * 3000,
        input_messages=[],
        requested_at=datetime.now(UTC),
    )

    assert len(event.error_message) == 2000


def test_inference_log_event_in_rejects_unknown_schema_version():
    with pytest.raises(ValidationError):
        InferenceLogEventIn(
            schema_version=2,
            request_id="r1",
            call_type="chat",
            model="gpt-5.6-terra",
            provider="openai",
            status="success",
            latency_ms=10,
            input_messages=[],
            requested_at=datetime.now(UTC),
        )


def test_inference_log_event_in_ignores_unknown_fields():
    event = InferenceLogEventIn(
        schema_version=1,
        request_id="r1",
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status="success",
        latency_ms=10,
        input_messages=[],
        requested_at=datetime.now(UTC),
        some_field_from_the_future="ignored",
    )

    assert not hasattr(event, "some_field_from_the_future")


def _make_log(**overrides) -> InferenceLog:
    defaults = dict(
        id=1,
        request_id="r1",
        schema_version=1,
        conversation_id=1,
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status="success",
        latency_ms=100,
        input_tokens=10,
        output_tokens=20,
        error_type=None,
        error_message=None,
        time_to_first_token_ms=None,
        cost_usd=None,
        request_params=None,
        config_hash=None,
        input_messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello there, this is my question"},
        ],
        output_text="here is my answer",
        provider_metadata=None,
        requested_at=datetime.now(UTC),
        completed_at=datetime.now(UTC),
        created_at=datetime.now(UTC),
    )
    defaults.update(overrides)
    return InferenceLog(**defaults)


def test_inference_log_summary_from_log_previews_last_user_message():
    summary = InferenceLogSummary.from_log(_make_log())

    assert summary.input_preview == "hello there, this is my question"
    assert summary.output_preview == "here is my answer"


def test_inference_log_summary_from_log_no_user_message_previews_none():
    log = _make_log(input_messages=[{"role": "system", "content": "sys"}])

    summary = InferenceLogSummary.from_log(log)

    assert summary.input_preview is None


def test_inference_log_summary_from_log_non_string_content_previews_none():
    log = _make_log(input_messages=[{"role": "user", "content": {"parts": ["a"]}}])

    summary = InferenceLogSummary.from_log(log)

    assert summary.input_preview is None
