# 006 — Inference Logging SDK

## Problem statement

Spec 005 built a place to put inference logs. Nothing produces them. Spec 004's
chat endpoint calls the provider directly, so every model call is invisible:
no latency, no token usage, no record of the rendered prompt, no error trail.

This spec builds the **producer half**: a portable SDK that instruments a
provider from the outside, records what happened, and publishes an
`InferenceLogEvent` through a transport-agnostic `EventPublisher` interface.

Three properties are non-negotiable and shape every decision below:

1. **Logging must never break or delay chat.** Publishing is fire-and-forget and
   contained: a dead ingestion endpoint produces an ERROR log line and a lost
   event, never a failed chat turn and never added latency. The same containment
   applies to the SDK's own bugs — a provider's `describe_*` method raising must
   not fail the call it was describing.
2. **The instrumented path is the only path — structurally, not by convention.**
   Callers do not opt in. `get_chat_provider()` returns a `ChatProvider` that is
   *already* decorated; the raw adapter is not exported and not reachable from a
   router. There is no second function a developer could call instead, and no
   "remember to use the logging one" rule to forget.
3. **The SDK is host-agnostic.** `app/logging_sdk/` imports **nothing** from
   `app.*` — no `settings`, no models, no schemas, no provider types. All
   configuration arrives as constructor arguments and all provider knowledge
   arrives through an ABC the host implements. The package can be copied into
   another codebase unchanged.

Depends on **003** (the `ChatProvider` interface it instruments — this spec
extends it), **004** (the chat endpoint it wires into) and **005** (the ingestion
endpoint it posts to, and the event contract it mirrors).

## Design: instrument at the composition root

The rejected alternative was a free function — `logged_chat(provider, ...)` —
that callers were expected to use *instead of* `provider.send_message(...)`.
That design has one fatal flaw: both calls remain possible, so "is every LLM call
logged?" is answered by auditing every call site forever, and a new developer's
most natural action (calling the method on the injected provider) is the wrong
one. A grep-based test is a smoke alarm, not a wall.

Instead, the decoration happens **once, where the provider is constructed**:

```
router / background task
    │  provider: ChatProvider = Depends(get_chat_provider)
    │  await provider.send_message(messages, system=..., model=..., ...)
    │      ↑ unchanged call site — the caller cannot tell logging exists
    ▼
LoggingChatProvider(ChatProvider)            [app/providers/logged.py]
    │  the only ChatProvider get_chat_provider() ever hands out
    ▼
CallRecorder.invoke(...)                     [SDK — the single emission point]
    │  request_id · requested_at · perf_counter
    │  provider.describe_call(**kwargs)      → CallContext
    │  result = await provider.send_message(**kwargs)   ← the real adapter
    │  provider.describe_outcome(result)     → CallOutcome
    │  provider.describe_failure(exc)        → CallFailure
    │  build InferenceLogEvent → EVENT_PROCESSORS → create_task(publish)
    ▼
OpenAIProvider(ChatProvider)                 [the raw adapter — never injected]
```

Two things make this work:

- **The provider describes itself.** The SDK never hardcodes a provider name, a
  result shape, or an exception type. It asks the provider, through three
  abstract methods the ABC forces every adapter to implement. Adding a provider
  adds a mapping; it changes no SDK code.
- **The wrapper satisfies the same interface it wraps.** `LoggingChatProvider`
  *is* a `ChatProvider`, so it substitutes anywhere one is expected —
  `Depends(get_chat_provider)`, spec 008's titling task, spec 012's
  streaming — with no call-site change.

## Functional requirements

### The portable SDK

1. **FR1** — `backend/app/logging_sdk/` imports **nothing** from `app.*`. Its
   only imports are the standard library, `pydantic`, and `httpx`. This is a
   hard, checkable constraint (see "Feature-specific rules" §1), and it is what
   makes the package liftable into another codebase or a separate service.
2. **FR2** — `InstrumentedProvider` (ABC) is the SDK's provider-side contract.
   It declares five abstract members, all of which an adapter **must** supply:

   | Member | Purpose |
   |---|---|
   | `provider_name` (abstract property) | The `provider` value written to every event |
   | `async send_message(*args, **kwargs)` | The call being instrumented |
   | `describe_call(*args, **kwargs) -> CallContext` | What is about to be sent |
   | `describe_outcome(result) -> CallOutcome` | What came back on success |
   | `describe_failure(exc) -> CallFailure` | How to classify a raised exception |

   Forgetting any of them is a `TypeError` at instantiation, from `abc` — not a
   silently under-populated log. This is the "enforce the interface writer to
   give all these details" property.
3. **FR3** — Three frozen dataclasses carry provider-supplied facts into the SDK:

   ```python
   @dataclass(frozen=True)
   class CallContext:
       provider: str
       model: str
       system_prompt: str
       input_messages: list[dict[str, Any]]
       request_params: dict[str, Any]
       conversation_id: int | None = None

   @dataclass(frozen=True)
   class CallOutcome:
       output_text: str | None = None
       input_tokens: int | None = None
       output_tokens: int | None = None
       provider_metadata: dict[str, Any] | None = None

   @dataclass(frozen=True)
   class CallFailure:
       error_type: str
       error_message: str
   ```

   The SDK reads only these. It never touches `ProviderResult`, `ProviderError`,
   `Provider`, or any other host type.
