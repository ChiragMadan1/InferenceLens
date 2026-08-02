"""register_exception_handlers is what CLAUDE.md's "never let a raw DB
error leak" rule is enforced by. Each handler is invoked directly here
(no TestClient, no route dispatch) to confirm it turns an internal
exception into the documented status code and ErrorResponse shape.
"""

import asyncio
import json

from sqlalchemy.exc import IntegrityError
from starlette.requests import Request

from app.main import app
from app.providers.base import ProviderError
from app.repositories.analytics_duckdb import AnalyticsEngineError


def _make_request() -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/logs",
        "headers": [],
        "query_string": b"",
        "server": ("testserver", 80),
        "scheme": "http",
    }
    return Request(scope)


def test_integrity_error_maps_to_409():
    handler = app.exception_handlers[IntegrityError]
    exc = IntegrityError("INSERT ...", {}, Exception("UNIQUE constraint failed"))

    response = asyncio.run(handler(_make_request(), exc))

    assert response.status_code == 409
    body = json.loads(response.body)
    assert body == {"detail": "A conflicting record already exists."}


def test_provider_error_maps_to_502():
    handler = app.exception_handlers[ProviderError]
    exc = ProviderError("timeout", "request timed out", status_code=None)

    response = asyncio.run(handler(_make_request(), exc))

    assert response.status_code == 502
    body = json.loads(response.body)
    assert "timeout" in body["detail"]


def test_analytics_engine_error_maps_to_500():
    handler = app.exception_handlers[AnalyticsEngineError]
    exc = AnalyticsEngineError("duckdb attach failed")

    response = asyncio.run(handler(_make_request(), exc))

    assert response.status_code == 500
    body = json.loads(response.body)
    assert body == {"detail": "The analytics query failed."}
