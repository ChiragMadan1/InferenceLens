from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CallContext:
    """What is about to be sent, as the provider renders it."""

    provider: str
    model: str
    system_prompt: str
    input_messages: list[dict[str, Any]]
    request_params: dict[str, Any]
    conversation_id: int | None = None


@dataclass(frozen=True)
class CallOutcome:
    """What came back, as the provider maps its own success type."""

    output_text: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    provider_metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class CallFailure:
    """How the provider classifies an exception it raised."""

    error_type: str
    error_message: str


class InstrumentedProvider(ABC):
    """Implement this to become loggable. Every member is mandatory — the SDK
    asks the provider for everything it records and assumes nothing.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Value written to every event's `provider` field. A concrete
        implementor may satisfy this with a plain class attribute."""

    @abstractmethod
    async def send_message(self, *args: Any, **kwargs: Any) -> Any:
        """The call being instrumented."""

    @abstractmethod
    async def stream_message(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        """The streaming call being instrumented. Yields opaque chunks in
        order; interpreted only by describe_stream_outcome."""

    @abstractmethod
    def describe_call(self, *args: Any, **kwargs: Any) -> CallContext:
        """Same arguments send_message receives. Return what is about to be
        sent, rendered exactly as the model will see it."""

    @abstractmethod
    def describe_outcome(self, result: Any) -> CallOutcome:
        """Map this provider's own success type into the canonical shape."""

    @abstractmethod
    def describe_stream_outcome(self, chunks: list[Any]) -> CallOutcome:
        """Same role as describe_outcome, given every chunk stream_message
        yielded, in order."""

    @abstractmethod
    def describe_failure(self, exc: BaseException) -> CallFailure:
        """Classify an exception raised by send_message. Must handle
        exceptions this provider did not raise itself — fall back to the
        exception's class name. Never called for CancelledError."""