4. **FR4** — An `InferenceLogEvent` Pydantic model in the SDK carries
   `schema_version: int = 1` and mirrors spec 005's `InferenceLogEventIn`
   field-for-field. It is the **only** thing the producer and the consumer share.
5. **FR5** — `LogStatus` (`success` | `error` | `cancelled`) is **SDK-owned** —
   the SDK's own branch classification. `call_type` on the event is a plain
   `str`, **not** an enum: the SDK does not enumerate the host's call types. The
   host passes its own `CallType` (a `StrEnum`, therefore a `str`).
6. **FR6** — An abstract `EventPublisher` exposes exactly one method:
   `async def publish(self, event: InferenceLogEvent) -> None`.
7. **FR7** — `HTTPEventPublisher(EventPublisher)` POSTs the event as JSON to a
   URL it is **given at construction**, using a shared `httpx.AsyncClient`:

   ```python
   HTTPEventPublisher(url: str, *, timeout_seconds: float = 5.0)
   ```

   It never reads `app.core.config.settings`. Reading host config from inside
   the SDK is exactly the coupling FR1 forbids; the host supplies the values in
   its composition root.
8. **FR8** — `NullEventPublisher(EventPublisher)` drops events and logs at
   `DEBUG`. It is the "logging disabled / not yet configured" configuration —
   the default a `CallRecorder` uses when no publisher has been installed, so an
   unconfigured SDK degrades to a no-op rather than an `AttributeError`.
9. **FR9** — `HTTPEventPublisher.publish` **never raises**. Every failure path —
   connection error, timeout, non-2xx status, serialization error, anything — is
   caught, logged at `ERROR` with event context (`request_id`,
   `conversation_id`, `status`, `call_type`), and swallowed. No bare `except:`,
   no silent `pass`.
10. **FR10** — A `409` response from ingestion is treated as **success** and
    logged at `DEBUG`, not `ERROR`. A duplicate means the event is already
    stored; there is nothing to retry and nothing to alarm about.
11. **FR11** — An `EventProcessor` protocol exists (`(InferenceLogEvent) ->
    InferenceLogEvent`) together with an ordered module-level list
    `EVENT_PROCESSORS`. Each registered processor is applied to the event, in
    order, before publish. **v1 registers none — the list ships empty.**
12. **FR12** — `config_hash(provider, model, system_prompt, request_params)`
    returns the first 16 hex characters of the SHA-256 of a canonical
    (sorted-keys, no-whitespace) JSON encoding of those four inputs. Identical
    configurations produce identical hashes across processes and runs.
13. **FR13** — `CallRecorder.invoke(provider, *, call_type, **call_kwargs)` is
    **the single emission point**: the only code in the codebase that constructs
    an `InferenceLogEvent` or hands one to a publisher. It mints `request_id`
    (uuid4 hex), records `requested_at`, times the call with a monotonic clock,
    and — on **success, error, and cancellation** — builds and publishes exactly
    one event.
14. **FR14** — `CallRecorder.invoke` forwards the provider's result unchanged on
    success and re-raises the provider's exception unchanged on failure. It adds
    no retries, no fallbacks, and no result transformation.
15. **FR15** — `CallRecorder.invoke` never awaits the publish. The event is
    scheduled with `asyncio.create_task(...)` so the caller's latency is
    unaffected.
16. **FR16** — Every SDK call into a provider's `describe_*` method is guarded.
    A `describe_*` that raises produces an `ERROR` log and a degraded-or-skipped
    event; it never propagates into the caller's call path (FR14 still holds —
    the *provider's* exception is what reaches the caller, never the logger's).

### Host wiring

17. **FR17** — `ChatProvider` (spec 003) extends `InstrumentedProvider`. Every
    adapter therefore implements `provider_name`, `describe_call`,
    `describe_outcome`, and `describe_failure` alongside `send_message`.
18. **FR18** — `ChatProvider.send_message` gains two keyword parameters:
    `temperature: float` and `conversation_id: int | None = None`. Both are
    consumed by the adapter's `describe_call` (they land in `request_params` and
    `CallContext.conversation_id`); whether either reaches the vendor API is the
    adapter's decision — `OpenAIProvider` records `temperature` and does **not**
    forward it, per spec 003's GPT-5 constraint.
19. **FR19** — `LoggingChatProvider(ChatProvider)` wraps any `ChatProvider`,
    delegating to `CallRecorder.invoke`. It binds `call_type` at **construction**,
    not per call, so a call site cannot mislabel a call.
20. **FR20** — `get_chat_provider()` returns
    `LoggingChatProvider(inner, recorder, call_type=CallType.CHAT)`;
    `get_title_provider()` (used by spec 008) returns the same inner adapter
    wrapped with `call_type=CallType.TITLE`. Both share one inner adapter
    instance, so the vendor connection pool is still process-wide.
21. **FR21** — `OpenAIProvider` — and any future concrete adapter — is **removed
    from `app.providers.__all__`** and is not importable from `app.providers`.
    The only way to obtain a provider is through the two accessors in FR20, both
    of which return an instrumented one.
22. **FR22** — Spec 004's chat endpoint is otherwise **unchanged**: same
    `Depends(get_chat_provider)`, same `await provider.send_message(...)`, same
    200 body, same 502 translation, same stored messages. The only edit is the
    two new keyword arguments from FR18. It injects no publisher and imports
    nothing from `app.logging_sdk`.
