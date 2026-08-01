# 008 — Auto-generated conversation titles

Depends on: 006 (logging SDK / the instrumented provider), and therefore transitively on
003 (provider adapter) and 004 (chat endpoint).

## Problem statement

Every conversation is created with the title `"New conversation"` (spec 001),
so the conversation list (spec 010) is a wall of identical rows and a user
cannot tell their chats apart. After the first exchange the system has enough
context to name the conversation itself.

This also serves a second, deliberate purpose for the assignment: the titling
call is a *second kind of inference call*, made with a different (cheap) model
and much smaller `max_tokens`. Routing it through the same instrumented
provider path means `GET /logs` shows chat and title calls side by side, and the
per-call cost/latency/token differences between models become visible in real
data. Titling is the feature that proves the logging layer is
call-site-agnostic.

The naming must never be able to damage the chat: it happens after the reply
is already stored and returned, in the background, and every failure mode
degrades to "the title stays `New conversation`".

## Functional requirements

1. **FR1** — After the chat endpoint (004) has successfully stored *and
   committed* the assistant message of a turn, it schedules exactly one
   titling task for that conversation.
2. **FR2** — The task is scheduled only when **both** conditions hold at
   schedule time:
   (a) the conversation now has exactly **one** message with
   `role = "assistant"`, and (b) `conversation.title` is still exactly the
   default `"New conversation"`. If either is false, nothing is scheduled and
   the turn returns normally.
3. **FR3** — The titling call obtains its provider from `get_title_provider()`
   (spec 006 FR20), which returns a `LoggingChatProvider` bound to
   `call_type="title"`. With `conversation_id` passed, it produces exactly one
   `inference_logs` row that is visible in `GET /logs` alongside the chat
   call for the same conversation. There is no second emission point.
4. **FR4** — The call uses `settings.OPENAI_TITLE_MODEL` (default
   `gpt-5.6-luna`, defined in 003), `max_tokens = 32`, and
   `temperature = 0.0`, all as module constants in the titling module — not
   new settings. These values are captured into the log's `request_params`
   and `config_hash` by 006, which is exactly what makes the cheap-vs-chat
   model comparison visible. As in the chat path, `temperature` is **passed to
   `send_message()` and recorded, but never forwarded to the API** —
   `OpenAIProvider._build_request()` drops it because GPT-5-family models reject
   the parameter outright (spec 003, "Constraints").
5. **FR5** — The titling prompt has the fixed shape defined in
   "API contracts → internal task contract" below: a dedicated system prompt
   plus one user message containing the first user text and the first
   assistant text, each truncated to 500 characters.
6. **FR6** — The model output is sanitized by the exact algorithm in
   "Feature-specific rules" (strip → collapse whitespace → strip surrounding
   quotes → truncate to 40 characters, appending a single ellipsis character
   when truncation occurs) before it is stored.
7. **FR7** — The title is written with a single conditional UPDATE
   (`... SET title = :new WHERE id = :id AND title = 'New conversation'`), so
   a concurrent writer can never double-apply or clobber a non-default title.
   Zero rows updated is a normal, logged outcome — not an error.
8. **FR8** — On any failure (`ProviderError`, timeout, empty or
   whitespace-only output, output that sanitizes to an empty string, DB
   error), the conversation keeps the title `"New conversation"`, an
   `error`-status log with `call_type="title"` is emitted by the SDK,
   the failure is logged at ERROR with `conversation_id` context, and the
   chat turn is completely unaffected. **This is a hard requirement: the
   titling task must never raise into the chat request.**
9. **FR9** — The task opens and closes its **own** DB session. It must not
   receive, hold, or touch the request's session or any ORM instance loaded
   from it.
10. **FR10** — Exactly one titling attempt is made per conversation. No
    retries, no backoff, no second attempt on a later turn (FR2's assistant
    count check makes later turns ineligible anyway).
11. **FR11** — There is no new endpoint. The new title surfaces the next time
    the client calls `GET /conversations` (or `GET /conversations/{id}`).
12. **FR12** — The chat response body is unchanged: `ChatTurnRead` gains no
    title field, and the response is sent before the titling call starts.

## Non-functional requirements

- **Zero user-visible latency added to the reply.** The titling call starts
  only after the `ChatTurnRead` response body has been handed to the client.
- **No realtime.** No websockets, no SSE, no polling, no auto-refresh to
  "push" the new title — CLAUDE.md's out-of-scope default. The title appears
  on the next list refresh, which is a user action (spec 010's refresh /
  navigation). Do not add a poll loop to the frontend for this.
- **Cost.** One extra provider call per conversation (not per turn), on the
  cheap model, capped at 32 output tokens.
