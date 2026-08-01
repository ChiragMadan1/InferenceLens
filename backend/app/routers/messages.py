import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db import get_db
from app.models import MessageRole
from app.providers import ChatProvider, ProviderError, ProviderMessage, get_chat_provider
from app.repositories.conversations import ConversationRepository
from app.repositories.messages import MessageRepository
from app.routers.conversations import get_conversation_repo
from app.schemas import ChatTurnRead, MessageCreate, MessageRead, Page
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
