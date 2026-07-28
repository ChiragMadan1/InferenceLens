# 001 — Conversations

Source: `.claude/designs/inference-logging-chatbot.md` → Feature breakdown item 1.
Dependencies: none. This is the first feature implemented in the project.

## Problem statement

A user needs a container for a chat session before any message can exist. This
feature adds the `Conversation` table, its Alembic migration, the shared
pagination envelope used by every list endpoint in the project, and three
read/create endpoints.

**Explicitly out of scope for this spec:**

- Messages, the `messages` table, and anything about `Conversation.messages`
  (spec 002 adds the model, the relationship, and the listing endpoint).
- Sending a message / calling the LLM (spec 004).
- Cancellation and `POST /conversations/{id}/cancel` (spec 009).
- Auto-generated titles (spec 008). This spec only ships the default title
  `"New conversation"` and the column that 008 later overwrites.
- Update, rename, delete, archive of a conversation — **no `PATCH`, no
  `DELETE` in v1.** The `status` column ships but no endpoint changes it.
- Any frontend work (spec 010).
- Inference logging (specs 005–007). Nothing here touches logs.

## Functional requirements

- **FR1** — `POST /conversations` creates a conversation and returns it with
  `201 Created`.
- **FR2** — `ConversationCreate` has exactly one field, `title: str | None`,
  optional. When it is omitted, `null`, or blank after stripping whitespace,
  the server stores the default title `"New conversation"`.
- **FR3** — A supplied title is stored stripped of leading/trailing whitespace.
- **FR4** — Every created conversation has `status == "active"`.
- **FR5** — `created_at` and `updated_at` are set at creation time and are
  equal on a freshly created row.
- **FR6** — `GET /conversations` returns a `Page[ConversationRead]` ordered by
  `updated_at DESC`, ties broken by `id DESC`.
- **FR7** — `GET /conversations` accepts `limit` (default 20, `ge=1`, `le=100`)
  and `offset` (default 0, `ge=0`) query params; out-of-range values are
  rejected by FastAPI with `422`.
- **FR8** — The `Page` envelope reports `total` as the count of **all**
  conversations matching the query, not the count of items on the current page,
  and echoes back the effective `limit` and `offset`.
- **FR9** — With zero conversations, or with an `offset` beyond the end of the
  result set, `GET /conversations` returns `200` with `items: []` and a correct
  `total`. It never returns `404`.
- **FR10** — `GET /conversations/{conversation_id}` returns a single
  `ConversationRead`, or `404` when no conversation with that id exists.
- **FR11** — `ConversationRead` exposes exactly `id, title, status, created_at,
  updated_at`. No derived fields (see "Feature-specific rules").
- **FR12** — The generic `Page[T]` envelope is defined once in
  `app/schemas.py` by this spec. Specs 002 and 007 import and parameterise it;
  they do not redefine it.

## Non-functional requirements

- **Deterministic pagination ordering.** Ordering must include the `id`
  tie-break so that two rows sharing an `updated_at` value cannot appear on two
  pages or vanish between them.
- **Two queries per list request** (one `COUNT(*)`, one windowed `SELECT`).
  Accepted: exact `total` is worth the second query at this scale.
- **No new dependencies.** Everything here uses FastAPI, SQLAlchemy 2.0,
  Pydantic v2, and Alembic, all already in `pyproject.toml`. No `uv add`.
- Deliberately **not** added, per CLAUDE.md "Out of scope by default" — call
  these out because a "list endpoint" invites all of them:
  - **No authentication/authorization.** Conversations are globally visible;
    there is no `user_id` column (design doc: deferred until auth exists).
  - **No rate limiting** on create.
  - **No caching layer** and no `ETag`/`Cache-Control` headers on the list.
  - **No realtime.** The list is refresh-based; an auto-title written by spec
    008 surfaces on the next manual `GET /conversations`. No polling, no
    websockets.

## Data model

New model in `backend/app/models.py`. Nothing else in the file changes.

```python
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import DateTime, Enum as SAEnum, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ConversationStatus(StrEnum):
    ACTIVE = "active"


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(primary_key=True)

    title: Mapped[str] = mapped_column(
        String(200), nullable=False, server_default="New conversation"
    )

    status: Mapped[ConversationStatus] = mapped_column(
        SAEnum(ConversationStatus, native_enum=False, length=16, values_callable=lambda e: [m.value for m in e]),
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
```

Field-by-field, per CLAUDE.md "Things to always clarify":

