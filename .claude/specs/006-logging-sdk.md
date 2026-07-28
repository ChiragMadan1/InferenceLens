# 006 — Logging SDK

## Problem statement

Spec 005 built a place to put inference logs. Nothing produces them. Spec 004's
chat endpoint calls the provider directly, so every model call is invisible:
no latency, no token usage, no record of the rendered prompt, no error trail.

This spec builds the **producer half**: a thin wrapper that stands between the
application and the provider, records what happened, and publishes an
`InferenceLogEvent` through a transport-agnostic `EventPublisher` interface.
The application code cannot tell it is there — same inputs, same return value,
same exceptions — which is the "middleware" property that makes it safe to add
everywhere.

Two properties are non-negotiable and shape every decision below:

1. **Logging must never break or delay chat.** Publishing is fire-and-forget and
   contained: a dead ingestion endpoint produces an ERROR log line and a lost
   event, never a failed chat turn and never added latency.
2. **There is exactly one emission point in the codebase.** `logged_chat()` is
   the only place an `InferenceLogEvent` is constructed and published — for
   success, error, and cancellation alike. Specs 008 (auto-title) and 009
   (cancellation) route through it; neither builds its own event.

Depends on **004** (the chat endpoint it wires into) and **005** (the ingestion
endpoint it posts to, and the event contract it mirrors).

## Functional requirements

1. **FR1** — An `InferenceLogEvent` Pydantic model exists in the SDK module,
   carrying `schema_version: int = 1`. It is the **only** thing the producer and
   the consumer share; it mirrors spec 005's `InferenceLogEventIn` field-for-field.
2. **FR2** — An abstract base class `EventPublisher` exposes exactly one method:
   `async def publish(self, event: InferenceLogEvent) -> None`.
3. **FR3** — `HTTPEventPublisher(EventPublisher)` POSTs the event as JSON to
   `settings.INGEST_URL` using a shared `httpx.AsyncClient`.
4. **FR4** — `HTTPEventPublisher.publish` **never raises**. Every failure path —
   connection error, timeout, non-2xx status, serialization error, anything —
   is caught, logged at `ERROR` with event context (`request_id`,
   `conversation_id`, `status`, `call_type`), and swallowed. No bare `except:`,
   no silent `pass`.
5. **FR5** — A `409` response from ingestion is treated as **success** and logged
   at `DEBUG`, not `ERROR`. A duplicate means the event is already stored; there
   is nothing to retry and nothing to alarm about.
6. **FR6** — An `EventProcessor` protocol exists (`(InferenceLogEvent) ->
   InferenceLogEvent`) together with an ordered module-level list
   `EVENT_PROCESSORS`. Each registered processor is applied to the event, in
   order, before publish. **v1 registers none — the list ships empty.**
7. **FR7** — `config_hash(provider, model, system_prompt, request_params)`
   returns the first 16 hex characters of the SHA-256 of a canonical
   (sorted-keys, no-whitespace) JSON encoding of those four inputs. Identical
   configurations produce identical hashes across processes and runs.
8. **FR8** — `logged_chat(...)` wraps a `ChatProvider` call. It mints
   `request_id` (uuid4 hex), records `requested_at`, times the call with a
   monotonic clock, and — on **success, error, and cancellation** — builds and
   publishes exactly one event.
9. **FR9** — `logged_chat` forwards the provider's result unchanged on success
   and re-raises the provider's exception unchanged on failure. It adds no
   retries, no fallbacks, and no result transformation.
10. **FR10** — `logged_chat` never awaits the publish. The event is scheduled
    with `asyncio.create_task(...)` so the caller's latency is unaffected.
11. **FR11** — Spec 004's chat endpoint calls `logged_chat` instead of calling
    the provider directly, on **both** the success and the `ProviderError` paths.
    Its externally observable behaviour is otherwise unchanged: same 200 body,
    same 502 translation, same stored messages.
