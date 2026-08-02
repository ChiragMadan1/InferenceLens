from enum import StrEnum
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.providers.base import Provider


class EventTransport(StrEnum):
    HTTP = "http"
    KAFKA = "kafka"


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

    # Which ChatProvider adapter get_chat_provider() builds.
    PROVIDER: Provider = Provider.OPENAI

    # Required — no default. Missing at startup means the app does not boot.
    OPENAI_API_KEY: str

    OPENAI_MODEL: str = "gpt-5.6-terra"
    OPENAI_TITLE_MODEL: str = "gpt-5.6-luna"
    SYSTEM_PROMPT: str = "You are a helpful, concise assistant."
    MAX_TOKENS: int = 1024

    # Recorded in request_params/config_hash; never sent to the OpenAI API —
    # the GPT-5 family rejects any non-default temperature with a 400.
    TEMPERATURE: float = 1.0

    PROVIDER_TIMEOUT_SECONDS: int = 60

    # Where the logging SDK's HTTPEventPublisher POSTs inference log events.
    # Points at this same app in v1; becomes a separate host once ingestion
    # is split out.
    INGEST_URL: str = "http://localhost:8000/ingest/logs"

    # httpx timeout for the ingest POST. Bounds how long a fire-and-forget
    # background publish task can hang on a wedged ingestion endpoint.
    INGEST_TIMEOUT_SECONDS: float = 5.0

    # Transport the logging SDK publishes InferenceLogEvents over. "http"
    # (default) POSTs to INGEST_URL, exactly as today. "kafka" produces to
    # KAFKA_TOPIC instead; a consumer (in-app or `python -m
    # app.ingestion.consumer`) writes the topic into inference_logs. See
    # spec 017.
    EVENT_TRANSPORT: EventTransport = EventTransport.HTTP

    KAFKA_BOOTSTRAP_SERVERS: str = "localhost:9092"
    KAFKA_TOPIC: str = "inference-logs"
    KAFKA_CONSUMER_GROUP: str = "ingestion"
    KAFKA_CONSUMER_MAX_RECORDS: int = 100
    KAFKA_CONSUMER_BATCH_TIMEOUT_MS: int = 1000

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
