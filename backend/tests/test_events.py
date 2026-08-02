"""config_hash groups inference logs by (provider, model, prompt, params) —
a query like "did the new prompt version get slower or costlier?" depends
on it being both stable and sensitive to real changes.
"""

from app.logging_sdk.events import config_hash


def test_config_hash_is_deterministic_regardless_of_param_key_order():
    a = config_hash("openai", "gpt-5.6-terra", "be helpful", {"max_tokens": 10, "temp": 0.5})
    b = config_hash("openai", "gpt-5.6-terra", "be helpful", {"temp": 0.5, "max_tokens": 10})

    assert a == b


def test_config_hash_is_16_hex_chars():
    h = config_hash("openai", "gpt-5.6-terra", "be helpful", {"max_tokens": 10})

    assert len(h) == 16
    assert all(c in "0123456789abcdef" for c in h)


def test_config_hash_changes_when_system_prompt_changes():
    a = config_hash("openai", "gpt-5.6-terra", "be helpful", {})
    b = config_hash("openai", "gpt-5.6-terra", "be terse", {})

    assert a != b


def test_config_hash_changes_when_model_changes():
    a = config_hash("openai", "gpt-5.6-terra", "be helpful", {})
    b = config_hash("openai", "gpt-5.6-luna", "be helpful", {})

    assert a != b


def test_config_hash_changes_when_request_params_change():
    a = config_hash("openai", "gpt-5.6-terra", "be helpful", {"max_tokens": 10})
    b = config_hash("openai", "gpt-5.6-terra", "be helpful", {"max_tokens": 20})

    assert a != b
