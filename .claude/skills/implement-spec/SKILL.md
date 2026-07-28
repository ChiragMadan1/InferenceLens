---
name: implement-spec
description: Implement a feature from a spec in .claude/specs in this project's canonical order - model, Alembic migration, schemas, router, lint (tests are separate, via generate-tests). Use whenever the user asks to build or implement a spec'd feature ("implement spec 003", "build the items feature"), has an approved spec or plan ready to execute, or asks to develop a backend feature in this repo.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(make:*), Bash(uv run:*), Bash(ls:*), AskUserQuestion, Skill
---

# Implement a feature spec

Build one spec'd feature in the order this stack demands. The order
matters because each layer depends on the previous one existing:
schemas reference model fields, routers reference schemas, tests
exercise routers — building out of order means rework.

**Backend only by default.** Do not touch `frontend/` unless the spec's
"Files to be changed" explicitly lists frontend files *and* the user
asked for UI work. If the spec implies UI but it wasn't requested, note
it as a follow-up in the final summary instead of building it.

## Input

A spec number or path. If none was given, `ls .claude/specs/` and ask
which one. If the directory is empty, say so and point at
`/generate-spec` — don't implement from vibes.

## Before writing any code

1. Read the spec end to end, plus `CLAUDE.md`.
2. If the spec's "Open questions" section has unresolved items that
   affect what you're about to build, surface them now via
   `AskUserQuestion` — an assumption baked into a migration is
   expensive to unwind later.
3. If this session already approved a plan for this feature (plan
   mode), that's the confirmation — proceed. Otherwise, per CLAUDE.md,
   state the plan briefly (model / endpoints / edge cases) and confirm
   before implementing.

## Build order

Work one logical piece at a time; after each piece, run what can be
run and fix failures before moving on.

1. **Model** — add/edit the SQLAlchemy model in `backend/app/models.py`
   per the spec's data model section. Use database-level constraints
   (unique, FK) for invariants that matter under concurrency.
2. **Migration** — `make db-revision message="<short description>"`,
   then run the `db-migration-check` skill (via the Skill tool) on the
   generated file before applying. Autogenerate is a starting point,
   not a guarantee. Only after it passes: `make db-upgrade`.
3. **Schemas** — request/response models in `backend/app/schemas.py`
   (`ConfigDict(from_attributes=True)` on read schemas). Every endpoint
   gets a request schema and a `response_model`; no raw dicts across
   the API boundary.
4. **Router** — `backend/app/routers/<resource>.py`, registered in
   `backend/app/main.py`. Validate parent entities exist before
   creating/updating children (404, not a raw DB error); let
   `IntegrityError` bubble to the central 409 handler in
   `app/core/errors.py` unless a more specific message is warranted.
5. **Lint** — `make lint`, fix anything it flags.

**No tests in this skill.** Do not write or run any tests here — test
generation and execution happen only through the `generate-tests`
skill, and only when the user invokes it. The spec's acceptance
criteria stay untouched in the spec; that skill turns them into pytest
cases later.

## Done means

- `make lint` passes — show its output, don't just claim it.
- Final summary calls out, per CLAUDE.md: behavior on null/empty
  input, behavior on duplicate/concurrent calls, and any tradeoff
  worth flagging — plus any spec items deliberately deferred
  (frontend, tests, open questions).
- Suggest next steps: `/generate-tests` to create and run tests for
  the new endpoints (when the user wants them), and `/commit`, which
  runs lint and a review pass on the staged changes before
  committing.
