"""InferenceLogRepository.create_many_skip_duplicates is what makes
at-least-once Kafka delivery safe (spec 017): redelivering an already-
stored request_id must add zero rows, and one bad row in a batch must not
roll back its siblings. Exercised here against a real in-memory SQLite
session — no FastAPI app/router in the loop, so this is a repository-level
unit test, not an HTTP integration test.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import InferenceLog
from app.repositories.ingest import InferenceLogRepository


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = session_factory()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


def _make_log(request_id: str, **overrides) -> InferenceLog:
    defaults = dict(
        request_id=request_id,
        schema_version=1,
        conversation_id=1,
        call_type="chat",
        model="gpt-5.6-terra",
        provider="openai",
        status="success",
        latency_ms=100,
        input_messages=[{"role": "user", "content": "hi"}],
        requested_at=datetime.now(UTC),
    )
    defaults.update(overrides)
    return InferenceLog(**defaults)


def test_create_many_skip_duplicates_all_new_rows_inserted(db_session: Session):
    repo = InferenceLogRepository(db_session)
    logs = [_make_log("a"), _make_log("b"), _make_log("c")]

    inserted, skipped = repo.create_many_skip_duplicates(logs)

    assert (inserted, skipped) == (3, 0)
    assert repo.get_by_request_id("a") is not None
    assert repo.get_by_request_id("b") is not None
    assert repo.get_by_request_id("c") is not None


def test_create_many_skip_duplicates_skips_already_stored_request_id(db_session: Session):
    repo = InferenceLogRepository(db_session)
    repo.create(_make_log("existing"))

    inserted, skipped = repo.create_many_skip_duplicates(
        [_make_log("existing"), _make_log("new-1"), _make_log("new-2")]
    )

    assert (inserted, skipped) == (2, 1)
    assert repo.get_by_request_id("new-1") is not None
    assert repo.get_by_request_id("new-2") is not None


def test_create_many_skip_duplicates_within_same_batch(db_session: Session):
    repo = InferenceLogRepository(db_session)

    inserted, skipped = repo.create_many_skip_duplicates(
        [_make_log("dup"), _make_log("dup"), _make_log("unique")]
    )

    assert (inserted, skipped) == (2, 1)
    assert repo.get_by_request_id("unique") is not None


def test_get_by_request_id_missing_returns_none(db_session: Session):
    repo = InferenceLogRepository(db_session)

    assert repo.get_by_request_id("does-not-exist") is None
