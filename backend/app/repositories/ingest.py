from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session

from app.models import InferenceLog


class InferenceLogRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, log: InferenceLog) -> InferenceLog:
        self.db.add(log)
        self.db.commit()
        self.db.refresh(log)
        return log

    def list(
        self,
        limit: int,
        offset: int,
        conversation_id: int | None = None,
        status: str | None = None,
        call_type: str | None = None,
    ) -> tuple[list[InferenceLog], int]:
        filters: list[ColumnElement[bool]] = []
        if conversation_id is not None:
            filters.append(InferenceLog.conversation_id == conversation_id)
        if status is not None:
            filters.append(InferenceLog.status == status)
        if call_type is not None:
            filters.append(InferenceLog.call_type == call_type)

        total = self.db.scalar(
            select(func.count()).select_from(InferenceLog).where(*filters)
        )
        logs = self.db.scalars(
            select(InferenceLog)
            .where(*filters)
            .order_by(InferenceLog.created_at.desc(), InferenceLog.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return list(logs), total

    def get_by_request_id(self, request_id: str) -> InferenceLog | None:
        return self.db.scalar(
            select(InferenceLog).where(InferenceLog.request_id == request_id)
        )
