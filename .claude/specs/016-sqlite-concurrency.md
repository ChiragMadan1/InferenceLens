# SQLite Concurrency Prep (WAL + busy timeout)

Parent design: `.claude/designs/eventing-and-analytics.md` (feature 1).
All decisions therein are final; this spec adds detail, it does not
reopen them.

## Problem statement

The app's SQLite database runs with the default rollback journal and no
busy timeout. Two upcoming features change the concurrency profile of
the same file: spec 017 adds a second writer path (the Kafka consumer's
batch inserts, alongside request threads and titling tasks), and spec
018 adds an out-of-band reader (DuckDB attaching the file read-only
while the app writes). Under the default journal mode, readers and
writers block each other and lock collisions surface as immediate
`database is locked` errors.

This spec enables WAL journal mode and a busy timeout on the app's
SQLite connections. That is the entire scope.

**Out of scope:** `synchronous=NORMAL` or any other pragma tuning (not
a blocker — recorded in the design doc's review as deliberately
untouched); any change for non-SQLite databases; any schema change;
any behavior change visible in the API.

## Functional requirements

1. FR1: Every connection the app's engine makes to a **SQLite**
   database executes `PRAGMA journal_mode=WAL` and
   `PRAGMA busy_timeout=5000` on connect.
2. FR2: Non-SQLite `DATABASE_URL`s (e.g. Postgres) are completely
   unaffected — no listener fires.
3. FR3: In-memory SQLite databases remain harmlessly unaffected in
   behavior (the WAL pragma is a documented no-op returning `memory`;
   the listener may still fire — no special-casing required).
4. FR4: WAL sidecar files (`app.db-wal`, `app.db-shm`) are gitignored.

## Non-functional requirements

- After this change, readers of the DB file (including an external
  DuckDB READ_ONLY attach) do not block the app's writer, and vice
  versa — the property 018 relies on.
- Writers contending for the single-writer lock wait up to 5 s instead
  of failing instantly — the property 017's consumer relies on.
- No user-visible latency change on any endpoint.

## Data model

None. No model change, no Alembic migration (pragmas are connection
settings, not schema; the critical "schema changes go through Alembic
only" rule is not triggered).

## API contracts

None. No endpoint added or changed.

## Constraints

- The engine is created once at import time in `backend/app/db.py`; the
  pragma hook must be a SQLAlchemy `event.listens_for(engine, "connect")`
  listener registered right after `create_engine`, so every pooled
  connection gets the pragmas (pool recycling makes per-connection,
  not per-engine, application mandatory).
- The listener must be conditional on the URL being SQLite
  (`settings.DATABASE_URL.startswith("sqlite")`), mirroring the
  existing `connect_args` guard in the same file.
- `journal_mode=WAL` is persistent in the DB file; re-executing it per
  connection is idempotent and cheap. `busy_timeout` is per-connection
  and must be set on every connect.
- Timeout value: 5000 ms, hardcoded next to the listener. Not a
  Settings field — no scenario at this scale tunes it, and config
  surface is a cost (design-doc micro-decision).
- `tests/conftest.py` builds its own in-memory engine and is untouched
  by this change.

## Error handling and edge cases

| Case | Behavior |
|---|---|
| In-memory SQLite (`sqlite:///:memory:`) | `journal_mode=WAL` no-ops (returns `memory`); `busy_timeout` set harmlessly; nothing to assert |
| Non-SQLite URL | Listener not registered (FR2) |
| Two writers collide (e.g. chat insert + consumer batch) | Second writer waits up to 5 s for the lock instead of raising immediately; past 5 s the normal `OperationalError` surfaces (not swallowed) |
| Pre-existing `app.db` created under rollback journal | First connection converts it to WAL transparently; no migration or data step needed |
| Concurrent external reader (sqlite3 CLI, DuckDB attach) during writes | Reader sees last-committed snapshot; writer proceeds unblocked |

## Acceptance criteria

- [ ] With the backend running against `sqlite:///./app.db`, `sqlite3
      backend/app.db "PRAGMA journal_mode;"` prints `wal`, and
      `app.db-wal` / `app.db-shm` exist beside the DB file.
- [ ] A connection obtained from the app engine reports
      `PRAGMA busy_timeout` = 5000.
- [ ] With `DATABASE_URL=postgresql+psycopg://...`, engine creation
      registers no SQLite listener (code-level check: guard mirrors the
      existing `connect_args` condition).
- [ ] `git status` stays clean after the app runs (sidecar files
      ignored).
- [ ] `make lint` passes.

## Files to be changed

- `backend/app/db.py` — `connect`-event listener applying the two
  pragmas, guarded to SQLite URLs.
- `.gitignore` — add `backend/app.db-wal`, `backend/app.db-shm`.

## Feature-specific rules

- The listener belongs in `app/db.py` beside the engine it configures —
  not in `main.py`, not in a lifespan hook (connections can be created
  before/independently of the app lifespan, e.g. Alembic runs or
  scripts importing `SessionLocal`).
- Do not "improve" adjacent concerns while here (no `synchronous`
  pragma, no pool tuning) — review finding R1 is the only item in
  scope, per the user's blockers-only decision.

## Open questions

None. (Assumed and recorded above: 5000 ms hardcoded; in-memory DBs not
special-cased. Both per the parent design doc's micro-decisions.)
