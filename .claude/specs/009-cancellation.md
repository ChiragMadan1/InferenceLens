# 009 — Cancel an in-flight generation

Depends on: 006 (logging SDK / `logged_chat()`), and therefore transitively on
003 (`AsyncAnthropic` adapter) and 004 (chat endpoint). **This spec modifies
spec 004's endpoint** — see "API contracts".

## Problem statement

`POST /conversations/{id}/messages` is a blocking request that can take tens
of seconds against a large model. Today a user who realises mid-generation
that they asked the wrong thing has no recourse: they wait for a reply they
don't want, pay for its tokens, and get it stored in their history. There is
also nothing stopping them from firing a second message into the same
conversation while the first is still generating, which would interleave two
context windows over the same message list.

This feature adds an explicit abort: a registry of in-flight generations keyed
by conversation, a `POST /conversations/{id}/cancel` endpoint that cancels the
one for that conversation, and a 409 on concurrent sends. The cancelled
generation still produces an inference log — `status="cancelled"` — because a
cancelled call is an operational event worth seeing in `GET /logs`, and
because `logged_chat()`'s contract (006) is "exactly one event per provider
call, whatever its outcome".

## Functional requirements

1. **FR1** — A module-level registry `_inflight: dict[int, asyncio.Task]`,
   keyed by `conversation_id`, lives in the same module as the chat endpoint.
   One in-flight generation per conversation, maximum.
2. **FR2** — The chat endpoint wraps its `logged_chat()` call in
   `asyncio.create_task(...)`, inserts the task into `_inflight` **before**
   awaiting it, awaits it, and removes it in a `finally` — with an identity
   guard so it only removes its own task.
3. **FR3** — If `conversation_id` is already present in `_inflight` when a new
   message arrives, the chat endpoint returns **409** with detail
   `"A generation is already in progress for this conversation."` The check
   happens **after** the 404 conversation-exists validation and **before** the
   user message is stored, so a rejected send leaves no orphan message.
4. **FR4** — `POST /conversations/{id}/cancel` returns **200** with
   `CancelResult` when a task is registered for that conversation, **404**
   when the conversation does not exist, and **409** with detail
   `"No generation in progress for this conversation."` when the conversation
   exists but nothing is registered.
5. **FR5** — Cancel calls `task.cancel()` and returns immediately. It does
   **not** await the task, does not remove the registry entry (FR2's `finally`
   owns removal), and does not touch the messages table.
6. **FR6** — `task.cancel()` raises `CancelledError` inside the awaited
   `AsyncAnthropic` call and genuinely aborts the in-flight HTTP request to
   the provider — the socket is closed, generation stops. This is the reason
   spec 003 mandates `AsyncAnthropic` over the sync client: a sync client call
   runs in a thread that `task.cancel()` cannot interrupt, and the request
   would keep running (and keep billing) after a "successful" cancel.
7. **FR7** — On cancellation: **no assistant message is stored**, the **user
   message remains** in history, `conversation.updated_at` is **not** bumped,
   and the registry key is freed so the user can send a new message
   immediately.
8. **FR8** — `logged_chat()` emits exactly one event with `status="cancelled"`,
   `input_tokens = None`, `output_tokens = None`, `output_text = None`,
   `error_type = None`, `error_message = None`, `completed_at` set to the
   cancellation moment, and `latency_ms` measured from `requested_at` to that
   moment. `input_messages`, `model`, `provider`, `request_params`,
   `config_hash`, and `conversation_id` are populated exactly as on the
   success path.
9. **FR9** — `CancelledError` is **never swallowed**: `logged_chat()` catches
   it, builds and fires the event, logs at INFO with `request_id` and
   `conversation_id`, and **re-raises**. The chat endpoint likewise cleans up
   in `finally` and lets it propagate.
10. **FR10** — The cancelled `POST /messages` request produces **no HTTP
    response**: the connection is closed without a status line/body (see
    "API contracts → client-visible consequence"). Spec 011 must handle a
    rejected `fetch`, not a 4xx/5xx.