| field | required | default | nullable | index |
|---|---|---|---|---|
| `id` | auto | autoincrement | no | PK |
| `title` | required at DB level, optional in the API | `"New conversation"` (applied by the router; `server_default` mirrors it) | no | no |
| `status` | required | `"active"` | no | no |
| `created_at` | required | now (UTC) | no | no |
| `updated_at` | required | now (UTC) | no | **no** — see below |

**No index on `updated_at` in v1.** The list is ordered by it, but at
single-user demo volume a sort over a few hundred rows is free. Adding the
index later is an additive migration. State this rather than pre-optimising.

**Enum storage:** `native_enum=False` renders as `VARCHAR(16)` plus a `CHECK`
constraint — a database-level invariant (CLAUDE.md prefers those) that works on
SQLite. Tradeoff: adding an enum value later requires rewriting the CHECK
constraint, which SQLite needs a batch migration for; that is acceptable because
v1 has exactly one value.

**Timestamps:** both a Python-side `default` and a `server_default` are set.
The Python default wins on ORM inserts and gives microsecond precision (SQLite's
`CURRENT_TIMESTAMP` is only second-granular, which would make ordering ties
common); `server_default` is the DB-level fallback for raw/migration inserts.
Store UTC by convention. Known caveat, not a bug to fix here: SQLite discards
the offset, so datetimes read back are naive — treat them as UTC.

**No `onupdate=func.now()` on `updated_at`.** It is set explicitly by spec 004
when a message is added. Reason: an unrelated `UPDATE` (e.g. spec 008 writing an
auto-generated title) must **not** count as user activity and reorder the list.

**Relationships:** none in this spec. Spec 002 adds
`Conversation.messages` alongside the `Message` model.

**Cascade on delete:** v1 has **no delete endpoint**, so nothing cascades today.
Recorded intent for when one is added (design doc "Cascade behavior"): messages
cascade with their conversation (`ondelete="CASCADE"` on the FK, declared by
spec 002); inference logs deliberately survive, because `inference_logs.conversation_id`
is a plain column with no FK.

### Migration

This is the **first** revision in the project — `backend/alembic/versions/` is
empty, so the generated file will have `down_revision = None`.

```
make db-revision message="add conversations table"
make db-upgrade
```

Read the generated file before upgrading (CLAUDE.md "Database migrations" step
3). Confirm it contains: `op.create_table("conversations", ...)` with the
`CHECK` constraint for `status`, both `server_default`s present, and a
`downgrade()` that drops the table.

## API contracts

All three endpoints live in **`backend/app/routers/conversations.py`**
(new file), on a router declared as
`APIRouter(prefix="/conversations", tags=["conversations"])` and registered in
`backend/app/main.py`.

Schemas added to `backend/app/schemas.py`:

```python
from typing import Generic, TypeVar
from pydantic import BaseModel, ConfigDict, field_validator

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class ConversationCreate(BaseModel):
    title: str | None = None

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
    status: ConversationStatus   # serialises as the string "active"
    created_at: datetime
    updated_at: datetime
```

`ConversationCreate.title` also carries `Field(default=None, max_length=200)` so
an over-long title is a `422` rather than a DB truncation/error.

### `POST /conversations`

| | |
|---|---|
| Request body | `ConversationCreate` |
| `response_model` | `ConversationRead` |
| `status_code` | `201` |
| Query params | none |

Behaviour: build a `Conversation` with `title = payload.title or "New conversation"`,
`status = ConversationStatus.ACTIVE`; add, commit, refresh, return.

| status | when |
|---|---|
| `201` | created |
| `422` | body is not an object, `title` is not a string, or `title` exceeds 200 chars |

### `GET /conversations`

| | |
|---|---|
| Request body | none |
| `response_model` | `Page[ConversationRead]` |
| `status_code` | `200` |

Query params, declared with `Query(...)` so FastAPI validates them:

| param | type | default | bounds |
|---|---|---|---|
| `limit` | `int` | `20` | `ge=1, le=100` |
| `offset` | `int` | `0` | `ge=0` |

Behaviour: `total = db.scalar(select(func.count()).select_from(Conversation))`,
then `select(Conversation).order_by(Conversation.updated_at.desc(), Conversation.id.desc()).limit(limit).offset(offset)`.
Return `Page(items=..., total=total, limit=limit, offset=offset)`.

| status | when |
|---|---|
| `200` | always, including zero results |
| `422` | `limit < 1`, `limit > 100`, `offset < 0`, or a non-integer value |

