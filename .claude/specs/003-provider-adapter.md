# 003 — Provider Adapter (`ChatProvider`, `ProviderResult`, `OpenAIProvider`)

## Problem statement

The chat feature (spec 004) and the auto-titling feature (spec 008) both need to
call an LLM, and the logging SDK (spec 006) needs to record *the same* fields for
every call regardless of which provider made it. Every provider returns a
differently shaped response: OpenAI's Responses API reports
`usage.input_tokens` / `usage.output_tokens` with nested
`input_tokens_details` / `output_tokens_details`, its older Chat Completions
surface reports `prompt_tokens` / `completion_tokens`, Anthropic reports
`usage.input_tokens` / `usage.output_tokens` plus cache-token fields, Gemini
nests `usageMetadata`; stop reasons and error taxonomies differ too. If the chat
router talks to the OpenAI SDK directly, that variance leaks into the router,
into the event schema, and eventually into the `inference_logs` table.

This spec builds the adapter boundary the design doc's "Cross-provider
normalization" section calls for: a `ChatProvider` interface, a canonical
`ProviderResult`, one `OpenAIProvider` implementation that maps OpenAI's native
response onto it, and a `ProviderError` exception that collapses the OpenAI
SDK's error taxonomy into a canonical `error_type`. Adding a second provider
later — Anthropic is the intended next one — = writing one more adapter;
nothing downstream changes.

**This spec ships no endpoints, no models, and no migration.** It is a pure
library + settings change. It is independent of 001 and 002.

## Functional requirements

1. **FR1** — A `ChatProvider` abstract base class defines a single async method,
   `send_message(...)`, that takes a rendered message window plus per-call
   generation parameters and returns a `ProviderResult`.
2. **FR2** — A `ProviderResult` dataclass carries the canonical fields every
   provider can supply (`content`, `input_tokens`, `output_tokens`, `model`,
   `provider`, `stop_reason`) plus a `provider_metadata` dict for
   provider-specific overflow.
3. **FR3** — `OpenAIProvider` implements `ChatProvider` using the official
   `openai` SDK's **`AsyncOpenAI`** client, calling the **Responses API**
   (`client.responses.create`). The async client is mandatory: spec 009's
   cancellation calls `task.cancel()` and needs the provider call to be an
   interruptible awaitable.
4. **FR4** — `OpenAIProvider` normalizes the native `Response` object into a
   `ProviderResult` per the mapping table in "Data model". OpenAI's
   `usage.input_tokens_details.cached_tokens`,
   `usage.output_tokens_details.reasoning_tokens`, the raw `status`, the
   `incomplete_details.reason`, and the provider-assigned response id go into
   `provider_metadata`, never into canonical fields.
5. **FR5** — The system prompt is passed to OpenAI as the Responses API's
   top-level **`instructions`** parameter. It is **never** injected as a
   message. The `input` array contains only `user` and `assistant` roles,
   matching the DB's `Message.role` enum 1:1.
6. **FR6** — A `ProviderError` exception carries a canonical `error_type` (a
   short lowercase string) and a human-readable `message`. It is defined in this
   spec so `app/core/errors.py` (spec 004) and the SDK wrapper (spec 006) can
   both import it.
7. **FR7** — `OpenAIProvider` catches the OpenAI SDK exception taxonomy
   (`APITimeoutError`, `APIConnectionError`, `RateLimitError`,
   `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`,
   `ConflictError`, `UnprocessableEntityError`, `BadRequestError`,
   `InternalServerError`, `APIStatusError`, `OpenAIError`), logs each with
   context at ERROR, and re-raises as `ProviderError`. No `except` block
   swallows; no bare `except:`.
8. **FR8** — `asyncio.CancelledError` is **not** caught or converted. It
   propagates unchanged so spec 009's cancellation works and asyncio semantics
   are preserved.
9. **FR9** — No custom retry logic. The `openai` SDK's built-in retry behaviour
   (default `max_retries=2`, short exponential backoff on connection errors and
   408/409/429/5xx) is the retry policy.
10. **FR10** — New `Settings` fields (`PROVIDER`, `OPENAI_API_KEY`,
    `OPENAI_MODEL`, `OPENAI_TITLE_MODEL`, `SYSTEM_PROMPT`, `MAX_TOKENS`,
    `TEMPERATURE`, `PROVIDER_TIMEOUT_SECONDS`) are added to
    `app/core/config.py` and mirrored in `backend/.env.example` with
    placeholder (never real) values.
