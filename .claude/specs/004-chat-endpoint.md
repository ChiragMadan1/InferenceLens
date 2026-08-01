# 004 — Chat Endpoint (`POST /conversations/{id}/messages`)

## Problem statement

Specs 001–003 give us conversations, stored messages, and a provider adapter,
but nothing yet ties them together: there is no way for a user to say something
and get a reply. This spec adds the single endpoint that makes the product a
chatbot — store the user's message, assemble the last 10 messages as context,
call the configured provider, store the assistant's reply, bump the
conversation's activity timestamp, and return both messages in one response so
the frontend can render the turn without a second round trip.

It also adds the `ProviderError` → **502** translation in
`app/core/errors.py`, so a provider outage surfaces to the user as a clean JSON
error rather than a 500 stack trace — and, per the design doc's edge case 6,
leaves the user's message stored so they can retry without retyping.

### Explicitly out of scope

- **Inference logging is NOT wired here.** Spec 006 introduces
  `InferenceLogEvent`, `EventPublisher`, `CallRecorder`, and
  `LoggingChatProvider`, and makes `get_chat_provider()` return an already
  instrumented provider. Do not emit events, mint `request_id`s, compute
  `config_hash`, or measure latency in this spec. Half-building it here creates
  a second emission point, which is precisely what the design doc forbids.
- **Cancellation does not exist in this project.** There is no in-flight
  registry, no `POST /conversations/{id}/cancel` endpoint, and no
  concurrent-send 409 — a cancellation feature was scoped and then descoped
  before being built. This spec does not register tasks, does not track
  in-flight state, and does not return 409 for a second concurrent send; see
  edge case 16.
- **Auto-titling is NOT here.** Spec 008 hangs a background task off the first
  assistant reply.
- **Streaming is NOT here.** Spec 012. This endpoint returns one complete JSON
  response.
- **No frontend work.** Spec 010 adds `sendMessage` to `src/api.ts` and the chat
  view.

### Where 006 hooks in

It attaches to the same few lines in the router — the spec is written so it
is additive, not surgical: **006** leaves
`result = await provider.send_message(...)` exactly where it is and adds two
keyword arguments to it (`temperature=`, `conversation_id=`). The logging
happens because `Depends(get_chat_provider)` starts returning a
`LoggingChatProvider` — the handler never learns that logging exists, injects
no publisher, and imports nothing from the SDK.

Keep the provider call on **one clearly isolated line** in the handler so
that follow-up is a one-line substitution.

## Functional requirements

1. **FR1** — `POST /conversations/{conversation_id}/messages` accepts a
   `MessageCreate` body and returns `ChatTurnRead` with HTTP **200**.
2. **FR2** — The handler is `async def`. It must be, so the provider call is
   awaited on the event loop.
3. **FR3** — The conversation is validated to exist **before** anything is
   written. Missing conversation → **404**, no message row created.
4. **FR4** — `MessageCreate.content` is rejected with **422** when it is empty or
   whitespace-only, via a Pydantic `field_validator`. The validator strips
   surrounding whitespace and the **stripped** value is what gets stored.
5. **FR5** — The user message is persisted with `role="user"` and **committed**
   before the provider call, so a provider failure cannot roll it back.
6. **FR6** — The context window is the **last 10 messages of the conversation,
   including the just-stored user message** (steady state: 9 prior + the new
   one), ordered oldest→newest. Fewer than 10 messages in the conversation → all
   of them.
7. **FR7** — The window is mapped to `ProviderMessage` entries preserving each
   row's `role` (`user` / `assistant`) and `content` verbatim.
8. **FR8** — The system prompt comes from `settings.SYSTEM_PROMPT` and is passed
   as the provider's `system` argument — never appended to the message window.
9. **FR9** — On success, the assistant reply is stored with `role="assistant"`
   and the returned `ProviderResult.content`.
10. **FR10** — `conversation.updated_at` is set to the current UTC time in the
    same transaction as the assistant message, so
    `GET /conversations` (spec 001, ordered `updated_at DESC`) surfaces the
    conversation as most-recently-active.
11. **FR11** — The response body contains **both** stored rows:
    `{"user_message": MessageRead, "assistant_message": MessageRead}`, each with
    its real database `id` and `created_at`.
12. **FR12** — `ProviderError` raised anywhere in the request is translated to a
    **502** JSON response by a handler registered in `app/core/errors.py`. The
    user message stays committed.
13. **FR13** — A provider that returns empty/whitespace-only content does not
    produce an empty assistant message; it is treated as a provider failure
    (**502**) with the user message retained.
14. **FR14** — The provider is obtained via FastAPI `Depends(get_chat_provider)`
    (spec 003), so tests can override it and no test hits the network.

## Non-functional requirements

