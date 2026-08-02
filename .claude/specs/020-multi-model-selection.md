# Multi-Model Selection (second provider + per-message model choice)

Parent designs: `.claude/designs/inference-logging-chatbot.md` (which
designed the provider seam: "Anthropic is the intended second adapter —
designed for, not built in v1"; "Adding a provider = writing one adapter
mapping") and user decisions recorded 2026-08-02.

**Ordering: implement this spec BEFORE 016/017/018** (user decision).
It touches `core/config.py`, `.env.example`, and `pyproject.toml`, which
017/018 also touch — sequential implementation avoids merges.

## Problem statement

The system is multi-provider by design but single-provider in practice:
one hardcoded adapter (OpenAI), chat model fixed by `OPENAI_MODEL`, no
way to choose a model per message. For the demo we want to send messages
against different models — OpenAI's `gpt-5.6-terra` and Anthropic's
`claude-sonnet-5` — from a dropdown in the chat composer, and see the
logs dashboard split by model/provider (filters and breakdowns for that
already exist via specs 014/015; they light up automatically).

This is **a demo capability, deliberately not extended further**: models
are hardcoded in a backend catalog, keys come from env, no per-user
model preferences, no per-conversation persistence, no model management
UI.

**Out of scope:** persisting model choice on the conversation (no DB
column, no migration); changing the auto-title path (stays on
`OPENAI_TITLE_MODEL` via the configured title provider — user decision);
provider fallbacks/routing policies; touching `app/logging_sdk/` (zero
SDK changes — the whole point of the architecture); pagination on
`GET /models` (fixed tiny list); postman regeneration (own skill).

## Functional requirements

1. FR1: A hardcoded backend **model catalog** maps model id → provider +
   display name: `gpt-5.6-terra` (openai, default) and
   `claude-sonnet-5` (anthropic). Adding a model is a one-line catalog
   edit (plus a price-map entry).
2. FR2: `GET /models` returns the **available** catalog entries — those
   whose provider has an API key configured — each as
   `{id, provider, display_name, is_default}`. No auth, no pagination.
3. FR3: `MessageCreate` gains optional `model` (trimmed, 1–128 chars
   when present). Omitted/null → the configured default model
   (`DEFAULT_CHAT_MODEL`, default `gpt-5.6-terra`). Existing clients
   keep working unchanged.
4. FR4: A `model` that is unknown to the catalog, or whose provider has
   no key configured, is rejected with 422 and a message naming the
   allowed ids. Whitespace-only `model` is 422 (schema validation).
5. FR5: Both chat endpoints (`POST /conversations/{id}/messages` and
   the SSE `/messages/stream`) route the call to the resolved model's
   provider adapter and pass the resolved model id to
   `send_message`/`stream_message`.
6. FR6: A new `AnthropicProvider` adapter (Anthropic SDK, Messages API)
   implements the full `ChatProvider` contract: `send_message`,
   `stream_message`, `describe_call`, `describe_outcome`,
   `describe_stream_outcome`, `describe_failure`, `provider_name =
   "anthropic"`. It is not exported from `app.providers` (same rule as
   `OpenAIProvider`).
7. FR7: Structural instrumentation is preserved: providers are obtainable
   only via `app.providers` accessors, and every returned provider is a
   `LoggingChatProvider`. `get_chat_provider()` accepts an optional
   resolved model id and wraps the matching adapter; no-arg behavior
   (default model's provider) is unchanged for existing callers.
8. FR8: Every Claude call produces exactly one inference log with
   `provider="anthropic"`, `model="claude-sonnet-5"`, token usage,
   rendered `input_messages` (system prompt first), `output_text`,
   `config_hash`, and — via the price map — non-null `cost_usd`.
   Streaming Claude calls record `time_to_first_token_ms`. No event
   schema or SDK change is needed for any of this.
9. FR9: Titling behavior is byte-for-byte unchanged (`call_type=title`,
   `OPENAI_TITLE_MODEL`, title provider).
10. FR10: Frontend: the chat composer gains a model dropdown populated
    from `GET /models` (default preselected); the selection is sent as
    `model` on both send and stream paths. Selection is page-local UI
    state (per user intent: "select from a dropdown while sending").

## Non-functional requirements

- No added latency on the default path: catalog resolution is an
  in-memory dict lookup; adapters remain per-provider singletons (one
  SDK connection pool per provider per process).
- Anthropic errors surface exactly like OpenAI errors: adapter raises
  `ProviderError` → 502 clean JSON; error-status log recorded.
- The portability invariant stands:
  `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/` empty.

## Data model

None. No model change, no migration. (`InferenceLog.model`/`provider`
columns already carry per-call values; conversations deliberately do not
record a model.)

## API contracts

| Method | Path | Request → Response | Notes |
|---|---|---|---|
| GET | `/models` | — → `list[ModelRead]` | new router `app/routers/models.py`; `ModelRead {id, provider, display_name, is_default}` in `app/schemas.py` |
| POST | `/conversations/{id}/messages` | `MessageCreate {content, model?}` → `ChatTurnRead` | 422 invalid model; otherwise unchanged |
| POST | `/conversations/{id}/messages/stream` | same `MessageCreate` → SSE | same validation before the stream opens |

Settings changes (`app/core/config.py`, mirrored in `.env.example`):

| Setting | Change |
|---|---|
| `ANTHROPIC_API_KEY` | new, `str \| None = None` — optional; absence just hides anthropic models from the catalog |
| `DEFAULT_CHAT_MODEL` | new, default `gpt-5.6-terra`; must be a catalog id (validated) |
| `OPENAI_MODEL` | **removed** — superseded by `DEFAULT_CHAT_MODEL` (it was only read by the two chat handlers). `OPENAI_TITLE_MODEL` stays |
| `ANTHROPIC_MODEL` | not added — model ids live in the catalog, not settings |

## Constraints

- `anthropic` SDK via `uv add anthropic`; async client (`AsyncAnthropic`)
  constructed once per process with `api_key` and
  `timeout=PROVIDER_TIMEOUT_SECONDS` (mirror of the OpenAI adapter).
- Catalog lives in `app/providers/catalog.py`: an ordered mapping of
  model id → `(Provider, display_name)` plus helpers `available_models()`
  (filters on configured keys — lazy settings import, same pattern as
  `app/providers/__init__.py`) and `resolve(model_id)`. Routers never
  map model→provider themselves; the catalog is the single source.
- `Provider` enum gains `ANTHROPIC`; `_build()` gains one `case`; the
  `_inner()` singleton becomes a per-provider registry
  (`dict[Provider, ChatProvider]`).
- Chat handlers switch from `Depends(get_chat_provider)` to resolving
  the model first (validate → 422) and then calling
  `get_chat_provider(model=resolved_id)` directly in the handler — it
  is still the accessor, so the critical "providers only via accessors"
  rule holds. `get_title_provider()` is untouched.
- Anthropic API mapping (verified against current SDK docs):
  - `client.messages.create(model=..., max_tokens=..., system=...,
    messages=[{role: user|assistant, content: str}, ...])` — system is a
    top-level param, not a message; roles map 1:1 from our window.
  - Usage fields are already OTel-shaped: `usage.input_tokens`,
    `usage.output_tokens` — map directly.
  - `stop_reason` and the response `model` echo go into
    `provider_metadata` (canonical columns stay provider-neutral).
  - **Do not send `temperature`** — `claude-sonnet-5` rejects non-default
    sampling params with a 400. Record it in
    `request_params`/`config_hash` exactly as the OpenAI adapter does
    (the two-mapping split from spec 003 applies unchanged).
  - Streaming via `client.messages.stream(...)`: text deltas become the
    adapter's stream chunks (mirroring `OpenAIProvider.stream_message`'s
    chunk contract from spec 012); final usage comes from the stream's
    final message and feeds `describe_stream_outcome`.
  - `describe_failure`: map the SDK's typed exceptions
    (`anthropic.APIStatusError` subclasses, `APIConnectionError`) to
    `error_type`/truncated `error_message`; wrap them in `ProviderError`
    for the router's existing 502 translation, mirroring the OpenAI
    adapter's approach.
- Price map (`app/core/pricing.py`): add `claude-sonnet-5` at
  **$3.00 input / $15.00 output per MTok** (standard rate; intro pricing
  $2/$10 runs through 2026-08-31 — comment this; the map is versioned in
  git and hand-maintained per the parent design).
- Frontend (`frontend/src/api.ts` + chat components): `ModelRead` type +
  `getModels()`; `MessageCreate` type gains `model?`; `sendMessage` and
  `streamMessage` take the selected model; the Composer renders a small
  `<select>` (models from the endpoint, default preselected, disabled
  while a send is in flight), styled with the existing token layer.

## Error handling and edge cases

| # | Case | Behavior |
|---|------|----------|
| 1 | `model` omitted / null | Default model used; response and logs identical to today |
| 2 | Unknown `model` ("gpt-9") | 422 listing allowed ids; no user message stored, no provider call |
| 3 | Known model, provider key not configured | Same 422 (it is not in the available catalog); `GET /models` never offered it |
| 4 | Whitespace-only `model` | 422 (schema validation, consistent with empty `content`) |
| 5 | Anthropic API error (auth, rate limit, 5xx) | `ProviderError` → 502 clean JSON; log row with `status=error`, `provider=anthropic`, error fields; user message kept for retry (parity with edge 6 of the parent design) |
| 6 | Mixed models within one conversation | Allowed; each turn logs its own model; context window (last 10 messages) is model-agnostic |
| 7 | Stream cancelled mid-Claude-response | Existing recorder behavior: `status=cancelled` log; no special casing |
| 8 | `ANTHROPIC_API_KEY` unset (default env) | App boots; `GET /models` returns only OpenAI entries; dropdown shows one model; everything else unchanged |
| 9 | `DEFAULT_CHAT_MODEL` set to a non-catalog id | Fail fast at startup (settings validation) — misconfiguration, not a request-time surprise |
| 10 | Old frontend / postman payloads without `model` | Work unchanged (FR3) |

## Acceptance criteria

- [ ] `GET /models` with both keys configured returns 2 entries with
      `gpt-5.6-terra` marked default; without `ANTHROPIC_API_KEY` it
      returns 1.
- [ ] `POST .../messages` with `"model": "claude-sonnet-5"` returns an
      assistant reply, and `GET /logs` shows the log row with
      `provider=anthropic`, `model=claude-sonnet-5`, non-null tokens and
      `cost_usd`.
- [ ] Same via the stream endpoint, with `time_to_first_token_ms`
      populated on the log.
- [ ] Omitting `model` behaves exactly as before this spec (default
      model, `provider=openai`).
- [ ] `"model": "gpt-9"` → 422 naming the allowed ids; no log row, no
      stored user message.
- [ ] After a Claude turn, the conversation's title call still logs
      `call_type=title` with the configured title model.
- [ ] Logs dashboard model/provider filters and by-model breakdowns show
      both models with no frontend logs-page changes.
- [ ] `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/`
      is empty; `git diff` shows zero changes under `app/logging_sdk/`.
- [ ] Composer dropdown lists available models, preselects the default,
      and the selected model is what the log records.
- [ ] `make lint` passes.

## Files to be changed

- `backend/pyproject.toml`, `backend/uv.lock` — `uv add anthropic`.
- `backend/app/providers/base.py` — `Provider.ANTHROPIC` enum member.
- `backend/app/providers/anthropic.py` — new adapter (never exported).
- `backend/app/providers/catalog.py` — new: model catalog +
  `available_models()` / `resolve()`.
- `backend/app/providers/__init__.py` — anthropic `_build` case;
  per-provider inner registry; `get_chat_provider(model=None)`.
- `backend/app/core/config.py` — `ANTHROPIC_API_KEY`,
  `DEFAULT_CHAT_MODEL` (+ validation), remove `OPENAI_MODEL`.
- `backend/app/core/pricing.py` — `claude-sonnet-5` price entry.
- `backend/app/schemas.py` — `MessageCreate.model`, `ModelRead`.
- `backend/app/routers/models.py` — new `GET /models` router (no
  repository — the catalog is static, not a DB resource; the data-access
  rule applies to DB-backed resources).
- `backend/app/routers/messages.py` — model resolution/validation in
  both handlers; provider via `get_chat_provider(model=...)`; pass
  resolved model.
- `backend/app/main.py` — register the models router.
- `backend/.env.example` — `ANTHROPIC_API_KEY`, `DEFAULT_CHAT_MODEL`;
  drop `OPENAI_MODEL`.
- `frontend/src/api.ts` — `ModelRead`, `getModels()`, `model` on
  `MessageCreate`/`sendMessage`/`streamMessage`.
- `frontend/src/components/chat/Composer.tsx` — model dropdown.
- `frontend/src/pages/ChatPage.tsx` — selected-model state, passed to
  send/stream.

## Feature-specific rules

- Concrete adapters stay unexported; `_build()`/accessors remain the
  only construction path (FR21 of spec 006 extends to the new adapter).
- Zero edits under `app/logging_sdk/` — if implementing this seems to
  require an SDK change, the implementation is wrong (the adapter ABC
  carries all provider knowledge).
- The catalog is deliberately hardcoded (user decision: "hardcoded like
  today's OpenAI"). Do not make it a DB table, a settings list, or a
  plugin registry.
- Model ids are used verbatim as API ids and log values — no aliasing
  layer.

## Open questions

None blocking. Recorded assumptions (confirm-or-correct at review):
`OPENAI_MODEL` removed in favor of `DEFAULT_CHAT_MODEL` (only the two
chat handlers read it); dropdown selection is per-page UI state, not
persisted anywhere; price map records the standard $3/$15 rate with the
intro discount noted as a comment.