11. **FR11** — A `Provider` string enum names every implemented provider. It has
    exactly one member in v1 (`Provider.OPENAI = "openai"`). It is the type of
    the `PROVIDER` setting, of `ChatProvider.name`, and of
    `ProviderResult.provider` — so the provider identity that reaches the log
    table is the same value the selector dispatched on, not a loose string
    typed twice.
12. **FR12** — A `get_chat_provider()` FastAPI dependency selects the
    implementation by **dispatching on `settings.PROVIDER`**, not by naming a
    class directly, and returns a process-wide singleton. Spec 004 depends on
    it; tests override it via `app.dependency_overrides` so no test ever makes
    a real API call.
13. **FR13** — Exactly one `AsyncOpenAI` client instance is constructed per
    process (connection pooling). It is not rebuilt per request.

## Non-functional requirements

- **Provider-agnostic downstream.** Nothing outside `app/providers/` imports the
  `openai` package. A grep for `import openai` / `from openai import` outside
  that directory must return nothing.
- **Timeout is bounded but not absolute.** `PROVIDER_TIMEOUT_SECONDS` is passed
  to the SDK client as its request timeout, overriding the SDK's own 10-minute
  default. Because the SDK retries timeouts, worst-case wall clock is roughly
  `PROVIDER_TIMEOUT_SECONDS × (max_retries + 1)` ≈ 180s at defaults. This is
  accepted in v1; spec 009's cancellation is the user-facing escape hatch.
- **Logging discipline.** Every caught SDK exception logs at ERROR with
  `provider`, `model`, and `error_type` context — never the API key, never the
  full prompt.
- **No I/O at import time.** Constructing `AsyncOpenAI` does not open a
  connection, so importing the module is cheap and safe under pytest.

## Data model

**No database change. No new SQLAlchemy model, no Alembic migration, no
`app/models.py` edit.** This spec adds only in-memory types. This section
defines them precisely instead.

### `Provider` (StrEnum, `app/providers/base.py`)

```python
class Provider(StrEnum):
    OPENAI = "openai"
```

One member in v1. `StrEnum` (not a bare `Enum`) is deliberate: members *are*
strings, so `Provider.OPENAI` serializes straight into the event payload and
the `inference_logs.provider` column with no `.value` unwrapping and no
custom JSON encoder. The DB column stays a plain `String` — the enum is a
producer-side guarantee, not a DB constraint, matching how the design doc
treats `error_type`.

Adding a provider means adding a member here, an adapter file, and a branch in
`get_chat_provider()`'s dispatch — three edits in three places that a reader
can find by grepping the enum.

### `ProviderMessage` (TypedDict, `app/providers/base.py`)

| field     | type                            | notes                                   |
|-----------|---------------------------------|-----------------------------------------|
| `role`    | `Literal["user", "assistant"]`  | mirrors `Message.role` from spec 002    |
| `content` | `str`                           | non-empty text                          |

### `ProviderResult` (frozen dataclass, `app/providers/base.py`)

| field               | type             | notes                                                                 |
|---------------------|------------------|-----------------------------------------------------------------------|
| `content`           | `str`            | the assistant's visible text; may be `""` (see edge cases)            |
| `input_tokens`      | `int \| None`    | canonical, OTel GenAI naming; `None` when the provider omits usage    |
| `output_tokens`     | `int \| None`    | canonical                                                             |
| `model`             | `str`            | as **reported by the provider**, not as requested                     |
| `provider`          | `Provider`       | `Provider.OPENAI` for this adapter; a `StrEnum`, so it *is* the string `"openai"` |
| `stop_reason`       | `str \| None`    | canonical stop reason string                                          |
| `provider_metadata` | `dict[str, Any]` | JSON-serializable overflow; defaults to `{}`, never `None`            |

`frozen=True` — a `ProviderResult` is an immutable snapshot of one call.

### OpenAI → `ProviderResult` mapping (FR4)

| OpenAI native field (Responses API)                        | Destination                                       |
|------------------------------------------------------------|---------------------------------------------------|
| `response.output_text`                                      | `content`                                         |
| `response.usage.input_tokens`                               | `input_tokens`                                    |
| `response.usage.output_tokens`                              | `output_tokens`                                   |
| `response.model`                                            | `model`                                           |
| *(constant)* `Provider.OPENAI`                              | `provider`                                        |
| `response.incomplete_details.reason` if `status == "incomplete"`, else `response.status` | `stop_reason`        |
| `response.status`                                           | `provider_metadata["status"]`                     |
| `response.incomplete_details.reason`                        | `provider_metadata["incomplete_reason"]`          |
| `response.usage.input_tokens_details.cached_tokens`         | `provider_metadata["cached_tokens"]`              |
| `response.usage.output_tokens_details.reasoning_tokens`     | `provider_metadata["reasoning_tokens"]`           |
| `response.id`                                               | `provider_metadata["response_id"]`                |

