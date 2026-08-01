"""
Pydantic request/response schemas go here, separate from the SQLAlchemy
table models in models.py so API contracts can evolve independently of
the DB schema (e.g. hiding internal fields, shaping nested responses).

Every endpoint should declare a `response_model` and, for POST/PUT/PATCH,
a request body schema — don't accept or return raw dicts.
"""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import ConversationStatus, MessageRole


class HealthResponse(BaseModel):
    status: str


class ErrorResponse(BaseModel):
    detail: str


class Page[T](BaseModel):
    items: list[T]
    total: int
    limit: int
    offset: int


class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)

    @field_validator("title")
    @classmethod
    def _blank_to_none(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class ConversationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    status: ConversationStatus
    created_at: datetime
    updated_at: datetime


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: int
    role: MessageRole
    content: str
    created_at: datetime


class MessageCreate(BaseModel):
    content: str

    @field_validator("content")
    @classmethod
    def _strip_and_require_nonblank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("content must not be empty or whitespace-only")
        return v


class ChatTurnRead(BaseModel):
    user_message: MessageRead
    assistant_message: MessageRead


class CallType(StrEnum):
    CHAT = "chat"
    TITLE = "title"


class LogStatus(StrEnum):
    SUCCESS = "success"
    ERROR = "error"
    CANCELLED = "cancelled"


class InferenceLogEventIn(BaseModel):
    """Ingestion event payload. Tolerant reader: unknown fields are dropped,
    never rejected, so a newer producer cannot break ingestion. schema_version
    is the one strict field — an unrecognized contract version is refused
    outright rather than silently mis-stored. See spec 005 for the full
    tolerant-reader-strict-version rationale.
    """

    model_config = ConfigDict(extra="ignore")

    schema_version: Literal[1]
    request_id: str = Field(min_length=1, max_length=64)
    conversation_id: int | None = None
    call_type: CallType
    model: str = Field(min_length=1, max_length=128)
    provider: str = Field(min_length=1, max_length=64)
    status: LogStatus
    latency_ms: int = Field(ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    error_type: str | None = Field(default=None, max_length=128)
    error_message: str | None = None
    time_to_first_token_ms: int | None = Field(default=None, ge=0)
    request_params: dict[str, Any] | None = None
    config_hash: str | None = Field(default=None, max_length=64)
    input_messages: list[dict[str, Any]]
    output_text: str | None = None
    provider_metadata: dict[str, Any] | None = None
    requested_at: datetime
    completed_at: datetime | None = None

    @field_validator("error_message")
    @classmethod
    def _truncate_error_message(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v[:2000]


class InferenceLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    request_id: str
    schema_version: int
    conversation_id: int | None
    call_type: str
    model: str
    provider: str
    status: str
    latency_ms: int
    input_tokens: int | None
    output_tokens: int | None
    error_type: str | None
    error_message: str | None
    time_to_first_token_ms: int | None
    cost_usd: Decimal | None
    request_params: dict[str, Any] | None
    config_hash: str | None
    input_messages: list[dict[str, Any]]
    output_text: str | None
    provider_metadata: dict[str, Any] | None
    requested_at: datetime
    completed_at: datetime | None
    created_at: datetime
