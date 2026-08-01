from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.pricing import compute_cost
from app.db import get_db
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
    cost = compute_cost(event.model, event.input_tokens, event.output_tokens)
    log = InferenceLog(**event.model_dump(), cost_usd=cost)
    return repo.create(log)
