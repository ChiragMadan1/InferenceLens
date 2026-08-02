from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.ingestion.service import build_log
from app.models import InferenceLog
from app.repositories.ingest import InferenceLogRepository
from app.schemas import InferenceLogEventIn, InferenceLogRead

router = APIRouter(prefix="/ingest", tags=["ingest"])


def get_ingest_repo(db: Session = Depends(get_db)) -> InferenceLogRepository:
    return InferenceLogRepository(db)


@router.post(
    "/logs", response_model=InferenceLogRead, status_code=201
)
def ingest_log(
    event: InferenceLogEventIn,
    repo: InferenceLogRepository = Depends(get_ingest_repo),
) -> InferenceLog:
    log = build_log(event)
    return repo.create(log)
