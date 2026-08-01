# Project Conventions

## Stack

This stack is deliberately narrow and single-store. Don't swap pieces in
or out per-feature, and don't introduce a second datastore (NoSQL, cache,
etc.) — if a project genuinely needs something else (Postgres instead of
SQLite, Redis, etc.), that's a project-level decision to make explicitly,
not a default to reach for.

- **Backend**: FastAPI, Pydantic v2 (schemas + `pydantic-settings` for
  config), SQLAlchemy 2.0 ORM (SQLite by default via `DATABASE_URL`),
  Alembic for migrations.
- **Frontend**: React + Vite + TypeScript, fetch via `src/api.ts`, API
  base URL from `VITE_API_URL`.
- **Package/env management**: `uv` (backend), `npm` (frontend). No Docker,
  no Poetry, no pip/venv — `uv sync` and `uv run` are the only entry
  points for backend commands.
- **Testing**: pytest, with an isolated in-memory SQLite DB per test (see
  `tests/conftest.py`) — tests never touch the dev `app.db`.
- **Linting**: ruff (lint only — no formatter opinions enforced yet).

## Critical rules

These are non-negotiable defaults for this project. Everything else in
this file is guidance; these are hard constraints.

- **Schema changes go through Alembic only.** Never add `Base.metadata.create_all()`
  calls, raw `CREATE TABLE`, or any other schema-mutating shortcut. After
  editing `app/models.py`, run `make db-revision message="..."` then
  `make db-upgrade`. If you edit a model, generating the migration is part
  of the same change, not a follow-up.
  *Exception:* `tests/conftest.py` builds the in-memory test schema with
  `Base.metadata.create_all()` by design — that's test setup, not a schema
  change. (Tradeoff to be aware of: tests validate models, not migrations,
  so migration drift only surfaces at `make db-upgrade` time.)
- **Never swallow exceptions.** Every `except` block logs with context and
  either re-raises or returns a clear error response. No bare `except:`,
  no `except Exception: pass`.
- **Never accept or return raw dicts across the API boundary.** Every
  endpoint declares a Pydantic request schema (for bodies) and a
  `response_model` (for responses), defined in `app/schemas.py`.
- **Never let a child record reference a nonexistent parent.** Validate
  the parent exists before creating/updating; return 404, not a raw DB
  error.
- **Never commit secrets or generated artifacts.** `.env`, `app.db`,
  `.venv/`, `node_modules/` are gitignored — keep it that way.
  `.env.example` (no real secrets) is the thing that gets committed.
- **Don't add auth, rate limiting, caching, or realtime (websockets/polling)
  unless explicitly asked.** See "Out of scope by default" below.

## Project structure

    backend/
      app/
        main.py           # FastAPI app, lifespan, CORS, exception handlers, router registration
        core/
          config.py        # pydantic-settings Settings, loaded from .env
          logging.py        # setup_logging(), called from lifespan
          errors.py          # exception -> clean JSON response translation
        db.py               # SQLAlchemy engine, SessionLocal, Base, get_db dependency
        models.py           # SQLAlchemy ORM table definitions
        schemas.py           # Pydantic request/response models
        routers/             # one file per resource — HTTP concerns only
        repositories/         # one file per resource — SQLAlchemy queries, see "Data access layer"
      alembic/                # migration scripts — see "Database migrations"
      tests/
        conftest.py           # isolated in-memory DB + `client` fixture
      pyproject.toml
      .env.example
    frontend/
      src/
        main.tsx
        App.tsx              # root component
        api.ts                # fetch wrapper, one function per endpoint, uses VITE_API_URL
      .env.example
    CLAUDE.md                 # this file
    Makefile

## Data access layer

Every resource's SQLAlchemy queries live behind a repository class in
`backend/app/repositories/<resource>.py` — routers never call
`db.query`/`select`/`db.add`/`db.commit` directly. Convention,
established by the `conversations` feature (spec 001):

- One class per resource, e.g. `ConversationRepository`, constructed
  with the request-scoped session:

      class ConversationRepository:
          def __init__(self, db: Session):
              self.db = db

- The class owns every query for that resource (`create`, `list`,
  `get`, etc.) and returns ORM model instances — or plain tuples for
  paginated lists (`(items, total)`) — never a `Page[T]` or other
  response schema. Shaping the response into a schema stays in the
  router.
- Wire it into the router with its own dependency, declared in the
  router file next to the resource's other router code:

      def get_<resource>_repo(db: Session = Depends(get_db)) -> <Resource>Repository:
          return <Resource>Repository(db)

  Handlers take `repo: <Resource>Repository = Depends(get_<resource>_repo)`,
  not `db: Session` directly. `db` should only appear in the
  repository's constructor and in `get_<resource>_repo` — nowhere else
  in the router.
- The repository is a thin query layer, not a service layer:
  validation that belongs to the endpoint (parent-exists checks, 404
  vs raising `HTTPException`, response shaping) stays in the router,
  not the repository.
- `pyproject.toml`'s `[tool.ruff.lint.flake8-bugbear]` already sets
  `extend-immutable-calls` for `fastapi.Depends`/`fastapi.Query`, so
  this pattern doesn't trip bugbear's B008 — no per-feature lint config
  needed.

This is the one deliberate exception to "no premature abstraction"
below: apply it to every new resource from the start, not just once a
second caller of the same queries appears. It keeps routers focused on
HTTP concerns (request/response, status codes, error translation) and
keeps query logic independently testable and reusable outside FastAPI.