12. **FR12** — `request_params` captures `max_tokens` and `temperature` **as
    sent** to the provider (the effective values, not the settings defaults, if
    they ever diverge).
13. **FR13** — `time_to_first_token_ms` is always `None` from this spec's
    producer. Spec 012 (streaming) populates it; the field exists on the event
    now so that is a producer change, not a contract change.
14. **FR14** — New settings `INGEST_URL` and `INGEST_TIMEOUT_SECONDS` exist on
    `Settings` and in `.env.example`.

## Non-functional requirements

- **Zero added user-visible latency.** The chat response must not wait on the
  publish. `asyncio.create_task` is the mechanism; the acceptance criteria assert
  the publish is not awaited.
- **Loose coupling for the future broker.** `logged_chat` depends on the
  `EventPublisher` interface, never on `httpx`, never on a URL. Swapping in a
  `KafkaEventPublisher` is a dependency-injection change at one call site and
  touches neither chat nor ingestion code.
- **No swallowed exceptions.** Every `except` in this spec logs with context and
  either re-raises (the chat path) or returns cleanly having logged (the publish
  path). CLAUDE.md's rule applies to both.
- **Event loss is accepted in v1.** HTTP fire-and-forget has no durability, no
  retry, and no queue. The design doc names this explicitly as the tradeoff the
  broker later removes. Do not build a retry loop or an in-memory buffer here.
- **Observability of the logger itself.** Publisher failures go through the
  existing `setup_logging()` configuration at `ERROR`. There is no metrics
  endpoint in v1.

## Data model

**No schema change. No new table, no new column, no Alembic migration.** Spec
005 already created `inference_logs` with every column this spec's event
populates. Running `make db-revision` for this feature should produce an empty
migration — if it does not, something drifted and must be investigated before
proceeding.

What this section defines instead is the **event contract** — the versioned
Pydantic model that is the sole shared surface between producer and consumer.

### `InferenceLogEvent`

Lives in `backend/app/logging_sdk/events.py`. Mirrors spec 005's
`InferenceLogEventIn` exactly; the two must be kept field-for-field identical.

| Field | Type | Optional | Default | Notes |
|---|---|---|---|---|
| `schema_version` | `int` | no | `1` | Bumped only on breaking changes; additive changes do not bump it |
| `request_id` | `str` | no | — | uuid4 hex minted by `logged_chat`. The idempotency key |
| `conversation_id` | `int \| None` | yes | `None` | Linkage metadata only. Consumer does **not** validate it (spec 005 rule) |
| `call_type` | `CallType` | no | — | `chat` from spec 004; `title` from spec 008 |
| `model` | `str` | no | — | The model id actually sent, e.g. `claude-opus-5` |
| `provider` | `str` | no | — | `anthropic` in v1, from `ProviderResult.provider` / the adapter |
| `status` | `LogStatus` | no | — | `success` \| `error` \| `cancelled` |
| `latency_ms` | `int` | no | — | Wall clock of the provider call, `time.perf_counter()` delta, rounded to int |
| `input_tokens` | `int \| None` | yes | `None` | From `ProviderResult`. `None` on error and cancelled |
| `output_tokens` | `int \| None` | yes | `None` | Same |
| `error_type` | `str \| None` | yes | `None` | `ProviderError.error_type` (canonical class name). `None` unless `status == error` |
| `error_message` | `str \| None` | yes | `None` | `ProviderError.message`. Ingestion truncates to 2000 chars |
| `time_to_first_token_ms` | `int \| None` | yes | `None` | **Always `None` in v1.** Populated by spec 012 |
| `request_params` | `dict[str, Any] \| None` | yes | `None` | `{"max_tokens": int, "temperature": float}` as sent |
| `config_hash` | `str \| None` | yes | `None` | 16 hex chars, from `config_hash()` |
| `input_messages` | `list[dict[str, Any]]` | no | — | The exact rendered payload: system prompt + message window, as sent |
| `output_text` | `str \| None` | yes | `None` | Full completion text. `None` on error and cancelled |
| `provider_metadata` | `dict[str, Any] \| None` | yes | `None` | `ProviderResult.provider_metadata` — cache tokens, raw stop reason, etc. |
| `requested_at` | `datetime` | no | — | UTC, captured immediately before the provider call |
| `completed_at` | `datetime \| None` | yes | `None` | UTC, captured when the call resolved/failed/was cancelled |

