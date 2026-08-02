"""Pure decision logic around auto-titling a conversation from its first
turn. sanitize_title in particular is the boundary between whatever the
model returns and what gets stored as a conversation title, so it's worth
pinning its edge cases directly.
"""

from app.models import DEFAULT_CONVERSATION_TITLE, Conversation, ConversationStatus
from app.titling import (
    TITLE_CONTEXT_CHARS,
    TITLE_MAX_LEN,
    render_title_prompt,
    sanitize_title,
    should_title,
)


def test_sanitize_title_none_input_returns_none():
    assert sanitize_title(None) is None


def test_sanitize_title_strips_surrounding_whitespace():
    assert sanitize_title("  Weekend Trip Planning  ") == "Weekend Trip Planning"


def test_sanitize_title_collapses_internal_whitespace():
    assert sanitize_title("Weekend   Trip\nPlanning") == "Weekend Trip Planning"


def test_sanitize_title_strips_matching_double_quotes():
    assert sanitize_title('"Weekend Trip"') == "Weekend Trip"


def test_sanitize_title_strips_matching_single_quotes():
    assert sanitize_title("'Weekend Trip'") == "Weekend Trip"


def test_sanitize_title_strips_curly_quotes():
    assert sanitize_title("“Weekend Trip”") == "Weekend Trip"


def test_sanitize_title_leaves_unmatched_quote_alone():
    assert sanitize_title('Weekend Trip"') == 'Weekend Trip"'


def test_sanitize_title_truncates_and_adds_ellipsis():
    raw = "a" * 100
    result = sanitize_title(raw)

    assert result is not None
    assert len(result) == TITLE_MAX_LEN
    assert result.endswith("…")


def test_sanitize_title_empty_after_strip_returns_none():
    assert sanitize_title("   ") is None


def test_sanitize_title_empty_quotes_returns_none():
    assert sanitize_title('""') is None


def test_should_title_true_on_first_assistant_reply_with_default_title():
    conversation = Conversation(title=DEFAULT_CONVERSATION_TITLE, status=ConversationStatus.ACTIVE)

    assert should_title(1, conversation) is True


def test_should_title_false_when_not_first_assistant_reply():
    conversation = Conversation(title=DEFAULT_CONVERSATION_TITLE, status=ConversationStatus.ACTIVE)

    assert should_title(2, conversation) is False


def test_should_title_false_when_title_already_set():
    conversation = Conversation(title="Already Titled", status=ConversationStatus.ACTIVE)

    assert should_title(1, conversation) is False


def test_render_title_prompt_truncates_long_context():
    long_text = "x" * (TITLE_CONTEXT_CHARS + 50)

    prompt = render_title_prompt(long_text, long_text)

    assert prompt.count("x") == TITLE_CONTEXT_CHARS * 2
