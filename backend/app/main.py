from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.errors import register_exception_handlers
from app.core.logging import setup_logging
from app.core.observability import close_observability, init_observability
from app.routers import conversations, ingest, logs, messages
from app.schemas import HealthResponse


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    init_observability()
    yield
    await close_observability()


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_exception_handlers(app)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


app.include_router(conversations.router)
app.include_router(messages.router)
app.include_router(ingest.router)
app.include_router(logs.router)
