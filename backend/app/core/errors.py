import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

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
