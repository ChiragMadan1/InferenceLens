# 007 — Inference Logs Read API

## Problem statement

Spec 005 stores inference logs; spec 006 produces them. Nothing reads them back.
The single highest-value query in an observability system — *"a user reported a
bad answer; show me exactly what the model was sent and what it returned"* — is
currently answerable only by opening `app.db` in a SQLite shell.

This spec adds the read surface: a paginated, filterable list and a
full-content detail lookup.

The split between the two endpoints is deliberate and follows the design doc's
query patterns. `input_messages` and `output_text` are full rendered prompts and
completions — potentially tens of kilobytes each. Returning them for 20 rows at a
time would make the list endpoint useless for scanning. So the list returns
**computed previews** and the detail endpoint returns **full content**.

Depends on **005 only**. It does not depend on 006 (logs written by hand, by a
test fixture, or by a future Kafka consumer read identically) and it does not
touch the chat feature.

## Functional requirements

1. **FR1** — `GET /logs` returns inference logs as `Page[InferenceLogSummary]`,
   ordered `created_at DESC`.
2. **FR2** — `GET /logs` accepts `limit` (default 20, `ge=1`, `le=100`) and
   `offset` (default 0, `ge=0`) as `Query(...)` parameters. Out-of-range values
   are rejected by FastAPI with 422.
3. **FR3** — `GET /logs` accepts three optional filters, combined with AND:
   `conversation_id` (int), `status` (`LogStatus`), `call_type` (`CallType`).
4. **FR4** — An invalid `status` or `call_type` value returns 422 (enum-validated
   by FastAPI, not silently ignored and not treated as "no filter").
5. **FR5** — `Page.total` is the count of rows matching the filters, **not** the
   number of items on the page and **not** the table's total row count.
6. **FR6** — A filter combination matching nothing returns 200 with
   `{"items": [], "total": 0, "limit": ..., "offset": ...}`. Never 404.
7. **FR7** — `InferenceLogSummary.input_preview` is **computed at read time**:
   the `content` of the **last** entry with `role == "user"` in `input_messages`,
   truncated to 500 characters. Nullable.
8. **FR8** — `InferenceLogSummary.output_preview` is **computed at read time**:
   `output_text` truncated to 500 characters. Nullable — `None` whenever
   `output_text` is `None` (every error and cancelled log).
9. **FR9** — Neither preview is a stored column. No schema change; nothing is
   denormalized.
10. **FR10** — `InferenceLogSummary` omits the bulk content fields entirely:
    `input_messages`, `output_text`, `request_params`, `provider_metadata`, and
    `error_message` are not in the list response.
11. **FR11** — `GET /logs/{request_id}` looks up a single log **by its
    `request_id`**, not by the integer primary key, and returns
    `InferenceLogRead` (full content) with 200.
12. **FR12** — An unknown `request_id` on the detail endpoint returns 404.
13. **FR13** — The `Page[T]` envelope is **referenced**, not redefined. Spec 001
    owns its definition in `app/schemas.py`.
14. **FR14** — Both endpoints are read-only. No POST, PATCH, PUT, or DELETE is
    added to `/logs`.

## Non-functional requirements

- **Every filter is index-backed.** The three filter shapes map onto the indexes
  spec 005 created; no filtered list query does a full scan plus sort. See the
  index table below.
- **Bounded response size.** `limit` is capped at 100 and previews are capped at
  500 characters, so the largest list response is bounded regardless of how large
  the stored prompts are.
- **Pagination is required, not optional.** Logs are the fastest-growing table in
  the system (~1–2 rows per chat turn once titling counts). The design doc's
  user-confirmed decision is pagination on all list endpoints, which overrides
  CLAUDE.md's ~1k-row default heuristic — this feature is explicitly on the
  paginated side of that line.
- **Read-only and side-effect free.** These endpoints never write. Logs are
  immutable observability records.
- **No caching.** Reads hit the database every time (CLAUDE.md out-of-scope
  default).
- **No auth.** Access control on `/logs` is future work, gated on auth existing
  at all.

## Data model

