# 002 — Messages

Source: `.claude/designs/inference-logging-chatbot.md` → Feature breakdown item 2.
Dependencies: **spec 001** (the `conversations` table and its migration must
exist first; this feature's FK and its migration's `down_revision` both point at
001).

## Problem statement

Chat turns need somewhere to live and a way to be read back. This feature adds
the `Message` table with its FK to `conversations`, the composite index that
serves both listing and spec 004's context-window query, and **one** endpoint:
`GET /conversations/{conversation_id}/messages`, paginated and chronological.

**Explicitly out of scope for this spec — read this before writing code:**

- **`POST /conversations/{conversation_id}/messages` belongs to spec 004**, not
  here. That endpoint stores the user message, builds the 10-message context
  window, calls the provider, stores the assistant reply, bumps
  `conversation.updated_at`, and translates `ProviderError` to `502`. **Do not
  half-build it here.** In particular: do **not** add `MessageCreate` to
  `app/schemas.py`, do **not** add a `ChatTurnRead`, and do **not** add a `POST`
  route stub, a `TODO`, or a `501` placeholder. This spec's router file contains
  exactly one route. Spec 004 adds the `POST` to that same file later.
- No message create, update, or delete of any kind. Messages are written only by
  spec 004 (and spec 008 writes no messages at all).
- No LLM call, no provider adapter, no `openai` dependency (spec 003).
- No inference logging (specs 005–007). A message row and a log row are
  independent by design — logs store their own denormalized copy of content and
  never reference `messages`.
- No frontend (spec 011).

## Functional requirements

- **FR1** — `GET /conversations/{conversation_id}/messages` returns
  `Page[MessageRead]` for an existing conversation.
- **FR2** — Messages are ordered `created_at ASC`, ties broken by `id ASC`
  (oldest first). `offset` counts from the oldest message.
- **FR3** — The endpoint accepts `limit` (default 20, `ge=1`, `le=100`) and
  `offset` (default 0, `ge=0`), declared with `Query(...)` so FastAPI rejects
  out-of-range values with `422`.
- **FR4** — `total` is the count of **all** messages in that conversation, not
  the page size, and is scoped to the conversation (never a global count).
- **FR5** — When the conversation does not exist, the endpoint returns `404`,
  before any message query runs.
- **FR6** — When the conversation exists but has no messages, the endpoint
  returns `200` with `items: []` and `total: 0`. This is distinct from FR5.
- **FR7** — `MessageRead` exposes exactly `id, conversation_id, role, content,
  created_at`.
- **FR8** — `role` is one of `user` | `assistant`, enforced by a database-level
  `CHECK` constraint.
- **FR9** — A message cannot exist without a parent conversation: the FK is
  declared `NOT NULL` and the API validates the parent explicitly (CLAUDE.md
  "never let a child record reference a nonexistent parent").
- **FR10** — The composite index `(conversation_id, created_at)` exists and
  serves both this listing and spec 004's "last 10 messages" query.
- **FR11** — `Page[T]` is **imported** from `app/schemas.py` where spec 001
  defined it. It is not redefined, subclassed, or shadowed here.

## Non-functional requirements

- **The `(conversation_id, created_at)` index is required, not optional.** It is
  the access path for the two hottest queries in the app: this listing and the
  per-turn context window in spec 004. (Contrast with 001, which deliberately
  ships no `updated_at` index.)
- **Two queries per list request** (scoped `COUNT(*)`, then windowed `SELECT`),
  plus one existence check for the parent — three round trips total. Accepted at
  this scale for an exact `total` and a clean `404`.
- **No new dependencies.** No `uv add`.
- Deliberately **not** added, per CLAUDE.md "Out of scope by default":
  - **No realtime.** No websockets, no SSE, no polling hints, no `Last-Event-ID`.
    Message history is refresh-based; the client re-`GET`s. (Spec 012 adds SSE
    for *streaming a generation*, which is a different thing from streaming the
    history.)
  - **No auth.** Any caller may read any conversation's messages; there is no
    ownership check because there are no users.
  - **No caching**, no `ETag`, no `If-Modified-Since` on the history.
  - **No rate limiting.**
