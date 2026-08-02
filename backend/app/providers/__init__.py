from app.providers.base import (
    ChatProvider,
    Provider,
    ProviderError,
    ProviderMessage,
    ProviderResult,
    ProviderStreamChunk,
)
from app.providers.logged import LoggingChatProvider

__all__ = [
    "ChatProvider",
    "Provider",
    "ProviderError",
    "ProviderMessage",
    "ProviderResult",
    "ProviderStreamChunk",
    "LoggingChatProvider",
    "get_chat_provider",
    "get_title_provider",
]

# Deliberately not re-exported: OpenAIProvider, AnthropicProvider (or any
# future concrete adapter) must not be importable from app.providers.
# get_chat_provider() and get_title_provider() are the only accessors, and
# both always return an instrumented LoggingChatProvider — see spec 006
# "Instrumentation is structural, not conventional".

_inner_providers: dict[Provider, ChatProvider] = {}


def _build(provider: Provider) -> ChatProvider:
    # Imported lazily: app.core.config imports Provider from app.providers.base,
    # and importing that submodule runs this __init__ first — a module-level
    # `from app.core.config import settings` here would be circular. Concrete
    # adapters are imported lazily too, so they never become attributes of
    # app.providers — `from app.providers import OpenAIProvider` must not
    # work; see FR21.
    from app.core.config import settings

    match provider:
        case Provider.OPENAI:
            from app.providers.openai import OpenAIProvider

            return OpenAIProvider(
                api_key=settings.OPENAI_API_KEY,
                timeout_seconds=settings.PROVIDER_TIMEOUT_SECONDS,
            )
        case Provider.ANTHROPIC:
            from app.providers.anthropic import AnthropicProvider

            return AnthropicProvider(
                api_key=settings.ANTHROPIC_API_KEY,
                timeout_seconds=settings.PROVIDER_TIMEOUT_SECONDS,
            )
    raise ValueError(f"No adapter registered for provider {provider!r}")


def _inner(provider: Provider) -> ChatProvider:
    """The raw, uninstrumented adapter singleton for `provider` — one SDK
    connection pool per provider per process, same idea as app.db's single
    `engine`. Not exported; both get_chat_provider() and get_title_provider()
    wrap it.
    """
    if provider not in _inner_providers:
        _inner_providers[provider] = _build(provider)
    return _inner_providers[provider]


def get_chat_provider(model: str | None = None) -> ChatProvider:
    """Resolves `model` (default: settings.DEFAULT_CHAT_MODEL) to its catalog
    provider and returns an already-instrumented provider bound to
    call_type=chat — the only kind of provider this module hands out for
    chat. Still the sole construction path — see catalog.resolve().
    """
    # Imported lazily for the same reason settings is: app.schemas pulls in
    # app.models -> app.db -> app.core.config, and this __init__ runs as a
    # side effect of app.core.config importing Provider from
    # app.providers.base — a module-level import here would be circular.
    from app.core.config import settings
    from app.core.observability import get_recorder
    from app.providers.catalog import resolve
    from app.schemas import CallType

    resolved_model = model or settings.DEFAULT_CHAT_MODEL
    entry = resolve(resolved_model)
    if entry is None:
        raise ValueError(f"No available catalog entry for model {resolved_model!r}")

    return LoggingChatProvider(_inner(entry.provider), get_recorder(), call_type=CallType.CHAT)


def get_title_provider() -> ChatProvider:
    """Titling's provider, bound to call_type=title (spec 008). Always
    settings.PROVIDER — titling does not participate in per-message model
    selection (spec 020 FR9); untouched by the catalog.
    """
    from app.core.config import settings
    from app.core.observability import get_recorder
    from app.schemas import CallType

    return LoggingChatProvider(_inner(settings.PROVIDER), get_recorder(), call_type=CallType.TITLE)
