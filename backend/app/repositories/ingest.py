import logging
import math
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import InstrumentedAttribute, Session

from app.models import InferenceLog
from app.repositories import analytics_duckdb
from app.schemas import percentile

logger = logging.getLogger(__name__)

_BUCKET_FORMATS: dict[str, str] = {
    "minute": "%Y-%m-%d %H:%M:00",
    "hour": "%Y-%m-%d %H:00:00",
    "day": "%Y-%m-%d 00:00:00",
}

_GROUP_COLUMNS: dict[str, InstrumentedAttribute[str]] = {
    "status": InferenceLog.status,
    "model": InferenceLog.model,
    "provider": InferenceLog.provider,
    "call_type": InferenceLog.call_type,
}


@dataclass
class GroupRow:
    key: str
    calls: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_sum: Decimal | None
    cost_count: int


@dataclass
class StatsRow:
    total_calls: int
    success_count: int
    error_count: int
    cancelled_count: int
    input_tokens: int
    output_tokens: int
    cost_sum: Decimal | None
    cost_count: int
    ttft_count: int
    latency_avg_ms: float | None
    latency_max_ms: int | None
    latency_p50_ms: int | None
    latency_p95_ms: int | None
    latency_p99_ms: int | None
    ttft_avg_ms: float | None
    ttft_max_ms: int | None
    ttft_p50_ms: int | None
    ttft_p95_ms: int | None
    ttft_p99_ms: int | None
    by_model: list[GroupRow]
    by_provider: list[GroupRow]
    by_call_type: list[GroupRow]
    by_status: list[GroupRow]


@dataclass
class BucketRow:
    bucket_key: str
    group_key: str
    calls: int
    error_count: int
    cancelled_count: int
    latency_p50_ms: int | None
    latency_p95_ms: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal | None


class InferenceLogRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, log: InferenceLog) -> InferenceLog:
        self.db.add(log)
        self.db.commit()
        self.db.refresh(log)
        return log

    def create_many_skip_duplicates(self, logs: list[InferenceLog]) -> tuple[int, int]:
        """Batch insert with per-row duplicate handling: each row gets its
        own SAVEPOINT so one `request_id` collision doesn't roll back the
        whole batch, and redelivery (at-least-once) results in zero new
        rows for already-stored events. One commit per batch. Returns
        (inserted, skipped).
        """
        inserted = 0
        skipped = 0
        for log in logs:
            try:
                with self.db.begin_nested():
                    self.db.add(log)
            except IntegrityError:
                skipped += 1
            else:
                inserted += 1
        self.db.commit()
        return inserted, skipped

    def _filters(
        self,
        *,
        window_from: datetime | None = None,
        window_to: datetime | None = None,
        conversation_id: int | None = None,
        status: str | None = None,
        call_type: str | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> list[ColumnElement[bool]]:
        filters: list[ColumnElement[bool]] = []
        if window_from is not None:
            filters.append(InferenceLog.created_at >= window_from)
        if window_to is not None:
            filters.append(InferenceLog.created_at < window_to)
        if conversation_id is not None:
            filters.append(InferenceLog.conversation_id == conversation_id)
        if status is not None:
            filters.append(InferenceLog.status == status)
        if call_type is not None:
            filters.append(InferenceLog.call_type == call_type)
        if model is not None:
            filters.append(InferenceLog.model == model)
        if provider is not None:
            filters.append(InferenceLog.provider == provider)
        return filters

    def list(
        self,
        limit: int,
        offset: int,
        conversation_id: int | None = None,
        status: str | None = None,
        call_type: str | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> tuple[list[InferenceLog], int]:
        filters = self._filters(
            conversation_id=conversation_id,
            status=status,
            call_type=call_type,
            model=model,
            provider=provider,
        )

        total = self.db.scalar(
            select(func.count()).select_from(InferenceLog).where(*filters)
        )
        logs = self.db.scalars(
            select(InferenceLog)
            .where(*filters)
            .order_by(InferenceLog.created_at.desc(), InferenceLog.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return list(logs), total

    def get_by_request_id(self, request_id: str) -> InferenceLog | None:
        return self.db.scalar(
            select(InferenceLog).where(InferenceLog.request_id == request_id)
        )

    def _percentile(
        self,
        column: InstrumentedAttribute[Any],
        p: float,
        filters: list[ColumnElement[bool]],
    ) -> int | None:
        col_filters = [*filters, column.isnot(None)]
        count = self.db.scalar(
            select(func.count()).select_from(InferenceLog).where(*col_filters)
        )
        if not count:
            return None
        k = min(max(math.ceil(p / 100 * count) - 1, 0), count - 1)
        return self.db.scalar(
            select(column).where(*col_filters).order_by(column).limit(1).offset(k)
        )

    def latency_percentile(
        self,
        *,
        p: float,
        window_from: datetime | None = None,
        window_to: datetime | None = None,
        conversation_id: int | None = None,
        status: str | None = None,
        call_type: str | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> int | None:
        filters = self._filters(
            window_from=window_from,
            window_to=window_to,
            conversation_id=conversation_id,
            status=status,
            call_type=call_type,
            model=model,
            provider=provider,
        )
        return self._percentile(InferenceLog.latency_ms, p, filters)

    def _group_query(
        self, column: InstrumentedAttribute[str], filters: list[ColumnElement[bool]]
    ) -> list[GroupRow]:
        rows = self.db.execute(
            select(
                column.label("key"),
                func.count().label("calls"),
                func.sum(case((InferenceLog.status == "error", 1), else_=0)).label(
                    "error_count"
                ),
                func.coalesce(func.sum(InferenceLog.input_tokens), 0).label("input_tokens"),
                func.coalesce(func.sum(InferenceLog.output_tokens), 0).label("output_tokens"),
                func.sum(InferenceLog.cost_usd).label("cost_sum"),
                func.count(InferenceLog.cost_usd).label("cost_count"),
            )
            .where(*filters)
            .group_by(column)
            .order_by(func.count().desc(), column.asc())
        ).all()
        return [
            GroupRow(
                key=row.key,
                calls=row.calls,
                error_count=row.error_count or 0,
                input_tokens=row.input_tokens or 0,
                output_tokens=row.output_tokens or 0,
                cost_sum=row.cost_sum,
                cost_count=row.cost_count or 0,
            )
            for row in rows
        ]

    def stats(
        self,
        *,
        window_from: datetime | None = None,
        window_to: datetime | None = None,
        conversation_id: int | None = None,
        status: str | None = None,
        call_type: str | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> StatsRow:
        if analytics_duckdb.should_use_duckdb():
            logger.debug("GET /logs/stats: analytics engine=duckdb")
            return analytics_duckdb.stats(
                window_from=window_from,
                window_to=window_to,
                conversation_id=conversation_id,
                status=status,
                call_type=call_type,
                model=model,
                provider=provider,
            )
        logger.debug("GET /logs/stats: analytics engine=sqlite")

        filters = self._filters(
            window_from=window_from,
            window_to=window_to,
            conversation_id=conversation_id,
            status=status,
            call_type=call_type,
            model=model,
            provider=provider,
        )

        headline = self.db.execute(
            select(
                func.count().label("total_calls"),
                func.sum(case((InferenceLog.status == "success", 1), else_=0)).label(
                    "success_count"
                ),
                func.sum(case((InferenceLog.status == "error", 1), else_=0)).label(
                    "error_count"
                ),
                func.sum(case((InferenceLog.status == "cancelled", 1), else_=0)).label(
                    "cancelled_count"
                ),
                func.coalesce(func.sum(InferenceLog.input_tokens), 0).label("input_tokens"),
                func.coalesce(func.sum(InferenceLog.output_tokens), 0).label("output_tokens"),
                func.sum(InferenceLog.cost_usd).label("cost_sum"),
                func.count(InferenceLog.cost_usd).label("cost_count"),
                func.count(InferenceLog.time_to_first_token_ms).label("ttft_count"),
                func.avg(InferenceLog.latency_ms).label("latency_avg_ms"),
                func.max(InferenceLog.latency_ms).label("latency_max_ms"),
                func.avg(InferenceLog.time_to_first_token_ms).label("ttft_avg_ms"),
                func.max(InferenceLog.time_to_first_token_ms).label("ttft_max_ms"),
            ).where(*filters)
        ).one()

        total_calls = headline.total_calls or 0
        ttft_count = headline.ttft_count or 0

        latency_p50_ms = latency_p95_ms = latency_p99_ms = None
        if total_calls:
            latency_p50_ms = self._percentile(InferenceLog.latency_ms, 50, filters)
            latency_p95_ms = self._percentile(InferenceLog.latency_ms, 95, filters)
            latency_p99_ms = self._percentile(InferenceLog.latency_ms, 99, filters)

        ttft_p50_ms = ttft_p95_ms = ttft_p99_ms = None
        if ttft_count:
            ttft_p50_ms = self._percentile(InferenceLog.time_to_first_token_ms, 50, filters)
            ttft_p95_ms = self._percentile(InferenceLog.time_to_first_token_ms, 95, filters)
            ttft_p99_ms = self._percentile(InferenceLog.time_to_first_token_ms, 99, filters)

        return StatsRow(
            total_calls=total_calls,
            success_count=headline.success_count or 0,
            error_count=headline.error_count or 0,
            cancelled_count=headline.cancelled_count or 0,
            input_tokens=headline.input_tokens or 0,
            output_tokens=headline.output_tokens or 0,
            cost_sum=headline.cost_sum,
            cost_count=headline.cost_count or 0,
            ttft_count=ttft_count,
            latency_avg_ms=headline.latency_avg_ms,
            latency_max_ms=headline.latency_max_ms,
            latency_p50_ms=latency_p50_ms,
            latency_p95_ms=latency_p95_ms,
            latency_p99_ms=latency_p99_ms,
            ttft_avg_ms=headline.ttft_avg_ms,
            ttft_max_ms=headline.ttft_max_ms,
            ttft_p50_ms=ttft_p50_ms,
            ttft_p95_ms=ttft_p95_ms,
            ttft_p99_ms=ttft_p99_ms,
            by_model=self._group_query(InferenceLog.model, filters),
            by_provider=self._group_query(InferenceLog.provider, filters),
            by_call_type=self._group_query(InferenceLog.call_type, filters),
            by_status=self._group_query(InferenceLog.status, filters),
        )

    def timeseries(
        self,
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
        """One scan of the window, ordered by bucket/group/latency, then the
        nearest-rank percentile function applied per (bucket, group) — see
        spec 014's "Percentile definition". `strftime` bucketing is confined
        to this method; porting to another database means replacing this one
        expression, not chasing date arithmetic across the codebase.
        """
        if analytics_duckdb.should_use_duckdb():
            logger.debug("GET /logs/timeseries: analytics engine=duckdb")
            return analytics_duckdb.timeseries(
                bucket=bucket,
                group_by=group_by,
                window_from=window_from,
                window_to=window_to,
                conversation_id=conversation_id,
                status=status,
                call_type=call_type,
                model=model,
                provider=provider,
            )
        logger.debug("GET /logs/timeseries: analytics engine=sqlite")

        filters = self._filters(
            window_from=window_from,
            window_to=window_to,
            conversation_id=conversation_id,
            status=status,
            call_type=call_type,
            model=model,
            provider=provider,
        )

        bucket_expr = func.strftime(_BUCKET_FORMATS[bucket], InferenceLog.created_at).label(
            "bucket_key"
        )
        group_col = _GROUP_COLUMNS.get(group_by)

        columns: list[Any] = [bucket_expr]
        if group_col is not None:
            columns.append(group_col.label("group_key"))
        columns.extend(
            [
                InferenceLog.status,
                InferenceLog.latency_ms,
                InferenceLog.input_tokens,
                InferenceLog.output_tokens,
                InferenceLog.cost_usd,
            ]
        )

        order_by = [bucket_expr]
        if group_col is not None:
            order_by.append(group_col)
        order_by.append(InferenceLog.latency_ms)

        rows = self.db.execute(select(*columns).where(*filters).order_by(*order_by)).all()

        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            group_key = row.group_key if group_col is not None else "all"
            acc = grouped.setdefault(
                (row.bucket_key, group_key),
                {
                    "calls": 0,
                    "error_count": 0,
                    "cancelled_count": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cost_sum": None,
                    "latencies": [],
                },
            )
            acc["calls"] += 1
            if row.status == "error":
                acc["error_count"] += 1
            elif row.status == "cancelled":
                acc["cancelled_count"] += 1
            acc["input_tokens"] += row.input_tokens or 0
            acc["output_tokens"] += row.output_tokens or 0
            if row.cost_usd is not None:
                acc["cost_sum"] = (acc["cost_sum"] or Decimal(0)) + row.cost_usd
            acc["latencies"].append(row.latency_ms)

        return [
            BucketRow(
                bucket_key=bucket_key,
                group_key=group_key,
                calls=acc["calls"],
                error_count=acc["error_count"],
                cancelled_count=acc["cancelled_count"],
                latency_p50_ms=percentile(acc["latencies"], 50),
                latency_p95_ms=percentile(acc["latencies"], 95),
                input_tokens=acc["input_tokens"],
                output_tokens=acc["output_tokens"],
                cost_usd=acc["cost_sum"],
            )
            for (bucket_key, group_key), acc in grouped.items()
        ]