- No full-text search over `content`. Not a v1 query pattern (design doc,
  "Inference log query patterns").

## Data model

Added to `backend/app/models.py`, below the `Conversation` model from spec 001.

```python
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import (
    DateTime, Enum as SAEnum, ForeignKey, Index, Text, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


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
        SAEnum(MessageRole, native_enum=False, length=16,
               values_callable=lambda e: [m.value for m in e]),
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
```

And the matching side is added to the **existing** `Conversation` model
(this is the only edit this spec makes to spec 001's model):

```python
    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
```

Field-by-field, per CLAUDE.md "Things to always clarify":

| field | required | default | nullable | index |
|---|---|---|---|---|
| `id` | auto | autoincrement | no | PK |
| `conversation_id` | **required** | none | no | leading column of the composite index |
| `role` | **required** | none — the writer (spec 004) always states it | no | no |
| `content` | **required** | none | no | no |
| `created_at` | required | now (UTC) | no | second column of the composite index |

Notes:

- **No `updated_at` on messages.** Messages are immutable once written; there is
  no edit endpoint in v1. Adding one later is an additive migration.
- **`content` is `Text`, not `String(n)`** — assistant replies are unbounded.
  There is no length ceiling and no truncation at this layer. Non-empty is
  enforced at the API boundary by spec 004's `MessageCreate` validator (`422`),
  not by a DB constraint; a `CHECK (length(content) > 0)` is deliberately not
  added because spec 004 owns that validation and duplicating it in two places
  invites drift.
- **Timestamps** follow spec 001's pattern exactly (Python `default` for
  microsecond precision, `server_default` as the DB-level fallback, UTC by
  convention, SQLite reads back naive). Microsecond precision matters more here
  than anywhere else: a user message and its assistant reply are written within
  the same second, and `created_at ASC` must order them correctly. The `id ASC`
  tie-break is the backstop.

### Cascade on delete

**v1 has no delete endpoint for conversations or messages, so nothing cascades
today.** The behaviour is nonetheless declared now so that adding a delete later
is one endpoint, not a schema change:

- `ondelete="CASCADE"` on the FK — the DB deletes child messages with the parent.
- `cascade="all, delete-orphan"` + `passive_deletes=True` on the relationship —
  the ORM defers to the DB rather than issuing per-row `DELETE`s.
- Inference logs are **not** affected: `inference_logs.conversation_id` (spec
  005) is a plain column with no FK, so observability data survives a
  conversation delete on purpose.

**Known caveat, deliberately not fixed here:** SQLite does not enforce foreign
keys unless `PRAGMA foreign_keys=ON` is issued per connection, and
`backend/app/db.py` does not currently set it. So in v1 the FK is declarative
documentation, and the real protection against orphans is the explicit parent
check in the router (FR9 / FR5) plus the fact that only spec 004 writes
messages. Enabling the pragma is a `db.py` change affecting the whole app —
out of scope for this spec; raised in "Open questions".

### Migration

```
make db-revision message="add messages table"
make db-upgrade
```

`down_revision` must be spec 001's `add conversations table` revision — run
`make db-upgrade` for 001 before generating this one so autogenerate diffs
against a DB that already has `conversations`.

Read the generated file before upgrading. Confirm it contains: `op.create_table("messages", ...)`
with the `ForeignKeyConstraint(..., ondelete="CASCADE")`, the `CHECK` constraint
for `role`, `op.create_index("ix_messages_conversation_id_created_at", "messages", ["conversation_id", "created_at"])`,
and a `downgrade()` that drops the index and the table. Adding a relationship
attribute to `Conversation` produces **no** schema diff — if autogenerate emits
anything touching `conversations`, that is drift and should be investigated, not
applied blindly.