11. **FR11** — A cancelled turn schedules **no** titling task (spec 008): no
    assistant message was stored, so 008's assistant-count trigger is not
    met.
12. **FR12** — The registry is process-local and in-memory. It is empty on
    startup and is not persisted anywhere.

## Non-functional requirements

- **Correct asyncio semantics.** No `except asyncio.CancelledError: pass`
  anywhere; no `await` inside a cancelled coroutine's cleanup path (it
  re-raises `CancelledError` immediately and would drop the log event).
- **Cancel is O(1) and non-blocking.** The endpoint does a dict lookup and a
  `.cancel()`; it returns in microseconds while the aborted task unwinds
  independently.
- **The known limitation is documented, not hidden** — see "Constraints".
- **No new datastore.** The registry is a plain dict, not Redis, not a table.
- **No realtime.** Cancel is a normal request/response POST. No websocket, no
  server push telling the client the generation died — the client already
  knows, because its own `sendMessage` request failed.

## Data model

**No schema change. No new column. No new table. No Alembic migration for
this feature.**

- `messages` — unchanged. Cancellation is expressed by the *absence* of an
  assistant row, not by a status column. (A `status` column on messages was
  considered and rejected: v1 stores only completed messages, so there is no
  state to represent.)
- `conversations` — unchanged. `updated_at` is not bumped on a cancelled
  turn, so a cancelled generation does not reorder the conversation list.
  Tradeoff: the user message stored during that turn does not move the
  conversation to the top of the list until the next successful turn.
  Accepted; the alternative is a bump in 004's user-message step, which is a
  change to 004's committed behaviour and out of scope here.
- `inference_logs` — unchanged. `status` (005) already includes `cancelled`,
  and `input_tokens` / `output_tokens` / `output_text` are already nullable
  (design-doc edge case 11).

The only new *Pydantic* schema is `CancelResult`, which is an API contract,
not a table.

## API contracts

### New: `POST /conversations/{id}/cancel`

| | |
|---|---|
| Request body | none |
| `response_model` | `CancelResult` |
| 200 | `{"conversation_id": 42, "cancelled": true}` |
| 404 | conversation does not exist — `ErrorResponse{detail: "Conversation not found."}` |
| 409 | conversation exists, nothing registered — `ErrorResponse{detail: "No generation in progress for this conversation."}` |

```python
class CancelResult(BaseModel):
    conversation_id: int
    cancelled: bool
```

Order of checks is fixed: **404 first** (conversation existence, per
CLAUDE.md's parent-validation rule), **then 409** (registry lookup). A cancel
against a nonexistent conversation is a 404 even though it is also
not-in-flight.

`cancelled` is `true` on every 200 response, because the not-registered case
is a 409 rather than a `false` body. The boolean is kept because the design
doc's API surface specifies it and because a future shared registry (see
Constraints) may legitimately return `false` for "cancel requested but the
owning worker had already finished". Do not repurpose it to mean anything
else in v1.

### Modified: `POST /conversations/{id}/messages` (spec 004)

The endpoint's request schema (`MessageCreate`), success response
(`ChatTurnRead`), 404, 422, and 502 behaviours are all unchanged. What
changes:

1. **New 409 response.** After the 404 check and before storing the user
   message:

   ```python
   if conversation_id in _inflight:
       raise HTTPException(409, "A generation is already in progress for this conversation.")
   ```

2. **The provider call becomes a task.** Where 004 had
   `result = await logged_chat(...)`, it now has:

   ```python
   task = asyncio.create_task(logged_chat(...))   # same arguments as 004/006
   _inflight[conversation_id] = task
   try:
       result = await task
   finally:
       if _inflight.get(conversation_id) is task:
           del _inflight[conversation_id]
   ```

   The identity guard matters: without it, a `finally` running late could
   delete a *newer* generation's registration.

