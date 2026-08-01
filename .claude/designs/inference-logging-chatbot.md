# Inference Logging Chatbot — Design Doc

## Problem statement

Build a lightweight LLM inference logging and ingestion system around a working
chatbot (source: `notes.md`). A user chats with an LLM-backed assistant in a
web UI; every model call is captured by a logging SDK/wrapper that emits an
inference event through an event-publisher abstraction to an ingestion API,
which validates and stores the log in the database alongside the chat data.
The deliverable is a take-home assignment: sensible schema design, clear
tradeoffs, and a README/architecture notes matter as much as the code.

## Product intent — why systems like this exist

LLM calls are expensive, slow, non-deterministic, and opaque. Inference
observability turns them into something operable. Concretely, teams run these
systems to get:

- **Cost control & attribution** — tokens are money; per-model/per-feature
  (and eventually per-user) usage answers "where is our spend going?"
- **Latency & reliability monitoring** — p50/p95 latency, error and timeout
  rates, provider outages; the on-call surface for an LLM product.
- **Debugging & prompt iteration** — when a user reports a bad answer, the
  log shows *exactly* what the model was sent and what it returned. This is
  the single highest-value query in these systems.
- **Evaluation datasets** — real production prompts/completions get exported
  as eval sets to test prompt changes and model upgrades against.
- **Model comparison** — same workload across models/providers, compared on
  quality-proxy metrics, latency, and cost.
- **Audit & compliance** — an immutable record of what the AI system did.

The design below optimizes for the debugging and monitoring use cases first,
with eval export as a natural consequence of storing full content.

## Industry landscape — what we draw from

The established players converge on the same pipeline shape:

