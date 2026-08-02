# App

Starter project: FastAPI + Pydantic + SQLAlchemy + Alembic + SQLite
(backend), React + Vite + TS (frontend). No Docker — backend deps run
through [`uv`](https://docs.astral.sh/uv/), frontend through `npm`.

See `CLAUDE.md` for conventions (critical rules, migration workflow,
etc.) — read that before building a feature.

## Starting a new project from this boilerplate

1. **Fork and rename.**

       cp -r project-boilerplate my-new-project && cd my-new-project
       rm -rf .git && git init

   Rename the identity markers so it's not "App" everywhere:
   `backend/pyproject.toml` (`name`), `frontend/package.json` (`name`),
   `backend/.env.example` (`APP_NAME`), and this file's title.

2. **Bootstrap and confirm the baseline works** before changing anything
   — see "First-time setup" and "Running the app" below. `make test`
   should show 1 passed, and http://localhost:5173 should show "Backend
   status: ok". If something breaks later, you'll know it's your change,
   not a broken starting point.

3. **Give the system context: extend `CLAUDE.md`, don't work around it.**
   It already has generic conventions (critical rules, workflow, code
   standards) that any assistant or teammate should follow automatically.
   Add a project-specific section, e.g.:

       ## Domain
       [One-paragraph description of what the product does, who uses it.]

       Core entities: ...

       ## Project-specific decisions
       [Anything that overrides or narrows a generic default — e.g.
       "pagination required on all list endpoints from day one" if
       that's known upfront rather than deferred per the generic
       default.]

   Don't duplicate what's derivable from the code (schema, routes) —
   only record what a reader can't get by reading the repo: the *why*.

4. **Do a system-design pass before writing code**, per entity you're
   about to build. This is a conversation/scratch step, not a doc to
   maintain:
   - Entities and relationships (this becomes `models.py`)
   - Required vs. optional fields, and defaults
   - Cascade behavior on delete (block / cascade / orphan)
   - Pagination — needed now, or explicitly deferred
   - Denormalized vs. computed-live derived values (counts, totals)

   These are the same questions in CLAUDE.md's "Things to always clarify
   before building a feature" — answering them upfront avoids the most
   common source of churn: a model shaped wrong on the first pass.

5. **Build features one at a time** — see "Adding a feature" below for
   the per-resource loop.

## First-time setup

    make install-backend    # uv sync — creates backend/.venv
    make install-frontend   # npm install

Copy the env templates and adjust if needed (defaults work as-is for
local dev):

    cp backend/.env.example backend/.env
    cp frontend/.env.example frontend/.env

## Running the app

Terminal 1 (backend, http://localhost:8000):

    make backend

Terminal 2 (frontend, http://localhost:5173):

    make frontend

Open http://localhost:5173 — you should see "Backend status: ok". If it
says "backend not reachable," confirm uvicorn is running on port 8000.

API docs (Swagger UI) are at http://localhost:8000/docs once the backend
is running.

## Running tests

Backend only — there is no frontend test suite in this project. Tests
live in `backend/tests/`, run via `pytest`, and are only ever written or
run through the `generate-tests` skill (see `CLAUDE.md` "Code
standards") — this section is about *running* what already exists, not
when to add more.

### Run everything

    make test

Equivalent, from `backend/`:

    uv run pytest -v

No manual venv activation needed — `uv run` resolves `backend/.venv`
automatically. No services need to be running first: tests never hit a
real database, network, or the dev `.env`.

### Run one file

    cd backend
    uv run pytest tests/test_recorder.py -v

### Run one test

    cd backend
    uv run pytest tests/test_recorder.py -k "test_invoke_error_publishes_event_and_reraises" -v

`-k` matches on substring, so a partial name works too, e.g.
`-k "cancelled"` runs every test with "cancelled" in its name across
whichever file(s) you pointed pytest at.

### Test database isolation

`backend/tests/conftest.py` overrides `get_db` with an in-memory SQLite
engine, rebuilt (`Base.metadata.create_all` / `drop_all`) before and
after every test via an autouse fixture. Tests never touch
`backend/app.db` and don't require `make db-upgrade` to have been run
first — the schema comes from `models.py` directly, not migrations
(which means migration drift only surfaces at `make db-upgrade` time,
not in the test suite).

### Two styles of test in this repo

**Router-level**, using the `client` fixture from `conftest.py`
(`TestClient` wrapping the FastAPI app) — exercises a request through
routing, dependency injection, and the DB in one pass. Currently just
`test_health.py`; this is the pattern to follow for a new resource's
endpoints (see the commented example at the bottom of that file).

**Unit-level**, calling a class or function directly with no FastAPI
app, no `TestClient`, and no HTTP in the loop. Where a test needs a
database (e.g. a repository method), it builds its own throwaway
in-memory SQLite session inline rather than reusing the `client`
fixture's engine — see the `db_session`/`session_factory` fixtures in
`test_ingest_repository.py` and `test_consumer.py`. This is the
current suite's dominant style, covering the app's structural
guarantees and highest-risk logic:

| File | What it exercises |
|---|---|
| `test_recorder.py` | `CallRecorder` — the "exactly one log per call" guarantee: success, error, cancellation, and every `describe_*`/processor failure mode |
| `test_events.py` | `config_hash` determinism |
| `test_pricing.py` | `compute_cost` — billing math and its `None`-on-unknown-input edge cases |
| `test_redaction.py` | `redact_event` — PII scrubbing and its fail-open-to-original-text behavior |
| `test_titling.py` | `sanitize_title` / `should_title` — the auto-title decision logic |
| `test_schemas.py` | `percentile`, log-preview helpers, and Pydantic field validators |
| `test_ingest_repository.py` | `InferenceLogRepository.create_many_skip_duplicates` — Kafka at-least-once dedup |
| `test_consumer.py` | `InferenceLogConsumer._parse` / `_write_logs` — malformed-message and DB-failure handling |
| `test_openai_provider.py` | `OpenAIProvider`'s response/error mapping (`describe_*`, `_map_response`) |
| `test_publisher.py` | `HTTPEventPublisher.publish` — the "never raises" contract |
| `test_errors.py` | `app/core/errors.py` exception handlers — exception → clean JSON translation |
| `test_analytics_duckdb.py` | `should_use_duckdb`, `sqlite_file_path`, `_escape_literal` — analytics engine routing |

## Linting

    make lint

## Database migrations

Schema changes are tracked with Alembic — there is no auto-create-tables
step, so a fresh clone has no tables until you add a model and migrate:

    make db-revision message="add item table"   # after editing app/models.py
    make db-upgrade

See "Database migrations" in `CLAUDE.md` for the full workflow.

## DuckDB analytics engine (optional, read-only)

Spec 018. `GET /logs/stats` and `GET /logs/timeseries` (the dashboard's
KPI tiles and charts) can be answered two ways: the original SQLAlchemy
queries, or DuckDB — an embedded, columnar SQL engine that's a better
fit for "scan and aggregate" workloads. The API contract doesn't
change; this is purely an internal engine swap, and it's on by default
whenever it can be (see "Fallback" below).

### How DuckDB "sits on top of" SQLite

There's no second copy of the data, no sync job, no ETL. DuckDB ships a
"sqlite scanner" extension that opens a SQLite file directly and reads
its tables as if they were DuckDB's own. On every `/logs/stats` or
`/logs/timeseries` request (when this engine is selected),
`app/repositories/analytics_duckdb.py` does, in order:

1. Open a fresh **in-memory** DuckDB connection — nothing is ever
   written to disk on DuckDB's side.
2. `INSTALL sqlite; LOAD sqlite;` — loads the extension (a one-time
   network download the first time this ever runs on a machine;
   cached locally after that).
3. `ATTACH 'app.db' AS src (TYPE sqlite, READ_ONLY)` — points DuckDB at
   the *same* `app.db` file SQLAlchemy already writes to, read-only.
4. Run the aggregate query directly against `src.inference_logs`: one
   statement for `/timeseries`, or five for `/stats` (headline +
   percentiles in one statement, plus one per breakdown — by model,
   provider, call type, status).
5. Close the connection.

So "on top of SQLite" means exactly that: DuckDB's engine reads the
same `.db` file on disk (translating SQLite's declared types to its
own — `INTEGER→BIGINT`, `NUMERIC→DOUBLE`, the datetime text columns →
`TIMESTAMP`), and computes the aggregate itself instead of asking
SQLite to.

### Which APIs use it

Only `GET /logs/stats` and `GET /logs/timeseries`. Everything else —
`GET /logs`, `GET /logs/{request_id}`, and every write — always goes
through the normal SQLAlchemy path in `app/db.py`. DuckDB only exists
for the lifetime of those two requests, per request.

### Fallback / kill switch

Controlled by `ANALYTICS_ENGINE` in `.env` (see `.env.example`),
re-evaluated on every request:

| Value | Behavior |
|---|---|
| `auto` (default) | DuckDB if `DATABASE_URL` points at a real SQLite file; the SQLAlchemy path otherwise (the in-memory DB tests use, or a Postgres URL) |
| `sqlite` | Always the SQLAlchemy path — the manual kill switch if DuckDB ever misbehaves |
| `duckdb` | Force DuckDB; if `DATABASE_URL` isn't a file-based SQLite URL that's now a config mistake, and the request fails loudly (500 + an ERROR log) instead of silently falling back |

Each request logs a DEBUG line naming the engine it used, e.g.
`GET /logs/stats: analytics engine=duckdb`.

### Does it touch the write path?

No, in two senses. First, DuckDB attaches **read-only** — an attempted
write against the attached database raises an error; it's physically
incapable of writing. Second, every write in the app (chat messages,
ingested inference logs) still goes exclusively through the
SQLAlchemy `engine`/`SessionLocal` in `app/db.py`; nothing in the
ingestion path was touched by this feature. DuckDB is a second,
*temporary* reader of the same file — which is also why this isn't "a
second datastore": there's still exactly one copy of the data and one
write path.

It also doesn't block, or get blocked by, a write happening at the
same time — SQLite's WAL journal mode (spec 016) means a DuckDB read
sees the last committed snapshot instantly, with no lock contention in
either direction.

### Why it's faster

Two concrete things changed, not just "DuckDB is fast in general":

- **Fewer round trips.** The old code computed each percentile
  (p50/p95/p99) with its own query (`ORDER BY ... LIMIT 1 OFFSET k`) —
  6 separate queries just for latency + TTFT. DuckDB computes all of
  them in the *same* statement as the headline counts/sums, via its
  `quantile_disc()` aggregate function.
- **No Python-side loop.** `/logs/timeseries` used to pull every
  matching row into Python and bucket/sort it by hand. The DuckDB
  version does the bucketing (`strftime`) and percentiles inside one
  `GROUP BY` statement — the database does the work, not the app.

DuckDB is also a columnar, vectorized engine (it processes values in
batches, not row-by-row), which suits this "scan and aggregate" shape
better than SQLite's row-at-a-time engine — but at this app's demo
scale, the query-count reduction above is what actually matters.

### Does it run as a separate service?

No — there's no DuckDB server, process, or port to run. `duckdb` is
just a Python library (`import duckdb`); every connection is opened,
used, and closed inside the same request, inside the FastAPI process,
the same way you'd use the stdlib `sqlite3` module. Installing the
package (already done via `uv add duckdb`) is the entire setup.

### Trying it locally

    # backend/.env
    ANALYTICS_ENGINE=duckdb   # or sqlite, or leave unset for auto

Restart `make backend`, hit `/logs/stats` or `/logs/timeseries` (via
the frontend dashboard or Swagger UI), and check the backend log for
the `analytics engine=...` DEBUG line to confirm which path ran.

## Kafka event pipeline (local dev, optional)

Spec 017. Inference log events normally travel HTTP fire-and-forget
(`EVENT_TRANSPORT=http`, the default) — nothing below is required for
that path, and a fresh clone with no broker running behaves exactly as
before this spec. This section is only for testing `EVENT_TRANSPORT=kafka`
locally. No Docker; the broker is a local Homebrew install running in
KRaft mode (no ZooKeeper).

### Install and start the broker

    brew install kafka

Homebrew's `kafka` formula only depends on `openjdk` — it's KRaft-only,
and it auto-formats local storage the first time you install it, so
there's no separate `kafka-storage format` step to run yourself.

Run it either as a background service:

    brew services start kafka

or in the foreground, in its own terminal (useful when you want to see
broker logs directly, or `Ctrl-C` to stop it):

    $(brew --prefix)/opt/kafka/bin/kafka-server-start $(brew --prefix)/etc/kafka/server.properties

Either way it listens on `localhost:9092` — the `KAFKA_BOOTSTRAP_SERVERS`
default in `backend/.env.example`. Stop the background service with
`brew services stop kafka`.

### Create the topic

The broker auto-creates topics on first publish, so this is optional —
but creating it explicitly lets you set partition count up front and
confirm the broker is reachable:

    $(brew --prefix)/opt/kafka/bin/kafka-topics --create \
      --topic inference-logs --bootstrap-server localhost:9092 \
      --partitions 1 --replication-factor 1

Confirm it exists:

    $(brew --prefix)/opt/kafka/bin/kafka-topics --list --bootstrap-server localhost:9092

### Subscribe to it (watch raw events land)

In its own terminal, independent of this app's consumer — useful for
confirming events are actually being produced before you go looking for
them in the database:

    $(brew --prefix)/opt/kafka/bin/kafka-console-consumer \
      --bootstrap-server localhost:9092 \
      --topic inference-logs --from-beginning

Each line is one `InferenceLogEvent` as JSON, the same payload the HTTP
transport POSTs to `/ingest/logs` today.

### Testing flow

1. Broker running (above), topic exists.
2. In `backend/.env`, set `EVENT_TRANSPORT=kafka` (copy from
   `.env.example` if you haven't already: `cp backend/.env.example
   backend/.env`).
3. `make backend` — the FastAPI lifespan starts the in-app consumer
   automatically when `EVENT_TRANSPORT=kafka`; `/ingest/logs` stays
   registered and usable regardless of transport.
4. Send a chat message (via the frontend, or `POST /conversations` +
   `POST /conversations/{id}/messages` through Swagger UI at
   http://localhost:8000/docs).
5. Watch it land: the `kafka-console-consumer` from above prints the
   event JSON, and `GET /logs` (or the frontend's log dashboard) shows
   the row the consumer wrote, cost populated identically to the HTTP
   path.
6. **Standalone consumer**: stop the backend, set `EVENT_TRANSPORT=http`
   in `.env`, run `make backend` (now publishing over HTTP again) in one
   terminal and `make consumer` in another — the standalone consumer
   still works independent of the app's transport, per FR4.
7. **Broker-down resilience**: stop Kafka (`brew services stop kafka` or
   `Ctrl-C` the foreground broker) with `EVENT_TRANSPORT=kafka` still
   set, then send another chat message — it still returns 200; the
   backend log shows an ERROR line for the dropped publish; nothing
   5xxes. Restart the broker and publishing resumes on the next call.
8. **Redelivery / dedup check**: reset the consumer group to replay the
   topic from the start (consumer must not be running when you do this):

       $(brew --prefix)/opt/kafka/bin/kafka-consumer-groups \
         --bootstrap-server localhost:9092 --group ingestion \
         --topic inference-logs --reset-offsets --to-earliest --execute

   Restart the consumer (`make backend` in kafka mode, or `make
   consumer`) — every event redelivers, and `create_many_skip_duplicates`
   skips them all as duplicates on `request_id`; `GET /logs` shows no new
   rows.
9. Set `EVENT_TRANSPORT` back to `http` (or delete the line) to return to
   the zero-infra default.

### Cleanup

    brew services stop kafka          # if run as a background service
    rm -rf $(brew --prefix)/var/lib/kraft-combined-logs   # wipe all topic data

Deleting `kraft-combined-logs` removes every topic and offset. Unlike a
fresh `brew install`, restarting the broker does **not** auto-reformat
storage — you have to redo that step once:

    uuid="$($(brew --prefix)/opt/kafka/bin/kafka-storage random-uuid)"
    $(brew --prefix)/opt/kafka/bin/kafka-storage format --standalone \
      -t "$uuid" -c $(brew --prefix)/etc/kafka/server.properties

(or just `brew reinstall kafka`, which re-runs that same step
automatically since the formatted-storage marker file is gone).

## Project structure

    backend/
      app/
        main.py            # FastAPI app, lifespan, CORS, exception handlers, router registration
        core/
          config.py         # pydantic-settings Settings, loaded from .env
          logging.py         # setup_logging()
          errors.py           # exception -> clean JSON response translation
        db.py                  # SQLAlchemy engine, SessionLocal, Base, get_db dependency
        models.py             # SQLAlchemy ORM table definitions
        schemas.py             # Pydantic request/response models
        routers/                # one file per resource
      alembic/                  # migration scripts
      tests/
        conftest.py             # isolated in-memory DB + `client` fixture
      pyproject.toml
      .env.example
    frontend/
      src/
        main.tsx
        App.tsx                # root component
        api.ts                  # fetch wrapper, one function per endpoint
      index.html
      package.json
      vite.config.ts
      tsconfig.json
      .env.example
    CLAUDE.md                   # conventions Claude Code follows automatically
    Makefile

## Adding a feature

Repeatable loop for every new resource. Build one at a time, pausing for
review between steps rather than doing all of them in one pass — per the
"Workflow" section in `CLAUDE.md`.

| Step | Artifact | What happens |
|---|---|---|
| 1 | `backend/app/models.py` | Add the SQLAlchemy model (see the commented example already in the file) |
| 2 | terminal | `make db-revision message="add item table"` — review the generated file under `backend/alembic/versions/` before applying; autogenerate won't catch renames or data migrations |
| 3 | terminal | `make db-upgrade` |
| 4 | `backend/app/schemas.py` | Add request/response Pydantic schemas (e.g. `ItemCreate`, `ItemRead`) |
| 5 | `backend/app/routers/<resource>.py` (new file) | `APIRouter(prefix="/items", tags=["items"])`; endpoints take `db: Session = Depends(get_db)` from `app.db` |
| 6 | `backend/app/main.py` | Register the router with `app.include_router(...)` |
| 7 | `backend/tests/test_<resource>.py` (new file) | At least one test for the main edge case (duplicate, missing parent, empty input), using the `client` fixture from `conftest.py` |
| 8 | `frontend/src/api.ts` | Add a fetch function per endpoint |
| 9 | `frontend/src/App.tsx` or a new component | Wire up the UI |

Note what you *don't* need to touch: `app/db.py` and `app/core/*` —
that's stable infrastructure, not per-feature code.

### Testing as you go

- **Backend**: `make test` — isolated in-memory DB (see `conftest.py`),
  safe to run constantly, never touches `backend/app.db`.
- **Manual API testing**: `make backend`, then
  http://localhost:8000/docs (Swagger UI) — exercise a new endpoint
  before wiring the frontend to it.
- **Migration sanity check**: after `make db-upgrade`, spot-check with
  `sqlite3 backend/app.db ".schema"`, especially for constraint/FK
  changes.
- **Frontend**: `npm run dev` + manual click-through is the real check;
  `npx tsc --noEmit` inside `frontend/` catches type errors without
  booting anything.
- `make lint` before calling a change done.
