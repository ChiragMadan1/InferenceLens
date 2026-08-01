import logging

from app.core.config import settings
from app.logging_sdk import CallRecorder, HTTPEventPublisher

logger = logging.getLogger(__name__)

_publisher: HTTPEventPublisher | None = None
_recorder: CallRecorder | None = None


def init_observability() -> None:
    """Build the process-wide publisher and recorder from settings. This is
    the only place host configuration meets the logging SDK — called from
    the FastAPI lifespan, after setup_logging().
    """
    global _publisher, _recorder
    _publisher = HTTPEventPublisher(
        settings.INGEST_URL, timeout_seconds=settings.INGEST_TIMEOUT_SECONDS
    )
    _recorder = CallRecorder(_publisher)


async def close_observability() -> None:
    """Close the publisher's httpx.AsyncClient on shutdown."""
    global _publisher, _recorder
    if _publisher is not None:
        await _publisher.aclose()
    _publisher = None
    _recorder = None


def get_recorder() -> CallRecorder:
    """Accessor for the process-wide CallRecorder. Falls back to a fresh
    recorder over a null publisher if init_observability() has not run
    (e.g. a script importing app.providers without the app's lifespan) —
    logging then degrades to a no-op rather than an AttributeError.
    """
    if _recorder is None:
        logger.debug("get_recorder() called before init_observability(); using a null publisher")
        return CallRecorder()
    return _recorder
