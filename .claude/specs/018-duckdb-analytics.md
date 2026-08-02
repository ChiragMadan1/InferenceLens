# DuckDB Analytics Layer

Parent design: `.claude/designs/eventing-and-analytics.md` (feature 3).
Decisions there are final. Needs spec 016 (WAL — readers must not block
the app's writer). Functionally independent of spec 017, but both edit
`core/config.py`, `repositories/ingest.py`, `pyproject.toml`, and
`.env.example` — implement sequentially (either order) or accept a
small merge.

## Problem statement

The aggregate endpoints — `GET /logs/stats` and `GET /logs/timeseries`
(query pattern Q5, spec 014) — run on the row store: percentiles cost
two queries each, and timeseries loads **every row in the window into
Python** and aggregates there. Correct today, and the documented first
casualty of scale. The original design named the fix: point DuckDB (an
embedded, MIT-licensed columnar engine) at the SQLite file as a
read-only analytics layer — no migration, no second write path, no API
change.

This spec swaps the *internals* of the two aggregate query paths onto
DuckDB when the engine is available, behind an `ANALYTICS_ENGINE`
setting. Everything the client sees is unchanged.

**Out of scope:** any route/schema/frontend change; any write through
DuckDB; repository restructuring (review finding R3 stays not-actioned;
selection happens inside the existing methods); Parquet exports,
rollups, retention; replacing SQLite anywhere (the design doc's option
"replace store" was explicitly declined in favor of this layer);
list/detail endpoints (point lookups stay on SQLAlchemy).

## Functional requirements

1. FR1: With the DuckDB engine active, `GET /logs/stats` and
   `GET /logs/timeseries` return responses **identical in shape and
   semantics** to the current implementation for the same data and
   filters: same fields, same filter behavior, same group orderings
   (count desc, key asc), same bucket-key strings, same empty-window
   shapes, and the same nearest-rank percentile definition (spec 014:
   for n sorted values, index `min(max(ceil(p/100·n)−1, 0), n−1)`).
2. FR2: Engine selection per request, from `ANALYTICS_ENGINE`:
   - `auto` (default): DuckDB iff `DATABASE_URL` is a **file-based
     SQLite** URL; otherwise the existing SQLAlchemy path (in-memory
     test DBs and Postgres cannot be attached this way).
   - `sqlite`: always the existing SQLAlchemy path (kill switch).
   - `duckdb`: force DuckDB; a non-file-SQLite `DATABASE_URL` is a
     configuration error that fails loudly (500 + ERROR log), never a
     silent fallback.
3. FR3: DuckDB access is strictly read-only: fresh in-memory DuckDB
   connection per request, `ATTACH '<file>' (TYPE sqlite, READ_ONLY)`,
   query, close. No pooling, no shared connections, no writes.
4. FR4: DuckDB failures are not swallowed: ERROR log with query context,
   then the standard 500 envelope (per CLAUDE.md error rules).
   Operators recover with `ANALYTICS_ENGINE=sqlite`.
5. FR5: `GET /logs` and `GET /logs/{request_id}` are untouched.

## Non-functional requirements

- Single-pass aggregates: stats and each timeseries call become one
  (or a small constant number of) DuckDB statements — no per-percentile
  queries, no Python row-loops.
- Per-request attach overhead is milliseconds at demo scale and always
  reads the current committed snapshot (WAL from 016 guarantees the
  reader never blocks the app's writer).
- Cost fields: SQLite's `NUMERIC` maps to DuckDB `DOUBLE`; aggregate
  cost values are converted back to `Decimal` for the existing response
  schemas. Sub-microdollar float error in *aggregates* is accepted
  (list/detail still serve exact values via SQLAlchemy).

## Data model

None. No model change, no migration. The declared-type mapping the
implementation must respect (from the design doc, verified against the
DuckDB sqlite extension docs): INTEGER→BIGINT, DATETIME text→TIMESTAMP,
NUMERIC→DOUBLE, JSON/TEXT→VARCHAR (content columns are never read by
these queries).

## API contracts

No endpoint added or changed; `LogsStats*` / `LogsTimeseries*` response
schemas in `app/schemas.py` are reused as-is.

New setting: `ANALYTICS_ENGINE` (`auto` | `sqlite` | `duckdb`, StrEnum
in `app/core/config.py`, default `auto`), documented in `.env.example`.

## Constraints

- `duckdb` Python package via `uv add duckdb`. The sqlite extension
  auto-installs/loads on first `ATTACH ... (TYPE sqlite)`; first-ever
  run downloads it (needs network once) — implementation should
  `INSTALL sqlite; LOAD sqlite;` explicitly so the failure mode is
  clear, and this caveat lands in the module docstring.
- **This is not a second datastore**: no DuckDB file is created
  (in-memory connection, read-only attach). The single-store rule and
  single write path stand.
- The DuckDB implementations return the **existing dataclasses**
  (`StatsRow`, `GroupRow`, `BucketRow` in `repositories/ingest.py`), so
  `routers/logs.py` — including its bucket densification and response
  shaping — is untouched.
- Timestamp binding: the app stores naive-UTC datetime text; window
  filter parameters (tz-aware UTC) must be converted to **naive UTC**
  before binding into DuckDB queries, or window edges silently shift.
  The existing `strftime` bucket formats (`%Y-%m-%d %H:00:00` etc.)
  must be reproduced exactly (DuckDB `strftime` supports them).
- Percentiles: DuckDB's `quantile_disc` may be used **only if the
  implementer verifies** it matches spec 014's nearest-rank definition
  at the boundaries (n=1, n=2, p99 on small n); otherwise implement
  nearest-rank explicitly (e.g. ordered-array indexing). Parity beats
  brevity here.
- SQLite file path derives from `DATABASE_URL` (`sqlite:///./app.db` →
  `./app.db`, resolved relative to the backend working directory);
  helper lives in the new analytics module (single caller).
- All queries parameterized — filter values are user input; no string
  interpolation of values (the table/column identifiers are static).

## Error handling and edge cases

| # | Case | Behavior |
|---|------|----------|
| 1 | `auto` + in-memory SQLite (tests) or Postgres URL | SQLAlchemy path, automatically (FR2) |
| 2 | `duckdb` forced + non-file DB | 500 + ERROR log naming the misconfiguration (FR2) — loud, not silent |
| 3 | DB file does not exist yet (fresh clone, no migration run) | Attach fails → FR4 (500 + ERROR); same operator story as every other endpoint before `make db-upgrade` |
| 4 | Stats request during active writes | WAL snapshot read; no blocking either direction (016) |
| 5 | Empty window / filters match nothing | Identical empty shapes to today (nulls for percentiles/avgs, zeros for counts, empty group lists) — FR1 includes empties |
| 6 | NULL `time_to_first_token_ms` / `cost_usd` / token columns | Same NULL-handling as today: percentile/avg over non-null only, `cost_count` counts non-null, token sums coalesce to 0 |
| 7 | DuckDB or extension failure mid-query | FR4: ERROR with context, 500, no retry loop, no fallback-swallow |
| 8 | Concurrent stats requests | Each has its own connection; no shared state (FR3 sidesteps the known duckdb-sqlite same-process connection-sharing issues) |

## Acceptance criteria

- [ ] Against a file DB seeded with mixed logs (statuses, models, null
      TTFT/cost rows), `GET /logs/stats` and `GET /logs/timeseries`
      (each bucket size, each group_by, with and without filters)
      return equal payloads under `ANALYTICS_ENGINE=duckdb` and
      `ANALYTICS_ENGINE=sqlite`, modulo documented float tolerance on
      cost aggregates.
- [ ] `ANALYTICS_ENGINE` unset + file DB → DuckDB path actually runs
      (verifiable via a DEBUG log line naming the engine).
- [ ] `ANALYTICS_ENGINE` unset + in-memory DB → SQLAlchemy path runs
      (test-suite compatibility; no test requires DuckDB).
- [ ] `ANALYTICS_ENGINE=duckdb` + in-memory DB → 500 with a clear
      ERROR log (edge 2).
- [ ] The attach is READ_ONLY (an attempted write statement against the
      attached DB errors).
- [ ] `GET /logs` and `GET /logs/{request_id}` behavior unchanged.
- [ ] `make lint` passes.

## Files to be changed

- `backend/pyproject.toml`, `backend/uv.lock` — `uv add duckdb`.
- `backend/app/core/config.py` — `AnalyticsEngine` StrEnum +
  `ANALYTICS_ENGINE` setting.
- `backend/app/repositories/analytics_duckdb.py` — new: DuckDB
  implementations of stats/timeseries (connection recipe, SQL,
  dataclass mapping, path helper, engine-selection predicate).
- `backend/app/repositories/ingest.py` — `stats()` / `timeseries()`
  delegate to the DuckDB module when selected; existing SQLAlchemy
  bodies remain as the `sqlite` path.
- `backend/.env.example` — `ANALYTICS_ENGINE`, commented.

## Feature-specific rules

- Keep both engines' outputs pinned to the same dataclasses and the
  same semantics; if a discrepancy is found during implementation, the
  SQLAlchemy path is the reference — DuckDB conforms to it, never the
  reverse (spec 014 remains the contract).
- No `duckdb-engine`/SQLAlchemy-dialect dependency — plain `duckdb`
  DBAPI in the one module. The ORM never learns about DuckDB.
- Do not cache DuckDB connections or results; freshness and isolation
  over micro-latency (design-doc micro-decision).

## Open questions

None blocking. Recorded assumption: engine choice is evaluated per
request (cheap, and honors env changes without restart-order concerns);
DEBUG-level log line states the chosen engine per request for
observability.
