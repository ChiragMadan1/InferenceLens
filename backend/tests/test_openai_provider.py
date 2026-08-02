"""OpenAIProvider's mapping methods are what CallRecorder trusts to
describe a call and its outcome accurately — a bug here corrupts every
inference log for this provider, not just the API response. All of these
are synchronous and pure given a fake response object, so no network call
or event loop is needed; send_message/stream_message (the actual HTTP
calls) are out of scope for a unit test.
"""

from types import SimpleNamespace

from app.providers.base import Provider, ProviderError, ProviderResult, ProviderStreamChunk
from app.providers.openai import OpenAIProvider

provider = OpenAIProvider(api_key="test-key", timeout_seconds=30)


def _fake_response(
    *,
    output_text="hello",
    status="completed",
    response_id="resp_1",
    model="gpt-5.6-terra",
    input_tokens=10,
    output_tokens=20,
    cached_tokens=None,
    reasoning_tokens=None,
    incomplete_reason=None,
):
    usage = None
    if input_tokens is not None or output_tokens is not None:
        usage = SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            input_tokens_details=SimpleNamespace(cached_tokens=cached_tokens),
            output_tokens_details=SimpleNamespace(reasoning_tokens=reasoning_tokens),
        )
    incomplete_details = (
        SimpleNamespace(reason=incomplete_reason) if incomplete_reason is not None else None
    )
    return SimpleNamespace(
        output_text=output_text,
        usage=usage,
        status=status,
        id=response_id,
        model=model,
        incomplete_details=incomplete_details,
    )


def test_map_response_success_shape():
    result = provider._map_response(_fake_response())

    assert result.content == "hello"
    assert result.input_tokens == 10
    assert result.output_tokens == 20
    assert result.provider == Provider.OPENAI
    assert result.stop_reason == "completed"
    assert result.provider_metadata["response_id"] == "resp_1"


def test_map_response_missing_output_text_defaults_to_empty_string():
    result = provider._map_response(_fake_response(output_text=None))

    assert result.content == ""


def test_map_response_incomplete_status_uses_incomplete_reason_as_stop_reason():
    result = provider._map_response(
        _fake_response(status="incomplete", incomplete_reason="max_output_tokens")
    )

    assert result.stop_reason == "max_output_tokens"
    assert result.provider_metadata["incomplete_reason"] == "max_output_tokens"


def test_map_response_includes_cached_and_reasoning_tokens_when_present():
    result = provider._map_response(
        _fake_response(cached_tokens=5, reasoning_tokens=15)
    )

    assert result.provider_metadata["cached_tokens"] == 5
    assert result.provider_metadata["reasoning_tokens"] == 15


def test_map_response_omits_cached_and_reasoning_tokens_when_absent():
    result = provider._map_response(_fake_response())

    assert "cached_tokens" not in result.provider_metadata
    assert "reasoning_tokens" not in result.provider_metadata


def test_build_request_never_sends_temperature():
    request = provider._build_request(
        [{"role": "user", "content": "hi"}], system="be helpful", model="gpt-5.6-terra",
        max_tokens=100,
    )

    assert "temperature" not in request
    assert request["model"] == "gpt-5.6-terra"
    assert request["instructions"] == "be helpful"


def test_describe_call_puts_system_prompt_first_and_records_temperature():
    context = provider.describe_call(
        [{"role": "user", "content": "hi"}],
        system="be helpful",
        model="gpt-5.6-terra",
        max_tokens=100,
        temperature=0.7,
        conversation_id=42,
    )

    assert context.input_messages[0] == {"role": "system", "content": "be helpful"}
    assert context.input_messages[1] == {"role": "user", "content": "hi"}
    assert context.request_params == {"max_tokens": 100, "temperature": 0.7}
    assert context.conversation_id == 42


def test_describe_outcome_maps_provider_result():
    result = ProviderResult(
        content="hi there",
        input_tokens=1,
        output_tokens=2,
        model="gpt-5.6-terra",
        provider=Provider.OPENAI,
        stop_reason="completed",
        provider_metadata={"a": 1},
    )

    outcome = provider.describe_outcome(result)

    assert outcome.output_text == "hi there"
    assert outcome.input_tokens == 1
    assert outcome.output_tokens == 2
    assert outcome.provider_metadata == {"a": 1}


def test_describe_stream_outcome_uses_final_chunk_result():
    final_result = ProviderResult(
        content="full text",
        input_tokens=3,
        output_tokens=4,
        model="gpt-5.6-terra",
        provider=Provider.OPENAI,
        stop_reason="completed",
    )
    chunks = [
        ProviderStreamChunk(delta="full "),
        ProviderStreamChunk(delta="text", result=final_result),
    ]

    outcome = provider.describe_stream_outcome(chunks)

    assert outcome.output_text == "full text"
    assert outcome.input_tokens == 3


def test_describe_failure_maps_provider_error():
    exc = ProviderError("rate_limit", "slow down", status_code=429)

    failure = provider.describe_failure(exc)

    assert failure.error_type == "rate_limit"
    assert failure.error_message == "slow down"


def test_describe_failure_falls_back_to_class_name_for_unknown_exception():
    failure = provider.describe_failure(ValueError("weird"))

    assert failure.error_type == "ValueError"
    assert failure.error_message == "weird"
