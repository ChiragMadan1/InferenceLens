"""
Pydantic request/response schemas go here, separate from the SQLAlchemy
table models in models.py so API contracts can evolve independently of
the DB schema (e.g. hiding internal fields, shaping nested responses).

Every endpoint should declare a `response_model` and, for POST/PUT/PATCH,
a request body schema — don't accept or return raw dicts.
"""

from datetime import datetime

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
