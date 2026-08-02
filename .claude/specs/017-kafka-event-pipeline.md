# Kafka Event Pipeline

Parent design: `.claude/designs/eventing-and-analytics.md` (feature 2).
Decisions there are final. Needs spec 016 (WAL/busy-timeout) applied
first. Functionally independent of spec 018, but both edit
`core/config.py`, `repositories/ingest.py`, `pyproject.toml`, and
`.env.example` — implement sequentially (either order) or accept a
small merge.

## Problem statement

Inference log events travel over HTTP fire-and-forget: any publish
failure loses the event, ingestion pays one synchronous insert per
event, and nothing can ever fan out. The original design
(`inference-logging-chatbot.md`) built the `EventPublisher` interface
precisely so a broker could replace the transport without touching chat
code, SDK internals, or ingestion validation. This spec cashes that in:
a `KafkaEventPublisher` in the SDK, an in-app consumer that batch-writes
the topic into `inference_logs`, and an `EVENT_TRANSPORT` switch whose
default (`http`) keeps today's zero-infra behavior byte-for-byte.

**Out of scope:** dead-letter topic (malformed = log + skip; DLQ is
recorded future work), multiple consumers/fan-out, Kafka in tests or CI
(no test may require a broker), Docker (broker is `brew install kafka`,
KRaft), schema or event-contract changes, README/setup docs (ride with
spec 013).

## Functional requirements

1. FR1: `EVENT_TRANSPORT=kafka` routes every `InferenceLogEvent` to the
   `inference-logs` topic (key: `conversation_id` as bytes when
   present, else null; value: the event's JSON — the same payload the
   HTTP transport sends today).
2. FR2: `EVENT_TRANSPORT=http` (default) leaves runtime behavior
   exactly as today; no Kafka connection is attempted anywhere.
3. FR3: Publisher failures — broker unreachable at startup or at
   publish, serialization errors — are logged at ERROR with event
   context and never raise into the chat path. A failed producer start
   must not prevent app boot; later publishes retry starting it, and on
   failure drop the event with an ERROR log.
4. FR4: With kafka transport, the FastAPI lifespan starts one consumer
   background task and cancels it cleanly on shutdown; the same
   consumer runs standalone via `uv run python -m app.ingestion.consumer`.
   `POST /ingest/logs` stays registered and functional in both modes.
5. FR5: The consumer polls in batches, validates every message against
   `InferenceLogEventIn` (the identical schema HTTP ingestion uses),
   and stores valid events with the identical cost computation and row
   shape (shared `build_log()`).
6. FR6: Malformed messages (bad JSON, failed validation, unknown
   `schema_version`) are logged at ERROR with topic/partition/offset
   and skipped; the loop never crashes and never blocks on a poison
   message.
7. FR7: Duplicate `request_id`s (batch replay, redelivery) are skipped
   silently — batch insert uses per-row duplicate handling, and a
   redelivered batch results in zero new rows.
8. FR8: Offsets are committed only after the batch's DB commit
   (at-least-once; combined with FR7, effectively exactly-once in the
   DB). Auto-commit is disabled.
9. FR9: The HTTP ingest handler delegates row construction to the same
   `build_log()` the consumer uses; its external contract (201, 409 on
   duplicate, 422 on invalid) is unchanged.
10. FR10: The SDK stays host-agnostic: `KafkaEventPublisher` takes
    bootstrap servers, topic, and timeouts as constructor arguments;
    `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/`
    stays empty. `aiokafka` joins httpx as an SDK dependency.

## Non-functional requirements

- Chat latency unchanged: `publish()` runs inside the existing
  fire-and-forget task (`_schedule_publish`), so awaiting broker acks
  (`send_and_wait`) never sits on a request path.
- Consumer throughput is irrelevant at demo scale; correctness of the
  commit ordering (FR8) is not negotiable.
- Broker downtime in kafka mode degrades to today's HTTP-loss semantics
  (ERROR log, event lost, chat unaffected) — never worse.

## Data model

None. No model change, no migration. The event contract
(`InferenceLogEvent`, `schema_version=1`) is untouched — the broker
carries the same JSON the HTTP transport carries.

## API contracts

No endpoint added, removed, or changed. `POST /ingest/logs` behavior is
identical from the outside (FR9).

New settings (in `Settings`, documented in `backend/.env.example`):

| Setting | Default | Purpose |
|---|---|---|
| `EVENT_TRANSPORT` | `http` | `http` \| `kafka` (StrEnum in `app/core/config.py`) |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | producer + consumer |
| `KAFKA_TOPIC` | `inference-logs` | one topic, demo runs 1 partition |
| `KAFKA_CONSUMER_GROUP` | `ingestion` | consumer group id |
| `KAFKA_CONSUMER_MAX_RECORDS` | `100` | `getmany` batch cap |
| `KAFKA_CONSUMER_BATCH_TIMEOUT_MS` | `1000` | `getmany` poll timeout |

## Constraints

- `aiokafka` (>=0.14, asyncio-native, Python 3.13 wheels) via
  `uv add aiokafka`; chosen over `confluent-kafka` in the design doc.
- The `EventPublisher` ABC does not change (publish-only). Lifecycle
  (`start`/`aclose`) is concrete-class surface; `init_observability()`
  becomes async and the lifespan awaits it — it already owns transport
  construction, and it is host code, so the signature change is
  internal.
- The consumer is **host code, not SDK code**: it imports app schemas,
  repositories, and `SessionLocal` (its own sessions per batch — never
  the request-scoped `get_db`). It lives in `app/ingestion/`, never in
  `app/logging_sdk/`.