## API contracts

One endpoint. It lives in **`backend/app/routers/messages.py`** (new file), on
`APIRouter(prefix="/conversations", tags=["messages"])`, registered in
`backend/app/main.py` alongside spec 001's conversations router.

Rationale for a separate router file rather than appending to
`conversations.py`: CLAUDE.md's "one file per resource" — messages are their own
resource, and spec 004's `POST` plus its provider/orchestration wiring lands in
this same file, keeping conversation CRUD unpolluted. The shared `/conversations`
URL prefix is a path-nesting detail, not a reason to share a module.

Schema added to `backend/app/schemas.py`:

```python
class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: int
    role: MessageRole      # serialises as "user" | "assistant"
    content: str
    created_at: datetime
```

`MessageCreate` and `ChatTurnRead` are **not** added by this spec — spec 004
adds them.

### `GET /conversations/{conversation_id}/messages`

| | |
|---|---|
| Path param | `conversation_id: int` |
| Request body | none |
| `response_model` | `Page[MessageRead]` (imported from `app/schemas.py`, defined by spec 001) |
| `status_code` | `200` |
| Router file | `backend/app/routers/messages.py` |

Query params, declared with `Query(...)`:

| param | type | default | bounds |
|---|---|---|---|
| `limit` | `int` | `20` | `ge=1, le=100` |
| `offset` | `int` | `0` | `ge=0` |

Behaviour, in this order:

1. Parent check — `db.get(Conversation, conversation_id)`; if `None`, raise
   `HTTPException(404, "Conversation not found")`. **This happens first**, so a
   missing conversation is never reported as an empty page.
2. `total = db.scalar(select(func.count()).select_from(Message).where(Message.conversation_id == conversation_id))`.
3. `select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at.asc(), Message.id.asc()).limit(limit).offset(offset)`.
4. Return `Page(items=..., total=total, limit=limit, offset=offset)`.

| status | when |
|---|---|
| `200` | conversation exists — including when it has zero messages |
| `404` | no conversation with that id — `{"detail": "Conversation not found"}` (exact string shared with specs 001, 004, 009) |
| `422` | `conversation_id` not an integer; `limit < 1`; `limit > 100`; `offset < 0`; non-integer `limit`/`offset` |

### Router registration

In `backend/app/main.py`:

```python
from app.routers import conversations, messages
...
app.include_router(conversations.router)
app.include_router(messages.router)
```

## Constraints

Locked in — do not re-decide:

- **CLAUDE.md:** Alembic-only schema changes, and the migration ships in the
  same change as the model — not as a follow-up; every endpoint declares a
  `response_model`; no raw dicts across the API boundary; never swallow
  exceptions; validate the parent exists and return `404`, never a raw DB error;
  database-level constraints (FK, `CHECK`) for invariants that matter under
  concurrency; flat routers; `make lint` before done; tests only via the
  `generate-tests` skill.
- **Design doc:** `Message` fields are `id, conversation_id, role, content,
  created_at`; index on `(conversation_id, created_at)`; pagination on all list
  endpoints; messages cascade with their conversation *if* delete is ever added;
  logs are never joined to `messages`.
- **Decisions file:** this spec ships `GET` only — the `POST` is 004's;
  chronological `ASC` with `offset` from the oldest; `404` for a missing
  conversation is distinct from an empty page; the `(conversation_id, created_at)`
  index serves 004's context window too; `Page[T]` is referenced, not redefined.
- No changes to `db.py`, `config.py`, `errors.py`, `conftest.py`, the Makefile,
  or `pyproject.toml`.

## Error handling and edge cases

