"""
SQLAlchemy ORM table definitions go here.

Left intentionally empty — define models here once requirements for
the specific project are clear. Schema changes are tracked with Alembic
(see alembic/ and the "Database migrations" section in README.md):
after adding or changing a model, run `make db-revision message="..."`
then `make db-upgrade`.

Example shape for reference (delete once real models are added):

    from sqlalchemy.orm import Mapped, mapped_column
    from app.db import Base

    class Item(Base):
        __tablename__ = "items"

        id: Mapped[int] = mapped_column(primary_key=True)
        name: Mapped[str]
        created_by: Mapped[int]
"""
