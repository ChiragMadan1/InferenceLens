from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Conversation, Message, MessageRole


class MessageRepository:
    def __init__(self, db: Session):
        self.db = db

    def list(
        self, conversation_id: int, limit: int, offset: int
    ) -> tuple[list[Message], int]:
        total = self.db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation_id)
        )
        messages = self.db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc(), Message.id.asc())
            .limit(limit)
            .offset(offset)
        ).all()
        return list(messages), total

    def get_window(self, conversation_id: int, limit: int = 10) -> list[Message]:
        rows = self.db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(limit)
        ).all()
        return list(reversed(rows))

    def create(self, conversation_id: int, role: MessageRole, content: str) -> Message:
        message = Message(conversation_id=conversation_id, role=role, content=content)
        self.db.add(message)
        self.db.commit()
        self.db.refresh(message)
        return message

    def create_and_touch_conversation(
        self, conversation: Conversation, role: MessageRole, content: str
    ) -> Message:
        message = Message(conversation_id=conversation.id, role=role, content=content)
        self.db.add(message)
        conversation.updated_at = datetime.now(UTC)
        self.db.commit()
        self.db.refresh(message)
        return message
