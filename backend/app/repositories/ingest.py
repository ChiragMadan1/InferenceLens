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
