# Eventing & Analytics — Design Doc (addendum)

Addendum to `.claude/designs/inference-logging-chatbot.md`. That doc
designed the seams; this one cashes in two of its stated futures:

1. A **Kafka event pipeline** for inference log events — the
   `EventPublisher` swap the original doc called "a config/DI swap, not
   a rewrite".
2. A **DuckDB read-only analytics layer** over the existing SQLite file
   — step 2 of the original doc's storage evolution path ("point DuckDB
   at the SQLite file as a read-only analytics layer").

Decisions here were made interactively with the user (2026-08-02); no
data migration is required anywhere ("cheap testing" explicitly
accepted).

## Problem statement

The logging pipeline is HTTP fire-and-forget: an event that can't reach
`/ingest/logs` is lost, ingestion takes one synchronous insert per
event, and there is exactly one consumer. The aggregate endpoints
(`/logs/stats`, `/logs/timeseries` — query pattern Q5) scan rows via
SQLAlchemy, compute percentiles with one query per percentile, and
aggregate timeseries buckets **in Python**. Both are correct at demo
scale and both are the documented first casualties of growth.

This project demonstrates the growing-up path without leaving the
demo footprint: a real broker between SDK and ingestion (durability,
replay, fan-out readiness), and a real columnar engine under the
analytics endpoints (single-pass aggregates) — with zero API changes,
zero schema changes, and zero data migration.

## Holistic review findings (2026-08-02)

Reviewed: design doc, specs 001–015, models, SDK (publisher/recorder),
composition root, ingest/logs routers and repository, db.py, config.

**Sound and load-bearing — do not touch:** the `EventPublisher` ABC and
fire-and-forget `_schedule_publish`; the portable SDK (no `app.*`
imports); the versioned `InferenceLogEvent` contract with tolerant-
reader ingestion; `request_id` unique constraint as the idempotency
key; structural instrumentation via `get_chat_provider()`.

**Findings, with disposition** (user decision: only blockers for the
two features get fixed; the rest is recorded, not actioned):

| # | Finding | Blocker? | Disposition |
|---|---------|----------|-------------|
| R1 | SQLite runs with default journal mode; no `busy_timeout`. Concurrent writers already exist (request threads + titling tasks); the Kafka consumer adds a batch writer and DuckDB adds an out-of-band reader of the same file. | **Yes — for both features** | **Spec 016** |
| R2 | `routers/ingest.py` builds the log row + computes cost inline; the Kafka consumer would duplicate that logic. | **Yes — for 017** | Extracted as `build_log()` **inside spec 017** (single feature needs it) |
| R3 | `repositories/ingest.py` mixes the write path with list/stats/timeseries reads; logs router borrows the ingest repo (one-repo-per-resource drift). | No | Recorded only. 018 swaps `stats()`/`timeseries()` internals in place; no repo split. |
| R4 | `close_observability()` closes the httpx client while `_pending_publish_tasks` may be in flight (no shutdown drain). | No | Recorded only. Kafka producer `stop()` flushes its own buffer, which covers the new transport's shutdown path. |
| R5 | `timeseries()` loads every row in the window into Python; percentiles cost ~2 queries each. Q5 outgrowing the row store, on schedule. | Resolved by feature | **Spec 018** replaces these code paths on the DuckDB engine |

## Scope

**In scope:**

- SQLite WAL + busy-timeout pragmas (016).
- `KafkaEventPublisher` in the logging SDK; `EVENT_TRANSPORT` setting;
  transport built in `app/core/observability.py` (017).
- In-app Kafka consumer (lifespan-managed background task, also
  runnable standalone via `python -m`), batch-consuming into
  `inference_logs` through shared `build_log()` logic (017).
- DuckDB as the query engine for `GET /logs/stats` and
  `GET /logs/timeseries` via read-only ATTACH of the SQLite file;
  `ANALYTICS_ENGINE` setting with automatic selection (018).
