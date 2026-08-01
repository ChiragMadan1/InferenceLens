from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import InferenceLog
from app.repositories.ingest import InferenceLogRepository
from app.schemas import CallType, InferenceLogRead, InferenceLogSummary, LogStatus, Page

router = APIRouter(prefix="/logs", tags=["logs"])


def get_logs_repo(db: Session = Depends(get_db)) -> InferenceLogRepository:
    return InferenceLogRepository(db)


@router.get("", response_model=Page[InferenceLogSummary])
def list_logs(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    conversation_id: int | None = Query(default=None),
    status: LogStatus | None = Query(default=None),
    call_type: CallType | None = Query(default=None),
    repo: InferenceLogRepository = Depends(get_logs_repo),
) -> Page[InferenceLogSummary]:
    logs, total = repo.list(
        limit=limit,
        offset=offset,
        conversation_id=conversation_id,
        status=status.value if status is not None else None,
        call_type=call_type.value if call_type is not None else None,
    )
    return Page(
        items=[InferenceLogSummary.from_log(log) for log in logs],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{request_id}", response_model=InferenceLogRead)
def get_log(
    request_id: str,
    repo: InferenceLogRepository = Depends(get_logs_repo),
) -> InferenceLog:
    log = repo.get_by_request_id(request_id)
    if log is None:
        raise HTTPException(status_code=404, detail="Inference log not found")
    return log
