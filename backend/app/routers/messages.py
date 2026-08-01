from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.repositories.conversations import ConversationRepository
from app.repositories.messages import MessageRepository
from app.routers.conversations import get_conversation_repo
from app.schemas import MessageRead, Page

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
