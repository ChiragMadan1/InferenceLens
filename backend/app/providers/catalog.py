from dataclasses import dataclass

from app.providers.base import Provider


@dataclass(frozen=True)
class ModelCatalogEntry:
    provider: Provider
    display_name: str


# Ordered model id -> catalog entry. Adding a model is a one-line edit here
# (plus a price-map entry in app.core.pricing) — the catalog is deliberately
# hardcoded, not a DB table or settings list (spec 020).
MODEL_CATALOG: dict[str, ModelCatalogEntry] = {
    "gpt-5.6-terra": ModelCatalogEntry(provider=Provider.OPENAI, display_name="GPT-5.6 Terra"),
    "claude-sonnet-5": ModelCatalogEntry(
        provider=Provider.ANTHROPIC, display_name="Claude Sonnet 5"
    ),
}


def _provider_key_configured(provider: Provider) -> bool:
    # Imported lazily: app.core.config imports Provider from
    # app.providers.base, and app.providers.base is imported by this module
    # at module load time — a module-level `from app.core.config import
    # settings` here would be circular. Same pattern as app/providers/__init__.py.
    from app.core.config import settings

    match provider:
        case Provider.OPENAI:
            return bool(settings.OPENAI_API_KEY)
        case Provider.ANTHROPIC:
            return bool(settings.ANTHROPIC_API_KEY)
    raise ValueError(f"No key-configured check for provider {provider!r}")


def available_models() -> list[tuple[str, ModelCatalogEntry]]:
    """Catalog entries whose provider has an API key configured, in catalog
    order. What GET /models offers."""
    return [
        (model_id, entry)
        for model_id, entry in MODEL_CATALOG.items()
        if _provider_key_configured(entry.provider)
    ]


def resolve(model_id: str) -> ModelCatalogEntry | None:
    """The catalog entry for model_id, or None when it is unknown or its
    provider's key is not configured — both cases the router treats as an
    invalid model (422), never a 500."""
    entry = MODEL_CATALOG.get(model_id)
    if entry is None or not _provider_key_configured(entry.provider):
        return None
    return entry
