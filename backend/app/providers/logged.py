from typing import Any

from app.logging_sdk import CallContext, CallFailure, CallOutcome, CallRecorder
from app.providers.base import ChatProvider, ProviderMessage, ProviderResult


class LoggingChatProvider(ChatProvider):
    """Every ChatProvider handed out by app.providers is one of these.
    Substitutable for the adapter it wraps: same interface, same return
    value, same exceptions — plus exactly one inference log event per call.

    The host-specific shim between this app's ChatProvider signature and the
    logging SDK's provider-agnostic CallRecorder. Everything that actually
    builds and publishes an event lives in app.logging_sdk; this class only
    binds `call_type` at construction and forwards.
    """

    def __init__(
        self,
        inner: ChatProvider,
        recorder: CallRecorder,
        *,
        call_type: str,
    ) -> None:
        self._inner = inner
        self._recorder = recorder
        self._call_type = call_type

    @property
    def provider_name(self) -> str:
        return self._inner.provider_name

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
        return await self._recorder.invoke(
            self._inner,
            call_type=self._call_type,
            messages=messages,
            system=system,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            conversation_id=conversation_id,
        )

    # describe_* delegate to the wrapped adapter — CallRecorder calls these
    # on `inner` (see send_message above); they exist here only because
    # ChatProvider's ABC requires every concrete class to define them.
    def describe_call(self, *args: Any, **kwargs: Any) -> CallContext:
        return self._inner.describe_call(*args, **kwargs)

    def describe_outcome(self, result: Any) -> CallOutcome:
        return self._inner.describe_outcome(result)

    def describe_failure(self, exc: BaseException) -> CallFailure:
        return self._inner.describe_failure(exc)