`cost_usd` is **not** on the event. The producer never prices a call; ingestion
does, from its own versioned price map (spec 005 FR7).

Serialize with `event.model_dump(mode="json")` so `datetime` becomes an ISO
string and enums become their string values before the POST.

### `input_messages` shape

`logged_chat` receives the already-rendered payload from its caller and stores it
verbatim. The convention for v1:

```python
[
    {"role": "system", "content": "<system prompt>"},
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."},
    ...
]
```

The system prompt is included as the first entry so the log is a **self-contained
reproduction** of what the model saw — the whole point of storing it (design doc:
"the rendered prompt is not reconstructable from any message row"). The provider
adapter may split system out again when calling the SDK; that is spec 003's
concern and does not change what gets logged.

### `EventProcessor`

```python
class EventProcessor(Protocol):
    def __call__(self, event: InferenceLogEvent) -> InferenceLogEvent: ...


# Applied in order, immediately before publish. v1 registers NONE.
# This is the documented PII-redaction extension point (design doc:
# "PII redaction & governance"). Do not build a registry or plugin
# system around it — it is a list, and it is empty.
EVENT_PROCESSORS: list[EventProcessor] = []
```

### `config_hash`

```python
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
```

`sort_keys=True` and the compact separators are load-bearing: without them, dict
ordering or whitespace differences produce different hashes for identical
configurations and the grouping is worthless.

### New settings

Added to `Settings` in `backend/app/core/config.py` and to `backend/.env.example`:

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `INGEST_URL` | `str` | `http://localhost:8000/ingest/logs` | Where `HTTPEventPublisher` POSTs. Points at this same app in v1; becomes a separate host when ingestion is split out |
| `INGEST_TIMEOUT_SECONDS` | `float` | `5.0` | httpx timeout for the ingest POST. Bounds how long a background task can hang on a wedged endpoint |

### New dependency

```
uv add httpx
```

`httpx` is currently a **dev-only** dependency (used by `TestClient`). It becomes
a main dependency here. `uv add` updates both `pyproject.toml` and `uv.lock`; do
not hand-edit either.

## API contracts

**This spec adds no endpoints and changes no route signatures.** It changes what
happens *inside* one existing handler and adds one outbound HTTP call.

### Inbound (unchanged)

`POST /conversations/{id}/messages` — spec 004's endpoint. Request `MessageCreate`,
`response_model=ChatTurnRead`, status codes `200` / `404` (unknown conversation) /
`422` (empty content) / `502` (`ProviderError`). **Identical before and after this
spec.** The only difference is that the provider is now reached through
`logged_chat`.

### Outbound (new)

The SDK calls spec 005's endpoint:

| | |
|---|---|
| Method / path | `POST {settings.INGEST_URL}` (default `http://localhost:8000/ingest/logs`) |
| Body | `event.model_dump(mode="json")` — an `InferenceLogEventIn`-shaped JSON object |
| Timeout | `settings.INGEST_TIMEOUT_SECONDS` |
| Expected | `201` |
| `409` | **Treated as success.** Duplicate `request_id`; already stored. Log at DEBUG, do not retry |
| `422` | Contract violation — the producer sent something the consumer rejects. Log at ERROR with the response body; this is a bug, not a transient failure. Do not retry |
| Other non-2xx | Log at ERROR with status and body. Do not retry. Event is lost |
| Connection error / timeout | Log at ERROR with the exception. Do not retry. Event is lost |

