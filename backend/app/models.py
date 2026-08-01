from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class ConversationStatus(StrEnum):
    ACTIVE = "active"


DEFAULT_CONVERSATION_TITLE = "New conversation"


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(primary_key=True)

    title: Mapped[str] = mapped_column(
        String(200), nullable=False, server_default=DEFAULT_CONVERSATION_TITLE
    )

    status: Mapped[ConversationStatus] = mapped_column(
        SAEnum(
            ConversationStatus,
            native_enum=False,
            length=16,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=ConversationStatus.ACTIVE,
        server_default=ConversationStatus.ACTIVE.value,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)

    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )

    role: Mapped[MessageRole] = mapped_column(
        SAEnum(
            MessageRole,
            native_enum=False,
            length=16,
            create_constraint=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )

    content: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )

    conversation: Mapped["Conversation"] = relationship(back_populates="messages")

    __table_args__ = (
        Index("ix_messages_conversation_id_created_at", "conversation_id", "created_at"),
    )


class InferenceLog(Base):
    __tablename__ = "inference_logs"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Idempotency key, minted by the SDK (uuid4 hex). Unique — the 409 source.
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    # Event contract version. Only 1 is accepted in v1.
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # DELIBERATE FK EXCEPTION — plain column, no ForeignKey, not parent-validated.
    # See spec 005 "Feature-specific rules" #1. Do not "fix" this: ingestion's
    # only contract is the event payload, it must survive conversation deletion,
    # and an FK would block extracting this table into its own service later.
    conversation_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    call_type: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)

    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)

    error_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(2000), nullable=True)

    # Null until spec 012 (streaming). Column ships now on purpose.
    time_to_first_token_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Computed at ingestion from PRICE_MAP; null when the model is unknown.
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)

    request_params: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # The exact rendered payload sent to the provider — the debugging artifact.
    input_messages: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    output_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    # Timezone-aware to match specs 001/002. created_at uses a Python-side UTC
    # default, NOT server_default=func.now(): SQLite's CURRENT_TIMESTAMP is
    # second-granular and drops tzinfo, which would both skew browser-rendered
    # times and make ordering ties routine (a chat log and its title log land
    # in the same second).
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )

    __table_args__ = (
        Index("ix_inference_logs_request_id", "request_id", unique=True),
        Index("ix_inference_logs_created_at", "created_at"),
        Index("ix_inference_logs_conversation_id_created_at", "conversation_id", "created_at"),
        Index("ix_inference_logs_status_created_at", "status", "created_at"),
    )
