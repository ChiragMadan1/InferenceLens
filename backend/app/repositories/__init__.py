# One file per resource, e.g. items.py, users.py, comments.py.
# Each repository owns the SQLAlchemy queries for its resource, behind a
# class constructed with the request-scoped session:
#
#   class ItemRepository:
#       def __init__(self, db: Session):
#           self.db = db
#
#       def get(self, item_id: int) -> Item | None: ...
#
# Wire it into a router with its own Depends:
#
#   def get_item_repo(db: Session = Depends(get_db)) -> ItemRepository:
#       return ItemRepository(db)
