import math
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import InferenceLog
from app.repositories.ingest import BucketRow, GroupRow, InferenceLogRepository
from app.schemas import (
    BucketSize,
    CallType,
    InferenceLogRead,
    InferenceLogSummary,
    LatencyStats,
    LogGroupBy,
    LogGroupStat,
    LogStatsRead,
    LogStatus,
    LogTimeseriesRead,
    Page,
    TimeseriesPoint,
    TimeseriesSeries,
    TimeWindow,
    TokenStats,
)

router = APIRouter(prefix="/logs", tags=["logs"])

MAX_BUCKETS = 500
MAX_BREAKDOWN_ROWS = 10
MAX_SERIES = 8

_BUCKET_DELTAS = {
    BucketSize.MINUTE: timedelta(minutes=1),
    BucketSize.HOUR: timedelta(hours=1),
    BucketSize.DAY: timedelta(days=1),
}

_BUCKET_KEY_FORMATS = {
    BucketSize.MINUTE: "%Y-%m-%d %H:%M:00",
    BucketSize.HOUR: "%Y-%m-%d %H:00:00",
    BucketSize.DAY: "%Y-%m-%d 00:00:00",
}


def get_logs_repo(db: Session = Depends(get_db)) -> InferenceLogRepository:
    return InferenceLogRepository(db)


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _resolve_window(from_: datetime | None, to: datetime | None) -> tuple[datetime, datetime]:
    """FR2/edge case #7 — naive input is interpreted as UTC, not local time;
    the server always resolves and echoes the window rather than trusting
    the client's notion of "now".
    """
    resolved_to = _to_utc(to) if to is not None else datetime.now(UTC)
    resolved_from = _to_utc(from_) if from_ is not None else resolved_to - timedelta(hours=24)
    if resolved_from >= resolved_to:
        raise HTTPException(status_code=422, detail="from must be earlier than to")
    return resolved_from, resolved_to


def _floor_to_bucket(value: datetime, bucket: BucketSize) -> datetime:
    if bucket == BucketSize.MINUTE:
        return value.replace(second=0, microsecond=0)
    if bucket == BucketSize.HOUR:
        return value.replace(minute=0, second=0, microsecond=0)
    return value.replace(hour=0, minute=0, second=0, microsecond=0)


def _bucket_count(window_from: datetime, window_to: datetime, bucket: BucketSize) -> int:
    """Arithmetic count, not a loop — so an extreme window can be rejected by
    FR17 without ever materializing the (potentially huge) bucket list. Only
    call _bucket_starts() once this has been checked against MAX_BUCKETS.
    """
    delta = _BUCKET_DELTAS[bucket]
    start = _floor_to_bucket(window_from, bucket)
    return math.ceil((window_to - start).total_seconds() / delta.total_seconds())


def _bucket_starts(
    window_from: datetime, window_to: datetime, bucket: BucketSize
) -> list[datetime]:
    delta = _BUCKET_DELTAS[bucket]
    start = _floor_to_bucket(window_from, bucket)
    count = _bucket_count(window_from, window_to, bucket)
    return [start + i * delta for i in range(count)]


def _build_breakdown(
    repo: InferenceLogRepository,
    groups: list[GroupRow],
    dimension: str,
    base_filters: dict[str, str | int | None],
    window_from: datetime,
    window_to: datetime,
) -> list[LogGroupStat]:
    named = groups[:MAX_BREAKDOWN_ROWS]
    remainder = groups[MAX_BREAKDOWN_ROWS:]

    rows = []
    for group in named:
        group_filters = {**base_filters, dimension: group.key}
        latency_p95_ms = repo.latency_percentile(
            p=95, window_from=window_from, window_to=window_to, **group_filters
        )
        rows.append(
            LogGroupStat(
                key=group.key,
                is_other=False,
                calls=group.calls,
                error_count=group.error_count,
                error_rate=round(group.error_count / group.calls, 4) if group.calls else 0.0,
                latency_p95_ms=latency_p95_ms,
                input_tokens=group.input_tokens,
                output_tokens=group.output_tokens,
                cost_usd=group.cost_sum,
            )
        )

    if remainder:
        other_calls = sum(g.calls for g in remainder)
        other_errors = sum(g.error_count for g in remainder)
        other_input = sum(g.input_tokens for g in remainder)
        other_output = sum(g.output_tokens for g in remainder)
        other_cost_count = sum(g.cost_count for g in remainder)
        other_cost = (
            sum((g.cost_sum or Decimal(0)) for g in remainder) if other_cost_count else None
        )
        rows.append(
            LogGroupStat(
                key="other",
                is_other=True,
                calls=other_calls,
                error_count=other_errors,
                error_rate=round(other_errors / other_calls, 4) if other_calls else 0.0,
                latency_p95_ms=None,
                input_tokens=other_input,
                output_tokens=other_output,
                cost_usd=other_cost,
            )
        )
    return rows


