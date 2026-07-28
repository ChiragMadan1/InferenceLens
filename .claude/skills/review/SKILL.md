---
name: review
description: Review all staged changes against this project's conventions before they're committed. Use when the user asks for a code review, wants staged changes checked, or invokes /review.
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Read, Grep, Glob
---

# Review staged changes

Review the currently staged changes (`git diff --staged`) — not the full
working tree, not unstaged edits. This is a pre-commit gate: the goal is
to catch real bugs and rule violations before they land, not to nitpick
style. The `commit` skill invokes this automatically before every
commit; it can also be run standalone via `/review`.

This skill produces a report and nothing else — it never edits files,
stages changes, or applies fixes, even for trivial findings. The
decision about what to do with the report belongs to the caller.

## Steps

1. Run `git status --short` and `git diff --staged` to see exactly
   what's staged. If nothing is staged, say so and stop — don't review
   unstaged or untracked files instead.
2. Read `CLAUDE.md` at the project root for this repo's conventions.
   Check the staged diff against it, in particular:
   - **Schema changes only via Alembic.** No `Base.metadata.create_all()`
     calls, raw `CREATE TABLE`, or other schema-mutating shortcuts. If
     `backend/app/models.py` changed, there should be a matching
     migration under `backend/alembic/versions/`.
   - **No raw dicts across the API boundary.** Every endpoint uses a
     Pydantic request schema and a `response_model`, from
     `backend/app/schemas.py`.
   - **Parent-existence validation.** Endpoints that create or reference
     a related entity 404 on a missing parent rather than letting a raw
     DB error surface.
   - **No swallowed exceptions.** Every `except` block logs with context
     and either re-raises or returns a clear error response. Flag bare
     `except:` or `except Exception: pass`.
   - **No secrets or generated artifacts staged.** `.env`, `app.db`,
     `.venv/`, `node_modules/`, `__pycache__/` should never appear in
     `git diff --staged --name-only`. If one does, flag it as a blocker
     regardless of anything else found.
   - **Test coverage is a reminder, not a blocker.** Tests are
     generated and run only via the `generate-tests` skill, when the
     user invokes it — so a new model/endpoint without a test is not a
     finding. If the diff *does* include tests, check they use the
     `client` fixture from `backend/tests/conftest.py`. Never run the
     test suite from this skill.
   - **No unrequested scope.** Auth, rate limiting, caching, or
     websockets/polling shouldn't appear unless the diff or commit
     context makes clear they were explicitly asked for.
   - **Single datastore.** No new dependency on a second database/cache
     — SQLite via SQLAlchemy is the only store this project uses.
3. Beyond convention-checking, review for actual correctness bugs: wrong
   logic, unhandled edge cases (null/empty input, duplicate/concurrent
   calls), off-by-one errors, type mismatches — and simplification/reuse
   opportunities (duplicated logic, premature abstraction).
4. Report findings ranked most-severe first, each classified as either
   a **blocker** (a critical-rule violation from CLAUDE.md, a
   correctness bug, or a staged secret/artifact) or a **suggestion**
   (improvement worth making but safe to defer). For each: file:line, a
   one-sentence description of the defect, and the concrete input/state
   that would trigger it. End with a one-line verdict: "N blockers, M
   suggestions" or "clean". If nothing survives scrutiny, say so
   plainly — don't invent nitpicks to seem thorough.
5. Do not edit any files. This skill reviews; `commit` (a separate
   skill) commits. If the user wants fixes applied, they'll ask.