| # | Case | Response |
|---|---|---|
| 1 | **Missing parent conversation** — `GET /conversations/999999/messages` | `404`, `{"detail": "Conversation not found"}`. The parent check runs before any message query, so this can never be mistaken for case 2. |
| 2 | **Existing conversation, zero messages** | `200`, `{"items": [], "total": 0, "limit": 20, "offset": 0}`. **This is the empty-page-vs-404 distinction:** a missing *resource* is `404`; an empty *collection* under an existing resource is `200`. A client that gets `200` knows the conversation is real. |
| 3 | `offset` past the end (`offset=500` on a 4-message conversation) | `200`, `items: []`, `total: 4`. Not a `404` and not a `422` — the client compares `offset` against `total`. |
| 4 | `limit=0`, `limit=101`, `offset=-1` | `422` from `Query` bounds. No clamping, no silent coercion. |
| 5 | `limit=abc` / `offset=1.5` | `422` |
| 6 | `GET /conversations/abc/messages` | `422` (path coercion) |
| 7 | **Ordering / pagination tradeoff** | Messages are append-only and ordered by an immutable `created_at`, so offset pagination is stable here — unlike `GET /conversations`, where a mutable `updated_at` sort key can shuffle rows between pages. The only skew is that a message appended *during* a paging sweep lands at the end and shifts nothing already read. Accepted; no cursor pagination in v1. |
| 8 | **Client wants the newest messages** (the common chat-UI need) | Not served directly — ordering is `ASC` only, with no `order` param. The client issues one request, reads `total`, and jumps to the last page: `offset = max(0, total - limit)`. Costs one extra round trip. Accepted deliberately: a single fixed ordering keeps `offset` semantics unambiguous, and spec 011's chat view loads a short history anyway. |
| 9 | Two messages with identical `created_at` | Deterministically ordered by the `id ASC` tie-break; neither is duplicated across pages nor dropped. |
| 10 | Concurrent reads while spec 004 writes a turn | Reads see either both messages of the turn or neither, per the writing transaction's commit boundary. No locking, no `409` — reads never conflict. |
| 11 | Orphan row (a `conversation_id` pointing nowhere) | Cannot arise via the API: only spec 004 writes messages and it validates the parent first. The FK declares the invariant; see the SQLite `PRAGMA` caveat under "Cascade on delete". If one existed, it would simply never be returned, because every read is scoped by an existing `conversation_id`. |
| 12 | `IntegrityError` from a bad FK on write | `409` via the existing central handler in `app/core/errors.py`. No router-level `try/except`. Note this is a write path, so it belongs to spec 004; nothing in this spec can trigger it. |

This feature introduces no `except` block. The two failure modes it owns —
missing parent and invalid pagination — are an explicit `HTTPException(404)` and
FastAPI's own `422`.

## Acceptance criteria

Each becomes a pytest case using the `client` fixture from
`backend/tests/conftest.py` (written **only** by the `generate-tests` skill).
Because no `POST /messages` exists yet, tests that need message rows insert them
directly through the session/`TestingSessionLocal` from `conftest.py` rather
than through the API.

- [ ] `GET /conversations/999999/messages` → `404`,
      `detail == "Conversation not found"`.
- [ ] Create a conversation via `POST /conversations`, then
      `GET /conversations/{id}/messages` → `200`,
      `{"items": [], "total": 0, "limit": 20, "offset": 0}` — asserting the
      empty-page case is **not** a `404`.
- [ ] Seed 3 messages (`user`, `assistant`, `user`) with increasing
      `created_at`; `GET` → `200`, `total == 3`, and `items` are in ascending
      `created_at` order with the first item being the oldest.
- [ ] Each returned item has exactly the keys
      `{id, conversation_id, role, content, created_at}` and `role` is one of
      `"user"`/`"assistant"`.
- [ ] Seed 5 messages; `?limit=2&offset=0` → 2 items (oldest two), `total == 5`,
      `limit == 2`, `offset == 0`; `?limit=2&offset=4` → 1 item (the newest),
      `total == 5`.