## Design docs and feature specs

Features flow through documents before code:

1. **Design doc** — `.claude/designs/<name>.md`, created via the
   `design-doc` skill from a raw idea. Covers problem statement, scope,
   FR/NFR, data model, APIs, user flows, edge cases, error handling, and
   an ordered feature breakdown.
2. **Feature spec** — `.claude/specs/NNN-<name>.md`, created via the
   `generate-spec` skill, one per small feature from the breakdown.
3. **Implementation** — via plan mode and/or the `implement-spec` skill,
   one spec at a time. No tests at this stage.
4. **Tests** — via the `generate-tests` skill, only when explicitly
   invoked (see "Code standards").
5. **Commit** — via the `commit` skill, which runs lint and a `review`
   pass on staged changes before committing.

Before implementing any feature, check `.claude/specs/` for its spec —
the spec is the source of truth over ad-hoc instructions. If a relevant
design doc or spec exists, don't re-decide what it already decided.

## Dev workflow

    make install-backend    # uv sync
    make install-frontend   # npm install
    make backend             # uv run uvicorn --reload
    make frontend             # npm run dev
    make test                  # uv run pytest

Run a single test while iterating (from `backend/`, only within a
`generate-tests` run — see "Code standards"):

    uv run pytest tests/test_items.py -k "test_name" -v
    make lint                   # uv run ruff check
    make db-revision message="add item table"   # alembic autogenerate
    make db-upgrade                                # alembic upgrade head
    make db-downgrade                              # alembic downgrade -1

No manual venv activation — every backend command goes through `uv run`,
which resolves the project's `.venv` automatically. Don't add
`source venv/bin/activate` or `pip install` instructions anywhere; if a
new dependency is needed, use `uv add <package>` (or `uv add --dev
<package>` for dev-only tools) so `pyproject.toml` and `uv.lock` both
update.

## Database migrations

SQLite + SQLAlchemy + Alembic is the only path for schema changes:

1. Edit/add a model in `app/models.py`.
2. `make db-revision message="short description"` — generates a migration
   under `alembic/versions/` by diffing `Base.metadata` against the DB.
3. Read the generated migration before running it — autogenerate is a
   starting point, not a guarantee (it won't catch renames, data
   migrations, or some constraint changes).
4. `make db-upgrade` to apply it.

`DATABASE_URL` in `.env` is the single source of truth for the DB
connection — Alembic reads it via `app.core.config.settings`, so it never
drifts from what the app itself connects to.

## Workflow

- Implement one logical piece at a time (one model, one endpoint, one
  component) rather than everything in a single pass. Pause after each
  piece for review before moving to the next.
- Before writing code for a new feature, state the plan briefly
  (data model / endpoint / edge cases) and confirm before implementing.
- An approved plan-mode plan counts as that confirmation — execute it
  piece by piece without re-asking; pause only for genuinely new
  decisions the plan or spec doesn't cover.
- After generating code, call out: (1) behavior on null/empty input,
  (2) behavior on duplicate/concurrent calls, (3) any tradeoff made
  that's worth flagging.
- If there are two reasonable approaches, present both with a one-line
  tradeoff each rather than silently picking one.

## Code standards

- Explicit error handling only (see "Critical rules").
- Every DB-touching endpoint validates that referenced entities exist
  before acting.
- Use database-level constraints (unique constraints, foreign keys) for
  invariants that matter under concurrency — don't rely on an
  application-level "check then act." Catch the resulting
  `IntegrityError`; the generic 409 translation already happens in
  `app/core/errors.py`, so routers usually don't need their own
  try/except for it — only add one where a more specific error message
  is warranted.
- Prefer explicit over clever. No premature abstraction — if something
  is only used once, don't build a framework for it. This is why routers
  are flat (`app/routers/<resource>.py`) rather than versioned
  (`api/v1/...`) — add versioning only when there's an actual second
  version to support. The one standing exception is the data access
  layer (see "Data access layer") — every resource gets a repository
  from the start, not just once a second caller shows up.
- Tests are generated and run **only** through the `generate-tests`
  skill, and only when the user invokes it — don't write pytest cases
  or run `make test`/`pytest` as part of implementing a feature. When
  that skill runs, new models/endpoints get at least one test covering
  the main edge case (e.g. duplicate action, missing parent entity,
  empty input), using the `client` fixture from `tests/conftest.py`.
- Run `make lint` before considering a change done.
- **Frontend**: every backend endpoint gets a typed function in
  `src/api.ts` — no inline `fetch` calls in components. Request/response
  TypeScript types mirror the backend Pydantic schemas by name (e.g.
  `ItemCreate`, `ItemRead`) so drift is easy to spot.

## Things to always clarify before building a feature

- Is this field/relationship required or optional? What's the default?
- What's the cascade behavior on delete (delete children, or orphan
  them, or block the delete)?
- Does a list endpoint need pagination? Project default: no pagination
  until a list is realistically expected to exceed ~1k rows — but the
  spec must state explicitly which side of that line the feature is on.
- Are derived values (counts, totals) denormalized for read speed or
  computed live? State the choice and why.

## Out of scope by default (build only if explicitly needed)

- Authentication / authorization
- Rate limiting
- Caching layer
- Real-time updates (websockets/polling) — assume refresh-based reads
  unless real-time is a stated requirement
