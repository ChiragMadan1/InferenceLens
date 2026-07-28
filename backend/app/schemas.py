"""
Pydantic request/response schemas go here, separate from the SQLAlchemy
table models in models.py so API contracts can evolve independently of
the DB schema (e.g. hiding internal fields, shaping nested responses).

Every endpoint should declare a `response_model` and, for POST/PUT/PATCH,
a request body schema — don't accept or return raw dicts.

Example shape for reference (delete once real schemas are added):

    from pydantic import BaseModel, ConfigDict

    class ItemCreate(BaseModel):
        name: str
        created_by: int

    class ItemRead(BaseModel):
        model_config = ConfigDict(from_attributes=True)  # lets .model_validate(orm_obj) work

        id: int
        name: str
        created_by: int
"""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str


class ErrorResponse(BaseModel):
    detail: str
