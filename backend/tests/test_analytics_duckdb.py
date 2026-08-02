"""should_use_duckdb decides, per request, whether GET /logs/stats and
GET /logs/timeseries run against SQLite or DuckDB (spec 018, FR2) — a bug
here silently switches the query engine app-wide. _escape_literal is the
only thing standing between a DATABASE_URL and a string-interpolated SQL
ATTACH statement, so it's worth pinning directly even though it's tiny.
"""

import pytest

from app.core.config import AnalyticsEngine
from app.repositories import analytics_duckdb
from app.repositories.analytics_duckdb import (
    AnalyticsEngineError,
    _escape_literal,
    should_use_duckdb,
    sqlite_file_path,
)


def test_sqlite_file_path_in_memory_returns_none():
    assert sqlite_file_path("sqlite:///:memory:") is None


def test_sqlite_file_path_bare_sqlite_returns_none():
    assert sqlite_file_path("sqlite://") is None


def test_sqlite_file_path_non_sqlite_url_returns_none():
    assert sqlite_file_path("postgresql+psycopg://user:pass@host/db") is None


def test_sqlite_file_path_relative_file_path():
    assert sqlite_file_path("sqlite:///./app.db") == "./app.db"


def test_escape_literal_escapes_single_quotes():
    assert _escape_literal("app'; DROP TABLE inference_logs; --") == (
        "app''; DROP TABLE inference_logs; --"
    )


def test_escape_literal_no_quotes_unchanged():
    assert _escape_literal("./app.db") == "./app.db"


def test_should_use_duckdb_false_when_engine_forced_to_sqlite(monkeypatch):
    monkeypatch.setattr(analytics_duckdb.settings, "ANALYTICS_ENGINE", AnalyticsEngine.SQLITE)

    assert should_use_duckdb() is False


def test_should_use_duckdb_true_when_forced_and_file_based_url(monkeypatch):
    monkeypatch.setattr(analytics_duckdb.settings, "ANALYTICS_ENGINE", AnalyticsEngine.DUCKDB)
    monkeypatch.setattr(analytics_duckdb.settings, "DATABASE_URL", "sqlite:///./app.db")

    assert should_use_duckdb() is True


def test_should_use_duckdb_forced_but_in_memory_db_raises(monkeypatch):
    monkeypatch.setattr(analytics_duckdb.settings, "ANALYTICS_ENGINE", AnalyticsEngine.DUCKDB)
    monkeypatch.setattr(analytics_duckdb.settings, "DATABASE_URL", "sqlite:///:memory:")

    with pytest.raises(AnalyticsEngineError):
        should_use_duckdb()


def test_should_use_duckdb_auto_true_for_file_based_sqlite(monkeypatch):
    monkeypatch.setattr(analytics_duckdb.settings, "ANALYTICS_ENGINE", AnalyticsEngine.AUTO)
    monkeypatch.setattr(analytics_duckdb.settings, "DATABASE_URL", "sqlite:///./app.db")

    assert should_use_duckdb() is True


def test_should_use_duckdb_auto_false_for_in_memory_sqlite(monkeypatch):
    monkeypatch.setattr(analytics_duckdb.settings, "ANALYTICS_ENGINE", AnalyticsEngine.AUTO)
    monkeypatch.setattr(analytics_duckdb.settings, "DATABASE_URL", "sqlite:///:memory:")

    assert should_use_duckdb() is False