23. **FR23** — `time_to_first_token_ms` is always `None` from this spec's
    producer. Spec 012 (streaming) populates it; the field exists on the event
    now so that is a producer change, not a contract change.
24. **FR24** — New settings `INGEST_URL` and `INGEST_TIMEOUT_SECONDS` exist on
    `Settings` and in `.env.example`, and are read **only** in
    `app/core/observability.py` — the host's composition root for the SDK.

## Non-functional requirements

- **Zero added user-visible latency.** The chat response must not wait on the
  publish. `asyncio.create_task` is the mechanism; the acceptance criteria assert
  the publish is not awaited.
- **Portability is a build-time property, not an aspiration.** The SDK's import
  graph is the test: `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/`
  must return nothing. If a future change wants `settings` inside the SDK, the
  answer is a constructor argument.
- **Loose coupling for the future broker.** `CallRecorder` depends on the
  `EventPublisher` interface, never on `httpx`, never on a URL. Swapping in a
  `KafkaEventPublisher` is a one-line change in `app/core/observability.py` and
  touches neither chat, nor providers, nor ingestion.
- **No swallowed exceptions.** Every `except` in this spec logs with context and
  either re-raises (the provider's exception, on the chat path) or returns
  cleanly having logged (the publish and `describe_*` paths). CLAUDE.md's rule
  applies to both.
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
| `request_id` | `str` | no | — | uuid4 hex minted by `CallRecorder`. The idempotency key |
| `conversation_id` | `int \| None` | yes | `None` | From `CallContext`. Linkage metadata only; the consumer does **not** validate it (spec 005 rule) |
| `call_type` | `str` | no | — | Plain `str`, supplied by the host. `chat` from spec 004; `title` from spec 008 |
| `model` | `str` | no | — | From `CallContext`, e.g. `gpt-5.6-terra` |
| `provider` | `str` | no | — | From `CallContext.provider`, sourced from `provider_name` |
| `status` | `LogStatus` | no | — | `success` \| `error` \| `cancelled` — SDK-owned enum |
| `latency_ms` | `int` | no | — | Wall clock of the provider call, `time.perf_counter()` delta, rounded to int |
| `input_tokens` | `int \| None` | yes | `None` | From `CallOutcome`. `None` on error and cancelled |
| `output_tokens` | `int \| None` | yes | `None` | Same |
| `error_type` | `str \| None` | yes | `None` | From `CallFailure`. `None` unless `status == error` |
| `error_message` | `str \| None` | yes | `None` | From `CallFailure`. Ingestion truncates to 2000 chars |
| `time_to_first_token_ms` | `int \| None` | yes | `None` | **Always `None` in v1.** Populated by spec 012 |
| `request_params` | `dict[str, Any] \| None` | yes | `None` | From `CallContext`, e.g. `{"max_tokens": int, "temperature": float}` |
| `config_hash` | `str \| None` | yes | `None` | 16 hex chars, from `config_hash()` over the `CallContext` |
| `input_messages` | `list[dict[str, Any]]` | no | — | From `CallContext` — the exact rendered payload, system prompt included |
| `output_text` | `str \| None` | yes | `None` | From `CallOutcome`. `None` on error and cancelled |
| `provider_metadata` | `dict[str, Any] \| None` | yes | `None` | From `CallOutcome` — cache tokens, raw stop reason, etc. |
| `requested_at` | `datetime` | no | — | UTC, captured immediately before the provider call |
| `completed_at` | `datetime \| None` | yes | `None` | UTC, captured when the call resolved/failed/was cancelled |

`cost_usd` is **not** on the event. The producer never prices a call; ingestion
does, from its own versioned price map (spec 005 FR7).

Serialize with `event.model_dump(mode="json")` so `datetime` becomes an ISO
string and enums become their string values before the POST.

**On the deliberate duplication of `LogStatus`.** The SDK defines `LogStatus`
and `app/schemas.py` (spec 005, the consumer) defines its own. They are not
shared by import, and that is the point: producer and consumer share exactly one
thing — the serialized event — which is what makes the later service split safe.
The round-trip acceptance criterion below is what guards them against drift.
`CallType` stays consumer-side only; the SDK never learns this app's call types.

### `input_messages` shape

The **adapter's `describe_call`** renders this, not the caller. The convention
for v1:

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
"the rendered prompt is not reconstructable from any message row"). The adapter
still splits system out again when calling the vendor API (OpenAI's
`instructions` field); that is spec 003's concern and does not change what gets
logged.

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
configurations and the grouping is worthless. The recorder calls this with the
four matching fields of the `CallContext` the provider returned.

### New settings

Added to `Settings` in `backend/app/core/config.py` and to `backend/.env.example`.
Read in exactly one place — `app/core/observability.py`.

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `INGEST_URL` | `str` | `http://localhost:8000/ingest/logs` | Passed to `HTTPEventPublisher(url=...)`. Points at this same app in v1; becomes a separate host when ingestion is split out |
| `INGEST_TIMEOUT_SECONDS` | `float` | `5.0` | Passed to `HTTPEventPublisher(timeout_seconds=...)`. Bounds how long a background task can hang on a wedged endpoint |

### New dependency

```
uv add httpx
```

`httpx` is currently a **dev-only** dependency (used by `TestClient`). It becomes
a main dependency here. `uv add` updates both `pyproject.toml` and `uv.lock`; do
not hand-edit either.

