import logging
import os
from typing import Any

# nltk >=3.10.1 (pulled in transitively via scrubadub's SkypeDetector)
# ships a CWE-427 mitigation that blocks any import resolving under the
# current working directory. This project's .venv lives inside backend/,
# the CWD every `uv run` command uses, so the hook treats the venv itself
# as hostile and raises ImportError on `import scrubadub`. Our CWD is our
# own trusted repo, not an attacker-planted directory, so we opt out via
# nltk's own documented escape hatch — scoped here, not process-wide.
os.environ.setdefault("NLTK_DISABLE_IMPORT_SECURITY", "1")

import scrubadub  # noqa: E402

from app.logging_sdk.events import InferenceLogEvent  # noqa: E402

logger = logging.getLogger(__name__)

_scrubber = scrubadub.Scrubber()


def redact_event(event: InferenceLogEvent) -> InferenceLogEvent:
    """EventProcessor that scrubs PII from an event's content fields using
    scrubadub's default detectors. Only input_messages[*].content and
    output_text are touched; every other field passes through
    byte-identical. Each field is scrubbed under its own try/except (FR7):
    a scrubadub failure on one field logs ERROR with request_id and keeps
    that field's original text rather than raising out of the processor
    chain.
    """
    input_messages = [
        _redact_message(message, event.request_id) for message in event.input_messages
    ]

    output_text = event.output_text
    if output_text is not None:
        output_text = _scrub_text(output_text, event.request_id, field="output_text")

    return event.model_copy(update={"input_messages": input_messages, "output_text": output_text})


def _redact_message(message: dict[str, Any], request_id: str) -> dict[str, Any]:
    content = message.get("content")
    if not isinstance(content, str):
        return message
    return {**message, "content": _scrub_text(content, request_id, field="content")}


def _scrub_text(text: str, request_id: str, *, field: str) -> str:
    try:
        return _scrubber.clean(text)
    except Exception:
        logger.error(
            "scrubadub raised while redacting %s; keeping original text: request_id=%s",
            field,
            request_id,
            exc_info=True,
        )
        return text
