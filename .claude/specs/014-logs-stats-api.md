# 014 — Inference Log Aggregates API

Depends on: backend specs **005-ingestion** and **007-logs-api**.
Blocks: **015-frontend-logs**.

Numbered 014 because the design doc's feature breakdown reserves **012-streaming**
and **013-docs**.

## Problem statement

Spec 007 gives `/logs` a paginated, filterable list and a full-content detail
lookup — the design doc's query patterns Q1–Q4. It does not answer Q5:
*aggregates* — p95 latency, error rate, tokens per hour, cost by model. Those
are the monitoring surface, and they are the whole point of an observability
product.

Spec 015 builds a dashboard for them. Without this spec, that dashboard would
have to page through `GET /logs` and aggregate in the browser, which is wrong
in two ways: the KPIs would describe only the rows that happened to be
fetched, and it gets slower exactly as the logs table grows. Aggregation
belongs in the database.

This spec adds two read-only endpoints — a KPI/breakdown summary and a
bucketed timeseries — plus one cross-cutting correctness fix (UTC
serialisation) that a time-windowed API cannot be correct without.

**In scope:** `GET /logs/stats`, `GET /logs/timeseries`, their schemas, their
repository methods, `model`/`provider` filters added to all three logs
endpoints, and the UTC serialisation fix.

**Out of scope:** any frontend (015), pre-aggregated rollup tables, a
columnar store, content search, per-user attribution, alerting, quality/eval
scores (`inference_scores` is designed, not built), and any write endpoint.

## Prerequisite fix: UTC serialisation

**This is a confirmed bug, not a hypothetical, and this spec cannot be correct
without fixing it.**

`InferenceLog.created_at` (and `requested_at` / `completed_at`, and specs
001/002's conversation and message timestamps) are declared
`DateTime(timezone=True)` with a Python-side `datetime.now(UTC)` default. The
model comment states this is to avoid browser-rendered time skew. **SQLite
does not honour it.** Verified against the real models:

```
stored:     '2026-08-01 14:27:55.282108'   (TEXT — the +00:00 offset is stripped)
read back:  datetime(2026, 8, 1, 14, 27, 55, 282108)   tzinfo = None
serialised: "2026-08-01T14:27:55.282108"   (no Z, no offset)
```

Consequences:

1. **Every timestamp in the app renders with a skew equal to the browser's UTC
   offset**, because `new Date("2026-08-01T14:27:55")` is parsed as *local*
   time. At UTC+05:30 that is five and a half hours.
2. **A time-windowed API is unusable.** A dashboard asking for "the last hour"
   sends a UTC-explicit `from`, the server compares it against naive values,
   and a client that computes the window from skewed timestamps asks the wrong
   question. This endpoint's entire contract is time windows.

**The fix**, in `app/db.py`: a `UtcDateTime(TypeDecorator)` wrapping
`DateTime(timezone=True)` that, on `process_result_value`, attaches
`tzinfo=UTC` to a naive value and converts an aware one to UTC. Applied to
every `DateTime` column in `app/models.py`.

- **No Alembic migration.** The stored representation does not change; the
  coercion is Python-side on read. `make db-revision` must produce an empty
  migration — if it does not, something else drifted.
- **No API contract change.** Timestamps that were serialised
  `"…T14:27:55.282108"` become `"…T14:27:55.282108Z"`. Every consumer that
  was already interpreting them as UTC now gets what it assumed.
- **Side effect, deliberate:** this resolves the "timestamp timezone" open
  question carried by specs 009 and 010.

It is in this spec rather than its own because this is the first feature whose
correctness depends on it, and because a two-line type decorator does not
warrant a spec of its own. It must be implemented and verified **first**, not
last.

## Functional requirements

### `GET /logs/stats`

1. **FR1** — Returns `LogStatsRead`: headline counts, error rate, latency
   percentiles, token sums, cost sum, and breakdowns by model, provider,
   call type, and status — for the rows matching the window and filters.
2. **FR2** — Accepts an optional time window as `from` and `to`
   (ISO-8601 datetime, `Query(...)`). Omitted `to` defaults to *now*; omitted
   `from` defaults to `to - 24 hours`. The **resolved** window is echoed in
   the response so a client never has to guess what it asked for.
3. **FR3** — Accepts the same filters as `GET /logs` — `conversation_id`,
   `status`, `call_type` — plus `model` and `provider` (exact match). All
   combined with AND. Invalid enum values return 422 (FastAPI-validated, never
   silently ignored, never treated as "no filter").
4. **FR4** — The window is applied to `created_at` as `from <= created_at < to`
   — half-open, so adjacent windows neither double-count nor drop a row.
5. **FR5** — `error_rate` is `error_count / total_calls` as a float in
   `[0, 1]`, rounded to 4 decimal places, and is **exactly `0.0` when
   `total_calls == 0`** — never null, never a division error.
6. **FR6** — Latency percentiles `p50`, `p95`, `p99` use the **nearest-rank**
   definition, specified once in "Percentile definition" below and used
   identically by both endpoints. `avg` is rounded to the nearest integer
   millisecond.
7. **FR7** — Token sums treat `NULL` as `0` (`input_tokens` and
   `output_tokens` are nullable — every error and cancelled log has them
   null). `total` is `input + output`.
8. **FR8** — `cost_usd` is the sum over rows whose `cost_usd` is non-null,
   returned as a `Decimal`. It is `null` only when **no** matching row has a
   cost — never `0` standing in for "unknown". A companion
   `cost_coverage` field gives the fraction of matching rows that had a cost,
   so a partial sum is never mistaken for a complete one.
9. **FR9** — `ttft_ms` percentiles are computed over rows where
   `time_to_first_token_ms` is non-null, and the whole object is `null` when
   there are none. This is the expected state until spec 012 lands, and it is
   not an error.
10. **FR10** — Each breakdown is a list of `LogGroupStat` rows ordered by
    `calls DESC`, then `key ASC` for a deterministic tie-break. At most 10
    named rows are returned; the remainder are folded into a single row with
    `is_other: true`. `is_other` is a boolean field, not a sentinel key
    string, so a group genuinely named "other" is unambiguous.
11. **FR11** — An empty result set returns `200` with `total_calls: 0`, all
    counts `0`, `error_rate: 0.0`, empty breakdown lists, and `null`
    percentile/cost objects. **Never 404, never 204.**

### `GET /logs/timeseries`

12. **FR12** — Returns `LogTimeseriesRead`: one or more series of
    time-bucketed points over the same window and filters as FR2/FR3.
13. **FR13** — `bucket` is an enum `minute | hour | day`, default `hour`.
14. **FR14** — `group_by` is an enum `none | status | model | provider |
    call_type`, default `none`. `none` yields exactly one series with
    `key: "all"`.
15. **FR15** — **Every bucket in the window is emitted, including empty ones,
    with zero counts and null percentiles.** This is load-bearing: a line
    chart given a sparse series draws a straight line across the gap, which
    asserts activity that did not happen.
16. **FR16** — Every series covers the identical bucket list, so a stacked
    chart never has to align mismatched x-axes client-side.
17. **FR17** — A window and bucket combination yielding more than
    `MAX_BUCKETS = 500` buckets returns **422** with a message naming both the
    computed bucket count and the limit. It does not silently truncate,
    silently widen the bucket, or attempt the query.
18. **FR18** — Grouped series are ordered by total `calls DESC` across the
    window, capped at 8 named series plus one `is_other` series (a chart
    cannot carry more distinguishable colours — see spec 015).
19. **FR19** — Each point carries `t` (the bucket's **start**, UTC, inclusive),
    `calls`, `error_count`, `cancelled_count`, `latency_p50_ms`,
    `latency_p95_ms`, `input_tokens`, `output_tokens`, and `cost_usd`.
20. **FR20** — Percentiles within a bucket use the **same** nearest-rank
    definition as FR6. A single-bucket timeseries and a `/logs/stats` call over
    the same window and filters must report the **identical** p50/p95 —
    this is a testable invariant, not an aspiration.

### Shared

21. **FR21** — Both endpoints are read-only. No POST, PATCH, PUT, or DELETE is
    added to `/logs`.
22. **FR22** — `model` and `provider` filters are added to `GET /logs` (spec
    007) as well, so a dashboard's filter bar governs the charts and the table
    below them identically. A filter bar that filters one and not the other is
    broken by construction.
23. **FR23** — Route declaration order: `/logs/stats` and `/logs/timeseries`
    are declared **before** `/logs/{request_id}`. Since `request_id` is typed
    `str`, `GET /logs/stats` would otherwise match the detail route with
    `request_id="stats"` and return 404. This is the one ordering mistake this
    spec is most likely to ship with.

## Non-functional requirements

- **Aggregation happens in SQL, not in the router and not in the client.**
  Counts, sums, averages, maxima, and grouping are `func.count`/`func.sum`/
  `func.avg`/`func.max` with `GROUP BY`. Only percentiles reach Python, and
  only by the bounded paths described below.
- **Bounded work per request.** The window is always present (FR2 supplies a
  default), `MAX_BUCKETS` caps the bucket count (FR17), and breakdowns are
  capped at 10 rows (FR10). No request can ask for an unbounded scan.
- **Index reality, stated plainly.** `created_at` and `(status, created_at)`
  and `(conversation_id, created_at)` exist from spec 005 and serve the window
  and the filters. **`latency_ms` is not indexed**, so percentile queries sort
  the windowed rows. At demo scale this is correct and fast; at real scale the
  design doc's answer is a **rollup table fed by the event stream**, not an
  index on a column with this cardinality. No index is added by this spec, and
  no migration.
- **`strftime` is SQLite-specific and confined to one place.** Bucketing uses
  `func.strftime` inside a single repository method; it is verified to work on
  the stored format (`'2026-08-01 14:27:55.282108'` → `strftime('%s', …)` →
  `'1785594475'`). Porting to Postgres means replacing `date_trunc` in that one
  method. Do not spread date arithmetic across the router or the schemas.
- **Read-only and side-effect free.** Logs are immutable observability records.
- **No caching** (CLAUDE.md out-of-scope default). Every request hits the
  database.
- **No auth, no rate limiting** (CLAUDE.md out-of-scope defaults). Access
  control on `/logs` is gated on auth existing at all.
- **No cross-table joins.** Consistent with spec 007's rule 2: the logs API
  does not know what conversations exist and does not decorate an aggregate
  with a conversation title.

## Percentile definition

Defined once because two endpoints and their tests depend on agreeing exactly.

Given the ascending-sorted list `v` of non-null values and `N = len(v)`:

```python
def percentile(v: list[int], p: float) -> int | None:
    """Nearest-rank percentile. v must be sorted ascending."""
    if not v:
        return None
    k = math.ceil(p / 100 * len(v)) - 1
    return v[min(max(k, 0), len(v) - 1)]
```

Nearest-rank rather than linear interpolation because the result is always a
value that **actually occurred** — for a latency dashboard, "p95 is 1841ms"
should name a real request, not an interpolation between two. Documented so a
reviewer does not "fix" it into `numpy.percentile`, and so tests can assert
exact values.

The two endpoints reach it by different routes, each right for its shape:

- **`/logs/stats`** — no Python-side row list at all. `k` is computed from the
  SQL `COUNT(*)`, then each percentile is one
  `SELECT latency_ms … ORDER BY latency_ms LIMIT 1 OFFSET k`. Three small
  queries, constant memory, identical result to the function above.
- **`/logs/timeseries`** — one `SELECT strftime(...) AS bucket, latency_ms …
  ORDER BY bucket, latency_ms` scan of the window, then the function above per
  bucket group. One scan instead of `2 × buckets` queries.

## Data model

**No schema change. No new model, no new column, no Alembic migration.** Every
value returned is computed from columns spec 005 already defined. `make
db-revision` must produce an empty migration; if it does not, the model has
drifted from the migration chain and that must be fixed first.

The UTC serialisation fix changes a column's Python **type decorator**, not its
storage type, and is likewise migration-free (see "Prerequisite fix").

### Response schemas (`backend/app/schemas.py`)

None are `from_attributes`-constructible — they are computed, built by the
router from repository return values.

```python
class TimeWindow(BaseModel):
    from_: datetime = Field(alias="from")   # inclusive
    to: datetime                            # exclusive
    model_config = ConfigDict(populate_by_name=True)


class LatencyStats(BaseModel):
    p50_ms: int
    p95_ms: int
    p99_ms: int
    avg_ms: int
    max_ms: int


class TokenStats(BaseModel):
    input: int
    output: int
    total: int


class LogGroupStat(BaseModel):
    key: str                    # model name / provider / call_type / status
    is_other: bool = False      # FR10 — the folded remainder
    calls: int
    error_count: int
    error_rate: float
    latency_p95_ms: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal | None


class LogStatsRead(BaseModel):
    window: TimeWindow
    total_calls: int
    success_count: int
    error_count: int
    cancelled_count: int
    error_rate: float                  # FR5 — 0.0 when total_calls == 0
    latency: LatencyStats | None        # None when total_calls == 0
    ttft: LatencyStats | None           # None until spec 012 populates TTFT
    tokens: TokenStats
    cost_usd: Decimal | None            # FR8
    cost_coverage: float                # fraction of rows with a cost, 0.0–1.0
    by_model: list[LogGroupStat]
    by_provider: list[LogGroupStat]
    by_call_type: list[LogGroupStat]
    by_status: list[LogGroupStat]


class TimeseriesPoint(BaseModel):
    t: datetime                  # bucket start, UTC, inclusive
    calls: int
    error_count: int
    cancelled_count: int
    latency_p50_ms: int | None   # None for an empty bucket
    latency_p95_ms: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal | None


class TimeseriesSeries(BaseModel):
    key: str                     # "all" when group_by=none
    is_other: bool = False
    points: list[TimeseriesPoint]


class LogTimeseriesRead(BaseModel):
    window: TimeWindow
    bucket: BucketSize
    group_by: LogGroupBy
    bucket_count: int
    series: list[TimeseriesSeries]
```

Two new enums, beside the existing `CallType` / `LogStatus`:

```python
class BucketSize(StrEnum):
    MINUTE = "minute"
    HOUR = "hour"
    DAY = "day"


class LogGroupBy(StrEnum):
    NONE = "none"
    STATUS = "status"
    MODEL = "model"
    PROVIDER = "provider"
    CALL_TYPE = "call_type"
```

`Page[T]` is **not** used — neither endpoint is a list of rows and neither
paginates. Do not wrap an aggregate in a pagination envelope.

## API contracts

Both live in the existing `backend/app/routers/logs.py`
(`APIRouter(prefix="/logs", tags=["logs"])`), already registered in
`app/main.py`. No new router file and no new registration.

**Declaration order in the file — FR23:**

```
1. GET ""                  (spec 007, + new model/provider filters)
2. GET "/stats"            (this spec)
3. GET "/timeseries"       (this spec)
4. GET "/{request_id}"     (spec 007 — MUST stay last)
```

### `GET /logs/stats`

| | |
|---|---|
| `response_model` | `LogStatsRead` |
| Success | `200 OK`, always, including an empty window |

| Query param | Type | Default | Behaviour |
|---|---|---|---|
| `from` | `datetime \| None` | `to - 24h` | Inclusive lower bound on `created_at` |
| `to` | `datetime \| None` | now (UTC) | Exclusive upper bound |
| `conversation_id` | `int \| None` | — | Exact match |
| `status` | `LogStatus \| None` | — | `success`/`error`/`cancelled`; else 422 |
| `call_type` | `CallType \| None` | — | `chat`/`title`; else 422 |
| `model` | `str \| None` | — | Exact match |
| `provider` | `str \| None` | — | Exact match |

**Status codes:** `200` always on a valid request · `422` for an unknown enum
value, a non-integer `conversation_id`, an unparseable datetime, or
`from >= to`.

### `GET /logs/timeseries`

| | |
|---|---|
| `response_model` | `LogTimeseriesRead` |
| Success | `200 OK` |

Same seven params as above, plus:

| Query param | Type | Default | Behaviour |
|---|---|---|---|
| `bucket` | `BucketSize` | `hour` | Bucket width; else 422 |
| `group_by` | `LogGroupBy` | `none` | Series dimension; else 422 |

**Status codes:** `200` · `422` for the above, plus **`422` when the computed
bucket count exceeds `MAX_BUCKETS` (500)**, with a `detail` naming the computed
count and the limit so the client can widen the bucket and retry.

### `GET /logs` (spec 007 — modified)

Two additive optional query params, `model: str | None` and
`provider: str | None`, ANDed with the existing three (FR22). No change to the
response schema, the ordering, the pagination bounds, or any existing
behaviour. Spec 007's acceptance criteria remain valid unchanged.

### Repository

Three methods added to the existing `InferenceLogRepository` in
`backend/app/repositories/ingest.py` — one repository per table, and it already
owns the `/logs` read queries:

```python
def stats(self, *, window_from, window_to, **filters) -> StatsRow
def latency_percentile(self, *, p: float, window_from, window_to, **filters) -> int | None
def timeseries(self, *, bucket, group_by, window_from, window_to, **filters) -> list[BucketRow]
```

Plus a private `_filters(...)` helper so the window and the five filters are
built **once** and shared by `list`, `stats`, `latency_percentile`, and
`timeseries`. Two filter builders drifting apart is how a KPI stops matching
the table under it.

Repository methods return ORM values, plain tuples, or small dataclasses —
never a response schema (CLAUDE.md "Data access layer"). Bucket densification
(FR15), the "other" fold (FR10/FR18), and the schema shaping stay in the
router.

*Filename note:* `repositories/ingest.py` is where spec 005 put this class; the
name is a historical artefact. Renaming it to `logs.py` is a mechanical change
outside this spec's scope — do not do it as a drive-by.

## Constraints

- **No schema change, no migration.** If `make db-revision` emits a non-empty
  migration, stop and investigate drift.
- **No new index.** `latency_ms` percentile sorts are accepted (see NFRs). The
  scale answer is a rollup table, not an index.
- **No new dependency.** No numpy, no pandas, no SQL extension. The percentile
  function is six lines of stdlib.
- **Do not paginate an aggregate.** No `Page[T]`, no `limit`/`offset` on either
  endpoint.
- **Do not add an `include_rows` / `include_logs` flag** returning log rows
  alongside the aggregates. `GET /logs` is one request away, and spec 007's
  rule 3 (list and detail are split because content size differs by two orders
  of magnitude) applies with equal force here.
- **No join to `conversations` or `messages`** (spec 007 rule 2). A
  `conversation_id` that matches no conversation yields zeros, not a 404.
- **Router stays flat** (`app/routers/logs.py`). No `api/v1/...`.
- **`from`/`to` are always resolved server-side** and echoed. The server, not
  the client, decides what "the last 24 hours" means.
- `make lint` passes before the change is considered done.

## Error handling and edge cases

| # | Case | Response |
|---|---|---|
| 1 | No logs at all | `200`; `total_calls: 0`, all counts `0`, `error_rate: 0.0`, `latency: null`, `ttft: null`, `cost_usd: null`, `cost_coverage: 0.0`, all breakdowns `[]`. Timeseries returns every bucket in the window with zeros. **Never 404.** |
| 2 | Filters match nothing (e.g. `?status=error` with no errors) | Same as #1. An empty result is a valid answer to a valid question. |
| 3 | `?conversation_id=999999` (no such conversation) | `200` with zeros. **No 404**, no join — spec 007 rule 2. |
| 4 | `?status=pending` / `?call_type=summarize` / `?bucket=week` / `?group_by=user` | `422` naming the field and the permitted values. Not ignored, not treated as "no filter". |
| 5 | `from >= to` | `422`: "from must be earlier than to". Not an empty 200 — an inverted window is a client bug, and returning zeros would hide it. |
| 6 | `from` or `to` unparseable | `422` from FastAPI's datetime coercion. |
| 7 | Naive `from`/`to` (no offset supplied by the client) | Interpreted as **UTC** and echoed back with an explicit offset, so the client can see how it was read. Documented in the endpoint description. |
| 8 | Window entirely in the future | `200`; zeros, and the full dense bucket list. Not an error. |
| 9 | `?bucket=minute` over a 30-day window (43,200 buckets) | `422`: "43200 buckets requested; the maximum is 500. Use a wider bucket or a shorter window." No truncation, no silent bucket widening. |
| 10 | Window shorter than one bucket (a 5-minute window with `bucket=day`) | `200` with exactly **one** bucket, whose start is the containing day boundary. `bucket_count: 1`. |
| 11 | All matching rows have `cost_usd` null (unknown models) | `cost_usd: null`, `cost_coverage: 0.0`. **Not `0`** — "we do not know" and "it was free" are different facts. |
| 12 | Some rows have a cost, some do not | `cost_usd` is the partial sum; `cost_coverage` is the fraction, e.g. `0.6`. The client is responsible for labelling a partial sum; the API is responsible for making the partiality visible. |
| 13 | All matching rows are errors/cancelled (`input_tokens`, `output_tokens` null) | Token sums are `0`, not null (FR7). `latency` is still computed — `latency_ms` is non-nullable, and a failed call still took time. |
| 14 | No row has `time_to_first_token_ms` (the state until spec 012) | `ttft: null`. Expected, not an error. |
| 15 | Exactly one matching row | `p50 == p95 == p99 == avg == max == that row's latency`. The nearest-rank formula's clamp guarantees it. |
| 16 | Two matching rows, latencies `[100, 200]` | `p50 == 100`, `p95 == 200`, `p99 == 200` — `ceil(0.5×2)-1 = 0`, `ceil(0.95×2)-1 = 1`. Asserted exactly in tests; this is why the definition is written down. |
| 17 | More than 10 distinct models in `by_model` | Top 10 by `calls DESC`, then one folded row with `is_other: true` aggregating the rest. Its `calls`, `error_count`, and token sums are true totals for the remainder; its `latency_p95_ms` is `null` (a percentile of a union of groups is not a percentile of any group, and pretending otherwise would be a lie). |
| 18 | More than 8 distinct series with `group_by=model` | Top 8 plus one `is_other` series (FR18), all sharing the identical bucket list. |
| 19 | `group_by=none` | Exactly one series, `key: "all"`, `is_other: false`. |
| 20 | A bucket with rows but all of one status | Counts reflect it; the other counts are `0`. Percentiles are computed from that bucket's rows only. |
| 21 | Two logs with identical `created_at` | Both counted. Aggregates need no tie-break — unlike spec 007's paging, which does. |
| 22 | `GET /logs/stats` after the route-order mistake | Would return `404 "Inference log not found"`. FR23 prevents it; an acceptance criterion asserts it. |
| 23 | Concurrent ingestion during a stats request | Counts reflect whatever was committed when each query ran. `/stats` issues four-plus queries and is **not** wrapped in a snapshot transaction, so a KPI and a breakdown can differ by a row or two under active write load. Accepted at demo scale and documented rather than fixed with `REPEATABLE READ`, which SQLite does not offer in a useful form here. |

## Acceptance criteria

Written so each bullet becomes one pytest case using the `client` fixture from
`tests/conftest.py`. Fixtures seed `InferenceLog` rows directly with explicit
`created_at` values — this spec has no dependency on the chat feature, so tests
must not create conversations. **Tests are created only via the
`generate-tests` skill, when the user invokes it** — do not write them while
implementing.

**Prerequisite fix**

- [ ] A seeded log read back through the ORM has `created_at.tzinfo` equal to
      UTC, not `None`.
- [ ] `GET /logs/{request_id}` serialises `created_at` with an explicit UTC
      offset (`Z` or `+00:00`).
- [ ] The same holds for `ConversationRead.updated_at` and
      `MessageRead.created_at`.
- [ ] `make db-revision` produces an **empty** migration.

**Route ordering**

- [ ] `GET /logs/stats` returns `200` and a `LogStatsRead` body — **not** a
      404 from the detail route.
- [ ] `GET /logs/timeseries` returns `200` and a `LogTimeseriesRead` body.
- [ ] `GET /logs/{a-real-request-id}` still returns that log.

**`/logs/stats` — shape and window**

- [ ] With no logs, returns `200`, `total_calls: 0`, `error_rate: 0.0`,
      `latency: null`, `ttft: null`, `cost_usd: null`, `cost_coverage: 0.0`,
      and four empty breakdown lists.
- [ ] With no `from`/`to`, the echoed window spans exactly 24 hours ending at
      approximately now.
- [ ] A log at exactly `from` is **included**; a log at exactly `to` is
      **excluded** (FR4's half-open window).
- [ ] Seeding 6 rows inside and 4 outside the window yields
      `total_calls == 6`.
- [ ] `from >= to` returns `422`.
- [ ] `?status=pending` returns `422`; `?conversation_id=abc` returns `422`.

**`/logs/stats` — values**

- [ ] With 7 success, 2 error, 1 cancelled: counts are 7/2/1,
      `total_calls == 10`, `error_rate == 0.2`.
- [ ] With latencies `[100, 200, 300, 400, 500]`: `p50 == 300`,
      `p95 == 500`, `p99 == 500`, `avg == 300`, `max == 500`.
- [ ] With latencies `[100, 200]`: `p50 == 100`, `p95 == 200` (edge case #16).
- [ ] With a single row: `p50 == p95 == p99 == avg == max`.
- [ ] Token sums treat nulls as 0 and `total == input + output`.
- [ ] With costs `[0.001, 0.002]` and one null-cost row: `cost_usd == 0.003`
      and `cost_coverage == 0.6667` (2 of 3).
- [ ] With every `cost_usd` null: `cost_usd is None` and
      `cost_coverage == 0.0` — explicitly **not** `0`.
- [ ] With every `time_to_first_token_ms` null: `ttft is None`.
- [ ] `by_status` sums to `total_calls`.
- [ ] With 12 distinct models: 10 named rows ordered by `calls DESC`, plus one
      row with `is_other: true` whose `calls` equals the remaining total and
      whose `latency_p95_ms` is `null`.
- [ ] `by_model` rows are ordered `calls DESC`, ties broken by `key ASC`.
- [ ] `?model=gpt-5` restricts every headline number and every breakdown to
      that model.

**`/logs/timeseries`**

- [ ] Default `bucket` is `hour` and default `group_by` is `none`; the single
      series has `key == "all"`.
- [ ] Over a 6-hour window with rows in only 2 hours, **6** points are
      returned; the 4 empty ones have `calls: 0` and
      `latency_p50_ms: null` (FR15).
- [ ] `bucket_count` equals `len(points)` of every series.
- [ ] Every point's `t` is the bucket **start** in UTC, and consecutive `t`
      values differ by exactly one bucket width.
- [ ] `?group_by=status` returns one series per present status, all with the
      **identical** list of `t` values (FR16).
- [ ] With 10 distinct models and `group_by=model`: 8 named series plus one
      `is_other` series.
- [ ] Summing `calls` across all series and buckets equals `/logs/stats`'
      `total_calls` for the same window and filters.
- [ ] **A one-bucket timeseries reports the same `latency_p95_ms` as
      `/logs/stats`' `latency.p95_ms` for the same window and filters**
      (FR20's invariant).
- [ ] `?bucket=minute` over a 30-day window returns `422` naming both the
      computed bucket count and 500.
- [ ] A 5-minute window with `bucket=day` returns exactly one point, at the
      day boundary.
- [ ] `?bucket=week` returns `422`; `?group_by=user` returns `422`.
- [ ] A window entirely in the future returns `200` with all-zero dense
      buckets.

**`GET /logs` additions**

- [ ] `?model=gpt-5` returns only logs for that model, with `total` reflecting
      the filtered count.
- [ ] `?provider=openai` likewise.
- [ ] `?model=X&status=error` ANDs both.
- [ ] Every acceptance criterion from spec 007 still passes.

**Read-only**

- [ ] `POST`, `PATCH`, `PUT`, and `DELETE` to `/logs/stats` and
      `/logs/timeseries` all return `405`.

## Files to be changed

| Path | Change | Purpose |
|---|---|---|
| `backend/app/db.py` | modify | Add `UtcDateTime(TypeDecorator)` — the prerequisite fix. |
| `backend/app/models.py` | modify | Use `UtcDateTime` for every `DateTime` column (conversations, messages, inference logs). **No migration** — the storage type is unchanged. |
| `backend/app/schemas.py` | add | `BucketSize`, `LogGroupBy`, `TimeWindow`, `LatencyStats`, `TokenStats`, `LogGroupStat`, `LogStatsRead`, `TimeseriesPoint`, `TimeseriesSeries`, `LogTimeseriesRead`, and the `percentile()` helper. Imports the existing `CallType`/`LogStatus`; defines neither. |
| `backend/app/repositories/ingest.py` | modify | Add `stats`, `latency_percentile`, `timeseries`, and the shared private `_filters` helper; refactor `list` to use `_filters` and accept `model`/`provider`. |
| `backend/app/routers/logs.py` | modify | Add `GET /stats` and `GET /timeseries` **before** `GET /{request_id}` (FR23); add `model`/`provider` params to `GET ""`; bucket densification, the "other" fold, and schema shaping. |
| `backend/tests/test_logs_stats_api.py` | — | Window resolution, percentile exactness, dense buckets, group folding, the stats↔timeseries invariant, 422 cases, route ordering. **Created only via the `generate-tests` skill, when the user invokes it.** |
| `backend/postman_collection.json` | regenerate | Via the `postman-collection` skill, once the endpoints exist. |

No new model, no new column, **no migration**, no new router file, no new
dependency, no frontend change (that is spec 015).

## Feature-specific rules

### 1. The percentile definition is written down because two endpoints must agree

`/logs/stats` computes percentiles with `ORDER BY … OFFSET k`;
`/logs/timeseries` computes them in Python over a single scan. Different
mechanics, **one definition** (nearest-rank, "Percentile definition" above),
because a dashboard that shows "p95: 1841ms" in a KPI tile above a chart whose
p95 line sits at 1902ms for the same window is worse than showing neither.
FR20 makes the agreement a test.

Nearest-rank, not interpolation: the reported value is always a latency that
actually happened.

### 2. Empty buckets are emitted, always

A sparse series is the single most common way a latency chart lies. Given
points at 09:00 and 14:00 and nothing between, every charting library draws a
straight line across five hours and the reader sees a smooth trend through a
period with no traffic. Emitting `calls: 0, latency_p50_ms: null` lets spec 015
render a gap for "no data" and a zero for "no calls" — which are different
facts and must look different.

This is why densification lives in the router rather than being left to the
client: every consumer needs it, and a client that forgets it produces a
plausible-looking wrong chart rather than an obvious error.

### 3. `cost_usd: null` and `cost_usd: 0` mean different things

`cost_usd` is null on a row whose model was not in the price map at ingestion
time (spec 005). Summing nulls as zero would report a spend of `$0.31` for a
window where half the calls had unknown pricing, with nothing on screen to say
so. Hence `cost_coverage` (FR8): the API reports the partial sum **and** its
completeness, and spec 015 is required to surface a coverage below 1.0.

Same principle as spec 007's rule 1 — store raw measurements, derive
presentations, and never let a derivation invent certainty the data does not
have.

### 4. `is_other` is a boolean, not a magic key

Folding the long tail is necessary — a chart cannot carry 40 distinguishable
model colours, and a breakdown table of 40 rows is not a summary. But a
sentinel key (`"other"`, `"__other__"`) is a string that can collide with real
data and that every client has to know to special-case. A boolean field cannot
collide and cannot be missed.

The folded row's `latency_p95_ms` is deliberately `null`: a percentile over the
union of several groups is not a percentile of any of them.

### 5. Route order is a correctness requirement, not a style preference

`/logs/{request_id}` with `request_id: str` matches **any** single path
segment, including `stats` and `timeseries`. Declared in the wrong order, this
spec's endpoints return `404 "Inference log not found"` — a failure that looks
like a routing typo and wastes an afternoon. FR23 fixes the order; an
acceptance criterion asserts it; this rule explains why so nobody reorders the
file for tidiness.

### 6. This spec fixes UTC serialisation because it is the first feature that cannot work without it

A time-windowed aggregate API compared against naive timestamps is not
approximately right, it is wrong by the client's UTC offset. The fix is a
two-line `TypeDecorator` with no migration and no contract change beyond
adding the offset that consumers already assumed. It is in this spec rather
than deferred because deferring it means shipping a dashboard whose "last
hour" means something else, and rather than in its own spec because two lines
do not warrant one. It must be done and verified **first**.

## Open questions

- **Default window.** Assumed **24 hours ending now** when `from`/`to` are
  omitted. Confirm before build — 1 hour or 7 days are equally defensible
  defaults, and it determines what spec 015's dashboard shows on first paint.
- **`MAX_BUCKETS`.** Assumed **500**, with the client choosing a bucket that
  fits. Spec 015's FR10 derives the bucket from the window
  (≤6h → minute, ≤7d → hour, >7d → day), whose worst case is 360 buckets — so
  the 422 is unreachable from the dashboard and the cap only guards
  hand-written API calls. The one view 500 forecloses is **a full day at
  minute granularity** (1440 buckets); raising the cap to 1500 would allow it
  at the cost of a 1440-point line chart, which is past the point where a
  reader can distinguish points. Confirm 500 is the right ceiling.
- **Breakdown and series caps.** Assumed 10 named breakdown rows and 8 named
  series, both with an `is_other` fold. The 8 is derived from spec 015's
  validated 5-colour categorical palette plus small-multiple headroom;
  confirm before build.
- **`p99` on small windows.** Assumed reported regardless of row count, so a
  window with 3 rows reports `p99 == max`. The alternative — null below some
  minimum sample size — is more statistically honest but adds a rule the
  client must explain in the UI. Confirm which is wanted.
- **`error_rate` denominator.** Assumed **all** calls, so a cancelled call
  counts against the rate's denominator but not its numerator. Confirm — the
  alternative (excluding cancelled from the denominator, since a user
  cancellation is not a reliability signal) is arguably more correct for an
  SLO-style read.
