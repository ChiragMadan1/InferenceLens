from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import DEFAULT_CONVERSATION_TITLE, Conversation, ConversationStatus


class ConversationRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, title: str | None) -> Conversation:
        conversation = Conversation(
            title=title or DEFAULT_CONVERSATION_TITLE,
            status=ConversationStatus.ACTIVE,
        )
        self.db.add(conversation)
        self.db.commit()
        self.db.refresh(conversation)
        return conversation

    def list(self, limit: int, offset: int) -> tuple[list[Conversation], int]:
        total = self.db.scalar(select(func.count()).select_from(Conversation))
        conversations = self.db.scalars(
            select(Conversation)
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return list(conversations), total

    def get(self, conversation_id: int) -> Conversation | None:
        return self.db.get(Conversation, conversation_id)
