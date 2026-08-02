.PHONY: backend frontend consumer test lint install-backend install-frontend db-revision db-upgrade db-downgrade

install-backend:
	cd backend && uv sync

install-frontend:
	cd frontend && npm install

backend:
	cd backend && uv run uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# Standalone inference log consumer (EVENT_TRANSPORT=kafka only — see
# README.md "Kafka event pipeline (local dev)"). The FastAPI app also runs
# this consumer in-app when EVENT_TRANSPORT=kafka; this target is for
# running it as its own process instead/as well.
consumer:
	cd backend && uv run python -m app.ingestion.consumer

test:
	cd backend && uv run pytest -v

lint:
	cd backend && uv run ruff check .

# Usage: make db-revision message="add item table"
db-revision:
	cd backend && uv run alembic revision --autogenerate -m "$(message)"

db-upgrade:
	cd backend && uv run alembic upgrade head

db-downgrade:
	cd backend && uv run alembic downgrade -1