def _fold_other_rows(rows: list[BucketRow]) -> dict[str, BucketRow]:
    """A percentile over the union of several groups is not a percentile of
    any of them (spec 014 rule #4), so folded points always carry null
    latency rather than a misleading merged value.
    """
    merged: dict[str, BucketRow] = {}
    for row in rows:
        existing = merged.get(row.bucket_key)
        if existing is None:
            merged[row.bucket_key] = BucketRow(
                bucket_key=row.bucket_key,
                group_key="other",
                calls=row.calls,
                error_count=row.error_count,
                cancelled_count=row.cancelled_count,
                latency_p50_ms=None,
                latency_p95_ms=None,
                input_tokens=row.input_tokens,
                output_tokens=row.output_tokens,
                cost_usd=row.cost_usd,
            )
        else:
            merged[row.bucket_key] = BucketRow(
                bucket_key=row.bucket_key,
                group_key="other",
                calls=existing.calls + row.calls,
                error_count=existing.error_count + row.error_count,
                cancelled_count=existing.cancelled_count + row.cancelled_count,
                latency_p50_ms=None,
                latency_p95_ms=None,
                input_tokens=existing.input_tokens + row.input_tokens,
                output_tokens=existing.output_tokens + row.output_tokens,
                cost_usd=(
                    (existing.cost_usd or Decimal(0)) + row.cost_usd
                    if row.cost_usd is not None
                    else existing.cost_usd
                ),
            )
    return merged


def _build_points(
    bucket_starts: list[datetime],
    bucket_key_format: str,
    rows_by_bucket_key: dict[str, BucketRow],
) -> list[TimeseriesPoint]:
    """FR15 — every bucket is emitted, including empty ones with null
    percentiles, so a sparse series never draws a chart line across a gap
    where no calls happened.
    """
    points = []
    for start in bucket_starts:
        row = rows_by_bucket_key.get(start.strftime(bucket_key_format))
        if row is None:
            points.append(
                TimeseriesPoint(
                    t=start,
                    calls=0,
                    error_count=0,
                    cancelled_count=0,
                    latency_p50_ms=None,
                    latency_p95_ms=None,
                    input_tokens=0,
                    output_tokens=0,
                    cost_usd=None,
                )
            )
        else:
            points.append(
                TimeseriesPoint(
                    t=start,
                    calls=row.calls,
                    error_count=row.error_count,
                    cancelled_count=row.cancelled_count,
                    latency_p50_ms=row.latency_p50_ms,
                    latency_p95_ms=row.latency_p95_ms,
                    input_tokens=row.input_tokens,
                    output_tokens=row.output_tokens,
                    cost_usd=row.cost_usd,
                )
            )
    return points


