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

    make test

Tests run against an isolated in-memory SQLite DB (see
`backend/tests/conftest.py`) — they never touch `backend/app.db` and
don't require migrations to have been run first.

## Linting

    make lint

## Database migrations

Schema changes are tracked with Alembic — there is no auto-create-tables
step, so a fresh clone has no tables until you add a model and migrate:

    make db-revision message="add item table"   # after editing app/models.py
    make db-upgrade

See "Database migrations" in `CLAUDE.md` for the full workflow.

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
