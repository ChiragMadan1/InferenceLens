# PII Redaction of Inference Log Events

## Problem statement

Inference log events currently leave the app with raw user content in
`input_messages` and `output_text`. Add demo-grade PII redaction in the
**application layer**, applied before any event reaches the logging
system, so the ingestion store (and everything downstream — Kafka, spec
017; DuckDB, spec 018) only ever sees redacted content.

The architecture for this was decided in the design doc
(`.claude/designs/inference-logging-chatbot.md`, "PII redaction &
governance") and built in spec 006: the SDK's `EVENT_PROCESSORS` chain
(`app/logging_sdk/events.py`) is the documented redaction extension
point, applied by `CallRecorder` immediately before publish. This
feature **fills that slot** — it does not redesign it. The redactor
itself is application code (redaction is the app's responsibility); the
SDK stays host-agnostic and unchanged.

**Out of scope:**
- Redacting the product itself — the `messages` table, API responses,
  and the SSE stream keep raw text. Redaction is a property of the
  observability pipeline only.
- Production-grade detection (NER/name detection, locale tuning,
  compliance guarantees). Demo-grade library defaults are the bar.
- Any change to `InferenceLogEvent` schema, ingestion endpoint, or
  `inference_logs` table — no `redaction_applied` marker field, no
  `schema_version` bump, no migration.
- Any change to `app/logging_sdk/` — recorder failure semantics (spec
  006 edge case 11, fail-open) are kept as-is.
- Redacting `error_message`, `request_params`, `provider_metadata`
  (decided: content fields only).

## Functional requirements

1. **FR1** — A redactor function with the SDK's `EventProcessor`
   signature (`(InferenceLogEvent) -> InferenceLogEvent`) lives in a new
   app module `backend/app/core/redaction.py`.
2. **FR2** — The redactor scrubs exactly two fields: the `content`
   string of every entry in `input_messages` (including the system
   message) and `output_text` (when not `None`). All other fields pass
   through byte-identical.
3. **FR3** — Detection/replacement uses `scrubadub` with its default
   detector set (email, phone, URL, handles, credentials — as shipped by
   the installed version), replacing matches with scrubadub's standard
   `{{TYPE}}` placeholders (e.g. `{{EMAIL}}`, `{{PHONE}}`).
4. **FR4** — `init_observability()` (`app/core/observability.py`)
   registers the redactor into `EVENT_PROCESSORS` at startup **iff**
   `settings.REDACTION_ENABLED` is true. Registration is idempotent
   (calling `init_observability()` twice must not register it twice);
   `close_observability()` deregisters it.
5. **FR5** — New setting `REDACTION_ENABLED: bool = True` in `Settings`
   (`app/core/config.py`), documented in `backend/.env.example`.
6. **FR6** — Redaction applies to every event the recorder emits — both
   `invoke()` and `invoke_stream()` paths, chat and title calls — with
   no per-call-site code. Call sites (routers, providers) are untouched.
7. **FR7** — The redactor never raises out of the processor chain: each
   field is scrubbed under its own try/except; on failure it logs ERROR
   with `request_id` context and keeps that field's original text,
   continuing with the rest. (Recorder-level fail-open behavior for a
   processor that does raise is unchanged — see Constraints.)

## Non-functional requirements

- **Latency**: processors run synchronously on the request path (inside
  the recorder's `finally`, before the fire-and-forget publish).
  scrubadub's regex detectors are milliseconds per event at chat-message
  sizes — acceptable. This is why NER-based options were rejected.
- **SDK portability is preserved**: no new imports inside
  `app/logging_sdk/`; the portability grep from CLAUDE.md must stay
  empty. The dependency on scrubadub belongs to the app, not the SDK.
- Deliberately not added (per CLAUDE.md defaults): no config-driven
  detector registry, no plugin system around `EVENT_PROCESSORS` — it
  stays a list with (now) one entry.

## Data model

None. No model changes, no Alembic migration. `InferenceLogEvent` keeps
`schema_version = 1`.

## API contracts

None. No new or changed endpoints; no `schemas.py` or frontend changes.
Existing `/ingest/logs` receives the same shape, with placeholder tokens
in content fields.

## Constraints

- `EVENT_PROCESSORS` is a module-level list in the SDK; the app mutates
  it only from the composition root (`init_observability()` /
  `close_observability()`) — nowhere else.
- Processors receive a Pydantic model; the redactor returns a modified
  copy (`model_copy(update=...)`) rather than mutating in place,
  honoring the `(event) -> event` contract.
- `config_hash` is computed by the recorder **before** processors run,
  from the raw system prompt/params. Unchanged and acceptable: a hash
  reveals no PII, and redacting first would fracture config grouping.
- Recorder failure semantics stay fail-open (spec 006 edge case 11): if
  the processor itself raises despite FR7, the recorder logs ERROR and
  publishes the **unredacted** event. Accepted demo-grade risk,
  documented here rather than engineered away.
- New dependency added via `uv add scrubadub` only (updates
  `pyproject.toml` + `uv.lock`).

## Error handling and edge cases

| Case | Expected behavior |
|---|---|
| `output_text is None` (error/cancelled events) | Field skipped; event otherwise redacted and published. |
| Message `content` missing or not a `str` | Entry passed through unchanged; no crash. |
| Empty string content / empty `input_messages` | No-op redaction; event published normally. |
| scrubadub raises on one field | ERROR log with request_id; that field keeps original text; other fields still redacted (FR7). |
| Redactor raises out of the chain anyway | Existing recorder behavior: ERROR log, unredacted event published — chat never breaks. |
| `REDACTION_ENABLED=false` | Processor never registered; events flow raw, exactly as today. |
| `init_observability()` called twice | Redactor registered once (FR4). |
| Text already containing `{{EMAIL}}`-like tokens | Passed through as-is; no double-encoding concerns for the demo. |

## Acceptance criteria

- [ ] With redaction on, a chat message containing an email and a phone
  number produces an `inference_logs` row whose `input_messages` show
  `{{EMAIL}}`/`{{PHONE}}` placeholders instead of the raw values.
- [ ] The same conversation's `messages` table rows and the API/SSE
  response still contain the raw text.
- [ ] `output_text` in the log is redacted when the model echoes PII.
- [ ] A streaming chat call and a title-generation call are redacted the
  same way (both recorder paths).
- [ ] With `REDACTION_ENABLED=false`, log rows contain raw content.
- [ ] A redactor made to fail on one field still yields a published
  event with the other fields redacted, plus an ERROR log line.
- [ ] `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/`
  is empty; `git diff` shows no changes under `app/logging_sdk/`.
- [ ] `make lint` passes.

## Files to be changed

- `backend/app/core/redaction.py` — **new**: redactor function
  (EventProcessor-shaped) using scrubadub; per-field error handling.
- `backend/app/core/observability.py` — register/deregister the redactor
  in `init_observability()` / `close_observability()` behind the flag.
- `backend/app/core/config.py` — add `REDACTION_ENABLED: bool = True`.
- `backend/.env.example` — document `REDACTION_ENABLED`.
- `backend/pyproject.toml`, `backend/uv.lock` — via `uv add scrubadub`.
- `backend/tests/test_redaction.py` — only via the `generate-tests`
  skill, when invoked.

Nothing in `app/logging_sdk/`, `app/providers/`, `app/routers/`, or
`frontend/` changes.

## Feature-specific rules

- The redactor is the **only** processor; keep `EVENT_PROCESSORS` a
  plain list — no registry/priority machinery (CLAUDE.md, spec 006 §5).
- FR7's log-and-continue inside the redactor is a deliberate extension
  of the SDK's documented "logging must never break chat" carve-out to
  the app-side redaction path — it is not a general licence to swallow
  exceptions.
- Swapping scrubadub for a production detector later means changing
  `redaction.py` only; nothing else in this spec is library-aware.

## Open questions

None blocking. Defaults chosen on the user's behalf, called out here:
scrubadub's stock `{{TYPE}}` placeholder format (no custom replacement
strings), and en-default locale for its detectors — both fine for
demo-grade; revisit only if a specific PII corpus underperforms.