### Internal contract — `logged_chat`

```python
async def logged_chat(
    *,
    provider: ChatProvider,
    publisher: EventPublisher,
    call_type: CallType,
    conversation_id: int | None,
    model: str,
    system_prompt: str,
    input_messages: list[dict[str, Any]],
    request_params: dict[str, Any],
) -> ProviderResult:
```

- Keyword-only, so call sites are readable and adding a parameter later cannot
  silently reorder arguments.
- Returns `ProviderResult` **unchanged**.
- Raises `ProviderError` **unchanged** (spec 004's 502 handler still sees exactly
  what it saw before).
- Re-raises `asyncio.CancelledError` **unchanged**.
- The provider is invoked through the `ChatProvider` interface defined in spec
  003. This spec does not restate or redefine that method signature — it forwards
  what it is given and returns what it gets back.

**Execution shape:**

```
request_id   = uuid4().hex
requested_at = datetime.now(UTC)
started      = time.perf_counter()

status, error_type, error_message, result = None, None, None, None
try:
    result = await provider.<complete>(...)          # spec 003's method
except asyncio.CancelledError:
    status = LogStatus.CANCELLED
    raise                                            # never swallow CancelledError
except ProviderError as exc:
    status = LogStatus.ERROR
    error_type, error_message = exc.error_type, exc.message
    raise                                            # spec 004 translates to 502
else:
    status = LogStatus.SUCCESS
finally:
    completed_at = datetime.now(UTC)
    latency_ms   = int((time.perf_counter() - started) * 1000)
    event = InferenceLogEvent(...)                   # fields per the table above
    for processor in EVENT_PROCESSORS:               # empty in v1
        event = processor(event)
    _schedule_publish(publisher, event)              # create_task; never awaits
```

Notes an implementer must get right:

- **The `finally` block must not `await`.** Awaiting inside `finally` while a
  `CancelledError` is propagating can raise a second `CancelledError` and skip
  the publish entirely. `_schedule_publish` calls `asyncio.create_task(...)` and
  returns synchronously.
- **`_schedule_publish` keeps a strong reference to the task** in a module-level
  `set[asyncio.Task]`, discarding it in a done-callback. Without this, the event
  loop only holds a weak reference and the task can be garbage-collected
  mid-flight.
- **`_schedule_publish` itself is wrapped in try/except** logging at ERROR: if
  there is no running loop (a synchronous caller, a test), scheduling fails and
  that must not propagate into the chat path either.

### Wiring into spec 004

The publisher is a **process-wide singleton** holding one `httpx.AsyncClient`,
created in the FastAPI lifespan and closed on shutdown, and injected via
`Depends`:

```python
# app/logging_sdk/publisher.py
_publisher: HTTPEventPublisher | None = None

def get_publisher() -> EventPublisher:      # FastAPI dependency
    ...
```

`app/main.py`'s `lifespan` constructs it after `setup_logging()` and closes its
client on shutdown. One client means connection reuse; per-request clients would
add a TCP handshake to every log.

Inside spec 004's handler, the single line that called the provider becomes a
call to `logged_chat(...)` with `call_type=CallType.CHAT`, the conversation id,
the rendered window, and `request_params={"max_tokens": settings.MAX_TOKENS,
"temperature": settings.TEMPERATURE}`. Everything else in that handler — the
404 parent check, storing the user message, storing the assistant message,
bumping `updated_at`, the `ChatTurnRead` response — is untouched.

## Constraints

- **No schema change.** No model edits, no migration. If `make db-revision`
  generates a non-empty migration for this feature, stop and investigate drift.
- **`logged_chat` is the single emission point.** No other module constructs an
  `InferenceLogEvent` or calls `publisher.publish`. Spec 008 and spec 009 route
  through this function; they do not duplicate it.
- **No retries, no queue, no batching.** The design doc describes batching and
  at-least-once retry as what production SDKs do *at scale*, and explicitly says
  the interface allows it while v1 does not build it. Building it now is
  premature abstraction.