### `GET /conversations/{conversation_id}`

| | |
|---|---|
| Path param | `conversation_id: int` |
| Request body | none |
| `response_model` | `ConversationRead` |
| `status_code` | `200` |

| status | when |
|---|---|
| `200` | found |
| `404` | no conversation with that id — `{"detail": "Conversation not found"}` |
| `422` | `conversation_id` is not an integer (FastAPI path coercion) |

Raise `HTTPException(status_code=404, detail="Conversation not found")`. Use
this exact detail string; specs 002, 004 and 009 reuse it for the same
condition.

### Router registration

In `backend/app/main.py`, replace the commented placeholder with:

```python
from app.routers import conversations
...
app.include_router(conversations.router)
```

## Constraints

Locked in — do not re-decide:

- **CLAUDE.md:** schema changes via Alembic only (no `Base.metadata.create_all()`
  outside `tests/conftest.py`); no raw dicts across the API boundary — every
  endpoint declares a `response_model`; no exception swallowing; no auth, rate
  limiting, caching or realtime; `make lint` before the change is done; routers
  are flat (`app/routers/conversations.py`, **not** `api/v1/...`).
- **Design doc:** pagination on all list endpoints, overriding the project's
  ~1k-row default heuristic; conversations ordered by last activity;
  `status` enum exists for future archive/soft-delete but no endpoint sets it;
  no `user_id` anywhere until auth exists; no delete endpoint in v1.
- **Decisions file:** `ConversationCreate` has one optional field;
  `ConversationRead` has no `message_count`; `Page[T]` is defined here and only
  here; `limit` default 20 / max 100, `offset` default 0; ordering
  `updated_at DESC`; schema names mirror the design doc's API table exactly.
- No new packages. No changes to `db.py`, `config.py`, `errors.py`,
  `conftest.py`, or the Makefile.

## Error handling and edge cases

| # | Case | Response |
|---|---|---|
| 1 | `GET /conversations/{id}` for an id that does not exist | `404`, `{"detail": "Conversation not found"}` |
| 2 | `GET /conversations/abc` (non-integer path param) | `422`, FastAPI validation body |
| 3 | No conversations exist at all | `200`, `{"items": [], "total": 0, "limit": 20, "offset": 0}` — **not** `404`. An empty collection is a valid collection; only a missing *single resource* is a 404. |
| 4 | `offset` past the end (e.g. `offset=500` with 3 rows) | `200`, `items: []`, `total: 3`. Again not a `404` — the client uses `total` to detect it overshot. |
| 5 | `limit=0` or `limit=101` or `offset=-1` | `422` from FastAPI's `Query` bounds. No manual clamping in the router — do not silently coerce out-of-range values, the caller must learn. |
| 6 | `limit=abc` | `422` |
| 7 | `POST` with no body / `{}` / `{"title": null}` | `201`, title `"New conversation"` |
| 8 | `POST` with `{"title": "   "}` | `201`, title `"New conversation"` (blank strips to nothing → treated as omitted). Deliberate: the field is optional, so blank means "no preference", not "invalid". |
| 9 | `POST` with a 300-char title | `422` (`max_length=200`) |
| 10 | Two concurrent `POST /conversations` with the same title | Both succeed with distinct ids. Titles are **not** unique — conversations are not identified by title. No `IntegrityError`, no `409`. |
| 11 | A row's `updated_at` changes (spec 004) between two page requests | The row moves in the ordering; a client paging `offset=0,20,40…` can see a row twice or miss one. **Accepted tradeoff of offset pagination on a mutable sort key.** Not fixed in v1; the fix is keyset/cursor pagination on `(updated_at, id)`, which the `id` tie-break already makes possible later. |
| 12 | Any `IntegrityError` reaching the handler | `409` via the existing central handler in `app/core/errors.py`. No router-level `try/except` — this feature has no unique constraint that can realistically fire. |

No `except` block is introduced anywhere in this feature. There is nothing to
catch that the central handler does not already cover.

## Acceptance criteria

Each becomes a pytest case using the `client` fixture from
`backend/tests/conftest.py` (written **only** by the `generate-tests` skill).

- [ ] `POST /conversations` with `{}` → `201`; body has `title == "New conversation"`,
      `status == "active"`, integer `id`, and `created_at == updated_at`.
- [ ] `POST /conversations` with `{"title": "Trip planning"}` → `201`, title
      `"Trip planning"`.
