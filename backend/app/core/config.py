from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All runtime configuration. Values load from environment variables,
    falling back to `.env` in the backend/ directory, falling back to the
    defaults below. Copy `.env.example` to `.env` to override locally.
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "App"
    LOG_LEVEL: str = "INFO"

    # SQLAlchemy connection URL. SQLite by default; swap for any
    # SQLAlchemy-supported URL (e.g. postgresql+psycopg://...) per project.
    DATABASE_URL: str = "sqlite:///./app.db"

    # Comma-separated in the environment, e.g. CORS_ORIGINS=http://localhost:5173,http://localhost:3000
    CORS_ORIGINS: list[str] = ["http://localhost:5173"]

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_csv(cls, value: str | list[str]) -> str | list[str]:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