- **No processors registered.** `EVENT_PROCESSORS` ships empty. Do not add a
  redactor, a sampler, or a registry/plugin discovery mechanism around it.
- **`logged_chat` does not touch the database.** It has no `Session`, imports no
  models, and knows nothing about `inference_logs`. Its only output channel is
  the publisher.
- **The publisher never raises into the chat path**, and never blocks it.
- **CancelledError is never swallowed** — caught, event emitted, re-raised.
- **`httpx` becomes a main dependency via `uv add httpx`.** No `pip`, no manual
  `pyproject.toml` edit.
- **No auth on the ingest POST** (project default). No shared-secret header.
- `make lint` passes before the change is considered done.

## Error handling and edge cases

| # | Case | Behaviour |
|---|---|---|
| 1 | **Ingestion unreachable** (connection refused, DNS failure, timeout) | Chat request is **completely unaffected** — same 200, same latency. `ERROR` log line with the exception plus `request_id`, `conversation_id`, `status`, `call_type`. **The event is lost. v1 accepts loss** — this is the durability gap Kafka later closes. |
| 2 | **Ingestion returns 409** (duplicate `request_id`) | Treated as **success**. `DEBUG` log line. No retry, no ERROR. The row already exists, which is exactly the guarantee that made at-least-once delivery safe. |
| 3 | **Ingestion returns 422** | `ERROR` log with the status and response body. This means the producer and consumer contracts have drifted — a bug to fix, not a transient failure. No retry. |
| 4 | **Ingestion returns 500 / 503** | `ERROR` log with status and body. No retry. Event lost. |
| 5 | **Provider raises `ProviderError`** | Event emitted with `status=error`, `error_type` and `error_message` from the exception, **null tokens, null `output_text`, null `cost_usd`** (ingestion cannot price a call with no token counts). The exception re-raises unchanged; spec 004's handler still returns 502; the user message stays stored so the user can retry. |
| 6 | **Provider call is cancelled** (`asyncio.CancelledError`) | Event emitted with `status=cancelled`, null tokens, null `output_text`, no error fields. `CancelledError` is re-raised — never swallowed. **The endpoint-side half of this — the in-flight registry, `POST /cancel`, the 409s, and not storing an assistant message — is spec 009's to complete.** This spec only guarantees the `cancelled` event is emitted when the wrapped call is cancelled. |
| 7 | **`model` not in spec 005's `PRICE_MAP`** | Not this spec's concern. The event carries no cost; ingestion stores `cost_usd` as null and returns 201. The publisher sees a normal success. |
| 8 | **A processor raises** (cannot happen in v1 — the list is empty) | The `finally` block's processor loop is wrapped in try/except that logs at ERROR and publishes the **un-processed** event rather than dropping it. Getting a log through matters more than getting it transformed. |
| 9 | **`asyncio.create_task` fails** (no running event loop, e.g. called from sync code or a non-async test) | `ERROR` log, swallowed. The chat path continues. |
| 10 | **The app shuts down with publish tasks in flight** | Tasks are cancelled by the loop teardown; those events are lost. v1 does not implement a best-effort final flush (the design doc names it as production SDK behaviour, not v1 behaviour). |
| 11 | **Event serialization fails** (a non-JSON-serializable value snuck into `provider_metadata` or `request_params`) | Caught inside `publish`, `ERROR` log with `request_id`, event dropped. The chat path is unaffected. |
| 12 | **Two logically identical calls in quick succession** | Two distinct `request_id`s → two distinct rows. `request_id` is per-*call*, not per-content; it de-duplicates re-delivery of the same event, not similar events. |

## Acceptance criteria

Written so each bullet becomes one pytest case. **Tests are created only via the
`generate-tests` skill, when the user invokes it** — do not write them while
implementing this spec.

