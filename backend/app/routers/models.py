from fastapi import APIRouter

from app.core.config import settings
from app.providers.catalog import available_models
from app.schemas import ModelRead

router = APIRouter(tags=["models"])


@router.get("/models", response_model=list[ModelRead])
def list_models() -> list[ModelRead]:
    """The catalog entries available to pick from — those whose provider has
    an API key configured. No repository: the catalog is static, not a
    DB-backed resource (spec 020)."""
    return [
        ModelRead(
            id=model_id,
            provider=entry.provider,
            display_name=entry.display_name,
            is_default=model_id == settings.DEFAULT_CHAT_MODEL,
        )
        for model_id, entry in available_models()
    ]
