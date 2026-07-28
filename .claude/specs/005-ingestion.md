# 005 — Inference Log Ingestion

## Problem statement

The chatbot makes provider calls that are expensive, slow, and opaque. Nothing
currently records what was sent, what came back, how long it took, how many
tokens it burned, or what it cost. Without a durable, queryable record there is
no debugging ("what exactly did the model see on request X?"), no cost
attribution, no latency/error monitoring, and no eval-export path.

This spec builds the **storage and ingestion half** of that system: the
`InferenceLog` table, a versioned static price map, and a single SDK-facing
endpoint `POST /ingest/logs` that validates an event payload, computes cost, and
stores one immutable row per provider call.

Ingestion is architecturally isolated by design. Its **only** contract is the
versioned event payload — it imports nothing from the chat feature, has no
foreign keys into the chat tables, and does not read them. That isolation is
what makes it splittable into its own service when a Kafka consumer replaces the
HTTP transport (design doc: "Is SQL the right store? Is event-driven the right
shape?"). Spec 005 is therefore **independent of specs 001–004** and must not be
coupled to them.

Producing the events is spec 006's job. Reading them back is spec 007's.

## Functional requirements

1. **FR1** — A new table `inference_logs` exists, created by an Alembic
   migration, with every column listed in the Data model section below.
2. **FR2** — `POST /ingest/logs` accepts a JSON body validated against the
   Pydantic schema `InferenceLogEventIn` and, on success, persists exactly one
   `InferenceLog` row and returns it as `InferenceLogRead` with HTTP 201.
3. **FR3** — `InferenceLogEventIn.schema_version` must be exactly `1`. Any other
   value is rejected with HTTP 422.
4. **FR4** — `InferenceLogEventIn` is a **tolerant reader**: unknown fields in
   the payload are silently dropped (`model_config = ConfigDict(extra="ignore")`),
   never rejected, so a newer producer cannot break ingestion.
5. **FR5** — `request_id` has a database-level unique constraint. A second
   ingest of the same `request_id` returns HTTP 409 via the existing central
   `IntegrityError` handler in `app/core/errors.py`. No router-level try/except.
6. **FR6** — `conversation_id` is a plain nullable integer column with **no
   foreign key** and **no parent-existence validation**. Ingestion accepts any
   value, including one that matches no conversation, and including `null`.
7. **FR7** — `cost_usd` is computed **at ingestion** by
   `app.core.pricing.compute_cost(model, input_tokens, output_tokens)` and stored
   on the row. It is never recomputed at read time.
8. **FR8** — `compute_cost` returns `None` when the model is not present in
   `PRICE_MAP`, or when either token count is `None`. A model unknown to the
   price map yields a stored `cost_usd` of `NULL` and a **successful** 201 — never
   a rejection.
9. **FR9** — `PRICE_MAP` is a module-level dict in `app/core/pricing.py` mapping
   model id → `(input_usd_per_mtok, output_usd_per_mtok)` as `Decimal`, seeded
   with the chat model and the title model. A `PRICE_MAP_VERSION` string constant
   sits alongside it and is bumped whenever a rate changes.
10. **FR10** — `time_to_first_token_ms` is accepted from the payload and stored,
    but every v1 producer sends `null`. The column ships now so that spec 012
    (streaming) is a data backfill, not a schema migration.
11. **FR11** — `input_tokens`, `output_tokens`, `output_text`, `error_type`,
    `error_message`, `completed_at`, `cost_usd`, `request_params`, `config_hash`,
    `provider_metadata`, and `time_to_first_token_ms` are all nullable and stay
    `NULL` when the event omits them (the error and cancelled paths).
12. **FR12** — The following indexes exist on `inference_logs`: unique on
    `request_id`; `(created_at)`; `(conversation_id, created_at)`;
    `(status, created_at)`.
13. **FR13** — `error_message` longer than 2000 characters is **truncated** to
    2000 at ingestion, not rejected — losing the log because a provider returned
    a verbose error is worse than losing the tail of the message.

## Non-functional requirements

- **Isolation.** `app/routers/ingest.py`, `app/core/pricing.py`, and the
  `InferenceLog` model import nothing from the conversations/messages/chat code.
  The event payload is the entire contract.
- **Immutability.** Logs are append-only. There is no update or delete endpoint
  in v1. `cost_usd` is frozen at the price in effect when the event was ingested;
  later `PRICE_MAP` edits do not rewrite history.
- **Exact money.** `cost_usd` is `Numeric(12, 6)`, computed with `Decimal`. No
  float arithmetic anywhere in the cost path.
- **Write cost.** One INSERT per event. Acceptable at demo volume; batching is
  the future Kafka consumer's concern, explicitly out of scope here.
- **Pagination.** `POST /ingest/logs` is a single-row create, so pagination does
  not apply. The list endpoint is spec 007's, and it is paginated.

## Data model

New model in `backend/app/models.py`. `LogStatus` and `CallType` are `StrEnum`s
defined in `backend/app/schemas.py` (they exist for request/response validation);
the columns themselves are plain `String` — validation happens at the Pydantic
boundary, and keeping the DB side a plain string avoids a SQLite enum migration
every time a new `call_type` is added. State this tradeoff in the PR.

```python
# app/schemas.py
class CallType(StrEnum):
    CHAT = "chat"
    TITLE = "title"


class LogStatus(StrEnum):
    SUCCESS = "success"
    ERROR = "error"
    CANCELLED = "cancelled"
```

```python
# app/models.py
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, Index, Integer, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class InferenceLog(Base):
    __tablename__ = "inference_logs"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Idempotency key, minted by the SDK (uuid4 hex). Unique — the 409 source.
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    # Event contract version. Only 1 is accepted in v1.
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # DELIBERATE FK EXCEPTION — plain column, no ForeignKey, not parent-validated.
    # See "Feature-specific rules". Do not "fix" this.
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

    # Timezone-aware to match specs 001/002 — see "Feature-specific rules".
    # created_at uses a Python-side UTC default, NOT server_default=func.now():
    # SQLite's CURRENT_TIMESTAMP is second-granular and drops tzinfo, which
    # would both skew browser-rendered times and make ordering ties routine
    # (a chat log and its title log land in the same second).
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
```

### Index justification (design doc query patterns Q1–Q6)

| Index | Serves | Why |
|---|---|---|
| `request_id` (unique) | **Q4** — inspect one request, full content | Point lookup by `request_id` is spec 007's detail endpoint; the same constraint is the idempotency key that produces the 409 on duplicate delivery |
| `(created_at)` | **Q1** — recent activity tail | `GET /logs` default ordering is `created_at DESC`; without this every list is a full scan + sort |
| `(conversation_id, created_at)` | **Q2** — trace a conversation | `GET /logs?conversation_id=42` filters then orders; the composite covers both halves |
| `(status, created_at)` | **Q3** — error triage | `GET /logs?status=error` ordered by recency; the on-call query |

Q5 (aggregates: p95 latency, tokens/day, error rate per model) is served by
scans — acceptable at demo row counts, and the design doc names ClickHouse or
rollups as the real answer. Q6 (eval export) is an offline full-table read. No
index is added for either.

### Derived values — computed at read, not stored

Per CLAUDE.md's derived-values rule: **output throughput (tokens/sec) is NOT a
column.** It is `output_tokens / (completed_at - requested_at)`, derived from
stored raw measurements whenever someone wants it. Storing it would let a
denormalized rate drift from its inputs, and it becomes more precise for free
once `time_to_first_token_ms` is populated in spec 012.

`cost_usd` is the deliberate exception in the other direction: it **is** stored,
because it is a function of a *versioned external price table* rather than of the
row's own columns. Deriving it at read would silently rewrite history whenever
`PRICE_MAP` changed. Immutable cost is the industry practice the design doc
adopts.

### Migration

```
make db-revision message="add inference_logs table"
make db-upgrade
```

Generated file: `backend/alembic/versions/<rev>_add_inference_logs_table.py`.
`down_revision` is whatever head is at the time (spec 005 is independent of
001–004, so it may be the first migration or may follow the conversations and
messages migrations — do not hand-edit the chain).

Read the generated migration before applying it. Specifically verify:

- `cost_usd` is `sa.Numeric(precision=12, scale=6)`, not `sa.Float`.
- All four indexes were emitted, and the `request_id` one has `unique=True`.
- `created_at` carries `server_default=sa.func.now()` (autogenerate sometimes
  drops server defaults).
- `input_messages` is `sa.JSON()` and `nullable=False`.

### Pricing module

`backend/app/core/pricing.py`:

```python
from decimal import Decimal

# Bump whenever any rate below changes. Stored costs are NOT backfilled —
# a log's cost_usd reflects the map version in effect when it was ingested.
PRICE_MAP_VERSION = "2026-07-28"

# model id -> (input USD per million tokens, output USD per million tokens)
PRICE_MAP: dict[str, tuple[Decimal, Decimal]] = {
    "claude-opus-5": (Decimal("5.00"), Decimal("25.00")),
    "claude-haiku-4-5-20251001": (Decimal("1.00"), Decimal("5.00")),
}

_MILLION = Decimal("1000000")


def compute_cost(
    model: str, input_tokens: int | None, output_tokens: int | None
) -> Decimal | None:
    """Cost in USD for one provider call, or None when it cannot be computed.

    Returns None (never raises) when the model is absent from PRICE_MAP or
    either token count is missing — an unpriced log is still a valid log.
    """
    rates = PRICE_MAP.get(model)
    if rates is None or input_tokens is None or output_tokens is None:
        return None
    input_rate, output_rate = rates
    return (
        Decimal(input_tokens) * input_rate + Decimal(output_tokens) * output_rate
    ) / _MILLION
```

The two seeded models mirror spec 003's settings defaults: `ANTHROPIC_MODEL`
(`claude-opus-5`) and `ANTHROPIC_TITLE_MODEL` (`claude-haiku-4-5-20251001`).
The map is hand-maintained in git; automated price sync is out of scope
(design doc open question).

## API contracts

### `POST /ingest/logs`

| | |
|---|---|
| Method / path | `POST /ingest/logs` |
| Router | `backend/app/routers/ingest.py`, `APIRouter(prefix="/ingest", tags=["ingest"])` |
| Request schema | `InferenceLogEventIn` |
| `response_model` | `InferenceLogRead` |
| Success status | `201 Created` (`status_code=status.HTTP_201_CREATED`) |
| Query params | none |
| Auth | none (project default; the endpoint is internal-only in v1) |

**Request schema — `InferenceLogEventIn`** (in `app/schemas.py`):

| Field | Type | Required | Constraints |
|---|---|---|---|
| `schema_version` | `Literal[1]` | yes | Anything but `1` → 422 |
| `request_id` | `str` | yes | `min_length=1, max_length=64` |
| `conversation_id` | `int \| None` | no (default `None`) | **not validated against any table** |
| `call_type` | `CallType` | yes | `chat` \| `title`; other → 422 |
| `model` | `str` | yes | `min_length=1, max_length=128` |
| `provider` | `str` | yes | `min_length=1, max_length=64` |
| `status` | `LogStatus` | yes | `success` \| `error` \| `cancelled`; other → 422 |
| `latency_ms` | `int` | yes | `ge=0` |
| `input_tokens` | `int \| None` | no | `ge=0` when present |
| `output_tokens` | `int \| None` | no | `ge=0` when present |
| `error_type` | `str \| None` | no | `max_length=128` |
| `error_message` | `str \| None` | no | truncated to 2000 chars by a `field_validator`, not rejected |
| `time_to_first_token_ms` | `int \| None` | no | `ge=0`; always `None` from v1 producers |
| `request_params` | `dict[str, Any] \| None` | no | |
| `config_hash` | `str \| None` | no | `max_length=64` |
| `input_messages` | `list[dict[str, Any]]` | yes | may be empty list |
| `output_text` | `str \| None` | no | |
| `provider_metadata` | `dict[str, Any] \| None` | no | |
| `requested_at` | `datetime` | yes | |
| `completed_at` | `datetime \| None` | no | |

`model_config = ConfigDict(extra="ignore")`.

**`cost_usd` is deliberately NOT a request field.** The producer never sends a
price; ingestion is the only thing that decides cost.

**Response schema — `InferenceLogRead`** (in `app/schemas.py`,
`model_config = ConfigDict(from_attributes=True)`): every column on the model —
`id`, `request_id`, `schema_version`, `conversation_id`, `call_type`, `model`,
`provider`, `status`, `latency_ms`, `input_tokens`, `output_tokens`,
`error_type`, `error_message`, `time_to_first_token_ms`, `cost_usd`,
`request_params`, `config_hash`, `input_messages`, `output_text`,
`provider_metadata`, `requested_at`, `completed_at`, `created_at`.

`cost_usd` is typed `Decimal | None`. Spec 007 reuses this exact schema for its
detail endpoint — it must not define a second one.

**Status codes:**

| Code | When |
|---|---|
| `201` | Log stored; body is `InferenceLogRead` |
| `409` | `request_id` already exists (central `IntegrityError` handler) |
| `422` | Pydantic validation failure — malformed body, missing required field, wrong `schema_version`, unknown `call_type`/`status`, negative `latency_ms` |

**Handler shape** (`app/routers/ingest.py`):

```
1. Accept the validated InferenceLogEventIn.
2. cost = compute_cost(event.model, event.input_tokens, event.output_tokens)
3. Build InferenceLog(**event.model_dump(), cost_usd=cost)
4. db.add(log); db.commit(); db.refresh(log)
5. return log
```

No try/except. No parent lookup. Step 4's `IntegrityError` on a duplicate
`request_id` propagates to the registered handler and becomes a 409.

## Constraints

- **Alembic only.** No `Base.metadata.create_all()`, no raw `CREATE TABLE`. The
  migration ships in the same change as the model.
- **No new datastore.** SQLite via `DATABASE_URL`, per the single-store rule.
- **No new runtime dependency.** Everything here uses SQLAlchemy, Pydantic, and
  the stdlib `decimal`. Do not `uv add` anything for this spec.
- **No auth, no rate limiting, no caching** on `/ingest/logs` (CLAUDE.md
  out-of-scope defaults). A shared-secret header is the noted future hardening if
  the endpoint is ever exposed beyond localhost.
- **No update/delete endpoints.** Logs are append-only in v1.
- **Router is flat**: `app/routers/ingest.py`, registered in `app/main.py` with
  `app.include_router(ingest.router)`. No `api/v1/...` nesting.
- **No imports from the chat feature** in the ingestion router, the pricing
  module, or the `InferenceLog` model.
- `make lint` passes before the change is considered done.

## Error handling and edge cases

| # | Case | Response |
|---|---|---|
| 1 | Malformed payload — not JSON, missing `request_id`, `latency_ms: -5`, `input_messages` not a list | `422` with FastAPI's field-level error body. No row written. |
| 2 | `schema_version: 2` (or `0`, or `"1"` as a non-coercible value) | `422`. `Literal[1]` rejects it. Message names `schema_version`. The v1 consumer deliberately refuses to guess at a contract it does not know. |
| 3 | Unknown extra fields, e.g. `{"trace_id": "abc", ...}` from a newer producer | `201`. Field is dropped by `extra="ignore"`. **Tolerant reader — never a rejection.** |
| 4 | Duplicate `request_id` (at-least-once re-delivery) | `409` with `{"detail": "A conflicting record already exists."}` from the existing central `IntegrityError` handler. Exactly one row exists. The publisher (spec 006) treats 409 as success and does not retry. |
| 5 | `model` absent from `PRICE_MAP` (e.g. a newly released model) | `201`, row stored, `cost_usd` is `null`. Never a rejection — FR8. |
| 6 | `status: "error"` with `input_tokens`/`output_tokens`/`output_text` omitted | `201`. Those columns are `NULL`. `cost_usd` is `null` (compute_cost short-circuits on `None` tokens). `error_type` and `error_message` are populated. |
| 7 | `status: "cancelled"` with null tokens and null `output_text` | `201`, same as #6 but with no error fields. `completed_at` may be present or null. |
| 8 | `conversation_id: 99999` referencing a conversation that does not exist (or was never created) | `201`. **No 404.** This is the documented FK exception — ingestion does not know or care about the chat schema. |
| 9 | `conversation_id` omitted entirely (a hypothetical non-conversation call) | `201`, column is `NULL`. |
| 10 | `error_message` of 8000 characters | `201`, stored value truncated to the first 2000 characters. Not a 422 — the log is more valuable than the tail of the message. |
| 11 | `input_messages: []` (empty list) | `201`. An empty rendered prompt is unusual but not invalid; ingestion records what it was told. |
| 12 | Two concurrent requests with the same `request_id` | The DB unique constraint resolves the race. One gets `201`, the other `409`. No application-level check-then-act. |
| 13 | Ingestion is unreachable from the publisher | Not this spec's concern — spec 006 owns it: the chat request is unaffected, the failure is logged at ERROR with event context, and the event is lost (v1 accepts loss). Nothing here changes. |

## Acceptance criteria

Written so each bullet becomes one pytest case using the `client` fixture from
`tests/conftest.py`. **Tests are created only via the `generate-tests` skill,
when the user invokes it** — do not write them while implementing this spec.

**Model / migration**

- [ ] `InferenceLog` is importable from `app.models` and its `__tablename__` is
      `inference_logs`.
- [ ] The model exposes all 22 columns listed in the Data model section, with the
      stated nullability.
- [ ] `InferenceLog.conversation_id` has **no** `ForeignKey` in its column
      definition (assert `not InferenceLog.__table__.c.conversation_id.foreign_keys`).
- [ ] `InferenceLog.__table__.c.cost_usd.type` is a `Numeric` with
      `precision == 12` and `scale == 6`.
- [ ] All four indexes from FR12 exist on `InferenceLog.__table__.indexes`, and
      the `request_id` one has `unique is True`.
- [ ] A migration file exists under `alembic/versions/` creating
      `inference_logs`; `make db-upgrade` then `make db-downgrade` round-trips
      cleanly on a throwaway DB.

**Pricing**

- [ ] `compute_cost("claude-opus-5", 1_000_000, 1_000_000)` returns
      `Decimal("30.000000")`-equal value (5 + 25).
- [ ] `compute_cost("claude-haiku-4-5-20251001", 500_000, 100_000)` returns the
      exact `Decimal` for 0.5 + 0.5 = `Decimal("1.0")`.
- [ ] `compute_cost("some-unknown-model", 100, 100)` returns `None`.
- [ ] `compute_cost("claude-opus-5", None, 50)` returns `None`.
- [ ] `compute_cost("claude-opus-5", 0, 0)` returns `Decimal("0")`, not `None`.
- [ ] `PRICE_MAP_VERSION` is a non-empty `str`.
- [ ] Every `PRICE_MAP` value is a 2-tuple of `Decimal` (no floats).

**Endpoint — happy path**

- [ ] `POST /ingest/logs` with a minimal valid success event returns `201` and a
      body whose `request_id` matches the payload and whose `id` is an int.
- [ ] The stored row's `cost_usd` equals `compute_cost(...)` for the same inputs.
- [ ] `time_to_first_token_ms` is `null` in the response when omitted from the
      payload.
- [ ] A payload containing an unknown extra key (`"trace_id": "x"`) still returns
      `201` and the key is absent from the response.

**Endpoint — edge cases**

- [ ] `schema_version: 2` returns `422` and the error body mentions
      `schema_version`.
- [ ] Omitting `request_id` returns `422`.
- [ ] `latency_ms: -1` returns `422`.
- [ ] `call_type: "summarize"` returns `422`.
- [ ] `status: "pending"` returns `422`.
- [ ] Posting the same `request_id` twice returns `201` then `409`, and a
      subsequent count of rows with that `request_id` is exactly 1.
- [ ] An event with `model: "not-in-the-price-map"` returns `201` with
      `cost_usd` `null`.
- [ ] An event with `status: "error"`, null tokens, null `output_text`, and
      populated `error_type`/`error_message` returns `201` with `cost_usd` null.
- [ ] An event with `status: "cancelled"`, null tokens, null `output_text`
      returns `201`.
- [ ] An event with `conversation_id: 424242` (no such conversation) returns
      `201`, **not** `404`.
- [ ] An event with `conversation_id` omitted returns `201` with
      `conversation_id` null.
- [ ] An event with a 5000-character `error_message` returns `201` and the stored
      value is exactly 2000 characters.

## Files to be changed

| Path | Change | Purpose |
|---|---|---|
| `backend/app/models.py` | add | `InferenceLog` ORM model with all columns and the four indexes |
| `backend/app/schemas.py` | add | `CallType`, `LogStatus` enums; `InferenceLogEventIn` (tolerant reader) and `InferenceLogRead` |
| `backend/app/core/pricing.py` | **new** | `PRICE_MAP`, `PRICE_MAP_VERSION`, `compute_cost()` |
| `backend/app/routers/ingest.py` | **new** | `POST /ingest/logs` handler; computes cost, inserts, returns 201 |
| `backend/app/main.py` | edit | `app.include_router(ingest.router)` |
| `backend/alembic/versions/<rev>_add_inference_logs_table.py` | generated | Creates `inference_logs` + indexes. Read it before running `make db-upgrade` |
| `backend/tests/test_ingestion.py` | — | Endpoint + edge-case tests. **Created only via the `generate-tests` skill, when the user invokes it.** |
| `backend/tests/test_pricing.py` | — | `compute_cost` unit tests. **Created only via the `generate-tests` skill, when the user invokes it.** |

No frontend changes — the ingestion endpoint is SDK-facing, never called from the
browser, and gets no `src/api.ts` function.

## Feature-specific rules

### 0. Timestamps are timezone-aware, with Python-side defaults

All three datetime columns use `DateTime(timezone=True)`, and `created_at`
defaults via `default=lambda: datetime.now(UTC)` rather than
`server_default=func.now()`. This matches specs 001 and 002 — keep all three
specs in agreement. Two reasons, both load-bearing:

- **Timezone**: SQLite's `CURRENT_TIMESTAMP` yields a naive value, which
  FastAPI then serialises without a UTC offset, and the browser renders it as
  local time — a silent skew in the frontend (flagged by specs 010/011).
- **Granularity**: `CURRENT_TIMESTAMP` is second-granular. A chat log and the
  title log for the same turn routinely land in the same second, so
  `ORDER BY created_at DESC` alone is unstable across pages. Spec 007's
  `id DESC` tie-break covers the paging correctness; the finer timestamp keeps
  the ordering itself meaningful.

`requested_at` / `completed_at` arrive from the SDK in the event payload and
must be stored as sent — ingestion never re-clocks them.

### 1. The deliberate FK exception — do not "fix" this

`InferenceLog.conversation_id` is a **plain nullable `Integer` column**. It has:

- **no `ForeignKey("conversations.id")`**, and
- **no parent-existence check in the router** (no 404 path).

This is an explicit, documented exception to CLAUDE.md's *"Never let a child
record reference a nonexistent parent"* rule, confined to the ingestion boundary.
The reasons:

1. Ingestion's only contract is the event payload. It must be able to store an
   event without knowing anything about the chat schema.
2. The module is designed to be extracted into its own service behind Kafka. At
   that point the log store may not share a database with the chat tables at all
   — an FK would be a hard blocker to that split, not a nuisance.
3. Logs are immutable observability records. They must survive their subject: if
   conversation deletion is ever added, messages cascade and **logs survive,
   deliberately unlinked** (design doc, "Cascade behavior").
4. Right-to-erasure still works: the column exists precisely so logs can be
   blanked or deleted by `conversation_id` without an FK.

A reviewer or an implementer scanning for CLAUDE.md violations **will** flag this.
It is intentional. Add a code comment on the column pointing at this section so
the next person does not add the FK.

The rule is **not** relaxed anywhere else. Spec 002/004's `Message.conversation_id`
keeps its foreign key and its 404-if-missing validation.

### 2. 409 on duplicate, and what FR11 of the design doc actually guarantees

The design doc contains a contradiction: FR11 says ingestion is "idempotent on
`request_id`", while edge case 8 says a duplicate produces a 409 via the
`IntegrityError` handler. **This spec resolves it in favour of 409.**

- A duplicate `POST /ingest/logs` returns **409**, not a 200 echoing the existing
  row.
- The 409 comes from the **existing central handler** in `app/core/errors.py`.
  The router adds no try/except — CLAUDE.md explicitly says routers usually
  should not, and there is no need for a more specific message here.
- FR11's real guarantee — **no duplicate row is ever created** — still holds, and
  holds at the database level via the unique constraint, not via an
  application-level check-then-act that would race under concurrency.
- The publisher (spec 006) **treats 409 as success**: the event is already
  stored, so at-least-once delivery is safe and no retry is warranted. That is
  the property the design doc's "idempotency key" language was reaching for.

### 3. Tolerant reader, strict version

Two rules that look contradictory but are not:

- **Unknown fields are ignored.** `ConfigDict(extra="ignore")` means a producer
  deployed ahead of the consumer — which will happen the moment a broker sits in
  the middle and events published before a deploy are consumed after it — cannot
  break ingestion. Additive, backward-compatible changes do **not** bump
  `schema_version`.
- **`schema_version` must be exactly 1.** Breaking changes (rename, retype,
  remove) *do* bump the version, and a v1 consumer that cannot correctly
  interpret a v2 payload must say so loudly (422) rather than silently
  mis-storing it. When v2 exists, this becomes `Literal[1, 2]` plus a branch —
  not a wildcard.

### 4. Cost is stored, throughput is derived

State both explicitly in the PR description, because they pull in opposite
directions and each has a reason:

- `cost_usd` is **denormalized on write** because it depends on an external,
  versioned price table. Deriving at read would silently rewrite historical cost
  whenever a rate changed.
- Tokens/sec is **derived on read** from `output_tokens`, `requested_at`, and
  `completed_at` because all three inputs are on the row. Storing it would let a
  cached rate drift from its own inputs, and it gets more precise for free when
  `time_to_first_token_ms` lands in spec 012.

### 5. Ship the TTFT column now

`time_to_first_token_ms` is accepted, stored, and always `null` in v1. It is not
dead code — it is the schema-evolution mechanism the design doc calls out:
"new columns arrive nullable... no destructive rewrites of a table that is
conceptually append-only." When spec 012 (streaming) lands, populating it is a
producer change and a data backfill, with **zero migration**. Do not remove it
because nothing writes to it yet.

## Open questions

- **Price map values.** Assumed `claude-opus-5` at $5.00 / $25.00 per MTok and
  `claude-haiku-4-5-20251001` at $1.00 / $5.00 per MTok (Anthropic list pricing
  as of 2026-07-28). Confirm before build if the account is on non-list pricing;
  the numbers are one-line edits in `pricing.py` either way.
- **`error_message` truncation limit.** Assumed 2000 characters, truncate rather
  than reject. Confirm before build if a longer or shorter cap is wanted — this
  is not specified anywhere upstream.
- **`request_id` format.** Assumed an opaque string up to 64 characters, not
  validated as a UUID, so a future producer can use a different id scheme without
  a schema change. Confirm before build if strict UUID validation is preferred.
