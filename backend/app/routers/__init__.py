# One file per resource, e.g. items.py, users.py, comments.py.
# Each router file should own its own prefix and tag, and take the
# session as a dependency:
#
#   from fastapi import APIRouter, Depends
#   from sqlalchemy.orm import Session
#   from app.db import get_db
#
#   router = APIRouter(prefix="/items", tags=["items"])
#
#   @router.get("", response_model=list[schemas.ItemRead])
#   def list_items(db: Session = Depends(get_db)): ...
#
# Register in main.py with app.include_router(items.router) once
# the feature is implemented.
