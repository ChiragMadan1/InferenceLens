import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db import get_db
from app.models import MessageRole
from app.providers import (
    ChatProvider,
    ProviderError,
    ProviderMessage,
    get_chat_provider,
)
from app.repositories.conversations import ConversationRepository
from app.repositories.messages import MessageRepository
from app.routers.conversations import get_conversation_repo
from app.schemas import ChatTurnRead, ErrorResponse, MessageCreate, MessageRead, Page, StreamChunk
from app.titling import generate_title, should_title

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["messages"])


def get_message_repo(db: Session = Depends(get_db)) -> MessageRepository:
    return MessageRepository(db)


@router.get("/{conversation_id}/messages", response_model=Page[MessageRead])
def list_messages(
    conversation_id: int,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    conversation_repo: ConversationRepository = Depends(get_conversation_repo),
    message_repo: MessageRepository = Depends(get_message_repo),
) -> Page[MessageRead]:
    if conversation_repo.get(conversation_id) is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages, total = message_repo.list(conversation_id, limit=limit, offset=offset)
    return Page(
        items=[MessageRead.model_validate(m) for m in messages],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/{conversation_id}/messages", response_model=ChatTurnRead)
async def send_message(
    conversation_id: int,
    body: MessageCreate,
    background_tasks: BackgroundTasks,
    conversation_repo: ConversationRepository = Depends(get_conversation_repo),
    message_repo: MessageRepository = Depends(get_message_repo),
    provider: ChatProvider = Depends(get_chat_provider),
) -> ChatTurnRead:
    conversation = conversation_repo.get(conversation_id)
    if conversation is None:
        raise HTTPException(
            status_code=404, detail=f"Conversation {conversation_id} not found."
        )

    user_message = message_repo.create(conversation_id, MessageRole.USER, body.content)

    window = message_repo.get_window(conversation_id, limit=10)
    provider_messages: list[ProviderMessage] = [
        {"role": m.role.value, "content": m.content} for m in window
    ]

    result = await provider.send_message(
        messages=provider_messages,
        system=settings.SYSTEM_PROMPT,
        model=settings.OPENAI_MODEL,
        max_tokens=settings.MAX_TOKENS,
        temperature=settings.TEMPERATURE,
        conversation_id=conversation_id,
    )

    if result.content.strip() == "":
        raise ProviderError("empty_response", "Provider returned no content.")

    assistant_message = message_repo.create_and_touch_conversation(
        conversation, MessageRole.ASSISTANT, result.content
    )

    try:
        assistant_count = message_repo.count_by_role(conversation_id, MessageRole.ASSISTANT)
        if should_title(assistant_count, conversation):
            background_tasks.add_task(
                generate_title,
                conversation_id=conversation.id,
                user_text=user_message.content,
                assistant_text=assistant_message.content,
            )
    except Exception:
        # A titling bug must never turn a successful chat into a 500: the
        # turn has already been stored and committed, so this is logged and
        # skipped, not raised.
        logger.exception(
            "should_title check failed for conversation %s; skipping title scheduling.",
            conversation_id,
        )

    return ChatTurnRead(
        user_message=MessageRead.model_validate(user_message),
        assistant_message=MessageRead.model_validate(assistant_message),
    )


# In-flight marker for the STREAMING endpoint only. This set only needs
# membership, never a Task to call .cancel() on — there is no cancellation
# feature anywhere in this project. A concurrent non-streaming send (the
# /messages endpoint above) and a streamed send to the same conversation are
# NOT mutually guarded in v1 — each endpoint only protects against
# concurrency with itself. Revisit if/when the two send paths need a shared
# guard.
# Process-local, in-memory, and empty on restart — not fixed here: single
# dev-server process, single user.
_streaming_inflight: set[int] = set()


def _sse_event(event: str, payload: BaseModel) -> str:
    return f"event: {event}\ndata: {payload.model_dump_json()}\n\n"


@router.post("/{conversation_id}/messages/stream")
async def stream_message(
    conversation_id: int,
    body: MessageCreate,
    background_tasks: BackgroundTasks,
    conversation_repo: ConversationRepository = Depends(get_conversation_repo),
    message_repo: MessageRepository = Depends(get_message_repo),
    provider: ChatProvider = Depends(get_chat_provider),
) -> StreamingResponse:
    # FR11 — 404/409 must resolve before a single byte streams: the HTTP
    # status is committed the instant StreamingResponse is returned, so
    # there is no way to "downgrade" a 200 once streaming has begun.
    conversation = conversation_repo.get(conversation_id)
    if conversation is None:
        raise HTTPException(
            status_code=404, detail=f"Conversation {conversation_id} not found."
        )

    # FR14 — checked and inserted before the user message is stored, so a
    # rejected send leaves no orphan row. No await between the membership
    # check and the insertion, so this check-then-act is safe within one
    # process.
    if conversation_id in _streaming_inflight:
        raise HTTPException(
            status_code=409,
            detail="A response is already being generated for this conversation.",
        )
    _streaming_inflight.add(conversation_id)

    user_message = message_repo.create(conversation_id, MessageRole.USER, body.content)

    window = message_repo.get_window(conversation_id, limit=10)
    provider_messages: list[ProviderMessage] = [
        {"role": m.role.value, "content": m.content} for m in window
    ]

    async def event_generator() -> AsyncIterator[str]:
        accumulated = ""
        saw_final_chunk = False
        try:
            async for chunk in provider.stream_message(
                messages=provider_messages,
                system=settings.SYSTEM_PROMPT,
                model=settings.OPENAI_MODEL,
                max_tokens=settings.MAX_TOKENS,
                temperature=settings.TEMPERATURE,
                conversation_id=conversation_id,
            ):
                # FR13 — stop accumulating once the final chunk (result
                # populated) has been seen; the loop is left to end naturally
                # afterward (StopAsyncIteration) rather than `break`ing early,
                # so the recorder's own generator (CallRecorder.invoke_stream)
                # runs its `finally` via normal exhaustion, not via a
                # GeneratorExit thrown in later at GC time, which would
                # otherwise get misclassified as a cancelled/errored call.
                if not saw_final_chunk and chunk.delta:
                    accumulated += chunk.delta
                    yield _sse_event("chunk", StreamChunk(delta=chunk.delta))
                if chunk.result is not None:
                    saw_final_chunk = True
        except ProviderError as exc:
            # FR15 — the central provider_error_handler (app/core/errors.py)
            # cannot fire here: the response status line was already sent as
            # 200 the instant StreamingResponse was returned. Same detail
            # string and log fields that handler would produce.
            logger.error(
                "Provider call failed on POST /conversations/%s/messages/stream: "
                "error_type=%s status_code=%s message=%s",
                conversation_id,
                exc.error_type,
                exc.status_code,
                exc.message,
            )
            yield _sse_event(
                "error",
                ErrorResponse(detail=f"The model provider failed to respond ({exc.error_type})."),
            )
            return
        finally:
            # FR20/open question — no request.is_disconnected() check: if the
            # client already closed the connection, whatever uvicorn/Starlette
            # does when a later `yield` tries to write to that socket is not
            # specially handled here. Not exercised against a real disconnect
            # during implementation (manual verification is the acceptance
            # criteria's job, per this spec) — if it turns out to raise here,
            # it propagates like any other exception; it is not swallowed.
            _streaming_inflight.discard(conversation_id)

        if accumulated.strip() == "":
            # Mirrors 004 FR13's empty_response handling, but as an SSE
            # event rather than a raised ProviderError — there is no HTTP
            # status left to change.
            yield _sse_event(
                "error",
                ErrorResponse(detail="The model provider failed to respond (empty_response)."),
            )
            return

        assistant_message = message_repo.create_and_touch_conversation(
            conversation, MessageRole.ASSISTANT, accumulated
        )

        try:
            assistant_count = message_repo.count_by_role(conversation_id, MessageRole.ASSISTANT)
            if should_title(assistant_count, conversation):
                background_tasks.add_task(
                    generate_title,
                    conversation_id=conversation.id,
                    user_text=user_message.content,
                    assistant_text=assistant_message.content,
                )
        except Exception:
            # A titling bug must never turn a successful streamed turn into
            # a broken one: the turn has already been stored and committed,
            # so this is logged and skipped, not raised.
            logger.exception(
                "should_title check failed for conversation %s; skipping title scheduling.",
                conversation_id,
            )

        yield _sse_event(
            "done",
            ChatTurnRead(
                user_message=MessageRead.model_validate(user_message),
                assistant_message=MessageRead.model_validate(assistant_message),
            ),
        )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        background=background_tasks,
    )