**No schema change. No new model, no new column, no Alembic migration.** Every
field this spec returns already exists on `InferenceLog` from spec 005. Running
`make db-revision` for this feature should produce an empty migration — if it
does not, the model has drifted from the migration chain and that must be fixed
before proceeding.

What this section defines is the two **response schemas** and the **read-time
computation** that produces the previews.

### Existing indexes this spec relies on (created in spec 005)

| Query | Index used | Design-doc pattern |
|---|---|---|
| `GET /logs` unfiltered | `(created_at)` | **Q1** — recent activity tail |
| `GET /logs?conversation_id=42` | `(conversation_id, created_at)` | **Q2** — trace a conversation |
| `GET /logs?status=error` | `(status, created_at)` | **Q3** — error triage |
| `GET /logs/{request_id}` | `request_id` unique | **Q4** — inspect one request |

`call_type` has no dedicated index. It is a low-cardinality filter (two values in
v1) that is almost always combined with another filter or used on a small recent
window, and adding an index for it would be speculative. If a `call_type`-only
query ever becomes hot, `(call_type, created_at)` is an additive migration.

### `InferenceLogSummary`

In `backend/app/schemas.py`. **Not** `from_attributes`-constructible on its own,
because two of its fields are computed — it is built via a `from_log` classmethod.

| Field | Type | Source |
|---|---|---|
| `id` | `int` | column |
| `request_id` | `str` | column |
| `conversation_id` | `int \| None` | column |
| `call_type` | `CallType` | column |
| `model` | `str` | column |
| `provider` | `str` | column |
| `status` | `LogStatus` | column |
| `latency_ms` | `int` | column |
| `input_tokens` | `int \| None` | column |
| `output_tokens` | `int \| None` | column |
| `time_to_first_token_ms` | `int \| None` | column (null until spec 012) |
| `cost_usd` | `Decimal \| None` | column |
| `error_type` | `str \| None` | column — needed for error triage without a second round trip |
| `config_hash` | `str \| None` | column |
| `requested_at` | `datetime` | column |
| `completed_at` | `datetime \| None` | column |
| `created_at` | `datetime` | column |
| `input_preview` | `str \| None` | **computed** — last user message, ≤500 chars |
| `output_preview` | `str \| None` | **computed** — `output_text`, ≤500 chars |

Deliberately absent: `input_messages`, `output_text`, `request_params`,
`provider_metadata`, `error_message`, `schema_version`. The first four are the
bulk-content fields the previews replace; `error_message` is capped at 2000
characters and would dominate a list of 100 error rows; `schema_version` is an
ingestion-time contract detail with no read-side use.

### Preview computation

```python
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
```

Both are pure functions of the row, called once per item in the router (via
`InferenceLogSummary.from_log`). They are **not** stored, **not** cached, and
**not** computed in SQL.

The *last* user message is the right choice for `input_preview` because
`input_messages` holds the whole rendered window — system prompt plus up to ten
prior turns. The first entry is the system prompt (identical on every row, so
useless as a preview) and earlier user turns are context. The last user message
is the one that actually prompted this call, which is what someone scanning a log
list is looking for.

Truncation is a hard slice with **no ellipsis marker** — a preview is a prefix of
the real content, and appending `"…"` would make it a string that never appears
in the stored data.

### `InferenceLogRead`

**Reused from spec 005 unchanged.** Spec 005 defines it as the ingest response;
this spec uses the identical schema as the detail response. Do not define a
second full-content schema — one drifting from the other is exactly the failure
mode CLAUDE.md's shared-schema convention exists to prevent.

### `Page[T]`

**Defined by spec 001 in `app/schemas.py`. This spec imports and parameterises
it; it does not redefine it.**

```python
class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int
```

`GET /logs` returns `Page[InferenceLogSummary]`. If spec 001 has not landed when
this is implemented, the correct action is to implement spec 001's envelope
there, not to declare a local copy here.

## API contracts

Router: `backend/app/routers/logs.py`, `APIRouter(prefix="/logs", tags=["logs"])`,
registered in `app/main.py` with `app.include_router(logs.router)`.