## API contracts

**This spec adds no endpoints and changes no route signatures.** It changes the
type of object behind one existing dependency, adds two parameters to an internal
interface, and adds one outbound HTTP call.

### Inbound (unchanged)

`POST /conversations/{id}/messages` — spec 004's endpoint. Request `MessageCreate`,
`response_model=ChatTurnRead`, status codes `200` / `404` (unknown conversation) /
`422` (empty content) / `502` (`ProviderError`). **Identical before and after this
spec.**

### Outbound (new)

The SDK calls spec 005's endpoint:

| | |
|---|---|
| Method / path | `POST {url}` — the value the host passed to `HTTPEventPublisher` (default `http://localhost:8000/ingest/logs`) |
| Body | `event.model_dump(mode="json")` — an `InferenceLogEventIn`-shaped JSON object |
| Timeout | the `timeout_seconds` the host passed at construction |
| Expected | `201` |
| `409` | **Treated as success.** Duplicate `request_id`; already stored. Log at DEBUG, do not retry |
| `422` | Contract violation — the producer sent something the consumer rejects. Log at ERROR with the response body; this is a bug, not a transient failure. Do not retry |
| Other non-2xx | Log at ERROR with status and body. Do not retry. Event is lost |
| Connection error / timeout | Log at ERROR with the exception. Do not retry. Event is lost |

### Internal contract — `InstrumentedProvider` (SDK)

```python
class InstrumentedProvider(ABC):
    """Implement this to become loggable. Every member is mandatory —
    the SDK asks the provider for everything it records and assumes nothing.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Value written to every event's `provider` field. A concrete adapter
        may satisfy this with a plain class attribute (see OpenAIProvider)."""

    @abstractmethod
    async def send_message(self, *args: Any, **kwargs: Any) -> Any: ...

    @abstractmethod
    def describe_call(self, *args: Any, **kwargs: Any) -> CallContext:
        """Same arguments send_message receives. Return what is about to be
        sent, rendered exactly as the model will see it."""

    @abstractmethod
    def describe_outcome(self, result: Any) -> CallOutcome:
        """Map this provider's own success type into the SDK's canonical shape."""

    @abstractmethod
    def describe_failure(self, exc: BaseException) -> CallFailure:
        """Classify an exception raised by send_message. Must handle exceptions
        this adapter did not raise itself — fall back to the exception's class
        name. Never called for CancelledError; the SDK handles that branch."""
```

`describe_call` and `describe_outcome` are the "config-driven, not assumed"
mechanism: the SDK writes `provider`, `model`, `request_params`,
`input_messages`, tokens, and `provider_metadata` from whatever the adapter
returns, and has no fallback of its own to hardcode.

### Internal contract — `CallRecorder` (SDK)

```python
class CallRecorder:
    def __init__(self, publisher: EventPublisher | None = None) -> None:
        self._publisher = publisher or NullEventPublisher()

    async def invoke(
        self,
        provider: InstrumentedProvider,
        *,
        call_type: str,
        **call_kwargs: Any,
    ) -> Any: ...
```

- Keyword-only past the provider, so adding a parameter later cannot silently
  reorder arguments.
- Returns the provider's result **unchanged**.
- Re-raises the provider's exception **unchanged**.
- Re-raises `asyncio.CancelledError` **unchanged**.

**Execution shape:**

```python
context = _safe_describe_call(provider, call_kwargs)   # None if it raised
request_id   = uuid4().hex
requested_at = datetime.now(UTC)
started      = time.perf_counter()

status = outcome = failure = None
try:
    result = await provider.send_message(**call_kwargs)
except asyncio.CancelledError:
    status = LogStatus.CANCELLED
    raise                                              # never swallow CancelledError
except BaseException as exc:                           # noqa: BLE001 — re-raised below
    status = LogStatus.ERROR
    failure = _safe_describe_failure(provider, exc)
    raise                                              # spec 004 translates ProviderError to 502
else:
    status = LogStatus.SUCCESS
    outcome = _safe_describe_outcome(provider, result)
    return result
finally:
    if context is not None:
        completed_at = datetime.now(UTC)
        latency_ms   = int((time.perf_counter() - started) * 1000)
        event = InferenceLogEvent(...)                 # fields per the table above
        event = _apply_processors(event)               # empty list in v1
        _schedule_publish(publisher, event)            # create_task; never awaits
```

Notes an implementer must get right:

- **`except BaseException` is deliberate**, and safe because the very next
  statement is a bare `raise`. `except Exception` would let a non-`Exception`
  `BaseException` reach the `finally` with `status` still `None` and construct an
  invalid event. `CancelledError` is caught first and separately.
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
- **The three `_safe_describe_*` helpers** are the FR16 guards: each wraps the
  provider call in try/except, logs at ERROR with `request_id`, and returns
  `None` (context/outcome) or a `CallFailure` fallback built from
  `type(exc).__name__` / `str(exc)`. A logging bug must never surface as a chat
  failure.

### Internal contract — `LoggingChatProvider` (host)

Lives in `backend/app/providers/logged.py`. It exists because the SDK cannot know
this host's `send_message` signature; this is the ~20-line typed shim that binds
the two together, and it is written **once** for all present and future adapters.

