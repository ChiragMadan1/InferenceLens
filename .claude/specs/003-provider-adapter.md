# 003 — Provider Adapter (`ChatProvider`, `ProviderResult`, `AnthropicProvider`)

## Problem statement

The chat feature (spec 004) and the auto-titling feature (spec 008) both need to
call an LLM, and the logging SDK (spec 006) needs to record *the same* fields for
every call regardless of which provider made it. Every provider returns a
differently shaped response: Anthropic reports `usage.input_tokens` /
`usage.output_tokens` plus cache-token fields, OpenAI reports
`prompt_tokens` / `completion_tokens`, Gemini nests `usageMetadata`; stop reasons
and error taxonomies differ too. If the chat router talks to the Anthropic SDK
directly, that variance leaks into the router, into the event schema, and
eventually into the `inference_logs` table.

This spec builds the adapter boundary the design doc's "Cross-provider
normalization" section calls for: a `ChatProvider` interface, a canonical
`ProviderResult`, one `AnthropicProvider` implementation that maps Anthropic's
native response onto it, and a `ProviderError` exception that collapses the
Anthropic SDK's error taxonomy into a canonical `error_type`. Adding a second
provider later = writing one more adapter; nothing downstream changes.

**This spec ships no endpoints, no models, and no migration.** It is a pure
library + settings change. It is independent of 001 and 002.

## Functional requirements

1. **FR1** — A `ChatProvider` abstract base class defines a single async method,
   `complete(...)`, that takes a rendered message window plus per-call
   generation parameters and returns a `ProviderResult`.
2. **FR2** — A `ProviderResult` dataclass carries the canonical fields every
   provider can supply (`content`, `input_tokens`, `output_tokens`, `model`,
   `provider`, `stop_reason`) plus a `provider_metadata` dict for
   provider-specific overflow.
3. **FR3** — `AnthropicProvider` implements `ChatProvider` using the official
   `anthropic` SDK's **`AsyncAnthropic`** client. The async client is mandatory:
   spec 009's cancellation calls `task.cancel()` and needs the provider call to
   be an interruptible awaitable.
