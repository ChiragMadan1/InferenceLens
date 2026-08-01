import logging
import re

from sqlalchemy import update

from app import db as db_module
from app.core.config import settings
from app.models import DEFAULT_CONVERSATION_TITLE, Conversation
from app.providers import ProviderError, get_title_provider

logger = logging.getLogger(__name__)

TITLE_MAX_TOKENS = 32
TITLE_TEMPERATURE = 0.0
TITLE_MAX_LEN = 40
TITLE_CONTEXT_CHARS = 500

TITLE_SYSTEM_PROMPT = (
    "You write short titles for chat conversations. "
    "Reply with the title only — 3 to 6 words, at most 40 characters, "
    "no surrounding quotes, no trailing punctuation, no explanation."
)

_QUOTE_PAIRS = (
    ('"', '"'),
    ("'", "'"),
    ("“", "”"),  # “ ”
    ("‘", "’"),  # ‘ ’
)


def render_title_prompt(user_text: str, assistant_text: str) -> str:
    return (
        "Title this conversation.\n\n"
        f"User: {user_text[:TITLE_CONTEXT_CHARS]}\n"
        f"Assistant: {assistant_text[:TITLE_CONTEXT_CHARS]}"
    )


def sanitize_title(raw: str | None) -> str | None:
    """Returns None to mean "reject, keep the default title"."""
    if raw is None:
        return None
    text = raw.strip()
    text = re.sub(r"\s+", " ", text)
    for _ in range(3):
        if len(text) >= 2 and (text[0], text[-1]) in _QUOTE_PAIRS:
            text = text[1:-1].strip()
        else:
            break
    if len(text) > TITLE_MAX_LEN:
        text = text[: TITLE_MAX_LEN - 1].rstrip() + "…"
    if not text:
        return None
    return text


def should_title(assistant_count: int, conversation: Conversation) -> bool:
    return assistant_count == 1 and conversation.title == DEFAULT_CONVERSATION_TITLE


async def generate_title(conversation_id: int, user_text: str, assistant_text: str) -> None:
    """Fire-and-forget. Never raises. Never returns a value."""
    session = db_module.SessionLocal()
    try:
        provider = get_title_provider()
        rendered = render_title_prompt(user_text, assistant_text)
        result = await provider.send_message(
            [{"role": "user", "content": rendered}],
            system=TITLE_SYSTEM_PROMPT,
            model=settings.OPENAI_TITLE_MODEL,
            max_tokens=TITLE_MAX_TOKENS,
            temperature=TITLE_TEMPERATURE,
            conversation_id=conversation_id,
        )

        title = sanitize_title(result.content)
        if title is None:
            # The provider call itself succeeded (status="success" in the
            # inference log) — this rejection of unusable output is an
            # app-level decision, so it gets an ERROR line here, not a
            # fabricated error status on the log.
            logger.error(
                "Titling for conversation %s sanitized to empty; keeping default title.",
                conversation_id,
            )
            return

        # Single conditional UPDATE, not read-then-write: a concurrent writer
        # (or a title already set) can never be clobbered. Deliberately does
        # not touch updated_at — titling is a system action, not user
        # activity, and bumping it would reorder the conversation list.
        update_result = session.execute(
            update(Conversation)
            .where(
                Conversation.id == conversation_id,
                Conversation.title == DEFAULT_CONVERSATION_TITLE,
            )
            .values(title=title)
        )
        session.commit()
        if update_result.rowcount == 0:
            logger.info(
                "Conversation %s already titled (or no longer exists); skipping.",
                conversation_id,
            )
        else:
            logger.info("Titled conversation %s: %r", conversation_id, title)
    except ProviderError as exc:
        logger.error("Titling failed for conversation %s: %s", conversation_id, exc)
        return  # degraded, not swallowed — the log row is the record
    except Exception:
        # Broad except is justified here specifically: the caller is a
        # background task with no HTTP response to return, and titling must
        # never surface as an unhandled task error after the chat turn
        # already returned 200. Logged with full context, then dropped.
        logger.exception("Unexpected titling failure for conversation %s", conversation_id)
        return
    finally:
        session.close()
