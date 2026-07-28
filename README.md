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