- New backend dependencies: `aiokafka`, `duckdb` (via `uv add`).

**Out of scope** (explicit):

- Auth, rate limiting, caching, realtime — CLAUDE.md defaults, unchanged.
- Running Kafka in CI or tests; tests never require a broker.
- Dead-letter topic (malformed messages are logged + skipped; DLQ
  recorded as future work).
- Schema/data migration of any kind — no model changes at all.
- Multiple consumers / fan-out (alerting, evals) — the topic makes them
  possible; none are built.
- Kafka in Docker — broker is a local install (`brew install kafka`,
  KRaft, no ZooKeeper). **This is the one new external dependency, and
  it is opt-in**: default `EVENT_TRANSPORT=http` keeps the app fully
  functional with no broker running.
- Second *write* store. DuckDB is read-only over the existing SQLite
  file — this deliberately does NOT breach the single-store rule: there
  is still exactly one datastore and one write path. (User explicitly
  authorized even a store swap; the chosen design doesn't need it.)
- Repo split / shutdown drain (R3, R4) — reviewed, deliberately not done.

## Users and user flows

No end-user-visible flows change. The affected flows are system flows:

**Flow A — event publish (kafka transport):** provider call completes →
`CallRecorder` builds event → `_schedule_publish` fires task →
`KafkaEventPublisher.publish()` serializes the event to JSON and
produces to topic `inference-logs` (key = `conversation_id`, so one
conversation's events stay ordered in a partition) → any failure is
logged at ERROR and swallowed (logging never breaks chat) → broker
persists the event.

**Flow B — event consume:** consumer task (started by lifespan when
`EVENT_TRANSPORT=kafka`) polls a batch (`getmany`) → each message is
validated against the same `InferenceLogEventIn` schema the HTTP
endpoint uses → valid events go through `build_log()` (cost
computed from the price map, row constructed) → batch inserted with
per-row duplicate-skip on `request_id` → DB commit → offsets committed.
Crash between DB commit and offset commit ⇒ redelivery ⇒ duplicate-skip
⇒ effectively exactly-once in the DB.

**Flow C — stats read (duckdb engine):** `GET /logs/stats` or
`/logs/timeseries` → repository opens a fresh in-memory DuckDB
connection → `ATTACH '<sqlite file>' (TYPE sqlite, READ_ONLY)` → runs
one aggregate SQL statement (native `quantile_disc`, `date_trunc`) →
closes the connection → shapes the same response schema as today.

**Flow D — demo without broker:** `EVENT_TRANSPORT=http` (default) —
everything behaves exactly as it does today.

## Functional requirements

1. FR-E1: With `EVENT_TRANSPORT=kafka`, every inference event is
   produced to the `inference-logs` topic instead of POSTed to
   `/ingest/logs`; with `http` (default) behavior is unchanged.
2. FR-E2: Publisher failures (broker down, serialization error) are
   logged at ERROR with event context and never raise into the chat
   path — same containment contract as `HTTPEventPublisher`.
3. FR-E3: The consumer validates each message with the same versioned
   event schema as HTTP ingestion; malformed messages are logged at
   ERROR (with offset/partition context) and skipped, never retried
   forever, never crash the consumer loop.
4. FR-E4: Consumed events are stored identically to HTTP-ingested ones
   (same cost computation, same row shape); duplicate `request_id`s are
   skipped silently (at-least-once delivery + unique constraint).
5. FR-E5: Offsets are committed only after the DB commit for that
   batch (no acknowledged-but-lost events).
6. FR-E6: The consumer runs as an in-app background task started and
   stopped by the FastAPI lifespan, and the same consumer class is
   runnable standalone (`uv run python -m app.ingestion.consumer`) for
   the future service split. In-app, `/ingest/logs` also remains live —
   transports coexist.
7. FR-E7: The SDK remains host-agnostic: `KafkaEventPublisher` receives
   bootstrap servers/topic/timeouts as constructor arguments; no
   `app.*` imports in `app/logging_sdk/`.
8. FR-A1: With the DuckDB engine active, `GET /logs/stats` and
   `GET /logs/timeseries` return responses identical in shape and
   semantics (incl. nearest-rank percentiles, dense buckets, filters)
   to the current implementation, computed by DuckDB over the live
   SQLite file.
9. FR-A2: Engine selection: `ANALYTICS_ENGINE=auto|sqlite|duckdb`,
   default `auto` = DuckDB when `DATABASE_URL` is a file-based SQLite
   URL, current SQLAlchemy path otherwise (in-memory test DBs cannot be
   attached by DuckDB). `sqlite` forces the legacy path (kill switch).
10. FR-A3: DuckDB access is strictly read-only (READ_ONLY attach);
    list/detail endpoints stay on SQLAlchemy.
11. FR-A4: A DuckDB failure on a stats request is not swallowed — it
    surfaces as the standard 500 envelope with context logged (the
    `sqlite` setting is the operator's fallback).

## Non-functional requirements

- **Chat latency unchanged**: producing is inside the existing
  fire-and-forget task; `await` on broker acks happens off the request
  path.
- **Durability (kafka mode)**: events survive ingestion downtime and
  are replayable from the topic; loss window shrinks from "any publish
  failure" to "broker unreachable" (still logged, still non-fatal).
- **Analytics latency**: single-pass aggregates; per-request DuckDB
  connection setup is milliseconds at demo scale — acceptable, and it
  always reads current data (no cache staleness, no shared-connection
  concurrency issues in-process).
- **Zero-infra default**: `make backend` with no broker and no env
  changes behaves exactly as today.

## Data model

**No model or migration changes.** `inference_logs` is untouched; the
event contract (`InferenceLogEvent`, `schema_version=1`) is untouched —
the broker carries the same JSON the HTTP transport carries.

DuckDB reads SQLite through declared-type affinity mapping; the spec
must respect these (verified against DuckDB sqlite extension docs):

| SQLite (declared by SQLAlchemy) | DuckDB | Notes |
|---|---|---|
| INTEGER (`latency_ms`, tokens, `conversation_id`) | BIGINT | direct |
| DATETIME text (`created_at`, `requested_at`) | TIMESTAMP | fractional-seconds text parses; verify during implementation |
| NUMERIC(12,6) (`cost_usd`) | DOUBLE | float aggregation accepted for stats (list/detail still serve exact Decimal from SQLAlchemy) |
| JSON / TEXT (`input_messages`, …) | VARCHAR | stats queries never read content columns |
| VARCHAR enums (`status`, `call_type`, …) | VARCHAR | direct |

## API surface

**No routes added, removed, or changed.** For the map:

| Method | Path | Change |
|---|---|---|
| POST | `/ingest/logs` | unchanged externally; handler delegates to shared `build_log()` (017) |
| GET | `/logs/stats` | same schema; internally DuckDB when engine active (018) |
| GET | `/logs/timeseries` | same schema; internally DuckDB when engine active (018) |
| GET | `/logs`, `/logs/{request_id}` | untouched (SQLAlchemy point reads) |

New settings: `EVENT_TRANSPORT` (`http` default), `KAFKA_BOOTSTRAP_SERVERS`
(`localhost:9092`), `KAFKA_TOPIC` (`inference-logs`), `KAFKA_CONSUMER_GROUP`
(`ingestion`), consumer batch size/timeout, `ANALYTICS_ENGINE` (`auto`).
All in `.env.example` with comments.

## Edge cases

| # | Case | Behavior |
|---|------|----------|
| 1 | `EVENT_TRANSPORT=kafka`, broker down at publish | ERROR log with event context; event lost from broker's perspective only if never accepted; chat unaffected (same contract as HTTP loss today) |
| 2 | Broker down at app startup (kafka mode) | Producer/consumer start retries in background; app boots and serves; ERROR logs until broker returns |
| 3 | Malformed message on topic (bad JSON / failed validation / unknown `schema_version`) | ERROR log incl. topic/partition/offset; message skipped; loop continues (DLQ = future work) |
| 4 | Duplicate `request_id` in a consumed batch or across redelivery | Row skipped; not an error (idempotent ingestion, FR11 of parent doc) |
| 5 | Crash after DB commit, before offset commit | Batch redelivered → all rows skip as duplicates → offsets commit |
| 6 | App shutdown with consumer mid-batch | Lifespan cancels task; uncommitted offsets ⇒ batch redelivers on next start; duplicates skip |
| 7 | Stats request while DB file has an active writer | WAL (016): readers never block the writer; DuckDB attach is READ_ONLY |
| 8 | Stats request with `ANALYTICS_ENGINE=auto` and in-memory/postgres `DATABASE_URL` | Legacy SQLAlchemy path (automatic) |
| 9 | DuckDB attach/query failure (corrupt file, extension missing) | 500 + ERROR log with query context; operator can set `ANALYTICS_ENGINE=sqlite` |
| 10 | Empty window / no rows (DuckDB path) | Same empty-shape responses as today (FR-A1 parity includes empties) |

## Error handling

Project conventions hold: publisher/consumer containment mirrors the
existing "logging must never break chat" rule (the one sanctioned
log-and-continue zone); ingestion validation failures remain 422 on the
HTTP path and log-and-skip on the consumer path (no HTTP status exists
there); duplicate `request_id` remains "success" semantics at every
entry point; DuckDB errors follow "never swallow" — logged with context
and surfaced as 500.

## Feature breakdown

Spec **019-multi-model-selection** (second provider + per-message model
choice; belongs to the parent design's roadmap, not this doc) is
implemented **before** all items below (user decision, 2026-08-02) — it
shares `core/config.py`, `.env.example`, and `pyproject.toml` with
017/018, so the order avoids merges.

1. **016-sqlite-concurrency** — WAL + busy-timeout pragmas on the
   SQLite engine (connect-event listener in `app/db.py`; file-based
   DBs only). No dependencies. Unblocks parallel 017/018.
2. **017-kafka-event-pipeline** — extract `build_log()`;
   `KafkaEventPublisher` (SDK); `EVENT_TRANSPORT` + Kafka settings;
   consumer class + lifespan wiring + `__main__` entry; batch insert
   with duplicate-skip. Needs 016.
3. **018-duckdb-analytics** — `duckdb` dependency; DuckDB
   implementations of stats/timeseries behind `ANALYTICS_ENGINE`
   selection inside the existing repository methods. Needs 016.
   Independent of 017.

017 and 018 are functionally independent (neither reads the other's
output) but both edit `core/config.py`, `repositories/ingest.py`,
`pyproject.toml`/`uv.lock`, and `.env.example` — implement them
sequentially in either order, or in separate worktrees accepting a
small merge.

## Open questions

All resolved with the user except micro-decisions, assumed as follows
(confirm-or-correct at spec review):

- Topic `inference-logs`, 1 partition, key = `conversation_id`
  (null-keyed events round-robin; fine at 1 partition).
- Consumer batch: `getmany(timeout_ms=1000, max_records=100)`.
- `EVENT_TRANSPORT` default stays `http` (zero-infra default).
- `aiokafka` (0.14.x) over `confluent-kafka`: asyncio-native, pure
  wheel install, fits the FastAPI event loop; librdkafka performance is
  irrelevant at demo volume.
- DuckDB connections are per-request (fresh attach), not pooled —
  correctness over micro-latency at demo scale.
- Kafka broker install path documented for macOS via Homebrew (KRaft);
  README/docs updates ride with 013 (docs spec), not these specs.
