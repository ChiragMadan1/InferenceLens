from abc import abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, ClassVar, Literal, TypedDict

from app.logging_sdk import CallContext, CallFailure, CallOutcome, InstrumentedProvider


class Provider(StrEnum):
    OPENAI = "openai"


class ProviderMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str


@dataclass(frozen=True)
class ProviderResult:
    content: str
    input_tokens: int | None
    output_tokens: int | None
    model: str
    provider: Provider
    stop_reason: str | None
    provider_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderStreamChunk:
    delta: str
    result: ProviderResult | None = None


class ProviderError(Exception):
    def __init__(self, error_type: str, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message
        self.status_code = status_code


class ChatProvider(InstrumentedProvider):
    """The interface every adapter implements. Extends the logging SDK's
    InstrumentedProvider (app.logging_sdk) — describe_call / describe_outcome
    / describe_failure are what let CallRecorder log a call without this
    interface, or the SDK, knowing anything about the other's internals.
    """

    provider_name: ClassVar[Provider]

    @abstractmethod
    async def send_message(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
        temperature: float,
        conversation_id: int | None = None,
    ) -> ProviderResult:
        """Send one chat request and return a normalized result.

        Implementors: this is the only method you must write. The conventional
        shape (see OpenAIProvider) is three private helpers —

          _build_request(...)  -> the vendor SDK's kwargs
          _map_response(raw)   -> ProviderResult
          _map_error(exc)      -> ProviderError

        — but they are a template, not a contract: a provider whose SDK does
        not fit that shape is free to organise itself differently. What is
        fixed is this signature, the ProviderResult returned, and the
        ProviderError raised.

        `temperature` and `conversation_id` exist for the log, not necessarily
        the vendor call — see describe_call. Whether temperature reaches the
        vendor API is the adapter's decision.

        Raises ProviderError on any provider failure. Must let
        asyncio.CancelledError propagate untouched.
        """
        raise NotImplementedError

    @abstractmethod
    async def stream_message(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
        temperature: float,
        conversation_id: int | None = None,
    ) -> AsyncIterator[ProviderStreamChunk]:
        """Same signature and contract as send_message, streamed.

        Yields zero or more chunks with `result=None` (each carrying the next
        slice of assistant text), followed by exactly one final chunk with
        `result` populated (a full ProviderResult, whose `content` equals the
        concatenation of every `delta` yielded). The generator then ends
        normally — it does not yield anything after the final chunk.

        Raises ProviderError on any provider failure. Must let
        asyncio.CancelledError propagate untouched.
        """
        raise NotImplementedError

    @abstractmethod
    def describe_call(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
        temperature: float,
        conversation_id: int | None = None,
    ) -> CallContext:
        """Same arguments send_message receives. See InstrumentedProvider."""
        raise NotImplementedError

    @abstractmethod
    def describe_outcome(self, result: ProviderResult) -> CallOutcome:
        raise NotImplementedError

    @abstractmethod
    def describe_stream_outcome(self, chunks: list[ProviderStreamChunk]) -> CallOutcome:
        """Same role as describe_outcome, given every chunk stream_message
        yielded, in order. The last chunk's `result` is guaranteed non-None
        per stream_message's contract."""
        raise NotImplementedError

    @abstractmethod
    def describe_failure(self, exc: BaseException) -> CallFailure:
        raise NotImplementedError