```python
class LoggingChatProvider(ChatProvider):
    """Every ChatProvider handed out by app.providers is one of these.
    Substitutable for the adapter it wraps: same interface, same return
    value, same exceptions — plus exactly one inference log event.
    """

    def __init__(
        self,
        inner: ChatProvider,
        recorder: CallRecorder,
        *,
        call_type: CallType,
    ) -> None:
        self._inner = inner
        self._recorder = recorder
        self._call_type = call_type

    @property
    def provider_name(self) -> str:
        return self._inner.provider_name

    async def send_message(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
        temperature: float,
        conversation_id: int | None = None,
    ) -> ProviderResult:
        return await self._recorder.invoke(
            self._inner,
            call_type=self._call_type,
            messages=messages,
            system=system,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            conversation_id=conversation_id,
        )

    # describe_* delegate to the wrapped adapter — the SDK calls them on
    # `inner`, so these exist only to satisfy the ABC.
```

### Wiring — `app/core/observability.py` (host composition root)

The one place host configuration meets the SDK. Holds the process-wide publisher
(one `httpx.AsyncClient`, created in the FastAPI lifespan and closed on shutdown)
and the `CallRecorder` built over it:

```python
_publisher: HTTPEventPublisher | None = None
_recorder: CallRecorder | None = None

def init_observability() -> None:      # called from lifespan, after setup_logging()
    """Build the publisher from settings and install it on the recorder."""

async def close_observability() -> None:   # called on lifespan shutdown

def get_recorder() -> CallRecorder:
    """Falls back to a NullEventPublisher-backed recorder if lifespan
    has not run (e.g. a unit test importing app.providers directly)."""
```

`app/providers/__init__.py` then composes:

```python
def get_chat_provider() -> ChatProvider:     # unchanged signature — FastAPI dependency
    return LoggingChatProvider(_inner(), get_recorder(), call_type=CallType.CHAT)

def get_title_provider() -> ChatProvider:    # spec 008
    return LoggingChatProvider(_inner(), get_recorder(), call_type=CallType.TITLE)
```

`_inner()` keeps the existing lazily-built singleton adapter, so both wrappers
share one `AsyncOpenAI` connection pool. The wrappers themselves are stateless
and cheap to construct per request.

### Wiring into spec 004

The chat handler's provider call gains exactly two keyword arguments:

```python
result = await provider.send_message(
    provider_messages,
    system=settings.SYSTEM_PROMPT,
    model=settings.OPENAI_MODEL,
    max_tokens=settings.MAX_TOKENS,
    temperature=settings.TEMPERATURE,     # new — recorded, not sent to OpenAI
    conversation_id=conversation_id,      # new — log linkage
)
```

Everything else in that handler — the 404 parent check, storing the user message,
the window build, storing the assistant message, bumping `updated_at`, the
`ChatTurnRead` response, the `ProviderError` → 502 path — is untouched. The
router imports nothing from `app.logging_sdk` and injects no publisher.

## Constraints

- **No schema change.** No model edits, no migration. If `make db-revision`
  generates a non-empty migration for this feature, stop and investigate drift.
- **`app/logging_sdk/` imports nothing from `app.*`.** No `settings`, no
  `models`, no `schemas`, no `providers`. Configuration is constructor
  arguments; provider knowledge is the `InstrumentedProvider` ABC.
- **`CallRecorder.invoke` is the single emission point.** No other module
  constructs an `InferenceLogEvent` or calls `publisher.publish`. Specs 008
  and 012 route through the decorated provider; they do not duplicate it.
- **The raw adapter is not reachable.** `OpenAIProvider` leaves
  `app.providers.__all__`. Nothing outside `app/providers/__init__.py` may
  import or instantiate a concrete adapter.
- **No retries, no queue, no batching.** The design doc describes batching and
  at-least-once retry as what production SDKs do *at scale*, and explicitly says
  the interface allows it while v1 does not build it. Building it now is
  premature abstraction.
- **No processors registered.** `EVENT_PROCESSORS` ships empty. Do not add a
  redactor, a sampler, or a registry/plugin discovery mechanism around it.
- **The SDK does not touch the database.** It has no `Session`, imports no
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
| 5 | **Provider raises `ProviderError`** | `describe_failure` classifies it; event emitted with `status=error`, `error_type`/`error_message` from the exception, **null tokens, null `output_text`, null `cost_usd`**. The exception re-raises unchanged; spec 004's handler still returns 502; the user message stays stored so the user can retry. |
| 6 | **Provider call is cancelled** (`asyncio.CancelledError`) | Event emitted with `status=cancelled`, null tokens, null `output_text`, no error fields. `describe_failure` is **not** called. `CancelledError` is re-raised — never swallowed. **There is no user-facing cancellation feature in this project** (a cancellation spec was scoped and then descoped before being built); this branch exists for any other source of task cancellation, e.g. server shutdown. |
| 7 | **`model` not in spec 005's `PRICE_MAP`** | Not this spec's concern. The event carries no cost; ingestion stores `cost_usd` as null and returns 201. |
| 8 | **`describe_call` raises** | `ERROR` log. **No event is emitted** — there is nothing to describe the call with. The provider call still runs and its result/exception still reaches the caller normally. |
| 9 | **`describe_outcome` raises** | `ERROR` log. Event still emitted with `status=success` and null tokens/`output_text`. A partial log beats no log. The caller still gets the real result. |
| 10 | **`describe_failure` raises** | `ERROR` log. Event emitted with `error_type=type(exc).__name__` and `error_message=str(exc)` as fallback. The **original** provider exception is what re-raises, never the describe failure. |
| 11 | **A processor raises** (cannot happen in v1 — the list is empty) | The processor loop is wrapped in try/except that logs at ERROR and publishes the **un-processed** event rather than dropping it. |
| 12 | **`asyncio.create_task` fails** (no running event loop, e.g. called from sync code or a non-async test) | `ERROR` log, swallowed. The chat path continues. |
| 13 | **No publisher configured** (lifespan never ran) | `get_recorder()` returns a recorder over `NullEventPublisher`: events are dropped with a `DEBUG` line. No crash, no `AttributeError`. |
| 14 | **The app shuts down with publish tasks in flight** | Tasks are cancelled by loop teardown; those events are lost. v1 does not implement a best-effort final flush. |
| 15 | **Event serialization fails** (a non-JSON-serializable value in `provider_metadata` or `request_params`) | Caught inside `publish`, `ERROR` log with `request_id`, event dropped. The chat path is unaffected. |
| 16 | **Two logically identical calls in quick succession** | Two distinct `request_id`s → two distinct rows. `request_id` is per-*call*, not per-content. |