- [ ] `POST /conversations` with `{"title": "  padded  "}` → `201`, title
      `"padded"`.
- [ ] `POST /conversations` with `{"title": "   "}` → `201`, title
      `"New conversation"`.
- [ ] `POST /conversations` with `{"title": "x" * 201}` → `422`.
- [ ] `GET /conversations` on an empty DB → `200`,
      `{"items": [], "total": 0, "limit": 20, "offset": 0}`.
- [ ] Create 3 conversations, `GET /conversations` → `200`, `total == 3`,
      `len(items) == 3`, and ids are in descending `updated_at`/`id` order
      (newest first).
- [ ] Create 3, `GET /conversations?limit=2&offset=0` → 2 items, `total == 3`,
      `limit == 2`, `offset == 0`; `?limit=2&offset=2` → 1 item, `total == 3`.
- [ ] `GET /conversations?offset=99` with 3 rows → `200`, `items == []`,
      `total == 3`.
- [ ] `GET /conversations?limit=0` → `422`.
- [ ] `GET /conversations?limit=101` → `422`.
- [ ] `GET /conversations?offset=-1` → `422`.
- [ ] `GET /conversations/{id}` for a created conversation → `200`, matching
      `id` and `title`.
- [ ] `GET /conversations/999999` → `404`, `detail == "Conversation not found"`.
- [ ] `ConversationRead` body keys are exactly
      `{id, title, status, created_at, updated_at}` — assert no `message_count`
      or other derived key leaked in.
- [ ] `make lint` passes.

## Files to be changed

| file | purpose |
|---|---|
| `backend/app/models.py` | Add `ConversationStatus` enum and the `Conversation` model (replacing the placeholder docstring content as needed). |
| `backend/alembic/versions/<rev>_add_conversations_table.py` | Generated by `make db-revision message="add conversations table"`; first revision, `down_revision = None`. Read it before `make db-upgrade`. |
| `backend/app/schemas.py` | Add `T`/`Page[T]` (shared, defined once), `ConversationCreate`, `ConversationRead`. |
| `backend/app/routers/conversations.py` | **New.** Router with `POST /conversations`, `GET /conversations`, `GET /conversations/{conversation_id}`. |
| `backend/app/routers/__init__.py` | Create if absent so `app.routers` is a package. |
| `backend/app/main.py` | Import and `include_router(conversations.router)`; drop the commented placeholder. |
| `backend/tests/test_conversations.py` | Tests for the acceptance criteria above — **created only via the `generate-tests` skill, when the user invokes it.** Not part of implementing this spec. |

## Feature-specific rules

- **No derived or denormalized fields. Deliberate.** `ConversationRead` carries
  no `message_count`, no `last_message_at`, no token totals. Rationale: a count
  column needs write-path maintenance on every message insert and can drift; a
  live `COUNT(*)` per row turns the list into an N+1. Neither is justified when
  no consumer asks for it — the frontend (spec 010) shows title and
  `updated_at` only. If a count is ever needed, compute it live in a single
  grouped query, and only then consider denormalising. This answers CLAUDE.md's
  "denormalized or computed live?" question for this feature: **neither, the
  value does not exist.**
- **`updated_at` is the activity clock, not the row-modified clock.** Only a new
  message bumps it (spec 004). Spec 008's title write must leave it alone.
- **`status` is write-once at creation.** No endpoint in v1 reads or filters on
  it. Do not add a `?status=` filter "for symmetry".
- **`Page[T]` is shared infrastructure, not conversation-specific.** Keep it
  free of any conversation field, and do not add `has_next`/`page_number`
  helpers — specs 002 and 007 depend on the exact four-field shape in the
  decisions file.
- **The 404 detail string is a cross-spec contract:** `"Conversation not found"`.
- Everything else follows CLAUDE.md; nothing in it is overridden here.

## Open questions

None blocking. Everything this feature needs was settled by the design doc and
the clarification interview. Two items are decided-with-rationale rather than
open, recorded so a reviewer can object cheaply:

- **`title` max length of 200 chars** is not stated in the design doc; assumed
  200 as a sane bound so `String(200)` has a matching `422`. Confirm before
  build if titles should be unbounded `Text`.
- **Blank title treated as omitted** rather than `422`. Confirm before build if
  a blank title should instead be rejected — note this differs on purpose from
  spec 004's `MessageCreate.content`, where blank **is** a `422`, because
  message content is required and title is not.