@router.get("", response_model=Page[InferenceLogSummary])
def list_logs(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    conversation_id: int | None = Query(default=None),
    status: LogStatus | None = Query(default=None),
    call_type: CallType | None = Query(default=None),
    model: str | None = Query(default=None),
    provider: str | None = Query(default=None),
    repo: InferenceLogRepository = Depends(get_logs_repo),
) -> Page[InferenceLogSummary]:
    logs, total = repo.list(
        limit=limit,
        offset=offset,
        conversation_id=conversation_id,
        status=status.value if status is not None else None,
        call_type=call_type.value if call_type is not None else None,
        model=model,
        provider=provider,
    )
    return Page(
        items=[InferenceLogSummary.from_log(log) for log in logs],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/stats", response_model=LogStatsRead)
def get_logs_stats(
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    conversation_id: int | None = Query(default=None),
    status: LogStatus | None = Query(default=None),
    call_type: CallType | None = Query(default=None),
    model: str | None = Query(default=None),
    provider: str | None = Query(default=None),
    repo: InferenceLogRepository = Depends(get_logs_repo),
) -> LogStatsRead:
    window_from, window_to = _resolve_window(from_, to)

    base_filters: dict[str, str | int | None] = {
        "conversation_id": conversation_id,
        "status": status.value if status is not None else None,
        "call_type": call_type.value if call_type is not None else None,
        "model": model,
        "provider": provider,
    }

    stats_row = repo.stats(window_from=window_from, window_to=window_to, **base_filters)

    total_calls = stats_row.total_calls
    error_rate = round(stats_row.error_count / total_calls, 4) if total_calls else 0.0
    cost_coverage = round(stats_row.cost_count / total_calls, 4) if total_calls else 0.0

    latency = None
    if total_calls:
        latency = LatencyStats(
            p50_ms=stats_row.latency_p50_ms,
            p95_ms=stats_row.latency_p95_ms,
            p99_ms=stats_row.latency_p99_ms,
            avg_ms=round(stats_row.latency_avg_ms),
            max_ms=stats_row.latency_max_ms,
        )

    ttft = None
    if stats_row.ttft_count:
        ttft = LatencyStats(
            p50_ms=stats_row.ttft_p50_ms,
            p95_ms=stats_row.ttft_p95_ms,
            p99_ms=stats_row.ttft_p99_ms,
            avg_ms=round(stats_row.ttft_avg_ms),
            max_ms=stats_row.ttft_max_ms,
        )

    return LogStatsRead(
        window=TimeWindow(from_=window_from, to=window_to),
        total_calls=total_calls,
        success_count=stats_row.success_count,
        error_count=stats_row.error_count,
        cancelled_count=stats_row.cancelled_count,
        error_rate=error_rate,
        latency=latency,
        ttft=ttft,
        tokens=TokenStats(
            input=stats_row.input_tokens,
            output=stats_row.output_tokens,
            total=stats_row.input_tokens + stats_row.output_tokens,
        ),
        cost_usd=stats_row.cost_sum,
        cost_coverage=cost_coverage,
        by_model=_build_breakdown(
            repo, stats_row.by_model, "model", base_filters, window_from, window_to
        ),
        by_provider=_build_breakdown(
            repo, stats_row.by_provider, "provider", base_filters, window_from, window_to
        ),
        by_call_type=_build_breakdown(
            repo, stats_row.by_call_type, "call_type", base_filters, window_from, window_to
        ),
        by_status=_build_breakdown(
            repo, stats_row.by_status, "status", base_filters, window_from, window_to
        ),
    )


@router.get("/timeseries", response_model=LogTimeseriesRead)
def get_logs_timeseries(
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    conversation_id: int | None = Query(default=None),
    status: LogStatus | None = Query(default=None),
    call_type: CallType | None = Query(default=None),
    model: str | None = Query(default=None),
    provider: str | None = Query(default=None),
    bucket: BucketSize = Query(default=BucketSize.HOUR),
    group_by: LogGroupBy = Query(default=LogGroupBy.NONE),
    repo: InferenceLogRepository = Depends(get_logs_repo),
) -> LogTimeseriesRead:
    window_from, window_to = _resolve_window(from_, to)

    bucket_count = _bucket_count(window_from, window_to, bucket)
    if bucket_count > MAX_BUCKETS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{bucket_count} buckets requested; the maximum is {MAX_BUCKETS}. "
                "Use a wider bucket or a shorter window."
            ),
        )
    bucket_starts = _bucket_starts(window_from, window_to, bucket)

    bucket_rows = repo.timeseries(
        bucket=bucket.value,
        group_by=group_by.value,
        window_from=window_from,
        window_to=window_to,
        conversation_id=conversation_id,
        status=status.value if status is not None else None,
        call_type=call_type.value if call_type is not None else None,
        model=model,
        provider=provider,
    )

    bucket_key_format = _BUCKET_KEY_FORMATS[bucket]

    if group_by == LogGroupBy.NONE:
        series_keys = ["all"]
        other_key_set: set[str] = set()
    else:
        totals: dict[str, int] = defaultdict(int)
        for row in bucket_rows:
            totals[row.group_key] += row.calls
        ordered_keys = sorted(totals, key=lambda k: (-totals[k], k))
        series_keys = ordered_keys[:MAX_SERIES]
        other_key_set = set(ordered_keys[MAX_SERIES:])

    series_key_set = set(series_keys)
    named_rows: dict[str, dict[str, BucketRow]] = defaultdict(dict)
    other_rows: list[BucketRow] = []
    for row in bucket_rows:
        if row.group_key in series_key_set:
            named_rows[row.group_key][row.bucket_key] = row
        elif row.group_key in other_key_set:
            other_rows.append(row)

    series = [
        TimeseriesSeries(
            key=key,
            is_other=False,
            points=_build_points(bucket_starts, bucket_key_format, named_rows.get(key, {})),
        )
        for key in series_keys
    ]
    if other_key_set:
        other_by_bucket = _fold_other_rows(other_rows)
        series.append(
            TimeseriesSeries(
                key="other",
                is_other=True,
                points=_build_points(bucket_starts, bucket_key_format, other_by_bucket),
            )
        )

    return LogTimeseriesRead(
        window=TimeWindow(from_=window_from, to=window_to),
        bucket=bucket,
        group_by=group_by,
        bucket_count=len(bucket_starts),
        series=series,
    )


@router.get("/{request_id}", response_model=InferenceLogRead)
def get_log(
    request_id: str,
    repo: InferenceLogRepository = Depends(get_logs_repo),
) -> InferenceLog:
    log = repo.get_by_request_id(request_id)
    if log is None:
        raise HTTPException(status_code=404, detail="Inference log not found")
    return log