## Acceptance criteria

Written so each bullet becomes one pytest case. **Tests are created only via the
`generate-tests` skill, when the user invokes it** — do not write them while
implementing this spec.

> **Tests must stub the publisher and the provider. No real network calls.**
> Use a `FakeEventPublisher` that appends events to a list, and a fake
> `ChatProvider` that returns a canned `ProviderResult` or raises a canned
> `ProviderError`. `HTTPEventPublisher`'s own behaviour is tested against a
> stubbed `httpx.AsyncClient` / `MockTransport`, never against a live server.
> Endpoint tests use the `client` fixture from `tests/conftest.py` with
> `get_chat_provider` overridden via `app.dependency_overrides` to return a
> `LoggingChatProvider` over the fake adapter and a `FakeEventPublisher`.

**SDK portability**

- [ ] `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/` returns
      nothing (the whole package imports no host code).
- [ ] `HTTPEventPublisher` can be constructed with an arbitrary URL and timeout
      and does not read `app.core.config.settings`.

**Provider contract enforcement**

- [ ] A subclass of `ChatProvider` that omits `describe_call` (or any other
      abstract member) raises `TypeError` on instantiation.
- [ ] `OpenAIProvider.provider_name` equals `Provider.OPENAI`, and that value is
      what lands in the event's `provider` field.
- [ ] `OpenAIProvider.describe_call(...)` puts the system prompt first in
      `input_messages` and returns `request_params` containing the `max_tokens`
      and `temperature` it was passed.
- [ ] `OpenAIProvider.describe_failure` on a non-`ProviderError` exception
      returns a `CallFailure` with `error_type == type(exc).__name__`.

**Event contract**

- [ ] `InferenceLogEvent(schema_version=...)` defaults to `1` when omitted.
- [ ] Every field in the Data model table exists on `InferenceLogEvent` with the
      stated type and optionality.
- [ ] `InferenceLogEvent` has **no** `cost_usd` field.
- [ ] `event.model_dump(mode="json")` produces a dict that validates cleanly
      against spec 005's `InferenceLogEventIn` (round-trip test — this is the
      contract guarantee, and the guard against the deliberate `LogStatus`
      duplication drifting).

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
      the recorder publishes an event whose `output_text` is `"REDACTED"`.
- [ ] With a processor temporarily appended that raises, the recorder still
      publishes an event (the un-processed one) and the call still succeeds.

**`CallRecorder` — success path**

- [ ] Returns the fake provider's `ProviderResult` object unchanged (identity).
- [ ] Publishes exactly **one** event.
- [ ] The event has `status == "success"`, non-null `input_tokens`,
      `output_tokens`, and `output_text`, and null `error_type`/`error_message`.
- [ ] `latency_ms` is an `int` and `>= 0`.
- [ ] `requested_at <= completed_at`.
- [ ] `request_id` is a 32-character hex string, and two consecutive calls
      produce different `request_id`s.
- [ ] `time_to_first_token_ms` is `None`.
- [ ] `call_type` on the event is the value bound at wrapper construction.
- [ ] `config_hash` is populated and equals `config_hash(...)` computed
      independently from the `CallContext`'s four fields.
- [ ] `input_messages` on the event is exactly what `describe_call` returned,
      including the leading system entry.

**`CallRecorder` — error path**

- [ ] A provider raising `ProviderError` causes `invoke` to raise the **same**
      `ProviderError` (type and message preserved).
- [ ] Exactly one event is still published.
- [ ] That event has `status == "error"`, `error_type` and `error_message` from
      the exception, and null `input_tokens`, `output_tokens`, `output_text`.

**`CallRecorder` — cancellation path**

- [ ] Cancelling the task running `invoke` re-raises `CancelledError` to the
      caller (it is not swallowed).
- [ ] Exactly one event is still published, with `status == "cancelled"`, null
      tokens, and null `output_text`.

**`CallRecorder` — self-containment**

- [ ] A provider whose `describe_call` raises: the call still returns its result,
      and **no** event is published.
- [ ] A provider whose `describe_outcome` raises: the call still returns its
      result, and one `status == "success"` event with null tokens is published.
