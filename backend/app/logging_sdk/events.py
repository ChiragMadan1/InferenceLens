import hashlib
import json
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel


class LogStatus(StrEnum):
    SUCCESS = "success"
    ERROR = "error"
    CANCELLED = "cancelled"


class InferenceLogEvent(BaseModel):
    """The sole shared surface between producer and consumer. Mirrors the
    host's ingestion payload schema field-for-field; kept in sync via a
    round-trip test, not a shared import.
    """

    schema_version: int = 1
    request_id: str
    conversation_id: int | None = None
    call_type: str
    model: str
    provider: str
    status: LogStatus
    latency_ms: int
    input_tokens: int | None = None
    output_tokens: int | None = None
    error_type: str | None = None
    error_message: str | None = None
    time_to_first_token_ms: int | None = None
    request_params: dict[str, Any] | None = None
    config_hash: str | None = None
    input_messages: list[dict[str, Any]]
    output_text: str | None = None
    provider_metadata: dict[str, Any] | None = None
    requested_at: datetime
    completed_at: datetime | None = None


class EventProcessor(Protocol):
    def __call__(self, event: InferenceLogEvent) -> InferenceLogEvent: ...


# Applied in order, immediately before publish. v1 registers NONE.
# This is the documented PII-redaction extension point. Do not build a
# registry or plugin system around it — it is a list, and it is empty.
EVENT_PROCESSORS: list[EventProcessor] = []


def config_hash(
    provider: str,
    model: str,
    system_prompt: str,
    request_params: dict[str, Any],
) -> str:
    """Stable 16-hex-char identity for a (provider, model, prompt, params) tuple.

    Groups calls made with an identical configuration so a later query can ask
    "did the new prompt version get slower or costlier?".
    """
    payload = json.dumps(
        {
            "provider": provider,
            "model": model,
            "system_prompt": system_prompt,
            "request_params": request_params,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