> **Tests must stub the publisher and the provider. No real network calls.**
> Use a `FakeEventPublisher` that appends events to a list, and a fake
> `ChatProvider` that returns a canned `ProviderResult` or raises a canned
> `ProviderError`. `HTTPEventPublisher`'s own behaviour is tested against a
> stubbed `httpx.AsyncClient` / `MockTransport`, never against a live server.
> Endpoint tests use the `client` fixture from `tests/conftest.py` with the
> publisher dependency overridden via `app.dependency_overrides`.

**Event contract**

- [ ] `InferenceLogEvent(schema_version=...)` defaults to `1` when omitted.
- [ ] Every field in the Data model table exists on `InferenceLogEvent` with the
      stated type and optionality.
- [ ] `InferenceLogEvent` has **no** `cost_usd` field.
- [ ] `event.model_dump(mode="json")` produces a dict that validates cleanly
      against spec 005's `InferenceLogEventIn` (round-trip test — this is the
      contract guarantee).

**`config_hash`**

- [ ] Two calls with identical inputs return the same 16-character string.
- [ ] The result is exactly 16 characters and is valid lowercase hex.
- [ ] Changing the system prompt changes the hash.
- [ ] Changing `max_tokens` inside `request_params` changes the hash.
- [ ] `request_params` dicts with the same pairs in a different insertion order
      produce the **same** hash (canonical, sorted-key encoding).

**Processor chain**

- [ ] `EVENT_PROCESSORS` is an empty list at import time.
- [ ] With a processor temporarily appended that sets `output_text="REDACTED"`,
      `logged_chat` publishes an event whose `output_text` is `"REDACTED"`.
- [ ] With a processor temporarily appended that raises, `logged_chat` still
      publishes an event (the un-processed one) and the chat call still succeeds.

**`logged_chat` — success path**

- [ ] Returns the fake provider's `ProviderResult` object unchanged (identity or
      full field equality).
- [ ] Publishes exactly **one** event.
- [ ] The event has `status == "success"`, non-null `input_tokens`,
      `output_tokens`, and `output_text`, and null `error_type`/`error_message`.
- [ ] `latency_ms` is an `int` and `>= 0`.
- [ ] `requested_at <= completed_at`.
- [ ] `request_id` is a 32-character hex string, and two consecutive calls
      produce different `request_id`s.
- [ ] `time_to_first_token_ms` is `None`.
- [ ] `request_params` contains `max_tokens` and `temperature` with the values
      passed in.
- [ ] `config_hash` is populated and equals `config_hash(provider, model,
      system_prompt, request_params)` computed independently.
- [ ] `input_messages` on the event is exactly what was passed in, including the
      leading system entry.

**`logged_chat` — error path**

- [ ] A provider raising `ProviderError` causes `logged_chat` to raise the
      **same** `ProviderError` (type and message preserved).
- [ ] Exactly one event is still published.
- [ ] That event has `status == "error"`, `error_type` and `error_message` from
      the exception, and null `input_tokens`, `output_tokens`, `output_text`.

**`logged_chat` — cancellation path**

- [ ] Cancelling the task running `logged_chat` re-raises `CancelledError` to the
      caller (it is not swallowed).
- [ ] Exactly one event is still published, with `status == "cancelled"`, null
      tokens, and null `output_text`.

**`HTTPEventPublisher`**

- [ ] A stubbed transport returning `201` results in no ERROR log.
- [ ] A stubbed transport returning `409` results in **no ERROR log** and no
      raised exception (409 is success).
- [ ] A stubbed transport returning `500` logs at ERROR and does not raise.
- [ ] A stubbed transport raising `httpx.ConnectError` logs at ERROR and does not
      raise.
- [ ] The ERROR log record for a failure contains the `request_id` (assert via
      `caplog`).
- [ ] `publish` POSTs to `settings.INGEST_URL` with a JSON body whose
      `request_id` matches the event.

**Chat endpoint wiring (spec 004 integration)**

