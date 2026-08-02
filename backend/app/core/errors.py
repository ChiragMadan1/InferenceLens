import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from app.providers.base import ProviderError
from app.repositories.analytics_duckdb import AnalyticsEngineError
from app.schemas import ErrorResponse

logger = logging.getLogger(__name__)


def register_exception_handlers(app: FastAPI) -> None:
    """Central place for translating internal exceptions into clean API
    responses, per the "no raw DB errors" rule in CLAUDE.md. Add one
    handler per exception type you need to special-case — most routers
    should not need their own try/except for these.
    """

    @app.exception_handler(IntegrityError)
    async def integrity_error_handler(request: Request, exc: IntegrityError) -> JSONResponse:
        logger.error(
            "Integrity constraint violated on %s %s: %s", request.method, request.url.path, exc
        )
        return JSONResponse(
            status_code=409,
            content=ErrorResponse(detail="A conflicting record already exists.").model_dump(),
        )

    @app.exception_handler(ProviderError)
    async def provider_error_handler(request: Request, exc: ProviderError) -> JSONResponse:
        logger.error(
            "Provider call failed on %s %s: error_type=%s status_code=%s message=%s",
            request.method,
            request.url.path,
            exc.error_type,
            exc.status_code,
            exc.message,
        )
        return JSONResponse(
            status_code=502,
            content=ErrorResponse(
                detail=f"The model provider failed to respond ({exc.error_type})."
            ).model_dump(),
        )

    @app.exception_handler(AnalyticsEngineError)
    async def analytics_engine_error_handler(
        request: Request, exc: AnalyticsEngineError
    ) -> JSONResponse:
        logger.error("Analytics engine failure on %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(detail="The analytics query failed.").model_dump(),
        )