| System | Capture method | Pipeline | Storage |
|---|---|---|---|
| **Langfuse** (OSS) | SDK wrapper / decorators | async ingestion API → Redis queue → workers | Postgres (OLTP) + ClickHouse (analytics) + S3 (large payloads) |
| **LangSmith** | SDK wrapper / callbacks | ingestion API → queue → processors | OLTP + blob store for payloads |
| **Helicone** | **Proxy** (change the SDK's base URL) | gateway → Kafka → workers | ClickHouse + S3 |
| **OpenTelemetry GenAI / OpenLLMetry** | Auto-instrumentation (monkey-patches provider SDKs) | standard OTel collector pipeline | any OTel backend (Datadog, Arize Phoenix, …) |

Common component chain: **instrument → ingest (validate) → buffer/queue →
process → store (hot metadata + cold content) → query/dashboards.** Our
design maps 1:1 onto it: SDK wrapper → `/ingest/logs` → (queue = future
Kafka; v1 skips the buffer) → `inference_logs` table → `/logs` API.

Two industry conventions we adopt directly:

1. **Denormalized content on the log record.** All of these systems store the
   full input/output *on* the log, never as a reference into the app's own
   tables — because the observability store is decoupled from the app DB,
   because what the model saw is a *rendered prompt* (system prompt + context
   window) that no single message row can reconstruct, and because logs must
   be immutable snapshots while app data can change.
2. **OTel GenAI naming for canonical fields** (`input_tokens`,
   `output_tokens`, provider/model attributes), so our schema speaks the
   emerging standard vocabulary.

One structure we deliberately simplify: the industry models a **trace**
(one user action) containing **spans/observations** (each LLM call, tool
call, retrieval). We store a flat log per LLM call with `request_id` as the
span-equivalent. A `trace_id` grouping is a straightforward later addition
if multi-call turns (e.g. tool use) arrive.

## Scope

**In scope:**

- Multi-turn chatbot backed by the OpenAI API (Responses API), with a
  pluggable provider adapter (multi-provider-ready, single provider
  implemented). Anthropic is the intended second adapter — designed for, not
  built in v1.
- Logging SDK: a wrapper around provider calls that captures inference
  metadata and publishes events via an `EventPublisher` interface.
  V1 transport: HTTP POST to the ingestion endpoint. Kafka publisher is a
  future swap-in (interface designed for it; consumer built later).
- Ingestion module: an API that receives log events, validates/parses them,
  and stores them. Lives in the same FastAPI app but is architecturally
  isolated (own router, own schemas, communicates only via the published
  event payload) so it can be split into its own service when Kafka lands.
- Auto-generated conversation titles via a separate async LLM call after the
  first turn (itself logged as an inference event).
- DB storage for conversations, messages, and inference logs (SQLite via
  SQLAlchemy, migrations via Alembic — per project conventions).
- Frontend (React/Vite): conversation list, create conversation, resume
  (open and continue) a conversation, chat view, cancel an in-flight
  response.
- Cancellation: aborts the in-flight generation only; the conversation
  stays open.
- Streaming responses (SSE): planned as a **later feature** in the breakdown,
  not part of the initial chat implementation.
- Pagination on **all** list endpoints (conversations, messages, logs) —
  explicit user decision, overriding the project's ~1k-row default heuristic.

**Out of scope** (explicit, so nobody wonders later):

- Auth/authorization, rate limiting, caching, websockets (CLAUDE.md defaults;
  single anonymous user assumed).
- Multi-user support and `user_id` columns — **deliberately deferred** until
  auth exists (user decision; adding a nullable column later is a trivial
  migration).
- Dashboards (latency/throughput/error charts) — bonus item not selected.
- PII redaction — bonus item not selected.
- Docker Compose / k8s deploy — conflicts with project conventions.
- Kafka itself and the event consumer — the publisher *interface* ships in
  v1 with an HTTP implementation; the broker and consumer are future work.
- Deleting conversations (no delete endpoint in v1; nothing to cascade).
- A second datastore. SQLite is the only store.

## Users and user flows

Single actor: an anonymous end user of the chat UI. (The ingestion API's
"caller" is the logging SDK, an internal actor.)

**Flow 1 — start a chat:** user opens the app → sees conversation list →
clicks "New conversation" (`POST /conversations`) → lands in an empty chat
view → types a message → `POST /conversations/{id}/messages` → assistant
reply appears → repeat.

**Flow 2 — auto-title (system flow):** after the *first* assistant reply of
a conversation is stored, a background task makes a small titling call
through the same logged provider path (`call_type=title`, cheap settings)
and updates `conversation.title`. Failure leaves the default title and logs
an error-status inference event; the chat is unaffected. The title appears
on the next conversation-list refresh.

**Flow 3 — resume:** user opens the app → clicks an existing conversation →
messages load (`GET /conversations/{id}/messages`) → user continues chatting;
the model receives the last 10 messages as context.

**Flow 4 — cancel:** user sends a message → while the assistant response is
pending, clicks "Cancel" → `POST /conversations/{id}/cancel` aborts the
in-flight generation → the user message remains in history, no assistant
message is stored → an inference log with status `cancelled` is emitted →
user may send another message immediately.

**Flow 5 — logging (system flow):** chat endpoint calls the provider through
the SDK wrapper → wrapper measures latency, captures usage/status → builds an
`InferenceLogEvent` → publishes via `EventPublisher` (v1: async HTTP POST to
`POST /ingest/logs`, fire-and-forget from the chat request's perspective) →
ingestion validates the payload → stores an `InferenceLog` row. Publisher
failures are logged server-side and never fail the chat request.

**Flow 6 — inspect logs (API-only in v1):** `GET /logs?conversation_id=...`
returns paginated inference logs (previews computed at read time; full
content on the detail endpoint).

## How the logging SDK works (explainer)

*(Kept in the doc because "how do such SDKs work" is part of the assignment's
architecture-notes deliverable.)*

**The core idea is a wrapper.** A logging SDK stands between your code and the
provider's SDK. It takes the same inputs, records a timestamp, calls the real
provider, and — whether the call succeeds, fails, or is cancelled — records what
happened and forwards the result unchanged. The application code cannot tell
it's there; that's the "middleware" property.

**Where we put the wrapper is the load-bearing decision.** A wrapper the caller
has to *choose* (`logged_chat(provider, ...)` instead of
`provider.send_message(...)`) leaves both paths open forever: "is every LLM call
logged?" becomes a question you re-answer at every call site, and the most
natural thing a new developer can write is the unlogged one. So the wrapper is
not a function callers pick — it is **an object that implements the provider
interface and is the only provider anyone can obtain**:

```
chat code ──> provider.send_message(messages, ...)   # ordinary call, unchanged
                 │   provider came from get_chat_provider(); it is a
                 │   LoggingChatProvider, and no other kind is reachable
                 ▼
              CallRecorder.invoke(inner, call_type=..., **kwargs)
                 t0 = now()
                 context = inner.describe_call(**kwargs)   # provider self-describes
                 try:    result = inner.send_message(**kwargs)   # real call
                         outcome = inner.describe_outcome(result)
                 except: failure = inner.describe_failure(exc); re-raise
                 finally: build event(latency=now()-t0, context, outcome, status)
                          publish(event)              # never blocks, never raises
              <── result (untouched)
```

**Ways the industry intercepts calls** (we use a typed variant of #2):

1. **Explicit wrapper function** — you call `logged_chat(...)` instead of the
   provider. Simple and visible, but opt-in: nothing stops the direct call, so
   coverage is a convention, not a guarantee. Rejected for that reason.
2. **Decorator** — the instrumented object *is* the interface, substituted at
   the composition root (Langfuse's `OpenAI` drop-in, LangChain callbacks).
   Ours: `LoggingChatProvider(ChatProvider)` is injected everywhere a
   `ChatProvider` is expected, so instrumentation is structural.
3. **Monkey-patching (auto-instrumentation)** — the SDK patches the provider
   library's methods at import time so *all* calls are captured with zero
   code changes (OpenLLMetry). Magical but fragile across SDK versions.
4. **Proxy** — point the provider SDK's `base_url` at a gateway that logs
   and forwards (Helicone). Zero code change, adds a network hop and a
   critical dependency on the proxy's uptime.

Approach #2 buys #3's "every call is captured" guarantee without #3's fragility:
the swap happens in one function we own (`get_chat_provider()`), not inside a
third-party library's namespace.

**The SDK never assumes anything about a provider.** It does not infer a
provider name from a class, reach into a result for `usage.input_tokens`, or
`isinstance`-check exception types. It asks, through three abstract methods the
provider ABC forces every adapter to implement — `describe_call`,
`describe_outcome`, `describe_failure`. Everything on an event comes from what
the adapter returned or from the SDK's own clock; adding a provider adds
mappings and changes zero SDK code.

**The SDK does not import the application.** `app/logging_sdk/` imports only the
standard library, Pydantic and httpx — no settings, no models, no schemas, no
provider types. Configuration arrives as constructor arguments (the ingest URL
and timeout are passed in by `app/core/observability.py`, the host's composition
root) and provider knowledge arrives through the ABC. The package can be lifted
into another codebase, or split into its own service, unchanged. The ~20-line
`LoggingChatProvider` shim is the only host-specific piece, because only the host
knows its own `send_message` signature.

**When exactly our SDK fires:** one event per provider call — chat calls and
titling calls alike. The event is assembled in `CallRecorder.invoke`'s `finally`
path after the call resolves (success, error, or cancellation), and published via
a fire-and-forget async task so the chat response is never delayed by logging.
There is exactly one emission point in the codebase.

**How these SDKs behave at scale** (v1 doesn't need this; the interface
allows it): production SDKs never send one HTTP request per event. They push
events into a **bounded in-memory queue**; a background worker **flushes in
batches** (every N events or T seconds); on overflow they **drop events**
rather than block the product (observability must never take down the thing
it observes); delivery is **at-least-once with retry**, made safe by an
**idempotency key** — our `request_id` unique constraint is exactly that;
shutdown does a best-effort final flush. Swapping our `HTTPEventPublisher`
for a batching or Kafka publisher changes none of the call sites.

## Cross-provider normalization

Every provider returns a differently-shaped response: OpenAI's Responses API
reports `usage.input_tokens`/`output_tokens` with nested
`input_tokens_details`/`output_tokens_details` and expresses "why generation
stopped" as a `status` plus `incomplete_details.reason`; its older Chat
Completions surface uses `prompt_tokens`/`completion_tokens` and a
`finish_reason`; Anthropic reports `usage.input_tokens`/`output_tokens` plus
cache token fields and a `stop_reason`; Gemini nests `usageMetadata`. Message
formats and error taxonomies differ too. The log schema must not absorb this
variance.

The answer is the **adapter boundary**: each `ChatProvider` implementation
maps its provider's native response into a canonical `ProviderResult`
(content, `input_tokens`, `output_tokens`, model, provider name, stop
reason, plus a `provider_metadata` dict of anything provider-specific that
didn't fit). The log schema stores:

- **Canonical columns** for the fields every provider can supply (the
  queryable core — tokens, model, latency, status), named per OTel GenAI
  conventions.
- **A `provider_metadata` JSON column** as the overflow for provider
  extras (cache token counts, raw stop reasons, safety ratings, …) —
  captured without schema churn, queryable ad hoc.

Adding a provider = writing one adapter mapping. The event schema, ingestion,
and log table never change. This normalized-core + JSON-overflow split is
how Langfuse/OTel handle the same problem.

## Functional requirements

1. FR1: User can create a conversation; it appears in the conversation list.
2. FR2: User can list conversations, paginated, ordered by last activity
   (most recent first).
3. FR3: User can send a message to a conversation and receive an assistant
   reply generated by the configured provider/model.
4. FR4: Each chat call includes at most the last 10 messages of the
   conversation as context (sliding window).
5. FR5: User can list a conversation's messages, paginated, in chronological
   order.
6. FR6: User can cancel an in-flight generation; the request aborts, no
   assistant message is stored, and the conversation remains usable.
7. FR7: Every provider call — chat or title; success, error, or cancelled —
   produces exactly one inference log event containing: request_id,
   call_type, model, provider, latency_ms, token usage (when available),
   request timestamps, status, error info (when failed), conversation
   linkage, generation params + config hash, the full rendered input (as
   sent to the provider), and the full output text (when produced).
   TTFT is included once streaming exists.
7a. FR7a: Ingestion computes and stores `cost_usd` for each log from a
   versioned price map; unknown models yield null cost, never a rejection.
8. FR8: After the first assistant reply in a conversation, the system
   auto-generates a title via a separate async LLM call and updates the
   conversation; failures leave the default title.
9. FR9: The SDK publishes events through an `EventPublisher` interface; the
   chat code never talks to the ingestion API or DB for logging directly.
9a. FR9a: Every LLM call is instrumented **structurally** — the only provider
   obtainable from `app.providers` is an already-decorated one, so a call site
   cannot opt out and no "remember to use the logging path" rule exists.
9b. FR9b: The SDK package imports nothing from the application. Configuration
   arrives as constructor arguments and provider knowledge arrives through an
   ABC the host implements, so the package is reusable in another codebase.
10. FR10: The ingestion endpoint validates incoming payloads (Pydantic
    schema, versioned via `schema_version`), rejects malformed ones with
    422, and stores valid ones.
11. FR11: Ingestion is idempotent on `request_id` — re-delivery of the same
    event does not create a duplicate log.
12. FR12: Inference logs are listable via API (paginated; filterable by
    `conversation_id`, `status`, `call_type`; content returned as computed
    previews) and retrievable individually with full content.
13. FR13: Provider errors surface to the user as a clean error response and
    are recorded as `error`-status logs.

## Non-functional requirements

- **Logging must not add user-visible latency**: event publishing is
  asynchronous and failures are contained at the publishing boundary —
  logged with context, never raised into the chat path.
- **Loose coupling for future eventing**: ingestion's only contract is the
  versioned event payload; nothing in ingestion imports chat internals.
  Swapping the HTTP publisher for a Kafka producer touches neither chat nor
  ingestion code.
- **Volumes**: single-user demo; logs grow fastest (~1–2 rows per chat turn
  once titling is counted). Pagination everywhere per user decision. No
  retention policy in v1.
- **Observability of the system itself**: standard app logging via the
  existing `setup_logging()`; publisher failures logged at ERROR.

## Data model

All tables via SQLAlchemy models + Alembic migrations.

### Conversation

| field       | type     | notes                                        |
|-------------|----------|----------------------------------------------|
| id          | int PK   | autoincrement                                |
| title       | str      | required, default `"New conversation"`; overwritten by auto-titling |
| status      | str enum | `active` — the only value used in v1; enum exists for extensibility (archive/soft-delete later), no endpoints change it yet |
| created_at  | datetime | server default now (UTC)                     |
| updated_at  | datetime | bumped on new message; drives list ordering  |

### Message

| field           | type     | notes                                     |
|-----------------|----------|-------------------------------------------|
| id              | int PK   |                                           |
| conversation_id | int FK → conversations.id | required; parent validated (404 if missing) |
| role            | str enum | `user` \| `assistant`                     |
| content         | text     | full text, non-empty (422 on empty)       |
| created_at      | datetime |                                           |

Index on `(conversation_id, created_at)` for the context-window query and
paginated listing.

### InferenceLog

| field             | type     | notes                                              |
|-------------------|----------|----------------------------------------------------|
| id                | int PK   |                                                    |
| request_id        | str uuid | **unique** — idempotency key, generated by the SDK |
| schema_version    | int      | event contract version (1); lets a future consumer handle old events |
| conversation_id   | int, nullable, **no FK** | linkage metadata from the event payload |
| call_type         | str enum | `chat` \| `title` (extensible)                     |
| model             | str      | e.g. `gpt-5.6-terra`                               |
| provider          | str      | e.g. `openai`                                      |
| status            | str enum | `success` \| `error` \| `cancelled`                |
| latency_ms        | int      | wall-clock of the provider call                    |
| input_tokens      | int, nullable | canonical (OTel GenAI naming); null on error/cancel |
| output_tokens     | int, nullable |                                               |
| error_type        | str, nullable | canonical error class on failure               |
| error_message     | str, nullable | truncated                                      |
| time_to_first_token_ms | int, nullable | TTFT — measurable only once streaming lands (feature 012); null until then. Column ships now so streaming is a data backfill, not a schema change |
| cost_usd          | numeric, nullable | computed **at ingestion** from a versioned static price map (per-MTok input/output rates × tokens); null when the model is unknown to the map. Stored (not derived at read) so cost is immutable even when prices change later — industry practice |
| request_params    | JSON, nullable | generation params as sent (max_tokens, effort/temperature, …) |
| config_hash       | str, nullable | hash of (provider, model, system prompt, params) — groups calls made with an identical configuration, enabling config-level comparison ("did the new prompt version get slower/costlier?") |
| input_messages    | JSON     | the exact rendered payload sent to the provider (system prompt + message window) — the debugging artifact |
| output_text       | text, nullable | full completion text                          |
| provider_metadata | JSON, nullable | provider-specific overflow (cache tokens, stop reason, provider-reported model snapshot/fingerprint, …) |
| requested_at      | datetime | when the provider call started                     |
| completed_at      | datetime, nullable | when it finished/failed                   |
| created_at        | datetime | ingestion time                                     |

**Derived metrics are computed at read time, not stored:** output throughput
(tokens/sec) = `output_tokens / (completed_at − requested_at)` — and, once
TTFT exists, the more precise `output_tokens / (completed_at − first_token)`
(vLLM's "TPOT"/inter-token latency). Storing raw measurements and deriving
rates avoids denormalized numbers drifting from their inputs.

**Indexes** (driven by the query patterns below): `request_id` (unique),
`(created_at)`, `(conversation_id, created_at)`, `(status, created_at)`.

**Content decision (user-confirmed, industry-aligned):** logs store the
**full** rendered input and output, denormalized — no references into the
`messages` table. Rationale: the log must be self-contained (the future
Kafka consumer may not share this DB), the rendered prompt is not
reconstructable from any message row, and logs are immutable snapshots while
messages could change. Previews are *computed at read time* by the list API
(first ~500 chars), not stored. Cost: content is stored roughly twice
(messages + logs); accepted, managed later via retention/offload exactly as
Langfuse/LangSmith do (tiered storage), never by re-normalizing.

**Deliberate FK exception:** `conversation_id` is a plain column, not a
foreign key, and is not parent-validated at ingestion. Ingestion's contract
is the event payload; it must accept events even if it knows nothing about
the chat schema. This is an explicit exception to the project's
"child records validate their parent" rule, confined to the ingestion
boundary.

### inference_scores (future table — designed, not built in v1)

Quality signals — hallucination detection, user feedback, LLM-as-judge
evaluations — are **not** derivable from a single log row at write time.
The industry pattern (Langfuse "scores", LangSmith "feedback") is a separate
table of post-hoc scores attached to logs, written by async evaluation
pipelines or user actions:

| field      | type    | notes |
|------------|---------|-------|
| id         | int PK  | |
| request_id | str     | joins to inference_logs.request_id (no FK — scores may arrive from a separate eval service) |
| name       | str     | e.g. `user_feedback`, `groundedness`, `hallucination_risk` |
| value      | numeric | score; semantics defined per name |
| source     | str enum | `user_feedback` \| `llm_judge` \| `heuristic` |
| created_at | datetime | |

This is the extension point for hallucination detection: an async job reads
logs (full content is already stored — a prerequisite this design meets),
runs a judge model or groundedness check, and writes scores. Nothing in the
v1 schema blocks it; the table ships when an eval feature does.

### Cascade behavior

No deletes exist in v1. If delete is added later: messages cascade with
their conversation; logs survive (observability data, deliberately
unlinked).

## Inference log query patterns

The schema is judged against these:

| # | Pattern | Example | Needs content? | Served by |
|---|---------|---------|----------------|-----------|
| Q1 | Recent activity tail | latest 50 logs | No | `(created_at)` index |
| Q2 | Trace a conversation | all logs for conversation 42, in order | No (list) / Yes (detail) | `(conversation_id, created_at)` |
| Q3 | Error triage | recent `status=error` logs | No | `(status, created_at)` |
| Q4 | **Inspect one request** | exact input/output for request X | **Yes — full** | `request_id` unique lookup |
| Q5 | Aggregates | p95 latency, tokens/day, error rate per model | No | scans; fine in SQL at demo scale |
| Q6 | Eval export | dump prompt/completion pairs | Yes — full | full-table read, offline |

V1's SQL model serves Q1–Q4 and Q6 well and Q5 acceptably. At real scale,
Q5 is the one that outgrows a row store — the industry answer is a columnar
analytics store (ClickHouse) or pre-aggregated rollup tables fed by the
event stream. Content search (find logs mentioning X) would need FTS —
explicitly not a v1 pattern.

## Metric taxonomy & extensibility roadmap

What the system captures now, what the schema is pre-wired for, and what
needs a pipeline extension — the forward-thinking map:

| Metric / capability | V1 | How the design accommodates it |
|---|---|---|
| Latency (e2e), status, errors | ✅ captured | `latency_ms`, `status`, error fields |
| Token usage (input/output) | ✅ captured | canonical columns, OTel naming |
| Cost per query | ✅ computed at ingestion | `cost_usd` from a versioned price map; stored for immutability |
| Model, provider, config identity | ✅ captured | `model`, `provider`, `request_params`, `config_hash`; provider-reported snapshot/fingerprint in `provider_metadata` |
| Time to first token (TTFT) | ⏳ column ships, null | populated when streaming (012) lands — TTFT only exists once tokens stream |
| Token throughput (tokens/sec, TPOT) | ⏳ derived | computed at read from stored raw measurements; precision improves when TTFT arrives |
| PII redaction / governance | 🔮 hook designed | `EventProcessor` chain in the SDK (below); v1 registers none |
| Infrastructure metrics | 🔮 mostly N/A for hosted APIs | `provider_metadata` carries anything the provider exposes; the real story is self-hosting (vLLM, below) |
| Hallucination / quality signals | 🔮 table designed | async eval pipeline writing `inference_scores`; enabled by full-content logs |

Legend: ✅ v1 · ⏳ schema-ready, populated by a planned feature ·
🔮 designed extension point, built when needed.

### PII redaction & governance (extension point)

Enterprises need content controls before logs are stored. The design places
a **processor chain** in the SDK between event assembly and publish:
`event = processor(event)` for each registered `EventProcessor`. A redactor
(regex/NER-based masking of emails, phones, card numbers in
`input_messages`/`output_text`) is just a processor; v1 registers none.
Redacting at the *SDK* (producer side) is the correct boundary — sensitive
content never crosses the wire or reaches the broker/store, which is what
compliance reviews require. Governance beyond redaction, all future scope
but unblocked by the schema: retention/TTL deletion jobs, right-to-erasure
(delete/blank logs by `conversation_id` — the column exists precisely for
this even without an FK), access control on the `/logs` API once auth
exists, and data-residency via the deployment, not the schema.

### Infrastructure metrics & what we take from vLLM

vLLM is an inference *server*, not an observability library — but it is the
reference for **which serving metrics matter**. It exposes a Prometheus
`/metrics` endpoint with TTFT, TPOT (time per output token), e2e latency
histograms, throughput, queue time, KV-cache utilization, and batch size.
Two lessons we adopt:

1. **Its metric taxonomy** — TTFT + TPOT + tokens/sec is exactly the trio
   our schema stores or derives. Speaking the same vocabulary makes our logs
   comparable with serving-side dashboards.
2. **The metrics-vs-logs split** — per-request *logs* (this system) answer
   "what happened on request X"; aggregate *metrics* (Prometheus/Grafana)
   answer "how is the system doing right now". Production deployments run
   both: a future `/metrics` endpoint on this app (request counts, latency
   histograms, publisher failure counter) complements the log store rather
   than duplicating it.

Infra metrics proper (GPU utilization, KV cache, batching) only exist when
you *host* the model. Against hosted APIs they're invisible — the provider's
problem. If this system ever fronts a self-hosted vLLM deployment, vLLM's
per-request stats can ride into `provider_metadata` via the adapter, and its
Prometheus metrics cover the fleet view. Nothing in the schema changes.

## Schema evolution — surviving provider and contract change

This system sits between two moving surfaces: provider APIs change shape,
and our own producer/consumer contract must survive the Kafka split. Three
mechanisms:

1. **Adapters absorb provider change.** A provider renaming a usage field or
   adding a response attribute touches exactly one adapter's mapping into
   `ProviderResult`. Nothing downstream (event schema, ingestion, table)
   notices. New provider capabilities land in `provider_metadata` first;
   a field earns promotion to a canonical column only when a query pattern
   needs to filter/aggregate on it (JSON → column is an additive migration).
2. **The event contract is versioned and evolves additively.**
   `InferenceLogEvent` carries `schema_version`. Policy: additive,
   backward-compatible changes (new optional fields) do not bump the
   version; breaking changes (rename/retype/remove) do, and the consumer
   handles all versions still in flight. Ingestion is a **tolerant reader**:
   unknown fields are ignored (Pydantic `extra="ignore"`), so an upgraded
   producer never breaks an older consumer. This matters doubly with a
   broker in the middle — events published before a deploy are consumed
   after it.
3. **Table migrations are additive.** New columns arrive nullable (as
   `time_to_first_token_ms` demonstrates in v1) via Alembic; no destructive
   rewrites of a table that is conceptually append-only.

## Is SQL the right store? Is event-driven the right shape?

**SQL, v1: yes.** Logs are structured, append-only rows with point lookups
and time-range filters — classic OLTP territory. SQLite (→ Postgres via
`DATABASE_URL`, no code change) handles demo-to-moderate scale. The pressure
points at real scale are write throughput (every model call is an insert)
and analytical scans (Q5) — solved in industry by batch inserts from a
queue consumer and a columnar sidecar, *not* by abandoning SQL for the
transactional core. Langfuse literally runs Postgres + ClickHouse.

**Event-driven: right interface now, right infrastructure later.**

| | Direct HTTP (v1) | Event bus (Kafka, future) |
|---|---|---|
| Coupling | producer must reach ingestion synchronously | fully decoupled; ingestion can be down |
| Durability | event lost if ingestion is unreachable | broker persists; replayable |
| Backpressure | none — burst hits ingestion directly | broker absorbs bursts; consumer batches |
| Fan-out | one consumer | many (storage + alerting + evals) from the same stream |
| Ops cost | none | broker to run, monitor, upgrade |
| Consistency | near-immediate | eventual; duplicates possible (our `request_id` idempotency already handles this) |

At demo scale the broker is pure overhead — that's why v1 ships the
**publisher interface with an HTTP transport** and accepts event loss.
The bus earns its complexity when any of these become true: multiple
consumers, bursty load that must not hit the DB directly, or ingestion
split into a separate service. The design makes that a config/DI swap,
not a rewrite.

**Will the current stack survive the Kafka move?** Yes, for the storage
path. Python is a first-class Kafka citizen (`confluent-kafka` /
`aiokafka`); the producer is a new `EventPublisher` implementation, and the
consumer is a small Python process that reads the topic, validates against
the same versioned event schema, and batch-inserts — reusing the ingestion
module's validation and models wholesale. A dedicated **stream-processing
framework** (Flink, Kafka Streams, Faust) is needed only for *stateful*
real-time computation: windowed aggregations ("error rate over the last 5
minutes"), stream joins, real-time alerting. Those are dashboard-tier
features; until then, periodic SQL rollup jobs over the log table deliver
the same numbers at a fraction of the complexity. Recommended sequence:
plain Python consumer → SQL rollups → stream processor only if real-time
windows become a product requirement.

### SQLite vs an analytics-first store (DuckDB, ClickHouse)

The logging side of this system is read-mostly-analytics, which raises a
fair question: start on an OLAP engine? The workload actually has two
halves — the **chat app** (transactional: row inserts/updates, point reads,
concurrent writers) and the **log store** (append-only writes, mixed point
lookups + aggregate scans). The tradeoffs:

| | SQLite (v1 choice) | DuckDB | ClickHouse |
|---|---|---|---|
| Model | embedded row store (OLTP) | embedded columnar (OLAP) | server columnar (OLAP) |
| Aggregate scans (Q5) | adequate at demo scale, degrades with volume | excellent | excellent at any scale |
| Point lookups / transactional app data | excellent | weaker fit — optimized for scans, not per-row OLTP churn | wrong tool (mutations are painful) |
| Concurrent writers | fine for one app process | effectively single-writer; concurrent app writes are a known pain | designed for high-volume ingest |
| Tooling fit (SQLAlchemy + Alembic — project stack) | first-class | `duckdb-engine` is community-grade; Alembic autogenerate is shaky | separate ecosystem entirely |
| Ops burden | none | none | a server to run |

**Decision: stay on SQLite for v1.** Three reasons: the same store must also
serve the transactional chat tables (DuckDB is the wrong engine for that
half, and splitting stores doubles complexity while violating the
single-store convention); the project's migration tooling is built around
it; and at demo volumes SQLite's aggregate performance is not the
bottleneck — forward thinking here is captured in the design, not bought
with tooling friction.

**The forward-thinking path DuckDB actually fits:** DuckDB's superpower is
querying data *where it already lives* — it can attach a SQLite file
directly (`sqlite_scanner`) or scan Parquet exports. So the evolution is:

1. **V1**: SQLite, single store.
2. **Analytics pressure appears**: point DuckDB at the SQLite file (or a
   periodic Parquet export of `inference_logs`) as a **read-only analytics
   layer** — columnar aggregate speed, zero migration, zero new write path,
   app untouched.
3. **Real scale**: Postgres for the app (via `DATABASE_URL`), ClickHouse fed
   by the Kafka consumer for logs — the Langfuse/Helicone architecture.

This keeps v1 lightweight while giving the assignment a concrete, staged
answer to "how does storage grow up?".

## Production & scale review

What breaks first beyond single-user demo scale, and what we're deliberately
not building yet (overengineering-for-v1 flags):

| Concern | V1 state | Production fix | Why deferring is right |
|---|---|---|---|
| Multi-user | none (user decision) | auth + nullable `user_id` on conversations & logs, propagated through the event schema | trivial migration later; building user columns without auth is dead code |
| DB | SQLite, single writer | Postgres via `DATABASE_URL` (already the only config knob) | zero code change by design |
| Event durability | HTTP fire-and-forget; loss accepted | Kafka publisher + consumer, batch inserts | broker is ops overhead with one consumer at demo volume |
| Ingestion write path | 1 insert per event | consumer-side batching; log table partitioning by time | irrelevant below ~100s of events/sec |
| **Cancellation registry** | **in-process dict — breaks with >1 uvicorn worker** | shared registry (Redis) or DB cancellation flag polled by the generation task | single-process dev server in v1; the *sharpest* known limitation, documented |
| Analytics (Q5) | SQL scans | rollups or ClickHouse sidecar | scans are instant at demo row counts |
| Log growth | unbounded | retention/TTL + cold storage offload for content | demo lifetime is short |
| Ingestion abuse | open endpoint | shared-secret header / mTLS between services | internal-only in v1, per project no-auth default |
| Provider resilience | SDK's built-in retries | circuit breaker, per-user rate limits, fallback models | premature at one user |

## API surface

All under the existing single FastAPI app. Request/response schemas in
`app/schemas.py`; every endpoint has a `response_model`.

| Method | Path                              | Purpose                                   | Schemas (req → resp) |
|--------|-----------------------------------|-------------------------------------------|----------------------|
| POST   | `/conversations`                  | Create conversation                       | `ConversationCreate` → `ConversationRead` |
| GET    | `/conversations`                  | List conversations (paginated, by recency)| — → `Page[ConversationRead]` |
| GET    | `/conversations/{id}`             | Get one conversation                      | — → `ConversationRead` |
| POST   | `/conversations/{id}/messages`    | Send user message, get assistant reply    | `MessageCreate` → `ChatTurnRead` (user + assistant messages) |
| GET    | `/conversations/{id}/messages`    | List messages (paginated, chronological)  | — → `Page[MessageRead]` |
| POST   | `/conversations/{id}/cancel`      | Abort in-flight generation                | — → `CancelResult` |
| POST   | `/ingest/logs`                    | Ingest an inference log event (SDK-facing)| `InferenceLogEventIn` → `InferenceLogRead` |
| GET    | `/logs`                           | List logs (paginated; filters: conversation_id, status, call_type; computed previews) | — → `Page[InferenceLogSummary]` |
| GET    | `/logs/{request_id}`              | One log with full input/output content    | — → `InferenceLogRead` |

Pagination: `limit` (default 20, max 100) + `offset` query params; `Page[T]`
envelope carries `items`, `total`, `limit`, `offset`.

Each frontend-facing endpoint gets a typed function in `frontend/src/api.ts`
mirroring these schema names.

## Architecture & design patterns

```
chat router ──> provider: ChatProvider = Depends(get_chat_provider)
     │            await provider.send_message(...)      ← caller sees only this
     │
     │          get_chat_provider() is the composition root; it returns
     │          exactly one kind of object, and the raw adapter is not exported:
     │
     │          LoggingChatProvider(ChatProvider)        [Decorator]
     │              ├── CallRecorder (SDK)               [single emission point]
     │              │      ├── InstrumentedProvider ABC  [Dependency inversion]
     │              │      │     describe_call / describe_outcome / describe_failure
     │              │      └── EventPublisher (interface)
     │              │             ├── HTTPEventPublisher (v1) ──POST──> /ingest/logs
     │              │             └── KafkaEventPublisher (future) ──> broker ──> consumer
     │              └── inner: ChatProvider (interface)  [Strategy/Adapter]
     │                     selected by PROVIDER: Provider enum
     │                       ├── OpenAIProvider (v1) ── normalizes → ProviderResult
     │                       └── AnthropicProvider (future) ── same interface
     │
     ├── in-flight registry (cancel)
     ├── auto-title background task ──> get_title_provider() (same path, call_type=title)
     └── conversations / messages tables        /ingest ──> inference_logs table

app/logging_sdk/  ──  imports nothing from app.*  ──  portable / liftable
app/core/observability.py  ──  the only place host settings meet the SDK
```

Patterns in play, and why each earns its place (per the project's
no-premature-abstraction rule, each has ≥2 concrete uses or a user-confirmed
future):

- **Strategy + Adapter** — `ChatProvider` implementations normalize each
  provider's native API into `ProviderResult`, behind a single
  `send_message()` method, and describe themselves to the SDK through
  `describe_call` / `describe_outcome` / `describe_failure`. Justified by the
  confirmed multi-provider direction; it is also what makes logging
  provider-agnostic. The strategy is chosen by a `Provider` enum read from the
  `PROVIDER` setting, so selection happens in exactly one function
  (`get_chat_provider()`) and the adapter's own `provider_name` is what lands in
  the log's `provider` column.
- **Decorator** — `LoggingChatProvider` *implements* `ChatProvider` and wraps
  one, so it substitutes anywhere a provider is expected and neither the
  adapter nor the chat code knows it exists. Because `get_chat_provider()` is
  the only accessor and the concrete adapter is not exported, this is not a
  convention a call site can forget — instrumentation is structural. One
  emission point; providers get logging for free (the "auto-instrumentation"
  story, without the monkey-patching).
- **Dependency inversion, both ways** — the SDK depends on the `EventPublisher`
  interface, never a transport (the Kafka future is a one-line swap in the
  composition root); and it depends on the `InstrumentedProvider` ABC, never on
  a concrete provider or on host config, which is what keeps the package
  portable across codebases.
- **Versioned schema contract** — `InferenceLogEvent` (Pydantic, with
  `schema_version`) is the *only* thing producer and consumer share. This is
  what makes the later service split safe.
- **DI via FastAPI `Depends`** — sessions, settings, publisher instances.

Deliberately **not** used: plugin registries, generic middleware chains,
repository layers over SQLAlchemy — single-use abstractions the project
conventions prohibit.

Model configurable via `OPENAI_MODEL` env (default `gpt-5.6-terra`);
key via `OPENAI_API_KEY`. Titling uses the same provider with
cheap/fast settings (`OPENAI_TITLE_MODEL`, default `gpt-5.6-luna`).

## Edge cases

| # | Case | Behavior |
|---|------|----------|
| 1 | Send message to nonexistent conversation | 404 |
| 2 | Empty/whitespace message content | 422 (schema validation) |
| 3 | Second message sent while one is in flight for the same conversation | 409 with clear detail |
| 4 | Cancel when nothing is in flight | 409 ("no generation in progress") |
| 5 | Cancel races completion (response already finished) | 409 same as #4; completed message stands |
| 6 | Provider API error (rate limit, auth, 5xx) | 502-style clean JSON error to client; log stored with `status=error` + error fields; user message kept so the user can retry |
| 7 | Publisher/ingestion unreachable | Chat response unaffected; ERROR log line with event context; event lost (v1 accepts loss — Kafka later adds durability) |
| 8 | Duplicate event delivery (same request_id) | Unique constraint → 409 via the existing IntegrityError handler; publisher treats as success |
| 9 | Malformed ingestion payload / unknown schema_version | 422 with field errors |
| 10 | Conversation with fewer than 10 messages | Window is simply all messages |
| 11 | Token usage missing (error/cancel paths) | Nullable columns stay null |
| 12 | Titling call fails or is slow | Title stays `"New conversation"`; error-status log with `call_type=title`; never blocks or fails the chat turn |
| 13 | Titling completes after user renamed nothing else (v1 has no rename) | Auto-title simply wins; rename is future scope |
| 14 | Log filter matches nothing | Empty page, 200 |
| 15 | Unknown `request_id` on log detail | 404 |

## Error handling

Per project conventions:

- 404 — missing parent (conversation) on message create/list/cancel; unknown
  log `request_id`.
- 409 — IntegrityError (duplicate `request_id`) via the existing central
  handler; explicit 409s for cancel-with-nothing-in-flight and
  concurrent-send.
- 422 — Pydantic validation (empty content, malformed event payload, unknown
  schema_version).
- 502 — provider failure, translated in `app/core/errors.py` from a
  `ProviderError` raised by the adapter (logged with context, never
  swallowed).

## Feature breakdown

Each item is one `/generate-spec` spec and one implementation pass.

1. **001-conversations** — Conversation model (incl. `status` enum) +
   migration; POST / GET list / GET one endpoints with pagination envelope.
   No dependencies.
2. **002-messages** — Message model + migration; GET messages endpoint
   (paginated). Needs 001.
3. **003-provider-adapter** — `ChatProvider` interface (`send_message()`),
   `ProviderResult` normalization, `Provider` enum + enum-dispatched
   `get_chat_provider()`, `OpenAIProvider`, settings (`PROVIDER`,
   `OPENAI_API_KEY`, `OPENAI_MODEL`); no endpoints. Independent.
4. **004-chat-endpoint** — POST messages endpoint: store user message, build
   10-message window, call provider, store + return assistant reply;
   `ProviderError` → 502 translation. Needs 002 and 003.
5. **005-ingestion** — InferenceLog model + migration (incl. TTFT/cost/
   params/config_hash columns); `POST /ingest/logs` with versioned-schema
   validation, request_id idempotency, and cost computation from the price
   map. Independent of 001–004.
6. **006-logging-sdk** — portable `app/logging_sdk/` package: `InferenceLogEvent`
   schema, `InstrumentedProvider` contract, `EventPublisher` interface +
   processor-chain hook (no processors registered), `HTTPEventPublisher`, and
   `CallRecorder` (the single emission point) capturing params + config_hash.
   Host side: `ChatProvider` extends the SDK contract, `LoggingChatProvider`
   shim, `get_chat_provider()` returns an instrumented provider, publisher built
   in `app/core/observability.py` from settings. Needs 003, 004 and 005.
7. **007-logs-api** — `GET /logs` (paginated, filters, computed previews) +
   `GET /logs/{request_id}` (full content). Needs 005.
8. **008-auto-title** — background titling task after first turn, through
   the logged provider path with `call_type=title`. Needs 006.
9. **009-cancellation** — in-flight registry, `POST /cancel`,
   concurrent-send 409, cancelled-status log emission. Needs 006.
10. **010-frontend-conversations** — conversation list page, create button,
    resume navigation; api.ts functions. Needs 001.
11. **011-frontend-chat** — chat view: message history, send box, pending
    state, cancel button, error display. Needs 004, 009, 010.
12. **012-streaming** — SSE streaming of assistant responses end-to-end
    (backend + frontend), cancel integrated with the stream; SDK starts
    measuring and emitting `time_to_first_token_ms`. Needs 011.
    (Deferred bonus.)
13. **013-docs** — README (setup, architecture overview, schema decisions,
    tradeoffs, future work incl. Kafka consumer + scale path) +
    architecture notes deliverable. Last.

## Open questions

- **OpenAI model default**: confirmed `gpt-5.6-terra` for chat (the balanced
  cost/intelligence tier, chosen over the `gpt-5.6-sol` flagship for demo
  traffic), overridable via env; titling uses `gpt-5.6-luna` on the same
  provider. Sampling parameters (`temperature`, `top_p`) are never sent —
  GPT-5-family models reject them; see spec 003.
- **Log retention**: assumed unbounded growth acceptable for the demo.
- **Ingestion auth**: `/ingest/logs` is open (no auth per project defaults).
  Assumed acceptable; a shared-secret header is the minimal hardening if
  ever exposed.
- **Titling prompt/limits**: assumed ~30-char titles, single short call;
  exact prompt is an implementation detail for spec 008.
- **Price map maintenance**: assumed a hand-maintained static map (model →
  input/output $ per MTok) in config, versioned in git; stale prices yield
  stale costs until updated. Automated price sync is out of scope.
- **Kafka future**: topic naming, partitioning (by conversation_id), and
  consumer design deferred to their own design doc when built.