3. **`CancelledError` propagates.** The endpoint adds no
   `except asyncio.CancelledError` handler of its own — the `finally` above is
   the entire cleanup, and the exception continues outward. Nothing after the
   `await` (assistant-message store, `updated_at` bump, titling schedule,
   response construction) executes.

4. **No change to the `ProviderError` → 502 path**, which still runs because
   `await task` re-raises the provider exception exactly as a direct await
   did.

**Client-visible consequence of a cancelled `POST /messages`** (load-bearing
for spec 011): `CancelledError` is a `BaseException`, so Starlette's
`ServerErrorMiddleware` (which catches `Exception`) does not convert it into
a 500. It propagates to the ASGI server, which abandons the response and
closes the connection. The browser sees an aborted/incomplete response and
the `fetch` promise **rejects** with a `TypeError` ("network error" /
"Failed to fetch") — there is **no status code to branch on**. Spec 011 must
treat "I just clicked Cancel, and my `sendMessage` promise rejected" as the
expected, non-scary path, distinguished by a client-side "cancel requested"
flag rather than by inspecting the error.

### Modified: `logged_chat()` (spec 006)

006 shipped the success and error branches; 009 completes the cancelled
branch:

```python
except asyncio.CancelledError:
    completed_at = utcnow()
    event = build_event(
        status="cancelled",
        input_tokens=None, output_tokens=None, output_text=None,
        error_type=None, error_message=None,
        completed_at=completed_at,
        latency_ms=int((completed_at - requested_at).total_seconds() * 1000),
        ...                                  # everything else as on success
    )
    publish_fire_and_forget(event)           # asyncio.create_task — NEVER awaited here
    logger.info("Generation cancelled: request_id=%s conversation_id=%s", request_id, conversation_id)
    raise                                    # bare re-raise, FR9
```

Two rules that are easy to get wrong and must be honoured literally:

- **Do not `await` anything in this branch.** Awaiting inside a coroutine
  that is being cancelled immediately raises `CancelledError` again, and the
  event would never be published. Publish by scheduling a task.
- **The publish task must be strongly referenced** (006's module-level set of
  pending publish tasks, with a `add_done_callback(discard)`). A task created
  from a dying coroutine is otherwise a prime candidate for garbage
  collection before it runs.

If 006 implemented the emission in a `finally` block rather than per-except
branches, keep that shape and derive `status` from what happened — the
requirement is the emitted event, not the syntax.

## Constraints