4. **FR4** — `AnthropicProvider` normalizes the native `Message` response into a
   `ProviderResult` per the mapping table in "Data model". Anthropic's
   `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, the raw
   `stop_reason`, and the provider-assigned response id go into
   `provider_metadata`, never into canonical fields.
5. **FR5** — The system prompt is passed to Anthropic as the API's top-level
   `system` parameter. It is **never** injected as a message. The `messages`
   array contains only `user` and `assistant` roles, matching the DB's
   `Message.role` enum 1:1.
6. **FR6** — A `ProviderError` exception carries a canonical `error_type` (a
   short lowercase string) and a human-readable `message`. It is defined in this
   spec so `app/core/errors.py` (spec 004) and the SDK wrapper (spec 006) can
   both import it.
7. **FR7** — `AnthropicProvider` catches the Anthropic SDK exception taxonomy
   (`APITimeoutError`, `APIConnectionError`, `RateLimitError`,
   `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`,
   `BadRequestError`, `APIStatusError`, `AnthropicError`), logs each with
   context at ERROR, and re-raises as `ProviderError`. No `except` block
   swallows; no bare `except:`.
8. **FR8** — `asyncio.CancelledError` is **not** caught or converted. It
   propagates unchanged so spec 009's cancellation works and asyncio semantics
   are preserved.
9. **FR9** — No custom retry logic. The `anthropic` SDK's built-in retry
   behaviour (default `max_retries=2`, exponential backoff on 408/409/429/5xx
   and connection errors) is the retry policy.
10. **FR10** — New `Settings` fields (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
    `ANTHROPIC_TITLE_MODEL`, `SYSTEM_PROMPT`, `MAX_TOKENS`, `TEMPERATURE`,
    `PROVIDER_TIMEOUT_SECONDS`) are added to `app/core/config.py` and mirrored in
    `backend/.env.example` with placeholder (never real) values.
11. **FR11** — A `get_chat_provider()` FastAPI dependency returns a
    process-wide singleton `AnthropicProvider`. Spec 004 depends on it; tests
    override it via `app.dependency_overrides` so no test ever makes a real API
    call.
12. **FR12** — Exactly one `AsyncAnthropic` client instance is constructed per
    process (connection pooling). It is not rebuilt per request.

## Non-functional requirements

- **Provider-agnostic downstream.** Nothing outside `app/providers/` imports the
  `anthropic` package. A grep for `import anthropic` outside that directory must
  return nothing.
- **Timeout is bounded but not absolute.** `PROVIDER_TIMEOUT_SECONDS` is passed
  to the SDK client as its request timeout. Because the SDK retries timeouts,
  worst-case wall clock is roughly `PROVIDER_TIMEOUT_SECONDS × (max_retries + 1)`
  ≈ 180s at defaults. This is accepted in v1; spec 009's cancellation is the
  user-facing escape hatch.
- **Logging discipline.** Every caught SDK exception logs at ERROR with
  `provider`, `model`, and `error_type` context — never the API key, never the
  full prompt.
- **No I/O at import time.** Constructing `AsyncAnthropic` does not open a
  connection, so importing the module is cheap and safe under pytest.

## Data model

**No database change. No new SQLAlchemy model, no Alembic migration, no
`app/models.py` edit.** This spec adds only in-memory types. This section
defines them precisely instead.

### `ProviderMessage` (TypedDict, `app/providers/base.py`)

| field     | type                            | notes                                   |
|-----------|---------------------------------|-----------------------------------------|
| `role`    | `Literal["user", "assistant"]`  | mirrors `Message.role` from spec 002    |
| `content` | `str`                           | non-empty text                          |

### `ProviderResult` (frozen dataclass, `app/providers/base.py`)

| field               | type             | notes                                                                 |
|---------------------|------------------|-----------------------------------------------------------------------|
| `content`           | `str`            | concatenated text of all `text` blocks; may be `""` (see edge cases)  |
| `input_tokens`      | `int \| None`    | canonical, OTel GenAI naming; `None` when the provider omits usage    |
| `output_tokens`     | `int \| None`    | canonical                                                             |
| `model`             | `str`            | as **reported by the provider**, not as requested                     |
| `provider`          | `str`            | `"anthropic"` for this adapter                                        |
| `stop_reason`       | `str \| None`    | canonical stop reason string                                          |
| `provider_metadata` | `dict[str, Any]` | JSON-serializable overflow; defaults to `{}`, never `None`            |

`frozen=True` — a `ProviderResult` is an immutable snapshot of one call.

### Anthropic → `ProviderResult` mapping (FR4)

| Anthropic native field                        | Destination                                          |
|-----------------------------------------------|------------------------------------------------------|
| `"".join(b.text for b in response.content if b.type == "text")` | `content`                       |
| `response.usage.input_tokens`                 | `input_tokens`                                       |
| `response.usage.output_tokens`                | `output_tokens`                                      |
| `response.model`                              | `model`                                              |
| *(constant)* `"anthropic"`                    | `provider`                                           |
| `response.stop_reason`                        | `stop_reason`                                        |
| `response.stop_reason`                        | `provider_metadata["stop_reason"]` (raw duplicate)   |
| `response.usage.cache_creation_input_tokens`  | `provider_metadata["cache_creation_input_tokens"]`   |
| `response.usage.cache_read_input_tokens`      | `provider_metadata["cache_read_input_tokens"]`       |
| `response.id`                                 | `provider_metadata["response_id"]`                   |
| `response.stop_sequence`                      | `provider_metadata["stop_sequence"]`                 |

Read the cache-token fields defensively (`getattr(usage, "...", None)`); they are
absent on some responses. Omit `None` values from `provider_metadata` rather
than storing nulls.

### `ProviderError` (`app/providers/base.py`)

```python
class ProviderError(Exception):
    def __init__(self, error_type: str, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message
        self.status_code = status_code
```

### Anthropic SDK exception → `error_type` mapping (FR7)

Catch **most specific first** — `APITimeoutError` subclasses `APIConnectionError`,
and `RateLimitError` / `AuthenticationError` / `PermissionDeniedError` /
`NotFoundError` / `BadRequestError` all subclass `APIStatusError`. Getting the
order wrong collapses everything into one bucket.

| Anthropic exception                       | `error_type`        | `status_code` |
|-------------------------------------------|---------------------|---------------|
| `anthropic.APITimeoutError`               | `timeout`           | `None`        |
| `anthropic.APIConnectionError`            | `connection`        | `None`        |
| `anthropic.RateLimitError`                | `rate_limit`        | `429`         |
| `anthropic.AuthenticationError`           | `authentication`    | `401`         |
| `anthropic.PermissionDeniedError`         | `permission`        | `403`         |
| `anthropic.NotFoundError`                 | `not_found`         | `404`         |
| `anthropic.BadRequestError`               | `invalid_request`   | `400`         |
| `anthropic.APIStatusError` (status ≥ 500) | `server_error`      | `exc.status_code` |
| `anthropic.APIStatusError` (other)        | `api_error`         | `exc.status_code` |
| `anthropic.AnthropicError` (anything else)| `unknown`           | `None`        |

`ProviderError.message` is the SDK exception's message, truncated to 500 chars
(spec 005's `error_message` column is truncated too; truncating at the source
keeps them consistent).

## API contracts

**This spec exposes no HTTP endpoints.** Its contract is the Python interface
below. Spec 004 is the first consumer.

```python
# app/providers/base.py

class ChatProvider(ABC):
    name: ClassVar[str]

    @abstractmethod
    async def complete(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
    ) -> ProviderResult:
        """Send one completion request. Raises ProviderError on any provider failure."""
```

- All generation parameters are **explicit keyword arguments**, not read from
  settings inside the provider. The caller (spec 004's router, spec 008's
  titling task) passes them, which is what lets 008 swap in
  `ANTHROPIC_TITLE_MODEL` and a small `max_tokens` without a second provider
  class.
- `messages` must be non-empty and must not contain consecutive duplicate roles
  that the provider would reject; spec 004's window construction guarantees a
  valid alternating-or-merged sequence because it is built from stored history.
- `temperature` is deliberately **not** a parameter of `complete()` — see
  "Constraints" and "Open questions".

```python
# app/providers/anthropic.py

class AnthropicProvider(ChatProvider):
    name = "anthropic"

    def __init__(self, api_key: str, *, timeout_seconds: int) -> None: ...
    async def complete(self, messages, *, system, model, max_tokens) -> ProviderResult: ...
```

```python
# app/providers/__init__.py

def get_chat_provider() -> ChatProvider:
    """FastAPI dependency. Returns the process-wide AnthropicProvider singleton."""
```

### Native request shape sent to Anthropic

```python
await self._client.messages.create(
    model=model,
    max_tokens=max_tokens,
    system=system,                       # top-level, NOT a message (FR5)
    thinking={"type": "disabled"},       # see Constraints + Open questions
    messages=[{"role": m["role"], "content": m["content"]} for m in messages],
)
```

## Constraints

- **`uv add anthropic`** — a main (not dev) dependency. `pyproject.toml` and
  `uv.lock` update together. No `pip install`, no venv activation.
- **`AsyncAnthropic` only.** Do not use the sync `Anthropic` client anywhere.
  Spec 009's `task.cancel()` depends on the call being an awaitable.
- **File layout — `backend/app/providers/` package**, not a flat
  `backend/app/providers.py`:
  - `app/providers/__init__.py` — `get_chat_provider()` dependency + re-exports
  - `app/providers/base.py` — `ChatProvider`, `ProviderResult`,
    `ProviderMessage`, `ProviderError`
  - `app/providers/anthropic.py` — `AnthropicProvider`

  Justification against CLAUDE.md's no-premature-abstraction rule: the rule bars
  building a framework for a single use, not splitting a genuinely shared
  contract from its implementation. `base.py` has **three** importers that must
  not see Anthropic internals — `app/core/errors.py` (needs `ProviderError`),
  spec 004's router (needs `ChatProvider`/`ProviderResult`), spec 006's
  `logged_chat()` (needs both) — and the design doc records multi-provider as a
  confirmed direction, so the second implementation is a file addition rather
  than an edit to a growing module. A flat `providers.py` would force those
  three importers to import the module that imports `anthropic`. There is no
  registry, no plugin loader, no factory hierarchy — just interface, impl, and a
  one-line dependency function.
  - Naming note: a module named `anthropic.py` inside `app.providers` does not
    shadow the top-level `anthropic` package — Python 3 uses absolute imports,
    so `from anthropic import AsyncAnthropic` inside it resolves to the SDK.
- **Sampling parameters are not sent.** `TEMPERATURE` exists in `Settings` (per
  the confirmed decision list) and will be recorded by spec 006 in
  `request_params`, but the adapter does **not** pass `temperature` to the
  Anthropic API: the default chat model `claude-opus-5` rejects `temperature` /
  `top_p` / `top_k` with a 400. See "Open questions".
- **`thinking` is disabled on every call.** `claude-opus-5` thinks by default and
  `max_tokens` caps thinking *plus* visible text together; at
  `MAX_TOKENS=1024` that risks truncated or empty responses. See "Open
  questions".
- **No endpoints, no router, no `main.py` change** in this spec.
- **No schema change** — do not touch `app/models.py` or `alembic/`.
- `make lint` must pass before this change is considered done.

## Error handling and edge cases

| # | Case | Behavior |
|---|------|----------|
| 1 | `ANTHROPIC_API_KEY` unset **at startup** | `Settings()` is constructed at import of `app.core.config`; a required field with no default raises pydantic `ValidationError` and the process fails to boot with a message naming the field. No request is ever served. **Implication:** `backend/.env` must set it for `make backend`, and the pytest run must have it in the environment — the `generate-tests` skill will add `os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")` at the top of `tests/conftest.py`, before `app.main` is imported. |
| 2 | `ANTHROPIC_API_KEY` present but invalid **at call time** | SDK raises `AuthenticationError` → logged at ERROR → `ProviderError("authentication", ...)`. Spec 004 turns this into a 502. |
| 3 | Provider timeout | SDK retries per its own policy, then raises `APITimeoutError` → `ProviderError("timeout", ...)`. |
| 4 | Rate limit (429) | `RateLimitError` → `ProviderError("rate_limit", ...)`. No custom backoff; the SDK already retried. |
| 5 | Provider 5xx / overloaded (529) | `APIStatusError` with `status_code >= 500` → `ProviderError("server_error", ..., status_code=<code>)`. |
| 6 | Network failure / DNS | `APIConnectionError` → `ProviderError("connection", ...)`. Caught **after** `APITimeoutError`. |
| 7 | Response contains no `text` blocks | `content` is `""`. The adapter returns this faithfully — it is a valid normalization, not an adapter error. Spec 004 decides what an empty completion means for a chat turn. |
| 8 | `response.usage` missing or partial | `input_tokens` / `output_tokens` set to whatever is present, `None` otherwise. Never raises, never coerces to 0 (0 and "unknown" are different facts for the log table). |
| 9 | Cache-token fields absent from `usage` | Key omitted from `provider_metadata` entirely. |
| 10 | Unknown / future `stop_reason` value | Stored verbatim in both `stop_reason` and `provider_metadata["stop_reason"]`. No enum validation — normalizing away unknown values is exactly what `provider_metadata` exists to avoid. |
| 11 | Caller passes an empty `messages` list | The SDK returns `BadRequestError` → `ProviderError("invalid_request", ...)`. The adapter does not pre-validate; spec 004 guarantees at least the just-stored user message is present. |
| 12 | Task cancelled mid-call (spec 009) | `asyncio.CancelledError` propagates untouched. It is a `BaseException`, so an `except Exception` clause will not catch it — but do not add a bare `except:` or an `except BaseException:` anywhere in this module. |
| 13 | An exception type outside the Anthropic taxonomy (e.g. a JSON decode bug) | Not caught here. It propagates as-is and becomes a 500 via FastAPI's default handling. Converting genuinely unexpected errors into a 502 "provider failed" would hide bugs. |

## Acceptance criteria

Tests are created **only** by the `generate-tests` skill, when the user invokes
it. This checklist is what those tests must assert.

Stubbing: tests never construct `AnthropicProvider`. They define a
`StubProvider(ChatProvider)` whose `complete()` returns a canned
`ProviderResult` or raises a canned `ProviderError`, and install it with
`app.dependency_overrides[get_chat_provider] = lambda: stub`. **No test makes a
real network call.** Adapter-mapping tests (items 3–6 below) instantiate
`AnthropicProvider` and monkeypatch `provider._client.messages.create` with an
async fake returning a fabricated response object — still no network.

- [ ] `ProviderResult` is constructible with all seven fields and is frozen
      (mutating `result.content` raises `FrozenInstanceError`).
- [ ] `ChatProvider` cannot be instantiated directly (`TypeError`), and a
      subclass that implements `complete()` can.
- [ ] Given a fake Anthropic response with two `text` blocks, `complete()`
      returns their concatenation as `content`.
- [ ] Given a fake response with
      `usage(input_tokens=11, output_tokens=22, cache_read_input_tokens=5)`,
      the result has `input_tokens == 11`, `output_tokens == 22`,
      `provider_metadata["cache_read_input_tokens"] == 5`, and
      `"cache_read_input_tokens"` is **not** a top-level `ProviderResult` field.
- [ ] `provider_metadata["stop_reason"]` equals `result.stop_reason` equals the
      fake response's raw `stop_reason`.
- [ ] `result.model` equals the fake response's `model` (provider-reported), not
      the `model` argument passed in, when the two differ.
- [ ] `result.provider == "anthropic"`.
- [ ] A fake response with zero `text` blocks yields `content == ""` and does
      **not** raise.
- [ ] For each row of the exception mapping table: patching the client to raise
      that SDK exception makes `complete()` raise `ProviderError` with the
      expected `error_type`. At minimum cover `APITimeoutError` → `timeout`,
      `RateLimitError` → `rate_limit`, `AuthenticationError` → `authentication`,
      and a 500 `APIStatusError` → `server_error`.
- [ ] `APITimeoutError` maps to `timeout`, **not** `connection` — proving the
      catch order is right.
- [ ] Patching the client to raise `asyncio.CancelledError` makes `complete()`
      raise `CancelledError`, not `ProviderError`.
- [ ] `complete()` passes the system prompt as the `system` kwarg and the
      `messages` list contains no entry with `role == "system"`.
- [ ] `Settings()` exposes the seven new fields with the documented defaults
      when only `ANTHROPIC_API_KEY` is set in the environment.
- [ ] `get_chat_provider()` returns the same object on two successive calls
      (singleton).

## Files to be changed

| Path | Purpose |
|------|---------|
| `backend/pyproject.toml` | `anthropic` added to `[project].dependencies` via `uv add anthropic`. |
| `backend/uv.lock` | Regenerated by the same `uv add`. |
| `backend/app/providers/__init__.py` | **New.** `get_chat_provider()` singleton dependency; re-exports `ChatProvider`, `ProviderResult`, `ProviderError`. |
| `backend/app/providers/base.py` | **New.** `ProviderMessage`, `ProviderResult`, `ChatProvider` ABC, `ProviderError`. Imports nothing from `app.*`. |
| `backend/app/providers/anthropic.py` | **New.** `AnthropicProvider` — `AsyncAnthropic` client, native→canonical mapping, SDK exception translation. The only file in the repo that imports the `anthropic` package. |
| `backend/app/core/config.py` | Seven new `Settings` fields (FR10). |
| `backend/.env.example` | Placeholder entries for the same seven fields. No real key. |
| `backend/tests/test_providers.py` | **Created only via the `generate-tests` skill, when the user invokes it.** Adapter mapping + error translation tests per "Acceptance criteria". |

Explicitly **not** changed: `app/models.py`, `alembic/versions/*`,
`app/schemas.py`, `app/routers/*`, `app/main.py`, anything under `frontend/`.

## Feature-specific rules

- **The adapter is a pure mapping.** It translates a response and it translates
  an error. It does not validate business rules (empty completions, message
  ordering, window size) — those belong to the caller. Keeping it pure is what
  makes it trivially replaceable.
- **New provider capabilities land in `provider_metadata` first.** A field is
  promoted to a canonical `ProviderResult` field (and later a log column) only
  when a query pattern needs to filter or aggregate on it.
- **One emission point discipline.** This spec does not log inference events.
  Spec 006 wraps `ChatProvider.complete()` from the outside with
  `logged_chat()`; the adapter must stay unaware that logging exists.
- **`error_type` values are a closed vocabulary in v1** — the eleven strings in
  the mapping table. Spec 005's `InferenceLog.error_type` column stores them
  as-is. Adding a value is a code change, not a schema change (the column is a
  plain string, deliberately).
- Never log or include the API key, and never put the rendered prompt into a
  `ProviderError` message.

## Open questions

- **`temperature` vs. the default model.** The confirmed decision list specifies
  a `TEMPERATURE` setting (default `1.0`), but the confirmed default chat model
  `claude-opus-5` rejects `temperature` / `top_p` / `top_k` with a 400.
  *Assumed:* `TEMPERATURE` stays in `Settings` and is recorded by spec 006 in
  `request_params` / `config_hash`, but the adapter never forwards it to the
  Anthropic API. Confirm before build — the alternative is dropping the setting
  entirely, or switching the default model to one that still accepts sampling
  parameters.
- **`thinking` and `MAX_TOKENS=1024`.** `claude-opus-5` runs adaptive thinking
  by default and `max_tokens` bounds thinking + visible text together, so a
  1024-token cap can yield a truncated or empty completion. *Assumed:* the
  adapter sends `thinking={"type": "disabled"}` on every call (accepted at the
  default effort level; v1 uses no tools, so the disabled-thinking tool-call
  failure mode does not apply), and the default `SYSTEM_PROMPT` includes a line
  instructing the model not to emit internal or system XML tags. Confirm before
  build — the alternative is leaving thinking on and raising `MAX_TOKENS` to
  ~4096.
- **Default `SYSTEM_PROMPT` text.** *Assumed:* a short generic assistant prompt
  (e.g. "You are a helpful, concise assistant. Do not include internal or system
  XML tags in your response."). Confirm the wording before build; it feeds
  `config_hash` in spec 006, so changing it later re-buckets historical logs.