- [ ] A recorder with no publisher installed drops events without raising.

**`HTTPEventPublisher`**

- [ ] A stubbed transport returning `201` results in no ERROR log.
- [ ] A stubbed transport returning `409` results in **no ERROR log** and no
      raised exception (409 is success).
- [ ] A stubbed transport returning `500` logs at ERROR and does not raise.
- [ ] A stubbed transport raising `httpx.ConnectError` logs at ERROR and does not
      raise.
- [ ] The ERROR log record for a failure contains the `request_id` (assert via
      `caplog`).
- [ ] `publish` POSTs to the URL it was constructed with, with a JSON body whose
      `request_id` matches the event.

**Chat endpoint wiring (spec 004 integration)**

- [ ] `POST /conversations/{id}/messages` returns `200` and a `ChatTurnRead`
      body — unchanged from spec 004.
- [ ] That request causes exactly one event to be published, with
      `call_type == "chat"` and `conversation_id` equal to the path id.
- [ ] With a publisher stubbed to raise on `publish`, the endpoint still returns
      `200` — **the publisher failure never reaches the chat path.**
- [ ] With a provider stubbed to raise `ProviderError`, the endpoint still
      returns `502` **and** one event with `status == "error"` is published.
- [ ] The user message is still stored on the `ProviderError` path (unchanged
      spec 004 behaviour).
- [ ] `get_chat_provider()` returns a `LoggingChatProvider` instance, and
      `OpenAIProvider` is not importable from `app.providers`.
- [ ] `CallRecorder` is the only symbol in the codebase constructing an
      `InferenceLogEvent` (grep-style assertion — now a redundancy check rather
      than the primary guarantee, which is structural).

## Files to be changed

| Path | Change | Purpose |
|---|---|---|
| `backend/app/logging_sdk/__init__.py` | **new** | Package marker; re-exports the public surface |
| `backend/app/logging_sdk/contract.py` | **new** | `CallContext`, `CallOutcome`, `CallFailure`, `InstrumentedProvider` ABC |
| `backend/app/logging_sdk/events.py` | **new** | `LogStatus`, `InferenceLogEvent`, `EventProcessor` protocol, empty `EVENT_PROCESSORS`, `config_hash()` |
| `backend/app/logging_sdk/publisher.py` | **new** | `EventPublisher` ABC, `HTTPEventPublisher` (constructor-configured, 409-as-success, full error containment), `NullEventPublisher` |
| `backend/app/logging_sdk/recorder.py` | **new** | `CallRecorder` — the single emission point — the `_safe_describe_*` guards, `_schedule_publish` and its task-reference set |
| `backend/app/providers/base.py` | edit | `ChatProvider` extends `InstrumentedProvider`; `send_message` gains `temperature` and `conversation_id`; the three `describe_*` methods become part of the adapter contract |
| `backend/app/providers/openai.py` | edit | Implement `provider_name`, `describe_call`, `describe_outcome`, `describe_failure`; accept `temperature` (recorded, not forwarded) and `conversation_id` |
| `backend/app/providers/logged.py` | **new** | `LoggingChatProvider(ChatProvider)` — the typed shim over `CallRecorder` |
| `backend/app/providers/__init__.py` | edit | `get_chat_provider()` / `get_title_provider()` return wrapped providers; drop `OpenAIProvider` from `__all__` |
| `backend/app/core/observability.py` | **new** | Host composition root: builds `HTTPEventPublisher` from settings, owns the `CallRecorder` singleton, lifespan init/close |
| `backend/app/core/config.py` | edit | Add `INGEST_URL` and `INGEST_TIMEOUT_SECONDS` to `Settings` |
| `backend/.env.example` | edit | Document both new settings with their defaults. No secrets |
| `backend/app/main.py` | edit | Call `init_observability()` in `lifespan`; `close_observability()` on shutdown |
| `backend/app/routers/messages.py` | edit | Add `temperature=` and `conversation_id=` to the existing `provider.send_message(...)` call. Nothing else |
| `backend/pyproject.toml`, `backend/uv.lock` | generated | `uv add httpx` moves httpx from dev-only to a main dependency |
| `backend/tests/test_logging_sdk.py` | — | `config_hash`, event contract, recorder success/error/cancel, publisher behaviour. **Created only via the `generate-tests` skill.** |
| `backend/tests/test_chat_logging.py` | — | Endpoint-level wiring assertions with stubbed provider + publisher. **Created only via the `generate-tests` skill.** |

No frontend changes. No migration.

*Structure note:* a package (five small modules) rather than a single
`logging_sdk.py` — the pieces have genuinely different audiences (the contract is
what a host implements, the event is what the consumer parses, the publisher is
the swappable transport, the recorder is the engine), and the whole point is that
each can be replaced without touching the others. The package boundary is also
where the future service split cuts.

## Feature-specific rules

### 1. The SDK must not import the host

`app/logging_sdk/` is written as if it were a separately-published package that
happens to live in this repo. That means:

- **No `from app.core.config import settings`.** `HTTPEventPublisher` takes
  `url` and `timeout_seconds`. `CallRecorder` takes a publisher. The host reads
  its own settings in `app/core/observability.py` and passes the values in.
- **No host types.** The SDK never imports `ProviderResult`, `ProviderError`,
  `Provider`, `CallType`, or anything from `app.models` / `app.schemas`. It
  learns everything through `InstrumentedProvider` and the three dataclasses.
