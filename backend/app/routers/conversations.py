from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Conversation
from app.repositories.conversations import ConversationRepository
from app.schemas import ConversationCreate, ConversationRead, Page

router = APIRouter(prefix="/conversations", tags=["conversations"])


def get_conversation_repo(db: Session = Depends(get_db)) -> ConversationRepository:
    return ConversationRepository(db)


@router.post("", response_model=ConversationRead, status_code=201)
def create_conversation(
    payload: ConversationCreate,
    repo: ConversationRepository = Depends(get_conversation_repo),
) -> Conversation:
    return repo.create(payload.title)


@router.get("", response_model=Page[ConversationRead])
def list_conversations(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    repo: ConversationRepository = Depends(get_conversation_repo),
) -> Page[ConversationRead]:
    conversations, total = repo.list(limit=limit, offset=offset)
    return Page(
        items=[ConversationRead.model_validate(c) for c in conversations],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{conversation_id}", response_model=ConversationRead)
def get_conversation(
    conversation_id: int,
    repo: ConversationRepository = Depends(get_conversation_repo),
) -> Conversation:
    conversation = repo.get(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation
