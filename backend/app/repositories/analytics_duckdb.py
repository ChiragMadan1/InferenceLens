"""Read-only DuckDB analytics layer over the SQLite-backed `inference_logs`
table (spec 018). This is not a second datastore: no DuckDB file is ever
created — each call opens a fresh in-memory DuckDB connection, attaches the
existing SQLite file read-only, queries, and closes it. Selection between
this module and the SQLAlchemy path in `app.repositories.ingest` happens
per request via `ANALYTICS_ENGINE` (see `should_use_duckdb`); the
SQLAlchemy path remains the reference implementation for correctness.

First-run caveat: DuckDB's sqlite extension is not bundled. The first
`ATTACH ... (TYPE sqlite)` anywhere in the process triggers `INSTALL
sqlite`, which downloads the extension from DuckDB's extension repository
(needs network once; cached locally after). `INSTALL`/`LOAD` are called
explicitly below so a missing-network failure surfaces as a clear log line
and 500 rather than a mysterious hang on first request.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import duckdb

from app.core.config import AnalyticsEngine, settings

if TYPE_CHECKING:
    from app.repositories.ingest import BucketRow, GroupRow, StatsRow

logger = logging.getLogger(__name__)

# Fixed allowlists only — never built from request input, so interpolating
# these into SQL text (unlike filter *values*, which are always bound as
# `?` parameters below) carries no injection risk.
_BUCKET_FORMATS: dict[str, str] = {
    "minute": "%Y-%m-%d %H:%M:00",
    "hour": "%Y-%m-%d %H:00:00",
    "day": "%Y-%m-%d 00:00:00",
}

_GROUP_COLUMNS: dict[str, str] = {
    "status": "status",
    "model": "model",
    "provider": "provider",
    "call_type": "call_type",
}

_STATS_SQL = """
    SELECT
        count(*) AS total_calls,
        sum(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
        sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
        sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
        coalesce(sum(input_tokens), 0) AS input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens,
        sum(cost_usd) AS cost_sum,
        count(cost_usd) AS cost_count,
        count(time_to_first_token_ms) AS ttft_count,
        avg(latency_ms) AS latency_avg_ms,
        max(latency_ms) AS latency_max_ms,
        quantile_disc(latency_ms, [0.5, 0.95, 0.99]) AS latency_percentiles,
        avg(time_to_first_token_ms) AS ttft_avg_ms,
        max(time_to_first_token_ms) AS ttft_max_ms,
        quantile_disc(time_to_first_token_ms, [0.5, 0.95, 0.99]) AS ttft_percentiles
    FROM src.inference_logs
    WHERE {where}
"""

_GROUP_SQL = """
    SELECT
        {column} AS key,
        count(*) AS calls,
        sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
        coalesce(sum(input_tokens), 0) AS input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens,
        sum(cost_usd) AS cost_sum,
        count(cost_usd) AS cost_count
    FROM src.inference_logs
    WHERE {where}
    GROUP BY {column}
    ORDER BY count(*) DESC, {column} ASC
"""

_TIMESERIES_SQL = """
    SELECT
        strftime(created_at, '{bucket_format}') AS bucket_key,
        {group_key_expr} AS group_key,
        count(*) AS calls,
        sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
        sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
        quantile_disc(latency_ms, [0.5, 0.95]) AS latency_percentiles,
        coalesce(sum(input_tokens), 0) AS input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens,
        sum(cost_usd) AS cost_usd
    FROM src.inference_logs
    WHERE {where}
    GROUP BY bucket_key, group_key
"""


class AnalyticsEngineError(RuntimeError):
    """ANALYTICS_ENGINE misconfiguration or a DuckDB attach/query failure.
    Always raised, never caught-and-swallowed here — `app.core.errors`
    translates it to a 500 (FR4).
    """


def sqlite_file_path(database_url: str) -> str | None:
    """`sqlite:///./app.db` -> `./app.db`, resolved relative to the backend
    working directory (matching SQLAlchemy's own resolution of the same
    URL). Returns None for anything DuckDB cannot attach this way: an
    in-memory SQLite URL (`sqlite://`, `sqlite:///:memory:`) or a
    non-SQLite URL (e.g. Postgres).
    """
    if not database_url.startswith("sqlite:///"):
        return None
    path = database_url.removeprefix("sqlite:///")
    if not path or path == ":memory:":
        return None
    return path


def should_use_duckdb() -> bool:
    """Per-request engine selection (FR2). Evaluated fresh on every call —
    cheap, and honors env changes without restart-order concerns.
    """
    engine = settings.ANALYTICS_ENGINE
    if engine == AnalyticsEngine.SQLITE:
        return False

    file_path = sqlite_file_path(settings.DATABASE_URL)
    if engine == AnalyticsEngine.DUCKDB:
        if file_path is None:
            logger.error(
                "ANALYTICS_ENGINE=duckdb requires a file-based SQLite DATABASE_URL, got %r",
                settings.DATABASE_URL,
            )
            raise AnalyticsEngineError(
                "ANALYTICS_ENGINE=duckdb requires a file-based SQLite DATABASE_URL, got "
                f"{settings.DATABASE_URL!r}"
            )
        return True

    return file_path is not None  # auto


def _escape_literal(value: str) -> str:
    return value.replace("'", "''")


@contextmanager
def _connect(file_path: str) -> Iterator[duckdb.DuckDBPyConnection]:
    con = duckdb.connect(database=":memory:")
    try:
        con.execute("INSTALL sqlite")
        con.execute("LOAD sqlite")
        con.execute(f"ATTACH '{_escape_literal(file_path)}' AS src (TYPE sqlite, READ_ONLY)")
        yield con
    finally:
        con.close()


def _naive_utc(value: datetime) -> datetime:
    """The app stores naive-UTC datetime text; a tz-aware filter bound
    as-is would shift the window edges by the datetime's own offset once
    DuckDB compares it against the naive TIMESTAMP column.
    """
    if value.tzinfo is not None:
        return value.astimezone(UTC).replace(tzinfo=None)
    return value


def _build_where(
    *,
    window_from: datetime | None,
    window_to: datetime | None,
    conversation_id: int | None,
    status: str | None,
    call_type: str | None,
    model: str | None,
    provider: str | None,
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if window_from is not None:
        clauses.append("created_at >= ?")
        params.append(_naive_utc(window_from))
    if window_to is not None:
        clauses.append("created_at < ?")
        params.append(_naive_utc(window_to))
    if conversation_id is not None:
        clauses.append("conversation_id = ?")
        params.append(conversation_id)
    if status is not None:
        clauses.append("status = ?")
        params.append(status)
    if call_type is not None:
        clauses.append("call_type = ?")
        params.append(call_type)
    if model is not None:
        clauses.append("model = ?")
        params.append(model)
    if provider is not None:
        clauses.append("provider = ?")
        params.append(provider)
    where_sql = " AND ".join(clauses) if clauses else "TRUE"
    return where_sql, params


def _to_decimal(value: float | None) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _run_query(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any]) -> Any:
    try:
        return con.execute(sql, params)
    except duckdb.Error as exc:
        logger.error("DuckDB query failed (sql=%r params=%r): %s", sql, params, exc)
        raise AnalyticsEngineError(f"DuckDB query failed: {exc}") from exc


def _run_group_query(
    con: duckdb.DuckDBPyConnection, column: str, where_sql: str, params: list[Any]
) -> list[GroupRow]:
    from app.repositories.ingest import GroupRow

    sql = _GROUP_SQL.format(column=column, where=where_sql)
    rows = _run_query(con, sql, params).fetchall()
    return [
        GroupRow(
            key=key,
            calls=calls,
            error_count=error_count or 0,
            input_tokens=input_tokens or 0,
            output_tokens=output_tokens or 0,
            cost_sum=_to_decimal(cost_sum),
            cost_count=cost_count or 0,
        )
        for key, calls, error_count, input_tokens, output_tokens, cost_sum, cost_count in rows
    ]


def stats(
    *,
    window_from: datetime | None = None,
    window_to: datetime | None = None,
    conversation_id: int | None = None,
    status: str | None = None,
    call_type: str | None = None,
    model: str | None = None,
    provider: str | None = None,
) -> StatsRow:
    from app.repositories.ingest import StatsRow

    file_path = sqlite_file_path(settings.DATABASE_URL)
    assert file_path is not None  # guaranteed by should_use_duckdb()

    where_sql, params = _build_where(
        window_from=window_from,
        window_to=window_to,
        conversation_id=conversation_id,
        status=status,
        call_type=call_type,
        model=model,
        provider=provider,
    )

    with _connect(file_path) as con:
        headline = _run_query(con, _STATS_SQL.format(where=where_sql), params).fetchone()
        by_model = _run_group_query(con, "model", where_sql, params)
        by_provider = _run_group_query(con, "provider", where_sql, params)
        by_call_type = _run_group_query(con, "call_type", where_sql, params)
        by_status = _run_group_query(con, "status", where_sql, params)

    (
        total_calls,
        success_count,
        error_count,
        cancelled_count,
        input_tokens,
        output_tokens,
        cost_sum,
        cost_count,
        ttft_count,
        latency_avg_ms,
        latency_max_ms,
        latency_percentiles,
        ttft_avg_ms,
        ttft_max_ms,
        ttft_percentiles,
    ) = headline

    latency_p50_ms = latency_p95_ms = latency_p99_ms = None
    if latency_percentiles is not None:
        latency_p50_ms, latency_p95_ms, latency_p99_ms = latency_percentiles

    ttft_p50_ms = ttft_p95_ms = ttft_p99_ms = None
    if ttft_percentiles is not None:
        ttft_p50_ms, ttft_p95_ms, ttft_p99_ms = ttft_percentiles

    return StatsRow(
        total_calls=total_calls,
        success_count=success_count or 0,
        error_count=error_count or 0,
        cancelled_count=cancelled_count or 0,
        input_tokens=input_tokens or 0,
        output_tokens=output_tokens or 0,
        cost_sum=_to_decimal(cost_sum),
        cost_count=cost_count or 0,
        ttft_count=ttft_count or 0,
        latency_avg_ms=latency_avg_ms,
        latency_max_ms=latency_max_ms,
        latency_p50_ms=latency_p50_ms,
        latency_p95_ms=latency_p95_ms,
        latency_p99_ms=latency_p99_ms,
        ttft_avg_ms=ttft_avg_ms,
        ttft_max_ms=ttft_max_ms,
        ttft_p50_ms=ttft_p50_ms,
        ttft_p95_ms=ttft_p95_ms,
        ttft_p99_ms=ttft_p99_ms,
        by_model=by_model,
        by_provider=by_provider,
        by_call_type=by_call_type,
        by_status=by_status,
    )


def timeseries(
    *,
    bucket: str,
    group_by: str,
    window_from: datetime,
    window_to: datetime,
    conversation_id: int | None = None,
    status: str | None = None,
    call_type: str | None = None,
    model: str | None = None,
    provider: str | None = None,
) -> list[BucketRow]:
    """One scan of the window (single GROUP BY statement, bucket + group),
    mirroring the SQLAlchemy path's "one scan" shape — see that method's
    docstring in `app.repositories.ingest`. `quantile_disc` replaces the
    Python-side nearest-rank pass; verified (see spec 018) to match it
    exactly, including the n=1/n=2/small-n-p99 boundaries.
    """
    from app.repositories.ingest import BucketRow

    file_path = sqlite_file_path(settings.DATABASE_URL)
    assert file_path is not None  # guaranteed by should_use_duckdb()

    where_sql, params = _build_where(
        window_from=window_from,
        window_to=window_to,
        conversation_id=conversation_id,
        status=status,
        call_type=call_type,
        model=model,
        provider=provider,
    )

    group_column = _GROUP_COLUMNS.get(group_by)
    group_key_expr = group_column if group_column is not None else "'all'"
    sql = _TIMESERIES_SQL.format(
        bucket_format=_BUCKET_FORMATS[bucket],
        group_key_expr=group_key_expr,
        where=where_sql,
    )

    with _connect(file_path) as con:
        rows = _run_query(con, sql, params).fetchall()

    result = []
    for (
        bucket_key,
        group_key,
        calls,
        error_count,
        cancelled_count,
        latency_percentiles,
        input_tokens,
        output_tokens,
        cost_usd,
    ) in rows:
        latency_p50_ms = latency_p95_ms = None
        if latency_percentiles is not None:
            latency_p50_ms, latency_p95_ms = latency_percentiles
        result.append(
            BucketRow(
                bucket_key=bucket_key,
                group_key=group_key,
                calls=calls,
                error_count=error_count or 0,
                cancelled_count=cancelled_count or 0,
                latency_p50_ms=latency_p50_ms,
                latency_p95_ms=latency_p95_ms,
                input_tokens=input_tokens or 0,
                output_tokens=output_tokens or 0,
                cost_usd=_to_decimal(cost_usd),
            )
        )
    return result