### `GET /logs`

| | |
|---|---|
| Method / path | `GET /logs` |
| Request body | none |
| `response_model` | `Page[InferenceLogSummary]` |
| Success status | `200 OK` |
| Ordering | `created_at DESC, id DESC` |

**Query parameters:**

| Name | Type | Default | Bounds | Behaviour |
|---|---|---|---|---|
| `limit` | `int` | `20` | `ge=1, le=100` | Page size. Out of range → 422 |
| `offset` | `int` | `0` | `ge=0` | Rows skipped. Negative → 422 |
| `conversation_id` | `int \| None` | `None` | — | Exact match. Omitted → no filter |
| `status` | `LogStatus \| None` | `None` | enum | `success` \| `error` \| `cancelled`. Anything else → 422 |
| `call_type` | `CallType \| None` | `None` | enum | `chat` \| `title`. Anything else → 422 |

All declared with `Query(...)` so FastAPI validates and documents them.

**Handler shape:**

```
1. Build the filter list from the non-None query params.
2. total = SELECT count(*) FROM inference_logs WHERE <filters>
3. rows  = SELECT * FROM inference_logs WHERE <filters>
           ORDER BY created_at DESC, id DESC
           LIMIT :limit OFFSET :offset
4. return Page(
       items=[InferenceLogSummary.from_log(row) for row in rows],
       total=total, limit=limit, offset=offset,
   )
```

The secondary `id DESC` sort is load-bearing: `created_at` comes from a server
default and multiple rows ingested in the same instant can tie. Without a
deterministic tie-break, two requests for the same offset can return overlapping
or skipped rows.

**Status codes:**

| Code | When |
|---|---|
| `200` | Always, including when the result set is empty |
| `422` | `limit`/`offset` out of range, non-integer `conversation_id`, unknown `status` or `call_type` value |

There is **no 404** on this endpoint. Not for an empty result, and not for a
`conversation_id` that matches no conversation — see Feature-specific rules.

### `GET /logs/{request_id}`

