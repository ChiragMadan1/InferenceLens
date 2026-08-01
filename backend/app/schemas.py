"""
Pydantic request/response schemas go here, separate from the SQLAlchemy
table models in models.py so API contracts can evolve independently of
the DB schema (e.g. hiding internal fields, shaping nested responses).

Every endpoint should declare a `response_model` and, for POST/PUT/PATCH,
a request body schema — don't accept or return raw dicts.
"""

import math
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import ConversationStatus, InferenceLog, MessageRole


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


class StreamChunk(BaseModel):
    delta: str


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


PREVIEW_MAX_CHARS = 500


def _input_preview(input_messages: list[dict[str, Any]] | None) -> str | None:
    """Text of the LAST user message in the rendered prompt, truncated.

    Returns None when there is no user-role entry, or when its content is not
    a plain string (a future multi-part content block, for example) — a preview
    is a convenience, never a reason to fail a list request.
    """
    for entry in reversed(input_messages or []):
        if entry.get("role") == "user":
            content = entry.get("content")
            if isinstance(content, str):
                return content[:PREVIEW_MAX_CHARS]
            return None
    return None


def _output_preview(output_text: str | None) -> str | None:
    if output_text is None:
        return None
    return output_text[:PREVIEW_MAX_CHARS]


class InferenceLogSummary(BaseModel):
    """List-view shape for an inference log. Not `from_attributes`-constructible
    on its own since input_preview/output_preview are computed, not columns —
    build it via `from_log`.
    """

    id: int
    request_id: str
    conversation_id: int | None
    call_type: CallType
    model: str
    provider: str
    status: LogStatus
    latency_ms: int
    input_tokens: int | None
    output_tokens: int | None
    time_to_first_token_ms: int | None
    cost_usd: Decimal | None
    error_type: str | None
    config_hash: str | None
    requested_at: datetime
    completed_at: datetime | None
    created_at: datetime
    input_preview: str | None
    output_preview: str | None

    @classmethod
    def from_log(cls, log: InferenceLog) -> "InferenceLogSummary":
        return cls(
            id=log.id,
            request_id=log.request_id,
            conversation_id=log.conversation_id,
            call_type=log.call_type,
            model=log.model,
            provider=log.provider,
            status=log.status,
            latency_ms=log.latency_ms,
            input_tokens=log.input_tokens,
            output_tokens=log.output_tokens,
            time_to_first_token_ms=log.time_to_first_token_ms,
            cost_usd=log.cost_usd,
            error_type=log.error_type,
            config_hash=log.config_hash,
            requested_at=log.requested_at,
            completed_at=log.completed_at,
            created_at=log.created_at,
            input_preview=_input_preview(log.input_messages),
            output_preview=_output_preview(log.output_text),
        )


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


class BucketSize(StrEnum):
    MINUTE = "minute"
    HOUR = "hour"
    DAY = "day"


class LogGroupBy(StrEnum):
    NONE = "none"
    STATUS = "status"
    MODEL = "model"
    PROVIDER = "provider"
    CALL_TYPE = "call_type"


def percentile(values: list[int], p: float) -> int | None:
    """Nearest-rank percentile. `values` must be sorted ascending.

    Nearest-rank (not linear interpolation) so the result is always a value
    that actually occurred — see spec 014's "Percentile definition".
    """
    if not values:
        return None
    k = math.ceil(p / 100 * len(values)) - 1
    return values[min(max(k, 0), len(values) - 1)]


class TimeWindow(BaseModel):
    from_: datetime = Field(alias="from")
    to: datetime

    model_config = ConfigDict(populate_by_name=True)


class LatencyStats(BaseModel):
    p50_ms: int
    p95_ms: int
    p99_ms: int
    avg_ms: int
    max_ms: int


class TokenStats(BaseModel):
    input: int
    output: int
    total: int


class LogGroupStat(BaseModel):
    key: str
    is_other: bool = False
    calls: int
    error_count: int
    error_rate: float
    latency_p95_ms: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal | None


class LogStatsRead(BaseModel):
    window: TimeWindow
    total_calls: int
    success_count: int
    error_count: int
    cancelled_count: int
    error_rate: float
    latency: LatencyStats | None
    ttft: LatencyStats | None
    tokens: TokenStats
    cost_usd: Decimal | None
    cost_coverage: float
    by_model: list[LogGroupStat]
    by_provider: list[LogGroupStat]
    by_call_type: list[LogGroupStat]
    by_status: list[LogGroupStat]


class TimeseriesPoint(BaseModel):
    t: datetime
    calls: int
    error_count: int
    cancelled_count: int
    latency_p50_ms: int | None
    latency_p95_ms: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal | None


class TimeseriesSeries(BaseModel):
    key: str
    is_other: bool = False
    points: list[TimeseriesPoint]


class LogTimeseriesRead(BaseModel):
    window: TimeWindow
    bucket: BucketSize
    group_by: LogGroupBy
    bucket_count: int
    series: list[TimeseriesSeries]
