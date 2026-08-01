from app.providers.base import (
    ChatProvider,
    Provider,
    ProviderError,
    ProviderMessage,
    ProviderResult,
)
from app.providers.openai import OpenAIProvider

__all__ = [
    "ChatProvider",
    "Provider",
    "ProviderError",
    "ProviderMessage",
    "ProviderResult",
    "OpenAIProvider",
    "get_chat_provider",
]

_chat_provider: ChatProvider | None = None


def _build(provider: Provider) -> ChatProvider:
    # Imported lazily: app.core.config imports Provider from app.providers.base,
    # and importing that submodule runs this __init__ first — a module-level
    # `from app.core.config import settings` here would be circular.
    from app.core.config import settings

    match provider:
        case Provider.OPENAI:
            return OpenAIProvider(
                api_key=settings.OPENAI_API_KEY,
                timeout_seconds=settings.PROVIDER_TIMEOUT_SECONDS,
            )
    raise ValueError(f"No adapter registered for provider {provider!r}")


def get_chat_provider() -> ChatProvider:
    """FastAPI dependency. Returns the process-wide singleton client, built
    once on first use and reused for every call after that — one AsyncOpenAI
    connection pool per process, same idea as app.db's single `engine`.
    """
    global _chat_provider
    if _chat_provider is None:
        from app.core.config import settings

        _chat_provider = _build(settings.PROVIDER)
    return _chat_provider