- The consumer consumes events; it must never construct an
  `InferenceLogEvent` or call a publisher (CLAUDE.md single-emission-
  point rule).
- Batch insert uses per-row nested savepoints (`begin_nested()`) with
  `IntegrityError` caught per row and one commit per batch — portable,
  no SQLite-specific `INSERT OR IGNORE`, correct under redelivery.
- Consumer DB writes rely on 016's `busy_timeout` when colliding with
  request-thread writes.
- `auto_offset_reset="earliest"` so events produced before the first
  consumer start are ingested (demo-friendly; assumption recorded
  below).

## Error handling and edge cases

| # | Case | Behavior |
|---|------|----------|
| 1 | Broker down at publish (kafka mode) | ERROR log with request_id/conversation_id/call_type; event dropped; chat unaffected (FR3) |
| 2 | Broker down at app startup (kafka mode) | App boots and serves; producer start failure logged; publishes retry-start then drop on failure; consumer task retries connecting with backoff, logging ERROR — never crashes the app |
| 3 | Malformed topic message (bad JSON / validation / unknown schema_version) | ERROR log incl. partition/offset; skipped; loop continues (FR6) |
| 4 | Duplicate `request_id` (redelivery, replay, HTTP+kafka double-send) | Row skipped via savepoint + `IntegrityError`; counted, not errored (FR7) |
| 5 | Crash after DB commit, before offset commit | Redelivered batch inserts zero rows (all duplicates), offsets then commit (FR8) |
| 6 | DB error mid-batch (non-integrity) | ERROR log; offsets NOT committed; batch redelivers after backoff — no swallowing (CLAUDE.md), no offset loss |
| 7 | Shutdown mid-batch | Task cancelled; `consumer.stop()` in cleanup; uncommitted offsets redeliver next start; duplicates skip |
| 8 | Event with `conversation_id=null` (future non-chat calls) | Null key — round-robin partitioning; fine at 1 partition |
| 9 | `EVENT_TRANSPORT=http` (default) | No aiokafka object constructed; behavior byte-for-byte today's |
| 10 | Producer `aclose()` on shutdown | `AIOKafkaProducer.stop()` flushes buffered sends — bounded by its internal timeout, and lifespan proceeds regardless |

## Acceptance criteria

- [ ] Default env (`EVENT_TRANSPORT` unset): app boots with no broker
      running; a chat turn logs via HTTP exactly as before this spec.
- [ ] `EVENT_TRANSPORT=kafka` with local broker: a chat turn results in
      (a) a message on `inference-logs` and (b) an `inference_logs` row
      created by the consumer — visible via `GET /logs` — with cost
      populated identically to the HTTP path.
- [ ] Broker stopped, kafka mode: chat requests still return 200;
      ERROR lines appear for the dropped events; no endpoint 5xxes.
- [ ] Re-running the consumer from offset 0 (fresh group or reset)
      creates zero duplicate rows.
- [ ] `uv run python -m app.ingestion.consumer` consumes standalone
      while the app runs with `EVENT_TRANSPORT=http`.
- [ ] `curl -X POST /ingest/logs` (valid payload) still returns 201;
      duplicate request_id still 409; malformed still 422.
- [ ] `grep -rn "^from app\.\|^import app\." backend/app/logging_sdk/`
      is empty.
- [ ] `make lint` passes.

## Files to be changed

- `backend/pyproject.toml`, `backend/uv.lock` — `uv add aiokafka`.
- `backend/app/logging_sdk/kafka_publisher.py` — new:
  `KafkaEventPublisher` (constructor-config, `publish` never raises,
  lazy/retrying producer start, `aclose`).
- `backend/app/logging_sdk/__init__.py` — export `KafkaEventPublisher`.
- `backend/app/core/config.py` — `EventTransport` StrEnum + the six
  settings above.
- `backend/app/core/observability.py` — transport selection; async
  `init_observability()`; close both transports.
- `backend/app/main.py` — await observability init; start/cancel the
  consumer task when transport is kafka.
- `backend/app/ingestion/__init__.py` — new package.
- `backend/app/ingestion/service.py` — `build_log(event) ->
  InferenceLog` (cost via `compute_cost` + row construction), the
  single event→row mapping.
- `backend/app/ingestion/consumer.py` — consumer class (batch loop,
  validation, storage, offset commit, backoff, graceful stop) +
  `__main__` entry with `setup_logging()`.
- `backend/app/routers/ingest.py` — handler delegates to `build_log()`.
- `backend/app/repositories/ingest.py` — add
  `create_many_skip_duplicates(logs) -> tuple[int, int]`
  (inserted, skipped).
- `backend/.env.example` — new settings, commented.
- `Makefile` — `consumer` target (`uv run python -m
  app.ingestion.consumer`).

## Feature-specific rules

- The "logging must never break chat" containment zone extends to this
  transport: publisher catch-log-continue is sanctioned. The consumer
  loop is likewise sanctioned to log-and-continue **per message/batch**
  (FR6, edge 6) — but it must never silently swallow: every skip is an
  ERROR with enough context to find the message again.
- Transports coexist by design: kafka mode does not unregister
  `/ingest/logs`. The unique `request_id` makes accidental double-
  delivery across transports harmless.
- Do not add a `KafkaEventPublisher` fallback-to-HTTP chain — one
  transport per process, chosen at startup. Fallback logic is
  complexity the demo doesn't need (and hides broker failures).

## Open questions

None blocking. Recorded assumptions (confirm-or-correct at review):
`auto_offset_reset="earliest"`; topic auto-creation relied on for the
demo (broker default) rather than a provisioning script; `send_and_wait`
(acked produce) inside the already-async publish task rather than
fire-and-forget `send`.
