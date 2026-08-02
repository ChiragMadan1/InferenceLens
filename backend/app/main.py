import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import EventTransport, settings
from app.core.errors import register_exception_handlers
from app.core.logging import setup_logging
from app.core.observability import close_observability, init_observability
from app.ingestion.consumer import InferenceLogConsumer
from app.routers import conversations, ingest, logs, messages
from app.schemas import HealthResponse


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    await init_observability()

    consumer_task: asyncio.Task[None] | None = None
    if settings.EVENT_TRANSPORT == EventTransport.KAFKA:
        consumer = InferenceLogConsumer(
            bootstrap_servers=settings.KAFKA_BOOTSTRAP_SERVERS,
            topic=settings.KAFKA_TOPIC,
            group_id=settings.KAFKA_CONSUMER_GROUP,
            max_records=settings.KAFKA_CONSUMER_MAX_RECORDS,
            batch_timeout_ms=settings.KAFKA_CONSUMER_BATCH_TIMEOUT_MS,
        )
        consumer_task = asyncio.create_task(consumer.run())

    yield

    if consumer_task is not None:
        consumer_task.cancel()
        with suppress(asyncio.CancelledError):
            await consumer_task
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