- **User work is never lost.** The commit ordering in FR5 is a hard requirement,
  not an optimization: it is what makes retry-after-failure possible.
- **No user-visible latency beyond the provider call.** No extra queries beyond
  the parent lookup, the window query, and the two writes. The window query is
  served by spec 002's `(conversation_id, created_at)` index.
- **Single-writer SQLite reality.** Two concurrent sends to the same
  conversation each get their own window snapshot; the second may not see the
  first's assistant reply. Accepted permanently — there is no concurrent-send
  guard anywhere in this project (see edge case 16).
- **No auth, no rate limiting, no caching, no realtime** (CLAUDE.md defaults).
- Errors are logged with context at ERROR and returned as clean JSON; nothing is
  swallowed.

## Data model

**No new table, no new column, no Alembic migration.** This endpoint writes to
tables that already exist:

- **`Message`** (spec 002) — two `INSERT`s per successful turn (`role="user"`,
  then `role="assistant"`), both with `conversation_id` set to the path
  parameter. This spec depends on 002 having created the model, its migration,
  and the `(conversation_id, created_at)` index (which serves the window query
  in FR6 as well as 002's listing).
- **`Conversation`** (spec 001) — one `UPDATE` of `updated_at` per successful
  turn (FR10). No other column is touched; `status` stays `active`.

New Pydantic schemas only (all in `app/schemas.py`):

| Schema        | Fields | Notes |
|---------------|--------|-------|
| `MessageCreate` | `content: str` | single field; `field_validator` strips and rejects blank (FR4) |
| `ChatTurnRead`  | `user_message: MessageRead`, `assistant_message: MessageRead` | `MessageRead` is defined by spec 002 — reuse it, do not redefine |

Derived values: none. The turn response is composed live from the two ORM rows;
nothing is denormalized.

Pagination: not applicable — this is a POST returning exactly two objects.

## API contracts

### Request

```
POST /conversations/{conversation_id}/messages
Content-Type: application/json
```

```json
{ "content": "What is the capital of France?" }
```

`conversation_id` is a path parameter of type `int`. A non-integer value is
rejected by FastAPI with **422** before the handler runs.

### Success — 200

`response_model=ChatTurnRead`

```json
{
  "user_message": {
    "id": 41,
    "conversation_id": 7,
    "role": "user",
    "content": "What is the capital of France?",
    "created_at": "2026-07-28T09:14:02.113Z"
  },
  "assistant_message": {
    "id": 42,
    "conversation_id": 7,
    "role": "assistant",
    "content": "Paris.",
    "created_at": "2026-07-28T09:14:04.881Z"
  }
}
```

### Status codes

| Code | When | Body |
|------|------|------|
| **200** | Turn completed; both messages stored | `ChatTurnRead` |
| **404** | `conversation_id` does not exist | `ErrorResponse` — `{"detail": "Conversation 7 not found."}` |
| **422** | `content` missing, empty, or whitespace-only; or `conversation_id` not an integer | FastAPI/Pydantic validation error body |
| **502** | `ProviderError` — provider timeout, rate limit, auth failure, 5xx, connection error, or empty completion | `ErrorResponse` — `{"detail": "The model provider failed to respond (timeout)."}` |

No 201: the response is a composite turn view rather than a single created
resource, and the frontend treats it as a read of the completed exchange.

### `ProviderError` handler (added to `app/core/errors.py`)

```python
@app.exception_handler(ProviderError)
async def provider_error_handler(request: Request, exc: ProviderError) -> JSONResponse:
    logger.error(
        "Provider call failed on %s %s: error_type=%s status_code=%s message=%s",
        request.method, request.url.path, exc.error_type, exc.status_code, exc.message,
    )
    return JSONResponse(
        status_code=502,
        content=ErrorResponse(
            detail=f"The model provider failed to respond ({exc.error_type})."
        ).model_dump(),
    )
```

The canonical `error_type` is surfaced (it is a closed vocabulary, safe to
show); the raw provider message is logged, not returned.

### Handler flow (normative order)

1. `SELECT` the conversation by id → `HTTPException(404)` if absent.
2. `INSERT` the user message; **`db.commit()`**; `db.refresh(user_message)`.
3. `SELECT` the window: last 10 rows for the conversation,
   `ORDER BY created_at DESC, id DESC LIMIT 10`, then reverse in Python to
   oldest-first. The secondary `id` sort matters — SQLite timestamps collide at
   sub-second resolution and an unstable sort would scramble turn order.
4. Map rows → `list[ProviderMessage]`.
5. `result = await provider.send_message(messages=window, system=settings.SYSTEM_PROMPT, model=settings.OPENAI_MODEL, max_tokens=settings.MAX_TOKENS)`
   — the single line spec 006 wraps.
6. If `result.content.strip() == ""` → `raise ProviderError("empty_response", "Provider returned no content.")`.
7. `INSERT` the assistant message; set `conversation.updated_at = datetime.now(UTC)`;
   `db.commit()`; `db.refresh(assistant_message)`.
8. Return `ChatTurnRead(user_message=..., assistant_message=...)`.

No `try`/`except` around step 5 in this spec — the central handler owns the
translation (CLAUDE.md: routers add their own only when a more specific message
is warranted). Spec 006 will add a `finally`-shaped path for event emission;
that is 006's change, not this one.

## Error handling and edge cases

| # | Case | Exact response |
|---|------|----------------|
| 1 | Nonexistent `conversation_id` | **404**, `{"detail": "Conversation {id} not found."}`. No `messages` row is created — the parent check precedes every write. |
| 2 | `content` is `""` | **422** from the Pydantic validator. Nothing written, no provider call. |
| 3 | `content` is `"   \n\t "` | **422** — the validator strips before checking, so whitespace-only is blank. |
| 4 | `content` has leading/trailing whitespace but real text | **200**; the **stripped** value is stored and echoed back. |
| 5 | `content` field omitted entirely / body not JSON | **422**, FastAPI's standard validation body. |
| 6 | Conversation exists but has **0** prior messages | Window = `[the just-stored user message]` (length 1). Valid; the provider gets a single-turn conversation. |
| 7 | Conversation has **fewer than 10** messages | Window = all of them, oldest-first, including the new user message. No padding. |
| 8 | Conversation has **more than 10** messages | Window = the 10 newest, oldest-first. Older history is silently dropped — that is the sliding window (design doc FR4), not an error. |
| 9 | Provider timeout | **502**, `{"detail": "The model provider failed to respond (timeout)."}`. **User message stays stored** — a subsequent `GET /conversations/{id}/messages` returns it. |
| 10 | Provider rate limit (429) | **502**, `(rate_limit)`. User message retained. |
| 11 | Provider auth failure at call time (bad/revoked key) | **502**, `(authentication)`. User message retained. Nothing about the key is echoed. |
| 12 | Provider 5xx / overloaded | **502**, `(server_error)`. User message retained. |
| 13 | Provider connection/DNS failure | **502**, `(connection)`. User message retained. |
| 14 | Provider returns a response with no text content | **502**, `(empty_response)` per FR13. No assistant message is written; the user message stays. Rationale: `Message.content` is non-empty by contract, and an empty bubble is worse UX than a retryable error. |
| 15 | `OPENAI_API_KEY` missing **at startup** | The app does not boot — `Settings()` raises a pydantic `ValidationError` at import (spec 003, FR10). This endpoint never serves a request. Distinct from case 11, which is a running app with a bad key. |
| 16 | Second message sent while one is in flight | Both proceed independently; the second may build its window before the first assistant reply lands. There is no concurrent-send guard anywhere in this project — accepted permanently, not just for v1. |
| 17 | Provider succeeds but the assistant `INSERT` fails (e.g. `IntegrityError`) | The existing central `IntegrityError` handler returns **409**. The user message is already committed and survives. Rare; no router-level handling added. |
| 18 | Request cancelled by the client mid-call | `asyncio.CancelledError` propagates; no assistant message is stored, the user message remains. There is no user-facing way to trigger this in v1 — it can only arise from something outside this endpoint (e.g. server shutdown) cancelling the task. |

## Acceptance criteria

Tests are created **only** by the `generate-tests` skill, when the user invokes
it. They use the `client` fixture from `tests/conftest.py`.

**Provider stubbing (mandatory — no test may make a real API call):** define a
`StubProvider(ChatProvider)` whose `send_message()` returns a canned
`ProviderResult` (or raises a canned `ProviderError`), and install it per-test
with

```python
app.dependency_overrides[get_chat_provider] = lambda: stub
```

clearing the override afterwards. Because `OpenAIProvider` is only ever built
inside `get_chat_provider()`, overriding the dependency means the `openai`
SDK is never touched. Tests must also ensure `OPENAI_API_KEY` is present in
the environment before `app.main` is imported (`os.environ.setdefault(...)` at
the top of `conftest.py`) — otherwise `Settings()` fails at import.

- [ ] POST to a conversation created via `POST /conversations` returns **200**
      and a body with both `user_message` and `assistant_message`.
- [ ] `user_message.role == "user"`, `assistant_message.role == "assistant"`,
      and both carry the correct `conversation_id`.
- [ ] `assistant_message.content` equals the stub's `ProviderResult.content`.
- [ ] Both messages have distinct integer `id`s, and
      `assistant_message.id > user_message.id`.
- [ ] POST to a nonexistent conversation id returns **404**, and a subsequent
      `GET /conversations/{that id}/messages` still 404s (no orphan row created).
- [ ] POST with `{"content": ""}` returns **422**; no message is stored.
- [ ] POST with `{"content": "   "}` returns **422**; no message is stored.
- [ ] POST with `{"content": "  hi  "}` stores and returns `"hi"`.
- [ ] The stub records the arguments it was called with; after a POST to an
      empty conversation, the recorded `messages` list has length 1 and its
      single entry is the just-sent user content.
- [ ] After seeding 12 prior messages and sending one more, the recorded
      `messages` list has length **exactly 10**, its last entry is the new user
      message, and its first entry is the 4th-oldest of the 13 total.
- [ ] After seeding 3 prior messages and sending one more, the recorded
      `messages` list has length **4** (fewer-than-10 case).
- [ ] The recorded `messages` list contains no entry with `role == "system"`,
      and the stub received `system == settings.SYSTEM_PROMPT`.
- [ ] `GET /conversations/{id}` after a successful turn shows an `updated_at`
      strictly greater than the value before the turn.
- [ ] When the stub raises `ProviderError("timeout", ...)`, the response is
      **502** with a `detail` string containing `timeout`.
- [ ] After that 502, `GET /conversations/{id}/messages` returns a page whose
      `total` is 1 and whose single item is the user message — proving the
      retry-safety guarantee (design doc edge case 6).
- [ ] When the stub returns a `ProviderResult` with `content=""`, the response
      is **502** and no assistant message was stored.
- [ ] When the stub raises `ProviderError("rate_limit", ...)`, the response is
      **502** (mapping is by exception type, not by `error_type` value).
- [ ] Two sequential turns in the same conversation both succeed and the second
      turn's recorded window contains the first turn's assistant reply.

## Files to be changed

| Path | Purpose |
|------|---------|
| `backend/app/schemas.py` | Add `MessageCreate` (with the strip/non-empty `field_validator`) and `ChatTurnRead`. Reuse spec 002's `MessageRead`; do not redefine it. |
| `backend/app/routers/messages.py` | Add the `POST /conversations/{conversation_id}/messages` handler to the router spec 002 created. `async def`, `response_model=ChatTurnRead`, `Depends(get_db)` + `Depends(get_chat_provider)`. |
| `backend/app/core/errors.py` | Register the `ProviderError` → 502 handler inside `register_exception_handlers()`; import `ProviderError` from `app.providers.base`. |
| `backend/app/main.py` | No change expected — spec 002 already registers the messages router. Verify it is registered; if 002 did not, add the `include_router` call. |
| `backend/tests/test_chat.py` | **Created only via the `generate-tests` skill, when the user invokes it.** Covers the checklist above with a stubbed provider. |

Explicitly **not** changed: `app/models.py`, `alembic/versions/*` (no schema
change), `app/providers/*` (spec 003 owns it), anything under `frontend/`.

## Feature-specific rules

- **Commit the user message before the provider call.** This is the single most
  important line-ordering rule in the spec. If it is flushed but not committed,
  a `ProviderError` bubbling to the exception handler leaves the session closed
  without a commit and the user's text is lost — breaking the design doc's
  retry guarantee.
- **Bump `updated_at` only on success.** A failed turn leaves the conversation's
  list position unchanged. *Stated tradeoff:* a conversation whose only recent
  activity was a failed send sorts as though nothing happened, even though it
  has a new user message. Accepted per the confirmed flow; revisit only if the
  list ordering feels wrong in practice.
- **Window construction is DESC-then-reverse, never ASC-with-offset.** Fetching
  ascending and offsetting from the end requires a count query and breaks when
  rows are added concurrently.
- **Order by `(created_at DESC, id DESC)`.** Timestamp-only ordering is unstable
  on SQLite for messages written in the same millisecond.
- **Roles are `user`/`assistant` only.** The DB enum, the `ProviderMessage`
  literal, and the OpenAI Responses API `input` array agree exactly; the system prompt
  travels on its own channel (FR8).
- **One line for the provider call.** Spec 006 substitutes on it. Do not
  inline it into a larger expression or split it across a helper chain.
- **No router-level `try`/`except` for `ProviderError` or `IntegrityError`** —
  both have central handlers.
- Run `make lint` before considering the change done.

## Open questions

- **Status code for the turn.** *Assumed:* **200**, since the response is a
  composite view of a completed exchange rather than a single created resource
  (spec 005's `POST /ingest/logs` uses 201 because it creates exactly one
  addressable row). Confirm before build if 201 is preferred for consistency
  across POSTs.
- **Whether an empty completion should be a 502 or an empty assistant message.**
  *Assumed:* 502 with `error_type="empty_response"`, no message stored (FR13) —
  it keeps `Message.content` non-empty and gives the user a retry. Confirm
  before build; the alternative is storing a placeholder reply, which would
  pollute the context window on the next turn.