- **`call_type` is a `str`, not an enum.** Enumerating `chat`/`title` in the SDK
  would bake this app's domain into a general-purpose package.

The check is mechanical, so use it:

```
grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/     # must be empty
```

Everything the SDK needs from the host arrives through a constructor argument or
an ABC. That is the entire portability contract, and it is cheap to keep.

### 2. Instrumentation is structural, not conventional

A developer adding a feature that calls an LLM does exactly what they would do
without logging: take a `ChatProvider` and call `send_message`. They cannot get
an uninstrumented one, because:

- `get_chat_provider()` and `get_title_provider()` are the only accessors, and
  both return a `LoggingChatProvider`.
- `OpenAIProvider` is not in `app.providers.__all__` and is not imported anywhere
  outside `app/providers/__init__.py`.
- `LoggingChatProvider` **is** a `ChatProvider`, so nothing in the type system
  invites unwrapping it.

There is no `logged_chat()` to remember and no second path to police. If a future
feature needs a log, it needs a provider — and every provider is instrumented.

**Corollary for reviewers:** the review question changes from "did this call site
use the logging wrapper?" (asked forever, at every call site) to "did this change
add a way to obtain an unwrapped adapter?" (asked once, about one file).

### 3. `CallRecorder.invoke` is the single emission point

Exactly one function in the codebase constructs an `InferenceLogEvent` and hands
it to a publisher. Everything routes through it:

| Caller | `call_type` | Spec |
|---|---|---|
| Chat endpoint | `chat` | 004, wired here |
| Auto-title background task | `title` | 008 |
| Streaming chat | `chat` (with TTFT) | 012 |

**One event per provider call — success, error, or cancellation, no exceptions.**

### 4. The provider declares; the SDK records

The SDK has **no defaults and no guesses**. It does not infer a provider name
from a class name, does not reach into a result object for `usage.input_tokens`,
and does not `isinstance`-check exception types. Every value on the event comes
from a `CallContext`, `CallOutcome`, or `CallFailure` the adapter returned, or
from the SDK's own clock and uuid.

This is why `describe_*` are abstract rather than optional hooks with defaults: a
default would let a new adapter ship with silently empty `request_params` or a
wrong provider name, and the log would be quietly useless rather than loudly
broken. Adding Anthropic means writing three small mappings — and changing zero
lines of SDK code.

### 5. The processor chain is a hook, not a framework

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

### 6. The publisher must never raise into the chat path

Three mechanisms enforce it, and all three are required:

1. **`asyncio.create_task`** — the chat coroutine never awaits the POST, so a
   slow or hanging ingestion endpoint cannot add latency. The publisher's
   timeout bounds how long the orphaned task can hang.
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

### 7. The cancelled path is structural, not feature-driven

`CallRecorder` emits a `status=cancelled` event when the wrapped provider call is
cancelled. That is the whole of this spec's cancellation scope, and it is the
**only** cancellation-related code in this project — there is no in-flight
task registry, no `POST /conversations/{id}/cancel` endpoint, and no
concurrent-send 409 anywhere in the codebase. A cancellation feature was
scoped and then explicitly descoped before being built. This branch exists
because `CancelledError` can still propagate from causes outside this
project's control (e.g. the ASGI server cancelling the request's task on
shutdown), and CLAUDE.md's "never swallow an exception" rule means that path
still needs a real log entry rather than a silent gap. Do not build a
cancellation feature to exercise this branch — it is not planned.

### 8. `request_params` and `config_hash` capture what was actually sent

`request_params` is built by `describe_call` from the arguments that call
received — the **effective** values, not `Settings` read at log time. If a future
feature makes `max_tokens` per-request, the log shows the per-request value;
otherwise `config_hash` groups calls that were not actually configured
identically, and the "did the new prompt get slower?" query silently lies.

This is also why `temperature` is a `send_message` parameter (FR18) even though
`OpenAIProvider` never forwards it to the API: a value recorded as "what this
call used" must travel with the call, not be re-read from global config by the
logger.

The system prompt is hashed, not duplicated into `request_params` — it is already
present verbatim as the first entry of `input_messages`.

## Open questions

- **`INGEST_TIMEOUT_SECONDS` default.** Assumed `5.0` seconds. Nothing upstream
  specifies it; it exists so a wedged ingestion endpoint cannot leave background
  tasks hanging indefinitely. Confirm before build.
- **`config_hash` truncation length.** Assumed 16 hex characters (64 bits) per
  the decisions file — ample for grouping at demo scale, and short enough to read
  in a log line. Confirm before build if full 64-char SHA-256 is preferred.
- **`conversation_id` naming inside the SDK.** The SDK's `CallContext` and event
  use `conversation_id` rather than a domain-neutral `correlation_id`, because
  the event must match spec 005's `InferenceLogEventIn` field-for-field and there
  is exactly one consumer. A host with a different correlation domain renames it
  in two places. Confirm before build if a generic `correlation_id` (mapped to
  `conversation_id` only at serialization) is preferred — the cost is one more
  indirection for a rename that may never happen.
- **`LoggingChatProvider` construction cost.** Assumed a fresh, stateless wrapper
  per `get_chat_provider()` call over a shared inner adapter and recorder.
  Confirm before build if a memoized wrapper singleton per `call_type` is
  preferred (marginally cheaper, marginally more global state).
