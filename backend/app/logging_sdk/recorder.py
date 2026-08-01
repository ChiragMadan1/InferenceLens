import asyncio
import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.logging_sdk.contract import CallContext, CallFailure, CallOutcome, InstrumentedProvider
from app.logging_sdk.events import EVENT_PROCESSORS, InferenceLogEvent, LogStatus, config_hash
from app.logging_sdk.publisher import EventPublisher, NullEventPublisher

logger = logging.getLogger(__name__)

# Strong references to in-flight publish tasks. Without this the event loop
# only holds a weak reference and a task can be garbage-collected mid-flight.
_pending_publish_tasks: set[asyncio.Task[None]] = set()


class CallRecorder:
    """Wraps one provider call and emits exactly one InferenceLogEvent for
    it — success, error, or cancellation. The single emission point: no
    other code in this package, or the host, should construct an
    InferenceLogEvent or call a publisher directly.
    """

    def __init__(self, publisher: EventPublisher | None = None) -> None:
        self._publisher = publisher or NullEventPublisher()

    async def invoke(
        self,
        provider: InstrumentedProvider,
        *,
        call_type: str,
        **call_kwargs: Any,
    ) -> Any:
        request_id = uuid4().hex
        requested_at = datetime.now(UTC)
        started = time.perf_counter()

        context = self._safe_describe_call(provider, request_id, call_kwargs)

        status: LogStatus
        outcome: CallOutcome | None = None
        failure: CallFailure | None = None
        try:
            result = await provider.send_message(**call_kwargs)
        except asyncio.CancelledError:
            status = LogStatus.CANCELLED
            raise
        except BaseException as exc:
            status = LogStatus.ERROR
            failure = self._safe_describe_failure(provider, request_id, exc)
            raise
        else:
            status = LogStatus.SUCCESS
            outcome = self._safe_describe_outcome(provider, request_id, result)
            return result
        finally:
            # Must not await anything below: awaiting inside a `finally` while
            # a CancelledError is propagating can raise a second
            # CancelledError and skip the publish entirely.
            if context is not None:
                completed_at = datetime.now(UTC)
                latency_ms = int((time.perf_counter() - started) * 1000)
                event = InferenceLogEvent(
                    request_id=request_id,
                    conversation_id=context.conversation_id,
                    call_type=call_type,
                    model=context.model,
                    provider=context.provider,
                    status=status,
                    latency_ms=latency_ms,
                    input_tokens=outcome.input_tokens if outcome else None,
                    output_tokens=outcome.output_tokens if outcome else None,
                    error_type=failure.error_type if failure else None,
                    error_message=failure.error_message if failure else None,
                    request_params=context.request_params,
                    config_hash=config_hash(
                        context.provider,
                        context.model,
                        context.system_prompt,
                        context.request_params,
                    ),
                    input_messages=context.input_messages,
                    output_text=outcome.output_text if outcome else None,
                    provider_metadata=outcome.provider_metadata if outcome else None,
                    requested_at=requested_at,
                    completed_at=completed_at,
                )
                event = self._apply_processors(event, request_id)
                _schedule_publish(self._publisher, event)

    async def invoke_stream(
        self,
        provider: InstrumentedProvider,
        *,
        call_type: str,
        **call_kwargs: Any,
    ) -> AsyncIterator[Any]:
        request_id = uuid4().hex
        requested_at = datetime.now(UTC)
        started = time.perf_counter()

        context = self._safe_describe_call(provider, request_id, call_kwargs)

        status: LogStatus
        outcome: CallOutcome | None = None
        failure: CallFailure | None = None
        ttft_ms: int | None = None
        chunks: list[Any] = []
        try:
            async for chunk in provider.stream_message(**call_kwargs):
                if ttft_ms is None:
                    ttft_ms = int((time.perf_counter() - started) * 1000)
                chunks.append(chunk)
                yield chunk
        except asyncio.CancelledError:
            status = LogStatus.CANCELLED
            raise
        except BaseException as exc:
            status = LogStatus.ERROR
            failure = self._safe_describe_failure(provider, request_id, exc)
            raise
        else:
            status = LogStatus.SUCCESS
            outcome = self._safe_describe_stream_outcome(provider, request_id, chunks)
        finally:
            # Must not await anything below: awaiting inside a `finally` while
            # a CancelledError is propagating can raise a second
            # CancelledError and skip the publish entirely.
            if context is not None:
                completed_at = datetime.now(UTC)
                latency_ms = int((time.perf_counter() - started) * 1000)
                event = InferenceLogEvent(
                    request_id=request_id,
                    conversation_id=context.conversation_id,
                    call_type=call_type,
                    model=context.model,
                    provider=context.provider,
                    status=status,
                    latency_ms=latency_ms,
                    input_tokens=outcome.input_tokens if outcome else None,
                    output_tokens=outcome.output_tokens if outcome else None,
                    error_type=failure.error_type if failure else None,
                    error_message=failure.error_message if failure else None,
                    time_to_first_token_ms=ttft_ms,
                    request_params=context.request_params,
                    config_hash=config_hash(
                        context.provider,
                        context.model,
                        context.system_prompt,
                        context.request_params,
                    ),
                    input_messages=context.input_messages,
                    output_text=outcome.output_text if outcome else None,
                    provider_metadata=outcome.provider_metadata if outcome else None,
                    requested_at=requested_at,
                    completed_at=completed_at,
                )
                event = self._apply_processors(event, request_id)
                _schedule_publish(self._publisher, event)

    def _safe_describe_call(
        self,
        provider: InstrumentedProvider,
        request_id: str,
        call_kwargs: dict[str, Any],
    ) -> CallContext | None:
        try:
            return provider.describe_call(**call_kwargs)
        except Exception:
            logger.error(
                "describe_call() raised; no inference log will be recorded: request_id=%s",
                request_id,
                exc_info=True,
            )
            return None

    def _safe_describe_outcome(
        self,
        provider: InstrumentedProvider,
        request_id: str,
        result: Any,
    ) -> CallOutcome | None:
        try:
            return provider.describe_outcome(result)
        except Exception:
            logger.error(
                "describe_outcome() raised; publishing a degraded event: request_id=%s",
                request_id,
                exc_info=True,
            )
            return None

    def _safe_describe_stream_outcome(
        self,
        provider: InstrumentedProvider,
        request_id: str,
        chunks: list[Any],
    ) -> CallOutcome | None:
        try:
            return provider.describe_stream_outcome(chunks)
        except Exception:
            logger.error(
                "describe_stream_outcome() raised; publishing a degraded event: request_id=%s",
                request_id,
                exc_info=True,
            )
            return None

    def _safe_describe_failure(
        self,
        provider: InstrumentedProvider,
        request_id: str,
        exc: BaseException,
    ) -> CallFailure:
        try:
            return provider.describe_failure(exc)
        except Exception:
            logger.error(
                "describe_failure() raised; falling back to the exception's class name: "
                "request_id=%s",
                request_id,
                exc_info=True,
            )
            return CallFailure(error_type=type(exc).__name__, error_message=str(exc))

    def _apply_processors(self, event: InferenceLogEvent, request_id: str) -> InferenceLogEvent:
        processed = event
        for processor in EVENT_PROCESSORS:
            try:
                processed = processor(processed)
            except Exception:
                logger.error(
                    "Event processor raised; publishing the un-processed event: request_id=%s",
                    request_id,
                    exc_info=True,
                )
                return event
        return processed


def _schedule_publish(publisher: EventPublisher, event: InferenceLogEvent) -> None:
    try:
        task = asyncio.create_task(publisher.publish(event))
    except RuntimeError:
        logger.error(
            "Could not schedule publish (no running event loop): request_id=%s",
            event.request_id,
        )
        return

    _pending_publish_tasks.add(task)
    task.add_done_callback(_pending_publish_tasks.discard)