- [ ] `POST /conversations/{id}/messages` with a stubbed provider returns `200`
      and a `ChatTurnRead` body — unchanged from spec 004.
- [ ] That request causes exactly one event to be published, with
      `call_type == "chat"` and `conversation_id` equal to the path id.
- [ ] With a publisher stubbed to raise on `publish`, the endpoint still returns
      `200` — **the publisher failure never reaches the chat path.**
- [ ] With a provider stubbed to raise `ProviderError`, the endpoint still
      returns `502` **and** one event with `status == "error"` is published.
- [ ] The user message is still stored on the `ProviderError` path (unchanged
      spec 004 behaviour).
- [ ] `logged_chat` is the only symbol in the codebase constructing an
      `InferenceLogEvent` (grep-style assertion, or reviewed manually at PR time).

## Files to be changed

| Path | Change | Purpose |
|---|---|---|
| `backend/app/logging_sdk/__init__.py` | **new** | Package marker; re-exports `InferenceLogEvent`, `EventPublisher`, `HTTPEventPublisher`, `get_publisher`, `logged_chat`, `config_hash` |
| `backend/app/logging_sdk/events.py` | **new** | `InferenceLogEvent`, `EventProcessor` protocol, empty `EVENT_PROCESSORS`, `config_hash()` |
| `backend/app/logging_sdk/publisher.py` | **new** | `EventPublisher` ABC, `HTTPEventPublisher` (httpx POST, 409-as-success, full error containment), lifespan wiring helpers, `get_publisher()` dependency |
| `backend/app/logging_sdk/wrapper.py` | **new** | `logged_chat()` — the single emission point — plus `_schedule_publish` and its task-reference set |
| `backend/app/core/config.py` | edit | Add `INGEST_URL` and `INGEST_TIMEOUT_SECONDS` to `Settings` |
| `backend/.env.example` | edit | Document both new settings with their defaults. No secrets |
| `backend/app/main.py` | edit | Create the shared `HTTPEventPublisher` in `lifespan`; close its `httpx.AsyncClient` on shutdown |
| `backend/app/routers/conversations.py` (or wherever spec 004 put the chat handler) | edit | Replace the direct provider call with `logged_chat(...)`; inject the publisher via `Depends(get_publisher)` |
| `backend/pyproject.toml`, `backend/uv.lock` | generated | `uv add httpx` moves httpx from dev-only to a main dependency |
| `backend/tests/test_logging_sdk.py` | — | `config_hash`, event contract, `logged_chat` success/error/cancel, publisher behaviour. **Created only via the `generate-tests` skill, when the user invokes it.** |
| `backend/tests/test_chat_logging.py` | — | Endpoint-level wiring assertions with stubbed provider + publisher. **Created only via the `generate-tests` skill, when the user invokes it.** |

No frontend changes. No migration.

*Structure note:* a package (four small modules) rather than a single
`logging_sdk.py` — the pieces have genuinely different audiences (the event is
the shared contract, the publisher is the swappable transport, the wrapper is the
call site), and the design doc's whole point is that the transport can be
replaced without touching the other two. If the reviewer prefers a single flat
module, the tradeoff is fewer files versus a fuzzier boundary at the exact place
the Kafka split will later cut.

## Feature-specific rules

### 1. The publisher must never raise into the chat path

This is the reason the whole abstraction exists. Three mechanisms enforce it,
and all three are required:

1. **`asyncio.create_task`** — the chat coroutine never awaits the POST, so a
   slow or hanging ingestion endpoint cannot add latency. `INGEST_TIMEOUT_SECONDS`
   bounds how long the orphaned task can hang.
2. **A total try/except inside `publish`** — catching `httpx.HTTPError`,
   `asyncio.TimeoutError`, and a final `except Exception` — that logs at `ERROR`
   with `request_id`, `conversation_id`, `status`, and `call_type`, then returns.
   It **swallows nothing silently**: there is no bare `except:` and no
   `except Exception: pass`. CLAUDE.md's never-swallow rule is satisfied by the
   contextual ERROR log plus the deliberate, documented decision not to re-raise
   — re-raising here would take down the thing being observed.
