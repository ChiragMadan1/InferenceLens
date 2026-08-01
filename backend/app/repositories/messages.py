from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Message


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