- **Log volume.** Titling adds exactly one `inference_logs` row per
  conversation — the "~1–2 rows per turn" figure in the design doc's NFRs.
- **Observability.** Both success (title applied / no-op) and failure paths
  emit an app log line with `conversation_id` and `request_id`.

## Data model

**No schema change. No new column. No Alembic migration for this feature.**

- `conversations.title` (spec 001) is **updated in place** by this feature.
  It is already `str`, required, defaulting to `"New conversation"`.
- No new table, no new column, no index change, no `Message` change, no
  `InferenceLog` change (005's `call_type` enum already includes `title`).
- If spec 001 inlined the string literal `"New conversation"` as the default,
  008 promotes it to a single module-level constant
  `DEFAULT_CONVERSATION_TITLE = "New conversation"` next to the
  `Conversation` model and makes 001's default reference it. That is a
  Python-level refactor of a default value already present in the DB schema —
  **still no migration**, and the implementer must confirm `alembic
  autogenerate` produces nothing before considering the change done.

## API contracts

**There is no new HTTP endpoint in this spec, and no existing response schema
changes.** `ConversationRead` already carries `title`; `ChatTurnRead` is
untouched. The only externally observable effect is that a subsequent
`GET /conversations` / `GET /conversations/{id}` may return a different
`title` for a conversation whose first turn has completed.

### Internal task contract

```python
# backend/app/titling.py

DEFAULT_CONVERSATION_TITLE = "New conversation"   # imported from models
TITLE_MAX_TOKENS = 32
TITLE_TEMPERATURE = 0.0
TITLE_MAX_LEN = 40
TITLE_CONTEXT_CHARS = 500

TITLE_SYSTEM_PROMPT = (
    "You write short titles for chat conversations. "
    "Reply with the title only — 3 to 6 words, at most 40 characters, "
    "no surrounding quotes, no trailing punctuation, no explanation."
)

async def generate_title(
    conversation_id: int,
    user_text: str,
    assistant_text: str,
) -> None:
    """Fire-and-forget. Never raises. Never returns a value."""
```

Contract rules the implementer must follow literally:

- **Plain values only.** `user_text` / `assistant_text` are `str` copied out
  of the ORM objects *inside* the request, before it ends. Never pass a
  `Message`, a `Conversation`, or a `Session` — they are detached/closed by
  the time the task runs (`DetachedInstanceError` is the failure you get).
- **Signature is `-> None` and it never raises.** The entire body is wrapped
  so that no exception escapes; see FR8.
- The rendered user message sent to the provider is exactly:

  ```
  Title this conversation.

  User: {user_text[:500]}
  Assistant: {assistant_text[:500]}
  ```

- The provider call is made as:

  ```python
  provider = get_title_provider()          # already instrumented, call_type="title"
  result = await provider.send_message(
      [{"role": "user", "content": rendered}],
      system=TITLE_SYSTEM_PROMPT,
      model=settings.OPENAI_TITLE_MODEL,
      max_tokens=TITLE_MAX_TOKENS,
      temperature=TITLE_TEMPERATURE,
      conversation_id=conversation_id,
  )
  ```

  Adapt argument names to the exact `ChatProvider.send_message()` signature 006
  shipped. **Do not import `CallRecorder`, `InferenceLogEvent`, a publisher, or
  anything else from `app.logging_sdk` in this module, do not add a parameter
  the interface does not define, and do not build a second wrapper** — the
  `call_type="title"` labelling is bound inside `get_title_provider()`, which is
  the only place that decision is made.

### Scheduling contract (change to spec 004's endpoint)

`POST /conversations/{id}/messages` gains a `background_tasks: BackgroundTasks`
parameter and, after the commit that stores the assistant message:

```python
assistant_count = message_repo.count_by_role(conversation_id, MessageRole.ASSISTANT)
if should_title(assistant_count, conversation):          # FR2, both checks
    background_tasks.add_task(
        generate_title,
        conversation_id=conversation.id,
        user_text=user_message.content,     # plain str, read before the request ends
        assistant_text=assistant_message.content,
    )
```

`should_title` is a pure function (`assistant_count: int, conversation: Conversation) ->
bool`) — it takes an already-fetched count rather than a `Session`, per CLAUDE.md's data
access layer convention (routers/domain modules don't touch `db` directly; only
repositories do). `MessageRepository` gains a `count_by_role(conversation_id, role)`
query method for this.

No other change to 004's flow, response, or status codes.

## Constraints

- **Background mechanism: FastAPI `BackgroundTasks`.** Chosen over
  `asyncio.create_task()`.
  - *Why:* Starlette awaits background tasks as part of the response cycle
    after the body is sent, so (a) the task cannot be garbage-collected
    mid-flight — the classic `create_task` footgun where nothing holds a
    strong reference to the task and it vanishes — and (b) `TestClient` runs
    it synchronously before `client.post()` returns, which makes the feature
    deterministically testable without any async orchestration.
  - *Tradeoff to accept and state in the PR:* the worker's request cycle
    stays open until titling finishes (~1s on the cheap model), so under
    concurrency it holds a worker slot slightly longer than a detached task
    would. Acceptable at v1's single-user scale. The production fix is a real
    task queue (Celery/arq/Kafka consumer), **not** `create_task` — do not
    build one here.
- **Own session, obtained late-bound.** The task body must do:

  ```python
  from app import db as db_module
  ...
  session = db_module.SessionLocal()
  try:
      ...
  finally:
      session.close()
  ```

  Not `Depends(get_db)` (there is no request to depend on) and **not**
  `from app.db import SessionLocal` — the module-attribute lookup at call
  time is what lets `tests/conftest.py` point the task at the in-memory test
  DB. Without this, the background task silently writes to the developer's
  real `app.db` during tests.
- Single-store rule: SQLite only. No queue, no Redis, no cache.
- `get_title_provider()` from 006 is the only way this module obtains a
  provider. No direct `AsyncOpenAI` use, no `OpenAIProvider` import (it is not
  exported), and no `app.logging_sdk` import.
- No new settings. `OPENAI_TITLE_MODEL` already exists from 003; the
  token/temperature/length numbers are module constants.
- No new dependency.
- `make lint` clean before the change is done.

## Error handling and edge cases

Design-doc edge cases by number, plus the ones specific to this feature.

| # | Case | Exact behaviour |
|---|------|-----------------|
| **12** | Titling call fails or is slow (provider error, 5xx, rate limit, `PROVIDER_TIMEOUT_SECONDS` exceeded) | The SDK emits a `status="error"`, `call_type="title"` log with `error_type`/`error_message` and null tokens; `generate_title` catches `ProviderError`, logs at ERROR with `conversation_id`, returns. Title stays `"New conversation"`. **The chat turn already returned 200 and is untouched.** |
| **13** | Auto-title completes and overwrites something | v1 has no rename endpoint, so the only value it can overwrite is the default — and the conditional UPDATE (FR7) guarantees that: if `title != "New conversation"` at write time, 0 rows update and the task logs "title already set, skipping". Auto-title simply wins on a fresh conversation. When a rename feature lands, this UPDATE already protects a user-chosen title with no change. |
| **3** | Second message sent while one is in flight | Rejected with 409 by spec 009 before any message is stored, so a conversation cannot produce two concurrent "first assistant messages". 008 relies on this only as belt-and-braces — FR7's conditional UPDATE is the actual guarantee, and it holds even with 009 absent. |
| **4** | Cancel with nothing in flight | Not applicable to titling (409, spec 009). No titling interaction. |
| **5** | Cancel races completion | If the assistant message was stored, the turn completed normally and titling is scheduled as usual; the later 409 from cancel does not un-schedule or affect it. |
| — | **First turn errored** (provider 502) | No assistant message was stored, so FR2's assistant-count check is 0 and **nothing is scheduled**. The next successful turn *is* the first assistant message, and titling fires then. This is correct and intentional. |
| — | **First turn cancelled** (spec 009) | Same as above: no assistant message stored → no titling. The user's retry produces the first assistant message and titles then. |
| — | Model returns empty / whitespace-only / all-punctuation output | Sanitization yields `""` → treated as a failure: title unchanged, ERROR log line. Note the inference log itself is `status="success"` (the provider call *did* succeed) — the sanitizer rejection is an app-level log line, not a fake error status. State this in the code comment; do not fabricate an error status for a successful call. |
| — | Model returns a long paragraph | Whitespace-collapsed and truncated to at most 40 chars, appending a single ellipsis character when truncated. No word-boundary logic. |
| — | Model wraps the title in quotes or smart quotes | Stripped by the quote rule; nested/doubled quotes handled by the bounded 3-iteration loop. |
| — | Conversation deleted between scheduling and the task running | v1 has no delete endpoint. If the row is missing, the conditional UPDATE affects 0 rows; log and return. No 404, no raise — there is no HTTP caller. |
| — | Race: two writers both try to title | Impossible-by-409 in practice (edge 3); made safe regardless by the single-statement compare-and-set. Last writer only wins if the title is still the default; otherwise it no-ops. |
| — | Publisher/ingestion unreachable while titling | 006's publisher already swallows-and-logs at its own boundary. The title still applies. Edge case 7, unchanged. |
| — | `should_title` query itself fails | Wrapped in the same try/except as the rest of the post-store block in 004; log at ERROR, skip scheduling, return the turn normally. A titling bug must never turn a successful chat into a 500. |

Nothing in this feature returns an HTTP error, because nothing in this feature
is reachable over HTTP.

## Acceptance criteria

Tests use the `client` fixture from `tests/conftest.py`. **They must never
make a real provider call**; stub as follows:

- **Provider:** stub at the seam 004/006 exposed — `app.dependency_overrides`
  if the provider is a `Depends(get_provider)`, otherwise monkeypatch the
  provider attribute on the chat module. The fake returns a canned
  `ProviderResult` whose `content` differs for the chat call and the title
  call (dispatch on `model` or `call_type`).
- **Publisher:** stub `EventPublisher` with an in-memory recorder that
  appends events to a list, so no HTTP is attempted and assertions can be
  made directly on the emitted event. (Alternatively assert against the
  `inference_logs` rows, since ingestion lives in the same app.)
- **Session:** `conftest.py` must also point `app.db.SessionLocal` at
  `TestingSessionLocal` (monkeypatch the module attribute) so the background
  task uses the in-memory DB. Without this the titling assertions read a
  different database than the one the test wrote to.
- **Timing:** none needed — `TestClient` executes `BackgroundTasks`
  synchronously before `client.post()` returns, so assertions can be made
  immediately after the POST.

Checklist:

- [ ] POST a first message to a fresh conversation → response is 200 and
      `ChatTurnRead`-shaped; afterwards `GET /conversations/{id}` returns the
      sanitized fake title, not `"New conversation"`.
- [ ] The same flow emits **two** logs for the conversation: one with
      `call_type="chat"` and one with `call_type="title"`, both
      `status="success"`, both carrying the conversation's id. Assert via
      `GET /logs?conversation_id={id}` (spec 007) or the recorder.
- [ ] The `title` log's `model` equals `settings.OPENAI_TITLE_MODEL` and
      its `request_params` show `max_tokens == 32`, distinguishing it from the
      chat log's model and `max_tokens`.
- [ ] POST a **second** message to the same conversation → no additional
      `call_type="title"` log is emitted, and the title from turn 1 is
      unchanged (FR2 assistant-count check).
- [ ] Conversation whose title was set to something non-default before the
      first turn → after the first turn, the title is unchanged and no title
      log is emitted (FR2 title check).
- [ ] Fake provider raises `ProviderError` **on the title call only** → chat
      response is still 200 with the assistant message stored, the title is
      still `"New conversation"`, and a `call_type="title"`, `status="error"`
      log exists.
- [ ] Fake provider raises `ProviderError` on the **chat** call → 502, no
      assistant message, and **no** `call_type="title"` log at all.
- [ ] Sanitizer unit checks (pure function, no client needed):
      `'"Trip to Japan"'` → `Trip to Japan`;
      `"  Trip\n  to  Japan  "` → `Trip to Japan`;
      a 60-character string → at most 40 characters, ending in a single
      ellipsis character with no trailing space before it;
      `""`, `"   "`, `"\n"` → `None` (rejection sentinel).
- [ ] Title is not applied when the conversation's title is no longer the
      default at write time: set the title mid-test (or pre-set it) and assert
      the conditional UPDATE no-ops rather than overwriting.

## Files to be changed

| File | Purpose |
|---|---|
| `backend/app/titling.py` | **New.** `DEFAULT_*`/`TITLE_*` constants, `TITLE_SYSTEM_PROMPT`, `render_title_prompt()`, `sanitize_title()`, `should_title()` (pure function over an already-fetched count), and the `generate_title()` background task (own session, never raises). |
| `backend/app/routers/messages.py` | Add the `BackgroundTasks` parameter and the count-fetch → `should_title` → `add_task` block after the assistant-message commit. (Use whichever router file spec 004 put `POST /conversations/{id}/messages` in — do not create a second one.) |
| `backend/app/repositories/messages.py` | Add `count_by_role(conversation_id, role)` so the router never touches `db` directly (CLAUDE.md's data access layer convention). |
| `backend/app/models.py` | Add/expose `DEFAULT_CONVERSATION_TITLE` constant and make the `Conversation.title` default reference it. **No column change, no migration.** |
| `backend/tests/conftest.py` | Point `app.db.SessionLocal` at `TestingSessionLocal` so background tasks use the in-memory DB. *Created/edited only via the `generate-tests` skill, when the user invokes it.* |
| `backend/tests/test_titling.py` | Coverage for the acceptance criteria above. *Created only via the `generate-tests` skill, when the user invokes it.* |

Explicitly **not** changed: `backend/app/schemas.py` (no new schema),
`backend/alembic/versions/` (no migration), `backend/app/core/config.py`
(no new setting), `frontend/src/*` (the title arrives through the existing
`ConversationRead`; no new api.ts function, no polling).

## Feature-specific rules

**Sanitization algorithm — implement exactly this, in this order.**
`sanitize_title(raw: str | None) -> str | None`, returning `None` to mean
"reject, keep the default title":

1. `if raw is None: return None`
2. `text = raw.strip()`
3. `text = re.sub(r"\s+", " ", text)` — collapses newlines, tabs, and runs of
   spaces into single spaces.
4. Strip surrounding quotes, **up to 3 iterations**: while
   `len(text) >= 2` and `text[0]` and `text[-1]` form a matching pair from
   `{" ", ' '}` plus the smart pairs `“ ”` and `‘ ’` (also accept the same
   straight quote on both ends), drop both characters and `.strip()` again.
5. `if len(text) > 40: text = text[:39].rstrip() + "…"` — soft truncate to a
   single character budget of 40: keep the first 39 characters, strip
   trailing whitespace, then append one ellipsis character (`"…"`, U+2026).
   The result is always ≤ 40 characters. No word-boundary logic.
6. `if not text: return None`
7. `return text`

**Trigger detection — both checks, then a compare-and-set.**

- *At schedule time* (`should_title(assistant_count, conversation)`, inside the
  request): the router fetches the count via
  `MessageRepository.count_by_role(conversation_id, MessageRole.ASSISTANT)` —
  `SELECT COUNT(*) FROM messages WHERE conversation_id = :id AND role = 'assistant'`
  — which must equal `1`, **and** `conversation.title == DEFAULT_CONVERSATION_TITLE`.
  Both, not either. `should_title` itself stays a pure function over the fetched
  count and the conversation, not a `Session` — the query lives in the
  repository per CLAUDE.md's data access layer convention. The count query is
  cheap and served by the
  `(conversation_id, created_at)` index from 002.
- *At write time* (inside the task, own session): do **not** re-read and
  branch in Python. Issue one statement:
  `UPDATE conversations SET title = :new, updated_at = updated_at WHERE id = :id AND title = :default`,
  then `commit()`, and branch on `rowcount`. `rowcount == 0` means someone
  else already titled it (or the row is gone) → log at INFO and return.
  This is CLAUDE.md's "don't rely on application-level check-then-act" applied
  to a title race.
- Do **not** bump `updated_at` when applying the title. Titling is a system
  action, not user activity, and bumping it would reorder the conversation
  list under the user for no reason.

**Never-swallow compliance.** `generate_title` must not contain
`except Exception: pass`. The required shape is:

```python
try:
    ...
except ProviderError as exc:
    logger.error("Titling failed for conversation %s: %s", conversation_id, exc)
    return                      # degraded, not swallowed — the log row is the record
except Exception:
    logger.exception("Unexpected titling failure for conversation %s", conversation_id)
    return                      # must not propagate: it would surface as an
                                # unhandled task error after a 200 response
finally:
    session.close()
```

The broad `except Exception` is justified *here specifically* because the
caller is a background task with no HTTP response to return and a hard
requirement never to affect the chat turn — it logs with full context
(`logger.exception`) and returns, which satisfies the never-swallow rule.
This justification belongs in a comment in the code.

**One emission point.** This feature adds no logging code at all. If you find
yourself writing `InferenceLogEvent(...)`, importing `CallRecorder`, or calling
a publisher in `titling.py`, stop — the provider returned by
`get_title_provider()` already logs, and `CallRecorder` is the only thing
allowed to build an event.

## Open questions

Resolved during implementation (2026-08-01):

- **Title length: soft ~40 with ellipsis** — chosen over a hard 30 with no
  ellipsis. `TITLE_MAX_LEN = 40`; `sanitize_title` appends a single `"…"`
  character when truncating, so `ConversationRead.title` is always ≤ 40
  characters. See "Feature-specific rules" for the exact algorithm.
- **`TITLE_TEMPERATURE = 0.0`** — confirmed as specified (titles are
  low-variance and this keeps the title call's `request_params` visibly
  different from the chat call's `temperature` in the logs).
- **Sanitizer rejection does not force an `error`-status log** — confirmed as
  specified. The log reflects provider truth (`success`, since the call
  succeeded); the rejection is an app-level ERROR line only.
