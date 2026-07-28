---
name: db-migration-check
description: Review the newest Alembic migration for known autogenerate failure modes (destructive renames, SQLite ALTER limitations, NOT NULL without server_default, broken downgrade) and roundtrip-test it on a throwaway database before it touches real data. Use right after `make db-revision`, before any `make db-upgrade`, whenever a migration file was just generated or hand-edited, or when the user asks to check, verify, or review a migration.
allowed-tools: Read, Grep, Glob, Bash(ls:*), Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(env:*), Bash(uv run:*)
---

# Check an Alembic migration

Alembic autogenerate diffs `Base.metadata` against the DB and guesses.
On SQLite the guesses fail in specific, well-known ways — and a bad
migration that reaches `app.db` can destroy data. This skill catches
those failures while the migration is still just a file.

This skill reports; it does not edit the migration. If findings need
fixing, present them and apply fixes only if the user agrees.

## Steps

1. **Find the migration.** Newest file in `backend/alembic/versions/`
   (`ls -t`). Confirm it's the intended one by checking its
   `down_revision` points at the previous head. Read the whole file —
   both `upgrade()` and `downgrade()`.

2. **Get the intent.** `git diff backend/app/models.py` (or `git diff
   HEAD` if already staged) to see the model change that prompted this
   migration. Every operation in `upgrade()` should trace back to
   something in that diff — operations that don't are red flags.

3. **Check for the known autogenerate failure modes:**
   - **Renames seen as drop + add.** Autogenerate cannot detect
     renames: a renamed column/table appears as `drop_column` +
     `add_column`, which silently destroys the data in it. If the
     model diff shows a rename, the migration must use
     `op.alter_column(..., new_column_name=...)` (in batch mode for
     SQLite) instead.
   - **Unexpected destructive ops.** Any `drop_table`, `drop_column`,
     or `drop_index` not clearly implied by the model diff is a
     blocker until explained.
   - **NOT NULL column added to an existing table without
     `server_default`.** Works on an empty dev DB, fails the moment
     the table has rows. Require a `server_default` (or a nullable-
     then-backfill-then-tighten sequence) for any non-nullable
     `add_column`.
   - **SQLite ALTER limitations.** SQLite can't do most `ALTER TABLE`
     ops (alter column type/nullability, add/drop constraints)
     directly — they need `op.batch_alter_table` (table-rebuild).
     Note: this project's `alembic/env.py` does **not** set
     `render_as_batch=True`, so autogenerate will emit plain
     `op.alter_column(...)` calls that fail at upgrade time on
     SQLite. Flag any such op; either the migration gets rewritten
     with `batch_alter_table` or (better, once) `render_as_batch=True`
     gets added to both `context.configure(...)` calls in `env.py`.
   - **Unnamed constraints.** Without a naming convention, SQLite
     constraints end up unnamed and can't be dropped by a later
     migration. Flag anonymous unique/FK constraints in new tables.
   - **Missing or asymmetric `downgrade()`.** An empty `pass` or a
     downgrade that doesn't mirror the upgrade makes
     `make db-downgrade` a trap.
   - **Data migrations autogenerate can't write.** If the model
     change implies moving/backfilling data (split column, new
     denormalized field), autogenerate produced only the schema half —
     the data half must be added by hand.

4. **Roundtrip on a throwaway DB.** Never test on the dev `app.db`.
   `DATABASE_URL` is read via pydantic-settings, so an environment
   variable overrides `.env`. From `backend/`, with a scratch path:

       env DATABASE_URL=sqlite:///<scratchpad>/migration_check.db uv run alembic upgrade head
       env DATABASE_URL=sqlite:///<scratchpad>/migration_check.db uv run alembic downgrade -1
       env DATABASE_URL=sqlite:///<scratchpad>/migration_check.db uv run alembic upgrade head

   All three must succeed. This catches SQLite ALTER failures and
   broken downgrades deterministically — the checklist above catches
   the data-loss cases a green roundtrip can't see (an empty DB
   happily "succeeds" at dropping a column that would have had data).

5. **Report.** Findings ranked most-severe first, each with the
   concrete failure it would cause ("upgrade fails on any table with
   rows", "silently drops the `email` data"). End with a verdict:
   **safe to `make db-upgrade`** or **fix first**. If clean, say so
   plainly.
