# 012 — Streaming: SSE Assistant Responses + TTFT

Depends on: **004** (chat endpoint — window construction, user-message
commit ordering, `ProviderError` taxonomy), **006** (logging SDK —
`CallRecorder`, `InstrumentedProvider`, `InferenceLogEvent`), **010**
(frontend chat page — this spec replaces its send flow). Transitively needs
**003** (provider adapter) and **009** (frontend foundation,
`request<T>`/`ApiError`).

**Cancellation is not part of this project.** There is no in-flight registry,
no `POST /conversations/{id}/cancel` endpoint, and no send↔cancel UI anywhere
in the codebase to interact with — a prior cancellation spec was descoped
before being built. This spec's own concurrency guard (FR14) is entirely
self-contained and does not assume or depend on any such feature — see
"Cancel is explicitly out of scope" below.

## Problem statement

Every prior chat spec (004, and 010's UI for it) waits for the full
completion before showing anything: the user stares at "Assistant is
responding" for however long the model takes, then the whole reply appears
at once. This spec makes the reply appear token-by-token as the provider
generates it, over Server-Sent Events, for both the backend (a new streaming
endpoint) and the frontend (the chat page renders growing text instead of a
static pending state).

It also turns on a metric the schema has been carrying since spec 005:
`inference_logs.time_to_first_token_ms` — "Null until spec 012 (streaming).
Column ships now on purpose." This spec is that purpose. No migration is
needed; this is a data backfill going forward, exactly as the design doc
promised.

### What changed since the design doc's framing, and why

The design doc's original feature-breakdown entry for this spec read: *"SSE
streaming of assistant responses end-to-end (backend + frontend), cancel
integrated with the stream, SDK starts measuring and emitting
`time_to_first_token_ms`."* The cancel-integration clause is stale: the
cancellation feature it referred to was descoped from the project before
being built, so there is nothing to integrate a stream with.

**No cancel mechanism of any kind is in this spec.** This spec adds no
mechanism to abort a stream in progress, no client disconnect detection, and
no DB cancellation flag. The consequence (see "Decisions confirmed with the
user" below) is that **there is no Cancel button**: spec 010's send↔cancel
morph, `cancelGeneration`, and `cancelRequestedRef` wiring do not exist to
begin with, so the chat page's send handler is simply rewritten around the
streaming call with no cancel affordance to remove. A future spec could
introduce a stream-aware stop; that is out of scope here.

### Explicitly out of scope

- **No cancel/stop of any kind for a streaming turn.** See above. The
  Composer simply disables while a stream is open — no second control
  appears.
- **Spec 004's non-streaming endpoint is untouched and keeps working** —
  useful for API consumers, and it's what titling (008) and any future
  non-UI caller still use. The chat page just stops calling it.
- **Token/cost accuracy is not improved.** `input_tokens`/`output_tokens`
  are populated for a streamed call exactly as before (from the provider's
  final usage payload, when the streaming API still supplies one) — this
  spec's new metric is TTFT, not a token-accounting rework.
  `PRICE_MAP`-based `cost_usd` computation is unaffected.
  *(Ingestion computes `cost_usd`; see spec 005 — nothing here changes
  that.)*
- **No markdown rendering beyond 010's FR12 fenced-code split.** Streaming
  doesn't change what's interpreted, only when the text arrives.
  *(Feature list, not needing a citation — this is 010's own boundary,
  restated because streaming text tempts scope creep here.)*
- **No new datastore, no websockets** (CLAUDE.md defaults). SSE over the
  existing HTTP connection, one direction, no ack channel.
- **Titling (008) is not streamed.** It stays a single non-streaming call
  through `get_title_provider()`; only the chat call type streams.

## Decisions confirmed with the user

Six architecture questions were open enough that the design doc and prior
specs didn't settle them; each was confirmed before drafting:

1. **Endpoint shape** — a **new dedicated endpoint**,
   `POST /conversations/{id}/messages/stream`, not content-negotiation on
   the existing path. 004's endpoint is unmodified.
2. **Frontend adoption** — **streaming only**. `ChatPage.tsx` always sends
   via the new streaming call; 010's `sendMessage` call is removed from the
   page (the function can stay in `api.ts` since CLAUDE.md requires one
   typed function per backend endpoint, but nothing in the UI calls it
   anymore).
3. **Stop control** — **none**. No client-only "stop rendering" button
   either — that was considered and rejected as confusing (it would look
   like a cancel without being one). The composer disables, full stop.
4. **Mid-stream provider failure** — **discard partial content**, matching
   004's existing contract: no assistant message is stored, the client
   drops whatever text had rendered, and the same "provider failed, your
   message was saved" notice from 010 appears.
5. **SDK extension shape** — a **new `stream_message()`** method on
   `ChatProvider`/`InstrumentedProvider`, sitting alongside the untouched
   `send_message()`. Titling and the non-streaming endpoint keep using
   `send_message()` unchanged.
6. **Concurrency guard** — **yes**, a minimal guard scoped to this spec (a
   single in-memory marker, `_streaming_inflight`) so a second streamed send
   to the same conversation still gets a 409.

Two smaller ones, also confirmed:

7. **Unclosed fenced code block while streaming** — renders as **plain
   text** until the closing ``` ` `` ` arrives (010's existing split logic,
   just re-evaluated on every chunk; no new "live code block" component).
8. **Titling trigger** — **unchanged**: fires the same
   `should_title()`/`generate_title()` background task once the full
   streamed reply is assembled and stored, exactly as 004/008 do today.

## Functional requirements

### Backend — provider layer

1. **FR1** — `ChatProvider` (`app/providers/base.py`) gains a new abstract
   method:

   ```python
   async def stream_message(
       self,
       messages: list[ProviderMessage],
       *,
       system: str,
       model: str,
       max_tokens: int,
       temperature: float,
       conversation_id: int | None = None,
   ) -> AsyncIterator[ProviderStreamChunk]:
   ```

   Same signature as `send_message`, same `ProviderError` contract, same
   "let `CancelledError` propagate untouched" contract. `send_message` is
   **not modified**.

2. **FR2** — New frozen dataclass in `app/providers/base.py`, alongside
   `ProviderResult`:

   ```python
   @dataclass(frozen=True)
   class ProviderStreamChunk:
       delta: str                         # "" allowed, esp. on the final chunk
       result: ProviderResult | None = None   # set ONLY on the last chunk
   ```

   `stream_message` yields zero or more chunks with `result=None` (each
   carrying the next slice of assistant text), followed by **exactly one**
   final chunk with `result` populated (a full `ProviderResult`, same shape
   `send_message` returns — `content` on it equals the concatenation of
   every `delta` yielded). The generator then ends normally
   (`StopAsyncIteration`); it does not yield anything after the final
   chunk.

3. **FR3** — `OpenAIProvider.stream_message()` calls
   `self._client.responses.create(..., stream=True)` (Responses API
   streaming). It iterates the returned event stream, yielding a
   `ProviderStreamChunk(delta=...)` for each text-delta event and, on the
   terminal completed event, one final `ProviderStreamChunk(delta="",
   result=self._map_response(final_response))` — reusing `_map_response`
   unchanged, so token counts, `stop_reason`, and `provider_metadata` are
   derived exactly as they are for the non-streaming path when the
   streaming API's terminal event carries the same `usage`/`status`
   shape as the non-streaming response. **Verify this during
   implementation** against the installed `openai` SDK version; if the
   terminal stream event's shape differs from the non-streaming
   `Response` object, adapt `_map_response`'s call site, not its body.
4. **FR4** — The same twelve `openai.*` exception types `send_message`
   maps (`APITimeoutError`, `APIConnectionError`, `RateLimitError`, …,
   `OpenAIError`) are caught around the streaming iteration in
   `stream_message` and raised as the same `ProviderError` taxonomy —
   duplicated, not shared via a helper, matching `send_message`'s existing
   style (no premature abstraction across the two methods).
5. **FR5** — `describe_call()` is reused unchanged for streaming calls —
   same arguments, same `CallContext`. No new describe method is needed
   for the request side.
6. **FR6** — New `describe_stream_outcome()` method on `ChatProvider`,
   mirroring `describe_outcome()`:

   ```python
   def describe_stream_outcome(self, chunks: list[ProviderStreamChunk]) -> CallOutcome:
       final = chunks[-1].result   # guaranteed non-None per FR2
       return self.describe_outcome(final)
   ```

   `OpenAIProvider` implements it exactly as above (one line, delegates to
   the existing `describe_outcome`). It exists as its own ABC method
   (rather than the SDK reaching into the last chunk itself) because the
   SDK must never assume anything about a provider's chunk shape — see FR8.

### Backend — logging SDK

7. **FR7** — `InstrumentedProvider` (`app/logging_sdk/contract.py`) gains
   two abstract methods, kept fully opaque (`Any`), preserving the "SDK
   imports nothing from `app.*`" rule:

   ```python
   @abstractmethod
   async def stream_message(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
       """The streaming call being instrumented. Yields opaque chunks in
       order; interpreted only by describe_stream_outcome."""

   @abstractmethod
   def describe_stream_outcome(self, chunks: list[Any]) -> CallOutcome:
       """Same role as describe_outcome, given every chunk stream_message
       yielded, in order."""
   ```

8. **FR8** — `CallRecorder` (`app/logging_sdk/recorder.py`) gains
   `invoke_stream()`, an async generator with the same one-event-per-call
   contract as `invoke()`:

   ```python
   async def invoke_stream(
       self, provider: InstrumentedProvider, *, call_type: str, **call_kwargs: Any,
   ) -> AsyncIterator[Any]:
   ```

   Behaviour:
   - Mints `request_id`, records `requested_at`/`started` exactly as
     `invoke()` does; calls `describe_call()` the same way.
   - Iterates `provider.stream_message(**call_kwargs)`. On the **first**
     chunk received (of any kind), records
     `ttft_ms = int((time.perf_counter() - started) * 1000)`.
   - Re-`yield`s every chunk to its own caller **unchanged** — the SDK
     never inspects, transforms, or drops a chunk; it only counts them and
     keeps a `list` of everything yielded (needed for FR9).
   - On normal exhaustion: `status = SUCCESS`, calls
     `self._safe_describe_stream_outcome(provider, request_id, chunks)`
     (new sibling to `_safe_describe_outcome`, same try/except-and-log
     shape) to get the `CallOutcome`.
   - On `asyncio.CancelledError`: `status = CANCELLED`, bare `raise` — same
     as `invoke()`. (Not expected to be user-triggered in v1 — see "Cancel
     is explicitly out of scope" — but the SDK's never-swallow contract
     doesn't get an exception for that.)
   - On any other `BaseException`: `status = ERROR`,
     `_safe_describe_failure(...)`, re-raise — same as `invoke()`.
   - `finally`: builds and publishes **exactly one** `InferenceLogEvent`,
     identical field-for-field to `invoke()`'s, **plus**
     `time_to_first_token_ms=ttft_ms` (which is `None` if the stream
     failed before yielding a single chunk — e.g. an auth error on the
     first request). Same "never `await` in this block" and
     "fire-and-forget via `_schedule_publish`" rules as `invoke()`.
9. **FR9** — `LoggingChatProvider.stream_message()` delegates:

   ```python
   async def stream_message(self, messages, *, system, model, max_tokens, temperature, conversation_id=None):
       async for chunk in self._recorder.invoke_stream(
           self._inner, call_type=self._call_type, messages=messages, system=system,
           model=model, max_tokens=max_tokens, temperature=temperature,
           conversation_id=conversation_id,
       ):
           yield chunk
   ```

   Plus a `describe_stream_outcome` delegate, matching the existing
   `describe_call`/`describe_outcome`/`describe_failure` delegation
   pattern in that class.

### Backend — endpoint

10. **FR10** — New `POST /conversations/{conversation_id}/messages/stream`
    in `app/routers/messages.py`, same router as everything else chat-
    related. Request body: `MessageCreate` (reused, unchanged — same
    strip/non-empty validation, same 422 on blank).
11. **FR11** — Validation that must complete **before** any byte of the
    streaming response is sent, because the HTTP status is committed the
    instant a `StreamingResponse` is returned (Starlette sends
    `http.response.start` before the body generator produces its first
    item — there is no way to "downgrade" a 200 once streaming has begun):
    - **404** if the conversation does not exist (same message as 004).
    - **409** if `conversation_id` is already in this spec's own in-flight
      marker (FR14) — checked and inserted **before** the user message is
      stored, so a rejected send leaves no orphan row.
    - **422** — ordinary FastAPI body validation on `MessageCreate`
      (blank content), which already runs before the handler executes.

    Only after all three pass does the handler store the user message,
    build the window, and return the `StreamingResponse`.
12. **FR12** — User-message commit ordering is identical to 004 FR5: the
    user message is `INSERT`ed and **committed** before the provider call
    begins, so a failure during generation never loses the user's text.
    The window (last 10 messages including the new one, oldest→newest) is
    built the same way as 004 FR6/FR7, with the same system-prompt-on-its-
    own-channel rule (FR8 of 004).
13. **FR13** — The generator (the `StreamingResponse` body) does the
    actual streaming:
    - Iterates `provider.stream_message(...)` with the same arguments 004
      passes to `send_message` (`system=settings.SYSTEM_PROMPT,
      model=settings.OPENAI_MODEL, max_tokens=settings.MAX_TOKENS,
      temperature=settings.TEMPERATURE, conversation_id=conversation_id`).
    - For each chunk with a non-empty `delta`: emits an SSE `chunk` event
      (FR16) and appends the delta to an accumulator.
    - On the final chunk (`result is not None`): stops accumulating.
    - If the accumulated text is empty/whitespace (mirrors 004 FR13):
      emits an `error` event with `error_type="empty_response"` (FR17) and
      returns — **no** assistant message is stored.
    - Otherwise: stores the assistant message via
      `message_repo.create_and_touch_conversation(...)` (same call 004
      makes), schedules titling via the **same** `background_tasks.add_task`
      call 004/008 make (see FR19 for why this still works from inside a
      generator), and emits a `done` event (FR16) carrying the same
      `ChatTurnRead` shape 004 returns in its JSON body.
14. **FR14** — A new module-level marker, scoped to this endpoint only:

    ```python
    # In-flight marker for the STREAMING endpoint only. This set only needs
    # membership, never a Task to call .cancel() on — there is no
    # cancellation feature anywhere in this project. A concurrent
    # non-streaming send (004) and a streamed send to the same conversation
    # are NOT mutually guarded in v1 — each endpoint only protects against
    # concurrency with itself. Revisit if/when the two send paths need a
    # shared guard.
    _streaming_inflight: set[int] = set()
    ```

    Inserted before the first `await` on the provider call, removed in a
    `finally` inside the generator. No `await` occurs between the
    membership check and the insertion, so the check-then-act is safe
    within one process.
15. **FR15** — `ProviderError` raised during the streaming iteration (FR4)
    is caught **inside the generator**, not by the central
    `provider_error_handler` in `app/core/errors.py` — that handler cannot
    fire here because the response's status line was already sent as 200
    (see FR11). The generator builds the identical detail string that
    handler would (`f"The model provider failed to respond
    ({exc.error_type})."`), logs at ERROR with the same fields that
    handler logs, and emits an `error` SSE event (FR17) with it. **No**
    assistant message is stored — matches the "discard partial" decision.
    This is the one place 012 deliberately does not reuse 004's central
    error path, and it is a transport constraint, not a style choice.
16. **FR16** — SSE wire format, exactly:

    ```
    event: chunk
    data: {"delta": "some text"}

    event: done
    data: {"user_message": {...MessageRead...}, "assistant_message": {...MessageRead...}}

    ```
    or, on failure:
    ```
    event: error
    data: {"detail": "The model provider failed to respond (timeout)."}

    ```
    Every `data:` line is a single-line JSON payload (embedded newlines in
    `delta` arrive JSON-escaped as `\n`, never literal, so they can never
    be mistaken for an SSE field/event terminator). `chunk` uses the new
    `StreamChunk` schema (FR18); `done` reuses `ChatTurnRead`; `error`
    reuses `ErrorResponse` — all serialized with `.model_dump_json()`, not
    hand-built dicts, keeping CLAUDE.md's "no raw dicts across the API
    boundary" spirit even though `response_model=` doesn't apply to a
    `StreamingResponse`. Exactly one of `done` or `error` is ever the last
    event; the connection closes immediately after it.
17. **FR17** — `media_type="text/event-stream"`, headers include
    `Cache-Control: no-cache` and `X-Accel-Buffering: no` (harmless no-op
    outside nginx, cheap insurance against a proxy buffering the stream in
    front of `make backend`'s dev server or any future deployment).
18. **FR18** — New schema in `app/schemas.py`:

    ```python
    class StreamChunk(BaseModel):
        delta: str
    ```

    `ChatTurnRead` and `ErrorResponse` are reused unchanged for `done` and
    `error`.
19. **FR19** — Titling scheduling from inside the generator: the same
    `BackgroundTasks` instance FastAPI injects into the route handler is
    captured by the generator closure and calls `.add_task(...)` on it
    exactly as 004 does today; the handler passes that instance to
    `StreamingResponse(..., background=background_tasks)`. Starlette runs
    background tasks after the full response body (all SSE events) has
    been sent — by which point the generator has already appended the
    title task, so it runs. Same `try`/`except Exception` guard 004 has
    around the `should_title` check (a titling bug must never break an
    otherwise-successful streamed turn), same log-and-skip behavior.
20. **FR20** — No `request.is_disconnected()` check anywhere — no
    client-disconnect handler is added. If the client navigates away or
    closes the tab mid-stream, the generator keeps running — the provider
    call, the eventual
    assistant-message store, the titling schedule, and the log event all
    complete exactly as if the client were still listening. Whatever
    happens when the ASGI server tries to write SSE bytes to an already-
    closed socket is **not specially handled**; see "Open questions".

### Frontend

21. **FR21** — New `streamMessage()` in `src/api.ts`:

    ```ts
    export async function streamMessage(
      conversationId: number,
      content: string,
      handlers: {
        onChunk: (delta: string) => void
        onDone: (turn: ChatTurnRead) => void
        onError: (detail: string) => void
      },
    ): Promise<void>
    ```

    Implementation: raw `fetch` (not `EventSource` — `EventSource` cannot
    send a POST body) against
    `/conversations/${conversationId}/messages/stream`, body
    `{content} satisfies MessageCreate`. If `!res.ok`, parses the error
    body with the **same rules** `request<T>` uses (string `detail` used
    as-is; array `detail` → `'Invalid request.'`; unreadable/absent →
    `HTTP ${res.status}`) and throws `ApiError` — reusing that logic
    requires extracting it out of `request<T>` into a small shared
    function (e.g. `buildApiError(res): Promise<ApiError>`) during this
    spec's implementation, since `streamMessage`'s response body is not
    JSON and cannot go through `request<T>` itself. A `fetch` rejection
    (backend down) throws `ApiError(0, 'Cannot reach the backend. Is it
    running?')`, identical to `request<T>`.
22. **FR22** — On `res.ok`, reads `res.body!.getReader()`, decodes with
    `TextDecoder`, and parses the SSE framing: buffer incoming text,
    split on `\n\n` for complete events, parse each event's `event:` and
    `data:` lines, `JSON.parse` the data line, and dispatch to
    `onChunk`/`onDone`/`onError` per the event name. Malformed/unrecognized
    event names are ignored (forward-compatible, matches the ingestion
    SDK's "tolerant reader" philosophy elsewhere in this project). Once
    `onDone` or `onError` fires, the function stops reading and returns.
23. **FR23** — `streamMessage` pushes exactly one entry into 009's latency
    ring buffer (`{ method: 'POST', path: '.../messages/stream', ms,
    ok }`) covering the whole request-to-terminal-event duration, the same
    signal `request<T>` provides for every other call — so the signal
    ribbon (009 FR8) still reflects chat latency once sends move to
    streaming. If 009's buffer-write function isn't already factored out
    for reuse outside `request<T>`, export it.
24. **FR24** — `ChatPage.tsx`'s send handler is rewritten to call
    `streamMessage` instead of `sendMessage`. State changes from 010's
    model:
    - **Added**: `streamingText: string | null` — the growing assistant
      text; `null` when no stream is open.
    - **Unchanged**: `pendingUserText`, `sending` (now means "a stream
      is open," gates the composer the same way), `mountedRef`, `notice`,
      the history/scroll state.

    Flow:
    1. Guard exactly as 010 FR14 (`sending` or blank draft → no-op).
    2. Clear draft, set `pendingUserText = content`, `streamingText = ''`,
       `sending = true`, `notice = null`.
    3. `await streamMessage(conversationId, content, { onChunk, onDone, onError })`.
       - `onChunk(delta)`: if `mountedRef.current`,
         `setStreamingText(prev => (prev ?? '') + delta)`.
       - `onDone(turn)`: append `turn.user_message` and
         `turn.assistant_message` to `messages`, `total += 2`, clear
         `notice`, clear `pendingUserText`/`streamingText`.
       - `onError(detail)`: clear `pendingUserText`/`streamingText`
         (FR discard-partial decision), set the notice per FR25, then
         `await resyncNewest()` — same "resync so the optimistic entry is
         only dropped once the real state is on screen" ordering 010 used
         for its failure branch.
       - A **thrown** `ApiError` (404/409/422/status-0, all pre-stream
         failures per FR11) is caught the same way: clear the two
         pending-state fields, map by `.status` per FR25, resync.
    4. `finally`: `sending = false`; if not already cleared,
       `pendingUserText = null`, `streamingText = null`.
25. **FR25** — Notice copy, reusing 010's table where the case matches
    (all text is 010's, not re-litigated here) plus one new case for this
    spec's own concurrency guard:

    | Source | Notice |
    |---|---|
    | `onError` (mid-stream provider failure) | Same as 010's 502 case: "The model provider failed to respond. Your message was saved — you can send it again." |
    | `ApiError(status: 409)` (this spec's new concurrency guard, FR14) | "A response is already being generated for this conversation. Wait for it to finish." |
    | `ApiError(status: 404)` | Same as 010: `gone = true`, "This conversation no longer exists." |
    | `ApiError(status: 0)` | Same as 010: "Cannot reach the backend — your message may not have been saved." |
    | `ApiError(status: 422)` | Same as 010: "Message could not be sent (invalid content)." Unreachable given the client-side guard; a bug if seen. |
26. **FR26** — Composer: send simply disables while `sending`, same as any
    other disabled-while-pending control. No second control appears in its
    place — there is no cancel affordance to morph into.
27. **FR27** — Rendering the growing reply: while `streamingText !== null`,
    render it in the assistant-message position using the **same**
    `MessageBubble` presentation FR7/FR12 already define (whitespace-pre,
    overflow-wrap, fenced-code split — the split logic runs again on every
    re-render, so an in-progress fence renders as plain text until closed,
    per the confirmed decision). Before the first chunk arrives, show
    010's existing "Assistant is responding" indicator (FR16/FR11 of 010);
    the first `onChunk` call replaces it with the growing bubble — this
    interval **is** the TTFT the backend is now measuring, made visible.
28. **FR28** — Scroll behavior extends 010's FR17: while a stream is open,
    if the reader was at/near the bottom when the stream started, the
    view stays pinned to the bottom as `streamingText` grows (no repeated
    smooth-scroll-per-chunk — a single sustained bottom anchor for the
    stream's duration avoids scroll jank). If the reader had scrolled up
    before the stream started, the view does not move; the "Jump to
    latest" pill logic from 010 FR17/FR18 covers the eventual `done`
    append the same way it covers any other appended message.

## Non-functional requirements

- **No new backend dependency.** SSE is hand-built on
  `fastapi.responses.StreamingResponse` — no `sse-starlette`.
- **No new frontend dependency.** No `EventSource` polyfill, no SSE
  client library — a `ReadableStreamDefaultReader` and `TextDecoder` are
  native browser APIs (Vite's target already assumes them).
- **Chunk-driven state updates may arrive at high frequency** (model- and
  network-dependent — could be many per second). No artificial batching
  or `requestAnimationFrame` throttling is added in v1; React 18's
  automatic batching is relied on. *Stated tradeoff:* if visible jank
  shows up in practice, batching `onChunk` calls is the documented
  follow-up, not built preemptively.
- **The SDK's host-agnostic boundary holds.** `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/` must stay empty after this spec — `invoke_stream`'s chunk type is `Any`, never `ProviderStreamChunk`.
- **No auth, no rate limiting, no caching, no realtime beyond this one
  SSE response** (CLAUDE.md defaults) — this is a plain HTTP response the
  client requested, not a push channel; nothing calls the client
  unprompted.
- Errors are logged with context at ERROR (FR15) and never swallowed —
  `CancelledError` inside `invoke_stream` re-raises bare, same as `invoke`.

## Data model

**No new table, no new column, no Alembic migration.**
`inference_logs.time_to_first_token_ms` already exists (spec 005) and is
nullable; this spec is the first thing that ever writes a non-null value
into it. `messages` and `conversations` are written to exactly as 004
already does (one user row, one assistant row, one `updated_at` bump per
successful turn) — streaming changes *when* the assistant row is written
(once, after the full text is assembled — never per-chunk), not its shape.

New Pydantic schema: `StreamChunk` (FR18). `ChatTurnRead`, `ErrorResponse`,
`MessageCreate`, `MessageRead` are all reused unchanged.

## API contracts

### `POST /conversations/{conversation_id}/messages/stream`

| | |
|---|---|
| Request body | `MessageCreate` — `{"content": "..."}` |
| Response | `text/event-stream`, framed per FR16 |
| 404 | conversation does not exist — `ErrorResponse` (before streaming starts) |
| 409 | a stream is already in flight for this conversation (FR14) — `ErrorResponse` (before streaming starts) |
| 422 | blank/missing `content` — FastAPI validation body (before streaming starts) |
| 200 + `error` event | any failure **after** streaming has started (provider error, empty response) — see FR15/FR16. There is no post-start HTTP status to observe; the terminal SSE event is the only signal. |

Unlike every other endpoint in this project, a 200 status here does **not**
mean the turn succeeded — only that the stream opened. Callers must inspect
the terminal event (`done` vs. `error`), not the HTTP status, to know the
outcome. This is called out explicitly because it is the one place this
spec's contract deviates from "status code tells you what happened," and
the deviation is forced by SSE, not chosen.

`GET /conversations/{id}/messages`, `GET /logs`, `GET /logs/{request_id}`
are unmodified; once a streamed turn completes, its assistant message and
its inference log (now carrying `time_to_first_token_ms`) are indistinguishable
from a non-streamed turn's in every existing read endpoint.

## Constraints

- **Endpoint placement:** `app/routers/messages.py`, next to
  `send_message` — no new module for a few lines of shared state.
- **`_streaming_inflight` is process-local, in-memory, and empty on
  restart** (FR14's docstring says so at the definition site). Not fixed
  here: single dev-server process, single user.
- **`ProviderStreamChunk`/`stream_message` live in `app/providers/base.py`,
  never in `app/logging_sdk/`.** The SDK's `Any`-typed hooks (FR7) are the
  only place streaming touches the SDK's public surface.
- **`_map_response` (OpenAIProvider) is reused, not duplicated**, for
  building the final chunk's `ProviderResult` (FR3) — one mapping function
  for both call shapes, same as the project's existing "two mappings,
  deliberately separate: `_build_request` vs. `describe_call`" pattern
  applies here too (build vs. describe stay separate; success-mapping does
  not).
- No new setting in `app/core/config.py` — reuses `OPENAI_MODEL`,
  `MAX_TOKENS`, `SYSTEM_PROMPT`, `TEMPERATURE`, `PROVIDER_TIMEOUT_SECONDS`.
- `make lint` clean before done, both backend and (implicitly) the
  TypeScript build (`npm run build`, which runs `tsc`) for the frontend
  side.

## Error handling and edge cases

| # | Case | Behaviour |
|---|------|-----------|
| 1 | Nonexistent `conversation_id` | **404** before streaming starts, same message as 004. No user message written. |
| 2 | `content` blank/whitespace | **422** before streaming starts, same `MessageCreate` validator as 004. |
| 3 | Second streamed send to the same conversation while one is in flight | **409** before streaming starts (FR14), this spec's own concurrency guard — there is no other concurrent-send guard anywhere else in the project. User message not written. |
| 4 | A non-streaming send (004, once callable) races a streamed send to the same conversation | **Not mutually guarded** in v1 — each endpoint's registry only protects against itself (FR14's docstring). Documented gap, not a bug. |
| 5 | Provider errors after zero chunks streamed (e.g. immediate auth failure) | `error` SSE event, `time_to_first_token_ms = None` on the log (FR8 — no chunk ever arrived). No message stored. |
| 6 | Provider errors after some chunks streamed | `error` SSE event; client discards the partial `streamingText`; no message stored (confirmed "discard partial" decision) — the visible "text was growing, then an error banner replaced it" moment is expected UX, not a bug. |
| 7 | Provider streams only whitespace / empty content | Treated as `empty_response` failure (FR13), same as 004 FR13 — `error` event, nothing stored. |
| 8 | Client navigates away / closes tab mid-stream | Generation continues to completion server-side (FR20); the assistant message, titling, and log event all land normally. Nobody is listening for the SSE bytes — see "Open questions" for what happens to the write itself. |
| 9 | Client's stream read is interrupted by a transient network blip (not a full disconnect) | Not specially handled — the `fetch`'s reader will error, `streamMessage` rejects, `ChatPage` treats it as an `ApiError(status: 0)`-shaped failure via its catch branch (FR24 step 3's thrown-error path) and resyncs. Same outcome as case 6 from the user's point of view. |
| 10 | Cancel button | **Does not exist anywhere in the project** (FR26) — there is no cancel endpoint, streaming or otherwise, for the streamed chat UI to reach. |
| 11 | A fenced code block opens but the stream ends (`done`) before the closing fence arrives | Same as 010 edge case 11: an odd number of fences renders the trailing segment as plain text. Streaming doesn't change this — the fully-reconciled message (FR24's `onDone`) is what finally renders, and it's a complete, static string at that point. |
| 12 | Very long streamed reply | No client-side cap (matches 010 edge case 9). The composer/history wrapping rules (010 FR7) apply unchanged to `streamingText` as it grows. |
| 13 | Titling races the stream's own completion | Titling is scheduled from inside the generator only after the assistant message is committed (FR19) — same ordering guarantee 004/008 already have; nothing new here. |
| 14 | User sends a second message immediately after `onDone` | `sending` is already `false` by then (FR24's `finally`); an ordinary next send, no special-casing. |
| 15 | Backend restarts mid-stream | The open connection dies; the client sees case 9's path. `_streaming_inflight` is memory-only and empty after restart — no `cancelled` log is emitted, since the generator's `finally` never ran. A silent gap in `inference_logs` for that turn; accepted for a single-process dev server. |

## Acceptance criteria

Verified **manually** against a running backend (`make backend`) and
frontend (`make frontend`) with a real `OPENAI_API_KEY`, same convention as
010 (no frontend test setup in this project; backend tests are created only
via the `generate-tests` skill, when invoked).

**Streaming happy path**
- [ ] Sending a message renders the optimistic user bubble immediately,
      then "Assistant is responding," then visibly growing assistant text
      as it streams in — not one instantaneous block.
- [ ] Once the stream's `done` event lands, the user message appears
      exactly once and the assistant message is the full text, matching
      what a non-streaming call would have produced for the same prompt.
- [ ] `GET /logs?conversation_id={id}` (007) shows a `status="success"` row
      for the turn with a non-null `time_to_first_token_ms` strictly less
      than its `latency_ms`.
- [ ] Reloading the chat page after a streamed turn shows the same history
      a non-streamed turn would have produced — no artifact of streaming
      (partial rows, duplicate messages) persists.

**Concurrency guard**
- [ ] Sending from two tabs on the same conversation nearly
      simultaneously: the losing request's stream never opens; the tab
      sees the 409 notice from FR25; the winning stream completes
      normally.

**Failure paths**
- [ ] Forcing a provider error (e.g. temporarily invalid
      `OPENAI_API_KEY`) after the fact — restart with a good key,
      confirm a normal streamed send resumes working, and with a bad key
      confirm the client shows the same "model provider failed to
      respond… your message was saved" notice 010 defines for its 502
      case, the partially-rendered text (if any appeared before the
      failure) disappears, and the user message is retained in history on
      resync.
- [ ] Sending to a nonexistent conversation id via the new endpoint
      (e.g. with a REST client) returns **404** with no stream opened.
- [ ] Sending blank content returns **422**, same as today.

**No cancel surface**
- [ ] There is no Cancel button, no send↔cancel morph, anywhere in the
      chat UI while a message is sending — there never was one to remove.
- [ ] `grep -rn "cancelGeneration\|cancelRequestedRef" frontend/src/pages/ChatPage.tsx` returns nothing.

**Regression against 010's non-streaming surface**
- [ ] `POST /conversations/{id}/messages` (004) still works exactly as
      before when called directly (e.g. via `curl`/Postman) — this spec
      does not remove or modify it.

## Files to be changed

| Path | Purpose |
|---|---|
| `backend/app/providers/base.py` | Add `ProviderStreamChunk`; add `stream_message` and `describe_stream_outcome` to `ChatProvider` (FR1, FR2, FR6). |
| `backend/app/providers/openai.py` | Implement `OpenAIProvider.stream_message()` via Responses API `stream=True`; implement `describe_stream_outcome()` (FR3, FR4, FR6). |
| `backend/app/providers/logged.py` | Add `LoggingChatProvider.stream_message()` and `describe_stream_outcome()` delegation (FR9). |
| `backend/app/logging_sdk/contract.py` | Add `stream_message`/`describe_stream_outcome` to `InstrumentedProvider`, both `Any`-typed (FR7). |
| `backend/app/logging_sdk/recorder.py` | Add `CallRecorder.invoke_stream()` and `_safe_describe_stream_outcome()` (FR8). |
| `backend/app/schemas.py` | Add `StreamChunk` (FR18). |
| `backend/app/routers/messages.py` | Add `POST /conversations/{id}/messages/stream`; add `_streaming_inflight` marker + its limitation docstring (FR10–FR20). |
| `backend/tests/test_streaming.py` | *Created only via the `generate-tests` skill, when the user invokes it.* |
| `frontend/src/api.ts` | Add `StreamChunk` type (mirrors the backend schema name), `streamMessage()`, and extract the shared error-body-parsing logic out of `request<T>` for reuse (FR21–FR23). |
| `frontend/src/pages/ChatPage.tsx` | Replace the send handler with the streaming flow (FR24, FR25, FR28). |
| `frontend/src/components/chat/MessageBubble.tsx` | No structural change — confirm it already renders from a plain `content: string` prop so a growing `streamingText` value can be passed through it unmodified (FR27). |
| `frontend/src/components/chat/Composer.tsx` | No structural change — Send already disables while `sending` (FR26); nothing to remove. |
| `frontend/src/hooks/useChatScroll.ts` | Extend with the "pinned to bottom while streaming" rule (FR28); no change to the existing per-event rules from 010. |

Explicitly **not** changed: `app/models.py`, `alembic/versions/*` (no
migration — the TTFT column already exists), `app/core/config.py` (no new
setting), `app/core/errors.py` (the streaming error path is handled inside
the generator, not the central handler — FR15), anything under
`app/routers/conversations.py`, `app/routers/logs.py`,
`app/routers/ingest.py`, `app/titling.py` (titling stays non-streaming, and
its call site in the new endpoint reuses 004/008's existing functions
unchanged).

## Feature-specific rules

- **Cancel is out of scope, full stop — do not wire `_streaming_inflight`
  to anything resembling `task.cancel()`.** It exists purely for the 409
  concurrency guard (FR14). If a future spec adds stream cancellation, it
  is a new spec, not a quiet addition here.
- **`send_message` is not touched.** Every existing call site (004's
  non-streaming endpoint, 008's titling) keeps working unmodified. If a
  change to this spec seems to require editing `send_message`, stop — that
  means the streaming path has leaked into the wrong method.
- **One emission point stays one emission point.** `invoke_stream()` is
  the only place a streaming call's `InferenceLogEvent` is built, exactly
  as `invoke()` is for non-streaming — CLAUDE.md's "never construct an
  `InferenceLogEvent` outside the SDK" rule applies identically here.
- **The SDK stays host-agnostic.** `stream_message`/`describe_stream_outcome`
  on `InstrumentedProvider` are `Any`-typed; run
  `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/` before
  calling this spec done — must be empty.
- **No per-chunk DB write.** The assistant message is written exactly
  once, after the full text is assembled — never incrementally.
- **`ChatTurnRead` is not modified.** The `done` event's payload is the
  existing schema, unchanged; do not add streaming-specific fields to it.
- Run `make lint` (backend) before considering the change done; run
  `npm run build` (frontend, `tsc` via the build script) since this
  project has no separate frontend lint step.

## Open questions

- **What happens when the ASGI server tries to write SSE bytes to a
  connection the client already closed (edge case 8).** Assumed: not
  specially handled, and whatever `uvicorn`/Starlette does by default
  (silently drop the write, or raise into the generator) is accepted as
  the v1 behavior — if it raises, that exception is not swallowed
  (`invoke_stream`'s `except BaseException` branch still logs and
  publishes an `error`-status event before re-raising) but nothing extra
  is built to detect the disconnect early. **Observe this once during
  implementation** and record the actual behavior in a code comment at the
  generator's `finally`.
- **The Responses API's streaming terminal event's exact `usage`/`status`
  shape** (FR3) is assumed compatible with `_map_response`'s existing
  expectations. Confirm against the installed `openai` SDK version during
  implementation; if the shapes diverge, `_map_response` may need a second
  small adapter rather than being called directly — a decision for
  implementation time, not this spec.
- **`frontend/src/lib/latencyBuffer.ts`'s exact write API** (FR23) is
  specified in 009 only at the concept level (the ring buffer, written by
  `request<T>`). Whether its push function is already exported separately
  or needs extracting is a 009-implementation detail this spec depends on
  without controlling — confirm/adjust when 009 is actually built, if it
  lands with a different internal shape than illustrated here.
- **Composer/`MessageBubble` prop shape for a "live" message.** Assumed
  `MessageBubble` can render `streamingText` by being passed a
  synthesized, ephemeral `content` string alongside a flag suppressing the
  timestamp/copy affordances until the message is real (FR27) — exact prop
  contract is an implementation detail for `ChatPage.tsx`/`MessageBubble.tsx`,
  not fixed here beyond "reuse the same rendering rules."