- [ ] Seed 4 messages; `?offset=99` → `200`, `items == []`, `total == 4`.
- [ ] `?limit=0` → `422`; `?limit=101` → `422`; `?offset=-1` → `422`.
- [ ] `GET /conversations/abc/messages` → `422`.
- [ ] Two conversations each with messages: `GET` on one returns only its own
      messages and a `total` scoped to it (no cross-conversation leakage).
- [ ] Messages seeded with identical `created_at` values come back in stable
      `id` order across two identical requests.
- [ ] `POST /conversations/{id}/messages` is **not routed** by this spec —
      asserting it returns `405` documents that 004 has not landed yet. Drop
      this assertion when spec 004 is implemented.
- [ ] `make lint` passes.

## Files to be changed

| file | purpose |
|---|---|
| `backend/app/models.py` | Add `MessageRole` enum, the `Message` model with its FK + composite index, and the `messages` relationship on the existing `Conversation`. |
| `backend/alembic/versions/<rev>_add_messages_table.py` | Generated by `make db-revision message="add messages table"`; `down_revision` = spec 001's revision. Read it before `make db-upgrade`. |
| `backend/app/schemas.py` | Add `MessageRead`. Import `Page` — do not redefine it. |
| `backend/app/routers/messages.py` | **New.** Exactly one route: `GET /conversations/{conversation_id}/messages`. Spec 004 adds the `POST` to this same file. |
| `backend/app/main.py` | Import and `include_router(messages.router)`. |
| `backend/tests/test_messages.py` | Tests for the acceptance criteria above — **created only via the `generate-tests` skill, when the user invokes it.** Not part of implementing this spec. |

## Feature-specific rules

- **This spec ships one route.** If you find yourself writing `MessageCreate`,
  a request body, a provider call, or a `conversation.updated_at` assignment,
  you have crossed into spec 004. Stop.
- **No derived or denormalized fields. Deliberate.** No `token_count` on a
  message, no `sequence_number`, no `is_last`, no per-conversation
  `message_count` (001 already declined that one). Ordering is by `created_at`
  and the composite index makes it cheap, so a maintained sequence column would
  be write-path work with drift risk and no reader. Token counts live on
  `inference_logs` (spec 005), captured from the provider's own usage report —
  duplicating an estimate on the message row would create two numbers that
  disagree. This answers CLAUDE.md's "denormalized or computed live?": **neither,
  the value does not exist on this table.**
- **`role` is a closed set enforced in the database.** Adding `system` or `tool`
  later is a migration, not a code tweak — the system prompt is config (spec
  003's `SYSTEM_PROMPT`) and is never stored as a message row.
- **Messages are immutable.** No edit, no soft delete, no `updated_at`. The
  inference log's `input_messages` snapshot depends on this assumption (design
  doc: "logs are immutable snapshots while messages could change" — in v1 they
  don't).
- **The `(conversation_id, created_at)` index is load-bearing for spec 004.**
  Do not drop or rename it when adding the `POST`.
- **`Page[T]` comes from spec 001.** Import it. If its shape needs to change,
  that is a change to 001's contract affecting 007 too — raise it, don't fork it.
- **`"Conversation not found"` is the exact shared 404 detail string.**
- Everything else follows CLAUDE.md; nothing in it is overridden here.

## Open questions

One, and it is not blocking for this spec:

- **SQLite foreign-key enforcement.** `backend/app/db.py` does not issue
  `PRAGMA foreign_keys=ON`, so the `ondelete="CASCADE"` declared here is inert on
  SQLite. **Assumed acceptable for v1** — there is no delete endpoint, and the
  router's explicit parent check is what actually prevents orphans. Confirm
  before build if the pragma should be enabled via a SQLAlchemy `connect` event
  listener in `db.py`; that is an app-wide change and would need its own small
  spec or an explicit go-ahead, since it also changes behaviour for spec 005's
  tables.

Everything else — ordering, pagination bounds, the 404-vs-empty-page split, the
scope boundary against spec 004 — was settled by the design doc and the
clarification interview.
