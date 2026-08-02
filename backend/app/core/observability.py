import logging

from app.core.config import EventTransport, settings
from app.logging_sdk import CallRecorder, HTTPEventPublisher, KafkaEventPublisher

logger = logging.getLogger(__name__)

_publisher: HTTPEventPublisher | KafkaEventPublisher | None = None
_recorder: CallRecorder | None = None


async def init_observability() -> None:
    """Build the process-wide publisher and recorder from settings. This is
    the only place host configuration meets the logging SDK — called from
    the FastAPI lifespan, after setup_logging(). Transport choice is a
    startup-only config/DI swap (spec 017): the rest of the app never knows
    which one is in play.
    """
    global _publisher, _recorder

    publisher: HTTPEventPublisher | KafkaEventPublisher
    if settings.EVENT_TRANSPORT == EventTransport.KAFKA:
        publisher = KafkaEventPublisher(settings.KAFKA_BOOTSTRAP_SERVERS, settings.KAFKA_TOPIC)
        await publisher.start()
    else:
        publisher = HTTPEventPublisher(
            settings.INGEST_URL, timeout_seconds=settings.INGEST_TIMEOUT_SECONDS
        )

    _publisher = publisher
    _recorder = CallRecorder(_publisher)


async def close_observability() -> None:
    """Close the active publisher's transport on shutdown."""
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