Notes on this mapping:

- **`output_text` is an SDK convenience property** that concatenates the text
  parts of every `output_text` content block across the response's message
  items, skipping `reasoning` items. It is the OpenAI equivalent of joining
  Anthropic's `text` blocks. Read it defensively —
  `getattr(response, "output_text", None) or ""` — so a response with no
  message item yields `""` rather than `None` or an `AttributeError`.
- **`stop_reason` has no direct OpenAI analogue.** The Responses API reports a
  `status` (`completed` \| `incomplete` \| `failed` \| `cancelled` \|
  `in_progress` \| `queued`) plus, when incomplete, an
  `incomplete_details.reason` (e.g. `max_output_tokens`,
  `content_filter`). Collapsing those two into one canonical string — the
  reason when it exists, otherwise the status — is what makes the field
  comparable across providers (`"max_output_tokens"` here plays the role
  Anthropic's `"max_tokens"` plays there). Both raw values are preserved
  separately in `provider_metadata`, so nothing is lost.
- Read the nested usage detail fields defensively
  (`getattr(usage.input_tokens_details, "cached_tokens", None)`, guarding the
  details object itself with `getattr(usage, "input_tokens_details", None)`);
  they are absent on some responses. Omit `None` values from
  `provider_metadata` rather than storing nulls.
- `usage.total_tokens` is **not** stored — it is `input_tokens +
  output_tokens`, and the design doc's rule is to store raw measurements and
  derive the rest at read time.

### `ProviderError` (`app/providers/base.py`)

```python
class ProviderError(Exception):
    def __init__(self, error_type: str, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message
        self.status_code = status_code
```

### OpenAI SDK exception → `error_type` mapping (FR7)

Catch **most specific first** — `APITimeoutError` subclasses
`APIConnectionError`, and `RateLimitError` / `AuthenticationError` /
`PermissionDeniedError` / `NotFoundError` / `ConflictError` /
`UnprocessableEntityError` / `BadRequestError` / `InternalServerError` all
subclass `APIStatusError`, which in turn subclasses `APIError` → `OpenAIError`.
Getting the order wrong collapses everything into one bucket.

| OpenAI exception                        | `error_type`      | `status_code`     |
|-----------------------------------------|-------------------|-------------------|
| `openai.APITimeoutError`                | `timeout`         | `None`            |
| `openai.APIConnectionError`             | `connection`      | `None`            |
| `openai.RateLimitError`                 | `rate_limit`      | `429`             |
| `openai.AuthenticationError`            | `authentication`  | `401`             |
| `openai.PermissionDeniedError`          | `permission`      | `403`             |
| `openai.NotFoundError`                  | `not_found`       | `404`             |
| `openai.ConflictError`                  | `conflict`        | `409`             |
| `openai.UnprocessableEntityError`       | `invalid_request` | `422`             |
| `openai.BadRequestError`                | `invalid_request` | `400`             |
| `openai.InternalServerError` (≥ 500)    | `server_error`    | `exc.status_code` |
| `openai.APIStatusError` (anything else) | `api_error`       | `exc.status_code` |
| `openai.OpenAIError` (anything else)    | `unknown`         | `None`            |

`InternalServerError` is the SDK's own class for every ≥ 500 response, so this
table needs no manual `status_code >= 500` branch. 400 and 422 deliberately
share `invalid_request`: both mean "the request we sent was not acceptable",
and the distinguishing HTTP code is preserved in `status_code`.

`ProviderError.message` is the SDK exception's message, truncated to 500 chars
(spec 005's `error_message` column is truncated too; truncating at the source
keeps them consistent).

## API contracts

**This spec exposes no HTTP endpoints.** Its contract is the Python interface
below. Spec 004 is the first consumer.

```python
# app/providers/base.py

class ChatProvider(ABC):
    name: ClassVar[Provider]

    @abstractmethod
    async def send_message(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
    ) -> ProviderResult:
        """Send one chat request and return a normalized result.

        Implementors: this is the only method you must write. The conventional
        shape (see OpenAIProvider) is three private helpers —

          _build_request(...)  -> the vendor SDK's kwargs
          _map_response(raw)   -> ProviderResult
          _map_error(exc)      -> ProviderError

        — but they are a template, not a contract: a provider whose SDK does
        not fit that shape is free to organise itself differently. What is
        fixed is this signature, the ProviderResult returned, and the
        ProviderError raised.

        Raises ProviderError on any provider failure. Must let
        asyncio.CancelledError propagate untouched.
        """
```

**Why one abstract method and not several** (`build_request` / `send` /
`map_response` as separate abstract hooks): the intermediate values between
those steps are vendor-shaped, so the base class could only type them as `Any`
— structure without safety. More importantly, two downstream features need
this to be exactly one awaitable: spec 006's `logged_chat()` measures one call
and emits exactly one event, and spec 009's cancellation interrupts one
in-flight awaitable. A multi-step sequence makes "latency" ambiguous and leaves
gaps where a cancel lands between steps. The per-step guidance lives in the
docstring and in the reference adapter instead, so a new implementor still gets
a checklist. If three providers later show the same duplicated skeleton,
promoting it to a template method is an internal refactor — this public
signature does not change.

- All generation parameters are **explicit keyword arguments**, not read from
  settings inside the provider. The caller (spec 004's router, spec 008's
  titling task) passes them, which is what lets 008 swap in
  `OPENAI_TITLE_MODEL` and a small `max_tokens` without a second provider
  class.
- The interface keeps the provider-neutral name `max_tokens`; the adapter
  translates it to the Responses API's `max_output_tokens`. Translating vendor
  parameter names is exactly the adapter's job.
- `messages` must be non-empty; spec 004's window construction guarantees a
  valid sequence because it is built from stored history.
- `temperature` is deliberately **not** a parameter of `send_message()` — see
  "Constraints" and "Open questions".

```python
# app/providers/openai.py

class OpenAIProvider(ChatProvider):
    name = Provider.OPENAI

    def __init__(self, api_key: str, *, timeout_seconds: int) -> None: ...
    async def send_message(self, messages, *, system, model, max_tokens) -> ProviderResult: ...
```

### Selecting the implementation (FR11 / FR12)

```python
# app/providers/__init__.py

@lru_cache
def _build(provider: Provider) -> ChatProvider:
    match provider:
        case Provider.OPENAI:
            return OpenAIProvider(
                api_key=settings.OPENAI_API_KEY,
                timeout_seconds=settings.PROVIDER_TIMEOUT_SECONDS,
            )
    raise ValueError(f"No adapter registered for provider {provider!r}")


def get_chat_provider() -> ChatProvider:
    """FastAPI dependency. Returns the process-wide singleton for settings.PROVIDER."""
    return _build(settings.PROVIDER)
```

Notes on this shape:

- **Dispatch on the enum, never name a class at the call site.** Today the
  `match` has one arm, so this is functionally "hardcoded to OpenAI" — but the
  *place where the decision is made* now exists and has a name. Adding
  Anthropic is a second `case` arm, not a rewrite of the dependency.
- **`match` over a dict literal**, because a `dict[Provider, ChatProvider]`
  would construct every adapter (and therefore require every provider's API
  key) just to look one up. Lazy construction means an unused provider's
  credentials are never needed.
- **The `raise` is not dead code.** It fires if someone adds an enum member and
  forgets the arm — a loud startup failure instead of a `None` provider
  surfacing as a confusing 500 on the first chat request.
- **`@lru_cache` on `_build`, keyed by the enum**, is what makes FR13's
  one-client-per-process true, and keeps it true per provider if a second one
  is ever added.
- `get_chat_provider` itself stays uncached and trivial so
  `app.dependency_overrides[get_chat_provider]` still works in tests.

### Native request shape sent to OpenAI

```python
await self._client.responses.create(
    model=model,
    instructions=system,                 # top-level, NOT a message (FR5)
    input=[{"role": m["role"], "content": m["content"]} for m in messages],
    max_output_tokens=max_tokens,
    reasoning={"effort": "none"},        # see Constraints + Open questions
    store=False,                         # see Constraints
)
```

The client itself is constructed once (FR12):

```python
self._client = AsyncOpenAI(api_key=api_key, timeout=timeout_seconds)
```

`api_key` is passed explicitly from `Settings` rather than relying on
`AsyncOpenAI()`'s implicit `OPENAI_API_KEY` environment lookup, so `.env` →
`Settings` stays the single configuration path.

## Constraints

- **`uv add openai`** — a main (not dev) dependency. `pyproject.toml` and
  `uv.lock` update together. No `pip install`, no venv activation.
- **`AsyncOpenAI` only.** Do not use the sync `OpenAI` client anywhere.
  Spec 009's `task.cancel()` depends on the call being an awaitable.
- **Responses API, not Chat Completions.** `client.responses.create` is chosen
  over `client.chat.completions.create` for three concrete reasons: it has a
  top-level `instructions` parameter, so FR5 (the system prompt is never a
  message) holds without inventing a `developer`-role message; its usage fields
  are already named `input_tokens` / `output_tokens`, matching our canonical
  OTel GenAI naming 1:1 instead of needing a
  `prompt_tokens`/`completion_tokens` rename; and it is OpenAI's current
  primitive, so reasoning controls and future capabilities land there first.
- **Stateless calls — `previous_response_id` is never used.** The Responses API
  can thread conversation state server-side, but we send our own 10-message
  window (spec 004, FR4) on every call. This is deliberate: the inference log's
  `input_messages` must be the *complete* rendered input, and a server-threaded
  conversation would make the logged payload an unreproducible fragment.
- **`store=False` on every call.** The Responses API stores responses on
  OpenAI's side for 30 days by default. This project's whole point is that *we*
  own the inference record, so provider-side retention is unnecessary
  duplication of user content. Opting out is the conservative default.
- **Sampling parameters are not sent.** `TEMPERATURE` exists in `Settings` (per
  the confirmed decision list) and will be recorded by spec 006 in
  `request_params`, but the adapter does **not** pass `temperature` to the
  OpenAI API: GPT-5-family reasoning models reject `temperature` / `top_p` with
  a 400 ("only the default (1) value is supported"). See "Open questions".
- **Reasoning is disabled on every call.** GPT-5.6 models reason by default and
  `max_output_tokens` caps reasoning *plus* visible text together; at
  `MAX_TOKENS=1024` that risks a `status="incomplete"` response with empty
  `output_text`. `reasoning={"effort": "none"}` is the OpenAI equivalent of
  turning thinking off. See "Open questions".
- **File layout — `backend/app/providers/` package**, not a flat
  `backend/app/providers.py`:
  - `app/providers/__init__.py` — `get_chat_provider()` dependency + re-exports
  - `app/providers/base.py` — `Provider`, `ChatProvider`, `ProviderResult`,
    `ProviderMessage`, `ProviderError`
  - `app/providers/openai.py` — `OpenAIProvider`

  Justification against CLAUDE.md's no-premature-abstraction rule: the rule bars
  building a framework for a single use, not splitting a genuinely shared
  contract from its implementation. `base.py` has **three** importers that must
  not see OpenAI internals — `app/core/errors.py` (needs `ProviderError`),
  spec 004's router (needs `ChatProvider`/`ProviderResult`/`Provider`), spec 006's
  `logged_chat()` (needs both) — and the design doc records multi-provider as a
  confirmed direction, so the second implementation is a file addition rather
  than an edit to a growing module. A flat `providers.py` would force those
  three importers to import the module that imports `openai`. There is no
  registry, no plugin loader, no factory hierarchy — just interface, impl, and a
  one-line dependency function.
  - Naming note: a module named `openai.py` inside `app.providers` does not
    shadow the top-level `openai` package — Python 3 uses absolute imports,
    so `from openai import AsyncOpenAI` inside it resolves to the SDK.
- **No endpoints, no router, no `main.py` change** in this spec.
- **No schema change** — do not touch `app/models.py` or `alembic/`.
- `make lint` must pass before this change is considered done.

## Settings (FR10)

| Field | Type | Default | Notes |
|---|---|---|---|
| `PROVIDER` | `Provider` | `Provider.OPENAI` | Which adapter `get_chat_provider()` builds. Pydantic validates the env value against the enum, so a typo (`PROVIDER=openai2`) fails at startup with a message listing the valid members — not at the first chat request. |
| `OPENAI_API_KEY` | `str` | *(required — no default)* | Missing at startup ⇒ the app does not boot. See edge case 1. |
| `OPENAI_MODEL` | `str` | `"gpt-5.6-terra"` | Chat model. $2.00 / $12.00 per MTok — the cost/intelligence balance point for demo traffic. |
| `OPENAI_TITLE_MODEL` | `str` | `"gpt-5.6-luna"` | Titling model (spec 008). $0.20 / $1.20 per MTok — cheapest in the family. |
| `SYSTEM_PROMPT` | `str` | `"You are a helpful, concise assistant."` | Feeds `config_hash` in spec 006. |
| `MAX_TOKENS` | `int` | `1024` | Sent as `max_output_tokens`. |
| `TEMPERATURE` | `float` | `1.0` | Recorded in `request_params`, **not** sent to the API. |
| `PROVIDER_TIMEOUT_SECONDS` | `int` | `60` | Passed as the `AsyncOpenAI` client `timeout`. |

Prices are OpenAI list pricing as of August 2026 and are duplicated in spec
005's price map; the two must be updated together.

## Error handling and edge cases

| # | Case | Behavior |
|---|------|----------|
| 1 | `OPENAI_API_KEY` unset **at startup** | `Settings()` is constructed at import of `app.core.config`; a required field with no default raises pydantic `ValidationError` and the process fails to boot with a message naming the field. No request is ever served. **Implication:** `backend/.env` must set it for `make backend`, and the pytest run must have it in the environment — the `generate-tests` skill will add `os.environ.setdefault("OPENAI_API_KEY", "test-key")` at the top of `tests/conftest.py`, before `app.main` is imported. |
| 2 | `OPENAI_API_KEY` present but invalid **at call time** | SDK raises `AuthenticationError` → logged at ERROR → `ProviderError("authentication", ...)`. Spec 004 turns this into a 502. |
| 3 | Provider timeout | SDK retries per its own policy, then raises `APITimeoutError` → `ProviderError("timeout", ...)`. |
| 4 | Rate limit (429) | `RateLimitError` → `ProviderError("rate_limit", ...)`. No custom backoff; the SDK already retried. |
| 5 | Provider 5xx | `InternalServerError` → `ProviderError("server_error", ..., status_code=<code>)`. |
| 6 | Network failure / DNS | `APIConnectionError` → `ProviderError("connection", ...)`. Caught **after** `APITimeoutError`. |
| 7 | Response contains no message item / no text | `content` is `""`. The adapter returns this faithfully — it is a valid normalization, not an adapter error. Most likely as `status="incomplete"` with `incomplete_details.reason == "max_output_tokens"`, which lands in `stop_reason` so spec 004 can tell the difference between "the model said nothing" and "the model was cut off". |
| 8 | `response.usage` missing or partial | `input_tokens` / `output_tokens` set to whatever is present, `None` otherwise. Never raises, never coerces to 0 (0 and "unknown" are different facts for the log table). |
| 9 | `input_tokens_details` / `output_tokens_details` absent from `usage` | Key omitted from `provider_metadata` entirely. |
| 10 | Unknown / future `status` or `incomplete_details.reason` value | Stored verbatim in `stop_reason` and in `provider_metadata`. No enum validation — normalizing away unknown values is exactly what `provider_metadata` exists to avoid. |
| 11 | `status == "failed"` with `response.error` populated | Treated as a normal mapping, **not** an exception: the SDK did not raise, so the adapter does not either. `stop_reason == "failed"` and `content == ""`. Spec 004 decides what an empty completion means for a chat turn. (The common failure modes — auth, rate limit, 5xx — raise before reaching this point.) |
| 12 | Caller passes an empty `messages` list | The SDK returns `BadRequestError` → `ProviderError("invalid_request", ...)`. The adapter does not pre-validate; spec 004 guarantees at least the just-stored user message is present. |
| 13 | Configured model rejects `reasoning={"effort": "none"}` | `BadRequestError` → `ProviderError("invalid_request", ...)`. `"none"` is supported by the GPT-5.6 family; older GPT-5 models bottom out at `"minimal"`. Changing `OPENAI_MODEL` to such a model requires changing the effort value with it. |
| 14 | Task cancelled mid-call (spec 009) | `asyncio.CancelledError` propagates untouched. It is a `BaseException`, so an `except Exception` clause will not catch it — but do not add a bare `except:` or an `except BaseException:` anywhere in this module. |
| 15 | An exception type outside the OpenAI taxonomy (e.g. a JSON decode bug) | Not caught here. It propagates as-is and becomes a 500 via FastAPI's default handling. Converting genuinely unexpected errors into a 502 "provider failed" would hide bugs. |

## Acceptance criteria

Tests are created **only** by the `generate-tests` skill, when the user invokes
it. This checklist is what those tests must assert.

Stubbing: tests never construct `OpenAIProvider` against the network. They define
a `StubProvider(ChatProvider)` whose `send_message()` returns a canned
`ProviderResult` or raises a canned `ProviderError`, and install it with
`app.dependency_overrides[get_chat_provider] = lambda: stub`. **No test makes a
real network call.** Adapter-mapping tests (items 3–8 below) instantiate
`OpenAIProvider` and monkeypatch `provider._client.responses.create` with an
async fake returning a fabricated response object — still no network.

- [ ] `ProviderResult` is constructible with all seven fields and is frozen
      (mutating `result.content` raises `FrozenInstanceError`).
- [ ] `ChatProvider` cannot be instantiated directly (`TypeError`), and a
      subclass that implements `send_message()` can.
- [ ] Given a fake response whose `output_text` is `"hello world"`,
      `send_message()` returns `content == "hello world"`.
- [ ] Given a fake response with
      `usage(input_tokens=11, output_tokens=22, input_tokens_details.cached_tokens=5,
      output_tokens_details.reasoning_tokens=7)`, the result has
      `input_tokens == 11`, `output_tokens == 22`,
      `provider_metadata["cached_tokens"] == 5`,
      `provider_metadata["reasoning_tokens"] == 7`, and neither
      `cached_tokens` nor `reasoning_tokens` is a top-level `ProviderResult`
      field.
- [ ] A fake response with `status="completed"` and `incomplete_details=None`
      yields `stop_reason == "completed"` and no `incomplete_reason` key in
      `provider_metadata`.
- [ ] A fake response with `status="incomplete"` and
      `incomplete_details.reason == "max_output_tokens"` yields
      `stop_reason == "max_output_tokens"`,
      `provider_metadata["status"] == "incomplete"`, and
      `provider_metadata["incomplete_reason"] == "max_output_tokens"`.
- [ ] `result.model` equals the fake response's `model` (provider-reported), not
      the `model` argument passed in, when the two differ.
- [ ] `result.provider is Provider.OPENAI`, and it compares equal to the plain
      string `"openai"` (proving the `StrEnum` serializes without unwrapping), and
      `provider_metadata["response_id"]` equals the fake response's `id`.
- [ ] A fake response whose `output_text` is `""` yields `content == ""` and
      does **not** raise.
- [ ] A fake response with no `usage` attribute yields
      `input_tokens is None` and `output_tokens is None` — not `0`.
- [ ] For each row of the exception mapping table: patching the client to raise
      that SDK exception makes `send_message()` raise `ProviderError` with the
      expected `error_type`. At minimum cover `APITimeoutError` → `timeout`,
      `RateLimitError` → `rate_limit`, `AuthenticationError` → `authentication`,
      `BadRequestError` → `invalid_request`, and `InternalServerError` →
      `server_error`.
- [ ] `APITimeoutError` maps to `timeout`, **not** `connection` — proving the
      catch order is right.
- [ ] Patching the client to raise `asyncio.CancelledError` makes
      `send_message()` raise `CancelledError`, not `ProviderError`.
- [ ] `send_message()` passes the system prompt as the `instructions` kwarg,
      `max_tokens` as the `max_output_tokens` kwarg, and the `input` list
      contains no entry with `role == "system"` or `role == "developer"`.
- [ ] `send_message()` does not pass a `temperature` kwarg.
- [ ] `Settings()` exposes the eight new fields with the documented defaults
      when only `OPENAI_API_KEY` is set in the environment, and
      `settings.PROVIDER is Provider.OPENAI`.
- [ ] `Settings(PROVIDER="not-a-provider")` raises pydantic `ValidationError`.
- [ ] `get_chat_provider()` returns the same object on two successive calls
      (singleton), and that object is an `OpenAIProvider` whose
      `name is Provider.OPENAI`.
- [ ] Every `Provider` member has a `case` arm in `_build` — i.e. calling
      `_build(member)` for each member of `Provider` returns a `ChatProvider`
      and never hits the `ValueError`. This test is what makes adding an enum
      member without an adapter a red build rather than a runtime surprise.

## Files to be changed

| Path | Purpose |
|------|---------|
| `backend/pyproject.toml` | `openai` added to `[project].dependencies` via `uv add openai`. |
| `backend/uv.lock` | Regenerated by the same `uv add`. |
| `backend/app/providers/__init__.py` | **New.** `_build()` enum dispatch + `get_chat_provider()` dependency; re-exports `Provider`, `ChatProvider`, `ProviderResult`, `ProviderError`. |
| `backend/app/providers/base.py` | **New.** `Provider` enum, `ProviderMessage`, `ProviderResult`, `ChatProvider` ABC, `ProviderError`. Imports nothing from `app.*`. |
| `backend/app/providers/openai.py` | **New.** `OpenAIProvider` — `AsyncOpenAI` client, native→canonical mapping, SDK exception translation. The only file in the repo that imports the `openai` package. |
| `backend/app/core/config.py` | Eight new `Settings` fields (FR10), including `PROVIDER: Provider`. |
| `backend/.env.example` | Placeholder entries for the same eight fields. No real key. |
| `backend/tests/test_providers.py` | **Created only via the `generate-tests` skill, when the user invokes it.** Adapter mapping + error translation tests per "Acceptance criteria". |

Explicitly **not** changed: `app/models.py`, `alembic/versions/*`,
`app/schemas.py`, `app/routers/*`, `app/main.py`, anything under `frontend/`.

## Adding Anthropic later (the interface's payoff)

Not built in this spec — recorded so the boundary can be judged against a real
second case. The complete change list:

1. `Provider.ANTHROPIC = "anthropic"` — one enum member in `base.py`.
2. `app/providers/anthropic.py` — one new file, one class, one
   `send_message()`.
3. One `case Provider.ANTHROPIC:` arm in `_build()`.
4. `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` settings and `uv add anthropic`.

Set `PROVIDER=anthropic` in `.env` and the whole app switches. Its mapping:

| Anthropic native field | Destination |
|---|---|
| `"".join(b.text for b in response.content if b.type == "text")` | `content` |
| `response.usage.input_tokens` / `output_tokens` | `input_tokens` / `output_tokens` |
| `response.model` | `model` |
| *(constant)* `Provider.ANTHROPIC` | `provider` |
| `response.stop_reason` (`end_turn`, `max_tokens`, …) | `stop_reason` |
| `usage.cache_creation_input_tokens` / `cache_read_input_tokens`, `response.id`, `response.stop_sequence` | `provider_metadata` |

Its error taxonomy is the same shape (`anthropic.APITimeoutError`,
`RateLimitError`, `AuthenticationError`, `APIStatusError`, …), mapping onto the
same closed `error_type` vocabulary. Nothing else changes: not `ProviderResult`,
not the event schema, not `inference_logs`, not the router, not `logged_chat()`,
not a single test that uses `StubProvider`.

Note what the four steps above do **not** include: no change to
`get_chat_provider()`'s signature, no change to how spec 004 obtains a
provider, and no `if provider == "anthropic"` anywhere outside `_build()`.
That is the whole test of whether this boundary is real.

## Feature-specific rules

- **The adapter is a pure mapping.** It translates a response and it translates
  an error. It does not validate business rules (empty completions, message
  ordering, window size) — those belong to the caller. Keeping it pure is what
  makes it trivially replaceable.
- **New provider capabilities land in `provider_metadata` first.** A field is
  promoted to a canonical `ProviderResult` field (and later a log column) only
  when a query pattern needs to filter or aggregate on it.
- **One emission point discipline.** This spec does not log inference events.
  Spec 006 wraps `ChatProvider.send_message()` from the outside with
  `logged_chat()`; the adapter must stay unaware that logging exists.
- **`error_type` values are a closed vocabulary in v1** — the eleven strings in
  the mapping table (`timeout`, `connection`, `rate_limit`, `authentication`,
  `permission`, `not_found`, `conflict`, `invalid_request`, `server_error`,
  `api_error`, `unknown`). Spec 005's `InferenceLog.error_type` column stores
  them as-is. Adding a value is a code change, not a schema change (the column
  is a plain string, deliberately). One value is minted **outside** the
  adapter: spec 004 raises `ProviderError("empty_response", ...)` when the
  provider succeeds but returns no text. That is a caller-level business rule,
  not a provider failure, which is why it is not in this table — but it does
  reach the same column, so treat the storable vocabulary as these eleven plus
  `empty_response`.
- Never log or include the API key, and never put the rendered prompt into a
  `ProviderError` message.

## Open questions

- **`temperature` vs. the default model.** The confirmed decision list specifies
  a `TEMPERATURE` setting (default `1.0`), but every GPT-5-family model rejects
  `temperature` / `top_p` with a 400 — only the default value 1 is accepted.
  *Assumed:* `TEMPERATURE` stays in `Settings` and is recorded by spec 006 in
  `request_params` / `config_hash`, but the adapter never forwards it to the
  OpenAI API. Confirm before build — the alternative is dropping the setting
  entirely, since no configured model can honour it.
- **Reasoning effort is hardcoded, not configurable.** *Assumed:* the adapter
  sends `reasoning={"effort": "none"}` on every call, mirroring how the
  Anthropic sketch disabled thinking, and both chat and titling calls want it
  off. Confirm before build — the alternatives are promoting it to an
  `OPENAI_REASONING_EFFORT` setting (needed if a future model doesn't accept
  `"none"`, see edge case 13) or to a per-call `send_message()` kwarg (needed if
  chat and titling ever want different effort levels).
- **Default `SYSTEM_PROMPT` text.** *Assumed:* `"You are a helpful, concise
  assistant."` Confirm the wording before build; it feeds `config_hash` in spec
  006, so changing it later re-buckets historical logs.
- **Model pricing drift.** `gpt-5.6-terra` / `gpt-5.6-luna` prices are recorded
  here and in spec 005's price map as of August 2026. Confirm they are current
  at build time; a stale map silently produces wrong `cost_usd` values.