3. **`_schedule_publish` is itself guarded**, so even a scheduling failure (no
   running loop) is contained.

**409 is success.** The publisher does not retry it, does not log it at ERROR,
and does not surface it. Spec 005's unique constraint means a duplicate delivery
found the row already stored — the exact outcome at-least-once delivery wants.
Treating it as failure would produce a permanent ERROR-log stream for a system
that is working correctly.

### 2. `logged_chat()` is the single emission point

Exactly one function in the codebase constructs an `InferenceLogEvent` and hands
it to a publisher. Everything routes through it:

| Caller | `call_type` | Spec |
|---|---|---|
| Chat endpoint | `chat` | 004, wired here |
| Auto-title background task | `title` | 008 |
| Cancelled generation | `chat` (status `cancelled`) | 009 |
| Streaming chat | `chat` (with TTFT) | 012 |

**One event per provider call — success, error, or cancellation, no exceptions.**
If a future feature needs a log, it calls `logged_chat`; it does not build an
event. This is what makes "did every model call get logged?" answerable by
reading one function instead of auditing the codebase.

### 3. What this spec does NOT complete: the cancelled path

`logged_chat` emits a `status=cancelled` event when the wrapped provider call is
cancelled. That is the whole of this spec's cancellation scope.

**Everything else about cancellation is spec 009's**: the in-flight task registry
keyed by `conversation_id`, `POST /conversations/{id}/cancel`, the 409 for
"no generation in progress", the 409 for a concurrent send, the guarantee that no
assistant message is stored, and the registration/`finally`-removal of the task
around the provider call. Do not build any of it here, and do not consider
cancellation "done" after this spec — the event is emitted but nothing yet
triggers it through the API.

### 4. The processor chain is a hook, not a framework

`EVENT_PROCESSORS` is an empty list plus a loop. That is the entire feature.

It exists because redaction is the *producer's* job: sensitive content must be
masked before it crosses the wire, so it never reaches the broker or the store —
which is what a compliance review asks for. Placing the hook here now costs three
lines and makes that a later drop-in; placing it at ingestion instead would be
architecturally wrong.

**Do not** build a registry, entry-point discovery, priority ordering,
configuration-driven registration, or an `EventProcessor` base class with
lifecycle methods. CLAUDE.md's no-premature-abstraction rule applies with force:
there are zero processors, so there is nothing to abstract over.

### 5. `request_params` and `config_hash` capture what was actually sent

`request_params` records the **effective** values passed to the provider, not
`Settings` defaults read at log time. If a future feature makes `max_tokens`
per-request, the log must show the per-request value — otherwise `config_hash`
groups calls that were not actually configured identically, and the
"did the new prompt get slower?" query silently lies.

The system prompt is hashed, not stored in `request_params` — it is already
present verbatim as the first entry of `input_messages`, so hashing it gives a
compact grouping key without a second copy.

## Open questions

- **`INGEST_TIMEOUT_SECONDS` default.** Assumed `5.0` seconds. Nothing upstream
  specifies it; it exists so a wedged ingestion endpoint cannot leave background
  tasks hanging indefinitely. Confirm before build.
- **`config_hash` truncation length.** Assumed 16 hex characters (64 bits) per
  the decisions file — ample for grouping at demo scale, and short enough to read
  in a log line. Confirm before build if full 64-char SHA-256 is preferred for
  collision-proofing.
- **Publisher lifetime.** Assumed one process-wide `HTTPEventPublisher` holding a
  single `httpx.AsyncClient`, created in `lifespan` and injected via `Depends`,
  so connections are reused. Confirm before build if a per-request client is
  preferred (simpler, but adds a TCP handshake per logged call).