- **The registry breaks with more than one uvicorn worker. This is the
  sharpest known limitation of the whole system** (design doc, "Production &
  scale review"). `_inflight` lives in one process's memory. With
  `--workers N`, the cancel request is load-balanced independently of the
  chat request, so it lands in the wrong process roughly `(N-1)/N` of the
  time and returns a spurious **409 "no generation in progress"** while the
  generation continues to completion in another worker — the user is told
  nothing was cancelled *and* still gets billed for the reply. The same flaw
  makes the concurrent-send 409 unreliable in the other direction: two
  workers each think nothing is in flight.
  - **Production fix (deliberately NOT built in v1):** either a shared
    registry — Redis `SETEX conversation:{id}:inflight`, with cancellation
    published on a Redis channel that the owning worker subscribes to — or a
    DB cancellation flag (`conversations.cancel_requested`) that the
    generation task polls between streamed chunks, which works without a
    second datastore but only once streaming (012) gives it a polling point.
  - **Why deferring is right:** v1 is a single-process dev server
    (`make backend` runs `uvicorn --reload`, one worker) with one user. Both
    fixes require infrastructure or a schema change that buys nothing at that
    scale. **What the implementer owes instead: a prominent module-level
    docstring on the registry saying exactly this, and a line in the README
    (013).** Do not add Redis. Do not add a column. Do not add a
    `--workers` flag to the Makefile.
- **Do not introduce a background thread, a lock, or a semaphore** around the
  registry. The event loop is single-threaded and there is no `await` between
  the membership check and the insertion (the intervening work — the 404
  query and the user-message write — uses the synchronous SQLAlchemy session),
  so the check-then-act is atomic *within this process*. If a future change
  inserts an `await` between them, the race is back; note this in a comment.
- **Registry placement:** module-level in the module that owns
  `POST /conversations/{id}/messages` (assumed
  `backend/app/routers/messages.py` from 004; if 004 put it elsewhere, follow
  it there). The cancel endpoint goes in the **same file**, so both share the
  dict by plain module scope with no import cycle and no new module. Do not
  create an `app/inflight.py` for a dict used in one file — CLAUDE.md's
  no-premature-abstraction rule.
- No auth on cancel (project default): any caller can cancel any
  conversation's generation. Single anonymous user; noted, not fixed.
- No new dependency for the implementation. `make lint` clean before done.

## Error handling and edge cases

Design-doc edge cases by number, plus the ones specific to this feature.

| # | Case | Exact behaviour |
|---|------|-----------------|
| **3** | Second message sent while one is in flight for the same conversation | **409**, `"A generation is already in progress for this conversation."` Raised before the user message is stored, so history is untouched and the in-flight generation is unaffected. |
| **4** | Cancel when nothing is in flight | Conversation exists, key absent → **409**, `"No generation in progress for this conversation."` No side effects. |
| **5** | Cancel races completion (response already finished) | Identical to #4: the chat endpoint's `finally` removed the key the instant the await returned, so cancel finds nothing → **409**. **The completed assistant message stands** — it is already committed and is returned to the original caller normally. Cancel never deletes a stored message. |
| **12** | Titling call fails or is slow | Owned by spec 008; unrelated to the registry. Titling calls are **not** registered in `_inflight` (they are background tasks with no user-facing cancel), so a slow title never blocks a send with a spurious 409. Make sure the `add_task` in 008 stays outside the registry. |
| **13** | Auto-title completes/overwrites | Owned by spec 008. Interaction here: a **cancelled** first turn stores no assistant message, so no titling is scheduled (FR11) and the conversation keeps `"New conversation"` until a turn completes. |
| — | **Cancel on a nonexistent conversation** | **404** `"Conversation not found."` — checked before the registry, so a stale client cancelling a bogus id gets 404, never 409. |
| — | **Cancel called twice** | While the key is still registered (the aborted task has not finished unwinding), the second call also returns **200**; `Task.cancel()` on an already-cancelling task is a documented no-op and must not be treated as an error. Once the `finally` has removed the key, further cancels return **409**. Both are correct; which one a real client observes is timing-dependent, and that is acceptable for an advisory operation. Do not add a "already cancelling" third status. |
| — | **Process restarts with tasks in the registry** | `_inflight` is memory-only, so it is empty after a restart. The tasks themselves died with the process: no assistant message was stored, the user message survives in the DB, and **no `cancelled` log is emitted** — the `except`/`finally` never ran, so that turn leaves a silent gap in `inference_logs` (a chat call with no terminal event). This is an accepted v1 loss, of the same family as edge case 7's dropped events; the shared-registry/DB-flag fix above also closes it. A cancel arriving after the restart returns **409**. Document the gap; do not build a startup reconciliation pass. |
| — | Cancel while the user message is being written (before registration) | Key not yet present → **409**. The generation proceeds. A sub-millisecond window at v1 scale; the client can cancel again once the request is genuinely in flight. |
| — | Provider errors and cancel arrives at the same moment | Whichever resolves first wins. If the provider raised, the endpoint returns 502 and `logged_chat()` emitted `status="error"`; the late cancel gets 409. Exactly one terminal log event either way — never two. |
| — | Cancel on a conversation that has never had a message | Conversation exists, key absent → **409**. Not a 404. |
| — | `task.cancel()` on a task that is already `done()` | Returns `False`; the endpoint still responds **200** with `cancelled: true` (the key was present, which is the documented precondition). Do not branch on the return value of `cancel()`. |

Response bodies use the existing `ErrorResponse` schema; 404/409 are raised
as `HTTPException` from the router. No new handler in
`app/core/errors.py` is needed — `CancelledError` is deliberately *not*
translated into a response (FR10).

## Acceptance criteria

Tests use the `client` fixture from `tests/conftest.py`. **No real provider
calls, ever.** Two stubbing layers are needed:

- **Provider stub** — as in 008: `app.dependency_overrides` if 004 exposed
  `get_provider`, otherwise monkeypatch the module attribute. For the
  registry-level tests a plain instant-returning fake is enough.
- **Controllable slow fake provider** — for the true in-flight tests, a fake
  whose `complete()` does `await release_event.wait()` on an
  `asyncio.Event` the test controls, so the test can (a) observe the
  registration, (b) cancel, and (c) prove the fake never returned a result.
  It should also record whether it was cancelled (`except CancelledError:
  self.aborted = True; raise`) to prove FR6's abort actually reached the
  provider layer.
- **Publisher stub** — an in-memory recorder, so cancelled events can be
  asserted without HTTP.

Two test styles, because `TestClient` is synchronous and cannot issue a
cancel while a `client.post()` is blocked in the same thread:

- **Sync (`client` fixture)** — everything that does not need a genuinely
  concurrent request. Seed `_inflight[conv_id]` with a stub object exposing a
  recording `.cancel()` to exercise 200/409/404 and the concurrent-send 409
  deterministically.
- **Async** — the genuine abort path, via
  `httpx.AsyncClient(transport=ASGITransport(app=app))` with
  `asyncio.gather(send, cancel)` and the slow fake. This needs an async test
  runner (`pytest-asyncio` or `anyio`) as a dev dependency — see Open
  questions.

Checklist:

- [ ] `POST /conversations/999/cancel` on a nonexistent conversation → **404**.
- [ ] Cancel on an existing conversation with nothing registered → **409**,
      detail mentions "No generation in progress"; a `GET` of the
      conversation shows it unchanged.
- [ ] With `_inflight[conv_id]` seeded with a stub: cancel → **200**, body
      `{"conversation_id": conv_id, "cancelled": true}`, and the stub's
      `.cancel()` was called exactly once.
- [ ] With `_inflight[conv_id]` seeded: `POST /conversations/{id}/messages` →
      **409** concurrent-send, and `GET /conversations/{id}/messages` shows
      **zero** new messages (the user message was not stored).
- [ ] Second cancel while the key is still seeded → **200** again (not an
      error); after removing the key → **409**.
- [ ] *(async)* Send with the slow fake, wait until `conv_id in _inflight`,
      cancel → 200; then assert all of: the fake recorded `aborted == True`;
      `GET .../messages` contains the user message and **no** assistant
      message; `_inflight` no longer contains the key; a subsequent send
      (with the fast fake) succeeds with 200.
- [ ] *(async)* The same run emits exactly one event with
      `status="cancelled"`, `call_type="chat"`, the right `conversation_id`,
      null `input_tokens`/`output_tokens`/`output_text`, and a
      `latency_ms >= 0`. Assert via the recorder or
      `GET /logs?conversation_id={id}&status=cancelled` (spec 007).
- [ ] *(async)* The cancelled `POST /messages` call itself does not return a
      normal response — assert the client call raises (wrap in
      `pytest.raises`; the exception may arrive as `CancelledError` or as the
      transport's connection error depending on the runner, so assert on
      "it raised", not on a specific class).
- [ ] *(async)* A cancelled **first** turn leaves the title as
      `"New conversation"` and emits no `call_type="title"` log (FR11,
      interaction with 008).
- [ ] `conversation.updated_at` is unchanged after a cancelled turn.

## Files to be changed

| File | Purpose |
|---|---|
| `backend/app/routers/messages.py` | The `_inflight` registry + its limitation docstring; the concurrent-send 409 check; wrapping `logged_chat()` in `asyncio.create_task` with registration and `finally` removal; the new `POST /conversations/{id}/cancel` handler. (Use whichever router file 004 put the chat endpoint in; both endpoints and the registry live together.) |
| `backend/app/schemas.py` | Add `CancelResult`. No other schema changes. |
| `backend/app/sdk/…` (the module 006 created for `logged_chat()`) | Complete the `CancelledError` branch: emit `status="cancelled"` with null tokens/output, fire the publish as a task without awaiting, log, re-raise. Do not create a second SDK module. |
| `backend/tests/test_cancellation.py` | Coverage for the checklist above, incl. the slow-fake provider. *Created only via the `generate-tests` skill, when the user invokes it.* |
| `backend/pyproject.toml` | Possibly `uv add --dev pytest-asyncio` for the async tests — **only** during a `generate-tests` invocation, not during implementation. |

Explicitly **not** changed: `backend/app/models.py`,
`backend/alembic/versions/` (no migration), `backend/app/core/errors.py` (no
`CancelledError` handler — the propagation is intentional),
`backend/app/core/config.py` (no new setting), `frontend/src/*` (spec 011
owns the cancel button and `cancelGeneration()` in `api.ts`).

## Feature-specific rules

**Registry docstring — the implementer must write something equivalent to
this, at the definition site:**

```python
# In-process registry of in-flight generations, keyed by conversation_id.
#
# KNOWN LIMITATION — the sharpest one in this system: this dict lives in a
# single process's memory. Running uvicorn with >1 worker breaks cancellation
# outright — the cancel request may land in a worker that has no entry for the
# conversation and will answer 409 while the generation continues (and keeps
# billing) in another worker. The concurrent-send 409 is equally unreliable.
# Production fix: a shared registry (Redis key + pub/sub cancel channel) or a
# DB cancellation flag polled by the generation task once streaming (012)
# provides a polling point. Deliberately NOT built in v1: single-process dev
# server, single user, and both fixes cost infrastructure that buys nothing at
# this scale. Documented here and in the README rather than hidden.
_inflight: dict[int, asyncio.Task] = {}
```

**Never-swallow compliance for `CancelledError`.** Two distinct reasons, both
of which must be respected:

1. *CLAUDE.md* — an `except` block logs with context and either re-raises or
   returns a clear error response. Here it logs and re-raises.
2. *asyncio correctness* — swallowing `CancelledError` makes the task
   "uncancellable": `await task` would resume normally, the endpoint would
   store an assistant message from a half-abandoned call, and `task.cancel()`
   would silently do nothing. A bare `raise` is mandatory; never
   `raise CancelledError()` (which loses the original) and never `return`.

**Registration ordering is a hard requirement.** Register *before* the first
`await` on the task. Registering after the await is the bug that makes cancel
silently useless for the entire duration of the call — the key only appears
once the call is already done.

**Cancel never mutates chat data.** No message deletion, no
`conversation.updated_at`, no status flag. The cancel handler touches exactly
two things: the conversation-existence query (for the 404) and the registry.

**Do not add a client-disconnect handler.** Aborting the generation when the
browser closes the connection (`await request.is_disconnected()`) is a
different, tempting feature — it is not in scope, it interacts badly with the
explicit registry, and 011's UI drives cancellation through the endpoint.

## Open questions

- **Async test runner dependency.** Assumed the genuine in-flight abort test
  needs `uv add --dev pytest-asyncio` plus an `httpx.AsyncClient` +
  `ASGITransport` fixture alongside the existing sync `client` fixture in
  `tests/conftest.py`. Confirm before the `generate-tests` run — the
  alternative is testing only the registry seams synchronously (deterministic,
  no new dependency) and verifying the true abort manually, which leaves FR6
  untested.
- **`cancelled: false` is unreachable in v1.** Assumed the field stays in
  `CancelResult` (design doc's API surface, and a shared registry would
  make it meaningful) even though every 200 response sets it to `true`.
  Confirm before build if you'd rather drop the field and return
  `CancelResult{conversation_id}` alone.