| | |
|---|---|
| Method / path | `GET /logs/{request_id}` |
| Path param | `request_id: str` — the SDK-minted idempotency key, **not** the integer PK |
| Request body | none |
| `response_model` | `InferenceLogRead` (spec 005's schema, reused) |
| Success status | `200 OK` |

Returns the complete row including `input_messages`, `output_text`,
`request_params`, `provider_metadata`, `error_message`, and `cost_usd`. This is
the "show me exactly what the model saw" endpoint — the reason full content is
stored denormalized in the first place.

**Status codes:**

| Code | When |
|---|---|
| `200` | Log found |
| `404` | No log with that `request_id`, with a clear `detail` |

Route ordering: `/logs/{request_id}` is declared **after** `/logs` in the router
so the collection route is not shadowed. Since `request_id` is typed `str`, any
path segment matches it — there is no risk of a numeric id being mis-routed, but
declaration order still matters for clarity.

### Frontend

**No frontend changes.** The logs API is API-only in v1 (design doc scope, and
the spec-decisions file's 011 entry: "No log-viewing UI in v1"). No functions are
added to `frontend/src/api.ts` and no TypeScript types are mirrored. When a log
UI is built, `InferenceLogSummary` / `InferenceLogRead` / `Page<T>` mirror by
name at that point.

## Constraints

- **No schema change, no migration.** If `make db-revision` emits a non-empty
  migration for this feature, stop and investigate drift.
- **Do not redefine `Page[T]`.** Import spec 001's definition.
- **Do not redefine `InferenceLogRead`.** Import spec 005's definition.
- **Previews are never stored.** No `input_preview`/`output_preview` columns, no
  triggers, no denormalization. Read-time computation only.
- **Read-only.** No mutating endpoints on `/logs` in v1.
- **No auth, no rate limiting, no caching** (CLAUDE.md out-of-scope defaults).
- **No cross-table joins.** The logs API does not join to `conversations` or
  `messages` — it does not enrich a log with a conversation title, and it does
  not validate `conversation_id`. Ingestion's isolation would be pointless if the
  read side re-coupled them.
- **Router is flat**: `app/routers/logs.py`. No `api/v1/...`.
- `make lint` passes before the change is considered done.

## Error handling and edge cases

| # | Case | Response |
|---|---|---|
| 1 | No logs exist at all | `200` with `{"items": [], "total": 0, "limit": 20, "offset": 0}` |
| 2 | Filter matches nothing, e.g. `?status=error` with no errors logged | `200` with `total: 0` and an empty `items`. **Never 404** — an empty result set is a valid answer to a valid question |
| 3 | `?conversation_id=99999` where no such conversation exists | `200` with `total: 0`. **No 404.** The logs API deliberately does not know what conversations exist — see rule 2 below |
| 4 | `?status=pending` (not a `LogStatus` member) | `422` with a field error naming `status` and listing the permitted values. **Not** silently ignored, and **not** treated as "no filter" |
| 5 | `?call_type=summarize` (not a `CallType` member) | `422`, same shape |
| 6 | `?limit=0`, `?limit=101`, `?limit=-5` | `422` from the `ge`/`le` constraints |
| 7 | `?offset=-1` | `422` from the `ge=0` constraint |
| 8 | `?offset=100000` past the end of the result set | `200` with empty `items` and the **true** `total`. A client can detect over-paging by comparing `offset` to `total` |
| 9 | `?conversation_id=abc` (non-integer) | `422` from FastAPI's type coercion |
| 10 | Multiple filters combined, e.g. `?conversation_id=1&status=error&call_type=title` | `200`, filters ANDed. Empty page if nothing matches |
| 11 | `GET /logs/{request_id}` with an unknown id | `404` with `{"detail": "..."}`. No empty-body 200, no 204 |
| 12 | `GET /logs/{request_id}` where the id is a valid integer string, e.g. `/logs/5` | Treated as a `request_id` string, **not** as the primary key. Almost certainly `404` — the PK is never a lookup key on this API |
| 13 | A log whose `input_messages` contains no `role == "user"` entry | `200`; `input_preview` is `null`. Not an error |
| 14 | A log whose last user message `content` is not a string (a future multi-part block) | `200`; `input_preview` is `null`. The list must not 500 because one row has an unexpected content shape |
| 15 | An error or cancelled log (`output_text` is `null`) | `200`; `output_preview` is `null` |
| 16 | A log whose `output_text` is 40,000 characters | `200`; `output_preview` is exactly the first 500 characters, no ellipsis. Full text is available on the detail endpoint |
| 17 | A log whose `cost_usd` is `null` (unknown model at ingestion time) | `200`; `cost_usd` is `null` in both list and detail responses. Not zero |
| 18 | Two logs with the identical `created_at` | Deterministic order via the `id DESC` tie-break, so paging over them neither duplicates nor skips |

## Acceptance criteria

Written so each bullet becomes one pytest case using the `client` fixture from
`tests/conftest.py`. Fixtures seed `InferenceLog` rows directly (or via
`POST /ingest/logs`) — this spec has no dependency on the chat feature, so tests
must not create conversations to exercise it. **Tests are created only via the
`generate-tests` skill, when the user invokes it** — do not write them while
implementing this spec.

**`GET /logs` — shape and ordering**

- [ ] With no logs, returns `200` and `{"items": [], "total": 0, "limit": 20,
      "offset": 0}`.
- [ ] With three logs, returns `200`, `total == 3`, and three items.
- [ ] Items are ordered newest-first by `created_at` (seed rows with distinct
      `created_at` values and assert the id order).
- [ ] Default `limit` is 20 and default `offset` is 0 when neither is supplied,
      and both are echoed in the response envelope.
- [ ] With 5 logs and `?limit=2&offset=2`, returns 2 items, `total == 5`, and the
      items are the third and fourth newest.
- [ ] The response contains no `input_messages`, `output_text`,
      `request_params`, `provider_metadata`, or `error_message` keys.

**`GET /logs` — filters**

- [ ] `?conversation_id=<id>` returns only logs with that `conversation_id`, and
      `total` reflects the filtered count, not the table count.
- [ ] `?status=error` returns only error logs.
- [ ] `?call_type=title` returns only title logs.
- [ ] Combining `?conversation_id=X&status=success` ANDs both filters.
- [ ] A filter matching nothing returns `200`, `total == 0`, `items == []`.
- [ ] `?conversation_id=999999` (no such conversation anywhere) returns `200`
      with `total == 0` — **explicitly asserts it is not a 404.**
- [ ] `?status=pending` returns `422`.
- [ ] `?call_type=summarize` returns `422`.
- [ ] `?limit=0` returns `422`.
- [ ] `?limit=101` returns `422`.
- [ ] `?offset=-1` returns `422`.
- [ ] `?conversation_id=abc` returns `422`.

**`GET /logs` — computed previews**

- [ ] For a log whose `input_messages` is
      `[{"role":"system",...},{"role":"user","content":"first"},
      {"role":"assistant",...},{"role":"user","content":"second"}]`,
      `input_preview == "second"` (the **last** user message, not the first, and
      not the system prompt).
- [ ] A 1200-character last-user-message yields an `input_preview` of exactly 500
      characters, equal to the first 500 characters of the original (no ellipsis).
- [ ] A 1200-character `output_text` yields an `output_preview` of exactly 500
      characters.
- [ ] A log whose `input_messages` has no user entry yields
      `input_preview is None`.
- [ ] A log whose last user entry has non-string `content` (e.g. a list) yields
      `input_preview is None` and a `200`, not a 500.
- [ ] A log with `output_text` null (an error log) yields
      `output_preview is None`.
- [ ] `InferenceLog.__table__.c` contains **no** `input_preview` or
      `output_preview` column — the previews are computed, never stored.

**`GET /logs/{request_id}`**

- [ ] A known `request_id` returns `200` and a body whose `request_id` matches.
- [ ] That body includes the **full** `input_messages` (all entries, untruncated)
      and the **full** `output_text`, not the 500-character previews.
- [ ] That body includes `request_params`, `provider_metadata`, `error_message`,
      and `cost_usd`.
- [ ] An unknown `request_id` returns `404` with a non-empty `detail`.
- [ ] `GET /logs/5` (a numeric string that is a valid PK but not a `request_id`)
      returns `404` — lookup is by `request_id`, never by primary key.
- [ ] A log whose `cost_usd` is null returns `cost_usd: null`, not `0`.
- [ ] A log ingested with `time_to_first_token_ms` null returns it as null.

## Files to be changed

| Path | Change | Purpose |
|---|---|---|
| `backend/app/schemas.py` | add | `InferenceLogSummary` (with the `from_log` classmethod), `PREVIEW_MAX_CHARS`, and the two preview helpers. Imports the existing `Page`, `InferenceLogRead`, `CallType`, `LogStatus` — defines none of them |
| `backend/app/routers/logs.py` | **new** | `GET /logs` (paginated, filtered, previews) and `GET /logs/{request_id}` (full content, 404) |
| `backend/app/main.py` | edit | `app.include_router(logs.router)` |
| `backend/tests/test_logs_api.py` | — | List, filters, pagination bounds, preview computation, detail lookup and 404. **Created only via the `generate-tests` skill, when the user invokes it.** |

No model change. No migration. No frontend change. No new dependency.

*Placement note:* the preview helpers and `from_log` live in `schemas.py`
alongside `InferenceLogSummary` rather than in the router, so the shape of the
schema and the code that fills it stay together. They are used once; that is
deliberate, not an abstraction — CLAUDE.md's no-premature-abstraction rule is
about not building frameworks, not about inlining a pure function into a handler.

## Feature-specific rules

### 1. Previews are computed at read time, never stored

`input_preview` and `output_preview` are **derived values**. Per CLAUDE.md's
"state the choice and why" rule for derived values, the choice is **computed
live**, for three reasons:

1. **They cannot drift.** A stored preview is a second copy of content that is
   already on the row; any change to the truncation rule (500 → 300 chars, or
   "last user message" → "first user message") would need a data migration and a
   backfill instead of a one-line edit.
2. **Cost is negligible.** Slicing a string for at most 100 rows per request is
   free relative to the query itself. There is no read-speed argument for
   denormalizing.
3. **Content is already denormalized once.** The design doc accepts that content
   is stored roughly twice (messages + logs). Storing a third partial copy for
   display convenience is the wrong trade.

This is the same principle applied to tokens/sec in spec 005: **store raw
measurements, derive presentations.** The one deliberate exception in this
feature set remains `cost_usd`, which is stored because it depends on an external
versioned price table rather than on the row's own columns.

### 2. `conversation_id` is a filter, not a foreign key — no 404, no join

`GET /logs?conversation_id=999999` returns an **empty page with 200**, not a 404,
even when no conversation with that id exists.

This follows directly from spec 005's deliberate FK exception. `conversation_id`
on `inference_logs` is a plain nullable column with no foreign key, and the logs
API deliberately does not know what conversations exist. Validating the filter
against the `conversations` table would:

- re-couple ingestion's read side to the chat schema, undoing the isolation that
  makes the module splittable into its own service; and
- break the moment logs outlive their conversations, which is the intended
  behaviour if conversation deletion is ever added (messages cascade, **logs
  survive, deliberately unlinked**).

For the same reason, `GET /logs` performs **no join** to `conversations` or
`messages`. It does not decorate a log with a conversation title. A caller that
wants both fetches both.

A reviewer may read the missing 404 as an omission. It is not — it is the read-side
consequence of a documented architectural decision, and it should be noted in the
PR description alongside spec 005's.

### 3. Two endpoints because content size differs by two orders of magnitude

The list/detail split is not stylistic. `input_messages` holds an entire rendered
prompt — system prompt plus up to ten prior messages — and `output_text` holds a
full completion. Returning both for 100 rows could produce a multi-megabyte
response for a page meant to be scanned.

So: **the list answers "which call?" and the detail answers "what happened in
it?"** (design-doc query patterns Q1–Q3 versus Q4). The 500-character preview is
sized to identify a call at a glance without carrying its payload.

Do not "helpfully" add an `?include_content=true` flag to the list endpoint. That
reintroduces the unbounded response the split exists to prevent, and there is a
detail endpoint one request away.

### 4. Reuse `Page[T]` and `InferenceLogRead` — define neither

Two schemas in this feature are owned elsewhere:

- **`Page[T]`** is defined once by spec 001 in `app/schemas.py`. Specs 002 and 007
  reference it. A local generic envelope here would drift in field names or
  semantics from the conversations and messages endpoints, which is precisely
  what a shared envelope prevents.
- **`InferenceLogRead`** is defined by spec 005 as the ingest response. This spec
  reuses it verbatim as the detail response. One schema means the shape a log was
  written with is provably the shape it is read back with.

### 5. Deterministic ordering under ties

`ORDER BY created_at DESC` alone is not stable. `created_at` comes from
`server_default=func.now()`, and rows ingested in the same instant — entirely
plausible when a chat call and its title call are logged microseconds apart —
tie. Under a tie, SQLite is free to return them in any order, so paging across
the boundary can duplicate or skip a row.

`ORDER BY created_at DESC, id DESC` breaks the tie on a monotonically increasing
primary key, which makes the sequence total and offset-based paging correct. Do
not drop the secondary sort.

## Open questions

- **Preview length.** Assumed 500 characters for both previews (design doc:
  "first ~500 chars"), applied as a hard slice with no ellipsis marker. Confirm
  before build if a truncation indicator is wanted — it would make a preview a
  string that never appears in the stored content, which is why it is omitted.
- **`error_message` in the list response.** Assumed **excluded** — it is capped at
  2000 characters, which would dominate a page of 100 error rows; `error_type` is
  included instead, and the full message is one request away on the detail
  endpoint. Confirm before build if error triage wants a truncated
  `error_message` preview in the list as well.
- **`call_type` index.** Assumed **not** worth an index in v1 (two values, almost
  always combined with another filter). Confirm before build if a
  `call_type`-only query is expected to be hot; `(call_type, created_at)` is an
  additive migration either way.
