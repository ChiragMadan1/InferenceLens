from app.providers.base import (
    ChatProvider,
    Provider,
    ProviderError,
    ProviderMessage,
    ProviderResult,
)
from app.providers.logged import LoggingChatProvider

__all__ = [
    "ChatProvider",
    "Provider",
    "ProviderError",
    "ProviderMessage",
    "ProviderResult",
    "LoggingChatProvider",
    "get_chat_provider",
    "get_title_provider",
]

# Deliberately not re-exported: OpenAIProvider (or any future concrete
# adapter) must not be importable from app.providers. get_chat_provider()
# and get_title_provider() are the only accessors, and both always return an
# instrumented LoggingChatProvider — see spec 006 "Instrumentation is
# structural, not conventional".

_inner_provider: ChatProvider | None = None


def _build(provider: Provider) -> ChatProvider:
    # Imported lazily: app.core.config imports Provider from app.providers.base,
    # and importing that submodule runs this __init__ first — a module-level
    # `from app.core.config import settings` here would be circular. OpenAIProvider
    # is imported lazily too, so it never becomes an attribute of app.providers —
    # `from app.providers import OpenAIProvider` must not work; see FR21.
    from app.core.config import settings

    match provider:
        case Provider.OPENAI:
            from app.providers.openai import OpenAIProvider

            return OpenAIProvider(
                api_key=settings.OPENAI_API_KEY,
                timeout_seconds=settings.PROVIDER_TIMEOUT_SECONDS,
            )
    raise ValueError(f"No adapter registered for provider {provider!r}")


def _inner() -> ChatProvider:
    """The raw, uninstrumented adapter singleton — one AsyncOpenAI connection
    pool per process, same idea as app.db's single `engine`. Not exported;
    both get_chat_provider() and get_title_provider() wrap it.
    """
    global _inner_provider
    if _inner_provider is None:
        from app.core.config import settings

        _inner_provider = _build(settings.PROVIDER)
    return _inner_provider


def get_chat_provider() -> ChatProvider:
    """FastAPI dependency. Returns an already-instrumented provider bound to
    call_type=chat — the only kind of provider this module hands out.
    """
    # Imported lazily for the same reason settings is: app.schemas pulls in
    # app.models -> app.db -> app.core.config, and this __init__ runs as a
    # side effect of app.core.config importing Provider from
    # app.providers.base — a module-level import here would be circular.
    from app.core.observability import get_recorder
    from app.schemas import CallType

    return LoggingChatProvider(_inner(), get_recorder(), call_type=CallType.CHAT)


def get_title_provider() -> ChatProvider:
    """Same instrumented provider, bound to call_type=title (spec 008)."""
    from app.core.observability import get_recorder
    from app.schemas import CallType

    return LoggingChatProvider(_inner(), get_recorder(), call_type=CallType.TITLE)
