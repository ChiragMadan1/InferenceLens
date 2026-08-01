import logging
from abc import ABC, abstractmethod

import httpx

from app.logging_sdk.events import InferenceLogEvent

logger = logging.getLogger(__name__)


class EventPublisher(ABC):
    @abstractmethod
    async def publish(self, event: InferenceLogEvent) -> None: ...


class NullEventPublisher(EventPublisher):
    """Drops every event. Used when no transport has been configured, so an
    unconfigured recorder degrades to a no-op instead of an AttributeError.
    """

    async def publish(self, event: InferenceLogEvent) -> None:
        logger.debug(
            "No publisher configured; dropping event: request_id=%s call_type=%s",
            event.request_id,
            event.call_type,
        )


class HTTPEventPublisher(EventPublisher):
    """POSTs the event as JSON to `url`. Never raises — every failure path is
    caught, logged at ERROR with event context, and swallowed.
    """

    def __init__(self, url: str, *, timeout_seconds: float = 5.0) -> None:
        self._url = url
        self._client = httpx.AsyncClient(timeout=timeout_seconds)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def publish(self, event: InferenceLogEvent) -> None:
        try:
            response = await self._client.post(self._url, json=event.model_dump(mode="json"))
        except httpx.HTTPError as exc:
            logger.error(
                "Failed to publish inference log event: request_id=%s conversation_id=%s "
                "status=%s call_type=%s error=%s",
                event.request_id,
                event.conversation_id,
                event.status,
                event.call_type,
                exc,
            )
            return
        except Exception as exc:
            logger.error(
                "Unexpected error publishing inference log event: request_id=%s "
                "conversation_id=%s status=%s call_type=%s error=%s",
                event.request_id,
                event.conversation_id,
                event.status,
                event.call_type,
                exc,
            )
            return

        if response.status_code == 201:
            return
        if response.status_code == 409:
            # Duplicate request_id — already stored. Exactly what at-least-once
            # delivery wants; not a failure.
            logger.debug(
                "Duplicate inference log event (already stored): request_id=%s",
                event.request_id,
            )
            return

        logger.error(
            "Ingestion rejected inference log event: request_id=%s conversation_id=%s "
            "status=%s call_type=%s http_status=%s body=%s",
            event.request_id,
            event.conversation_id,
            event.status,
            event.call_type,
            response.status_code,
            response.text,
        )
