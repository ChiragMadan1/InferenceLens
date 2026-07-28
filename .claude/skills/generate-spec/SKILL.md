---
name: generate-spec
description: Generate an industry-standard feature spec from an input file (notes, a rough PRD, a ticket), asking clarifying questions for anything missing. Use when the user wants a feature spec'd out before building it, or invokes /generate-spec.
allowed-tools: Read, Grep, Glob, Write, Bash(mkdir:*), Bash(ls:*), AskUserQuestion
---

# Generate feature spec

Produce a tightly-scoped spec doc that becomes the source of truth for
building one feature. Optimize for a spec that's actually followed, not
exhaustive coverage — if the input describes something bigger than one
feature, say so and propose splitting it before writing, rather than
writing one bloated spec.

## Input

This skill needs a path to an input file (notes, a rough PRD, a ticket,
a paragraph — whatever the user has). If no path was given — as an
argument or earlier in the conversation — ask for one before doing
anything else; don't guess a default or proceed without it.

## Steps

1. **Read the input file.** If it doesn't exist at the given path, say
   so and stop.

2. **Research before asking anything:**
   - Read `CLAUDE.md` at the project root for this project's conventions
     (critical rules, narrowed stack, out-of-scope defaults). The spec
     must not contradict them — don't spec auth, rate limiting, caching,
     or realtime unless the input explicitly calls for it.
   - Glob `.claude/specs/*.md` and skim existing specs for overlap,
     naming precedent, and prior decisions this feature should stay
     consistent with. If a related spec exists, reference it explicitly
     rather than re-deciding something already decided.
   - Glob `.claude/designs/*.md` — if a design doc covers this feature
     (design docs often *are* the input file, via their feature
     breakdown section), treat its decisions as already made: confirm
     them, don't reopen them.
   - Skim the parts of the codebase this feature will actually touch:
     `backend/app/models.py` (existing entities/relationships it might
     extend), `backend/app/schemas.py` and `backend/app/routers/`
     (existing API patterns to stay consistent with),
     `backend/alembic/versions/` (schema history), `frontend/src/api.ts`
     and `frontend/src/App.tsx` (existing frontend patterns).

3. **Extract what the input already answers**, and diff that against the
   required sections below. At minimum, check for the same gaps CLAUDE.md
   already flags before any feature gets built: required vs. optional
   fields and defaults, cascade behavior on delete, pagination
   (needed now vs. explicitly deferred), denormalized vs. computed-live
   derived values — plus scope boundaries, non-functional requirements,
   and error/edge-case behavior.

4. **Interview the user — at least the top 10 questions.** Compile the
   ten (or more) most decision-relevant questions for *this specific
   feature* — subject- and context-specific, not a generic checklist.
   They earn a slot by changing what gets built: field
   requiredness/defaults, cascade behavior, uniqueness and concurrent
   calls, pagination, denormalized vs. computed values, lifecycle/state
   transitions, scope boundaries. Edge cases must be flagged explicitly
   as questions, phrased concretely ("what should happen when the
   parent is deleted while items still reference it?" — not "any edge
   cases?"). Where the input or design doc already implies an answer,
   pose it as confirm-or-correct rather than open-ended, so nothing is
   assumed silently. Use `AskUserQuestion` for multi-choice decisions
   (batch up to 4 per call, multiple rounds as needed); ask in text for
   open-ended ones. Do not silently default an unresolved unknown into
   the spec — any default you do choose (because the user said "your
   call") must be called out explicitly in the doc, not left implicit.

5. **Draft the spec** using the structure below.

6. **Save it** to `.claude/specs/<NNN>-<kebab-case-feature-name>.md`,
   where `NNN` is the next sequential 3-digit number after whatever
   already exists in `.claude/specs/` (start at `001`). Create the
   directory first if it doesn't exist.

7. **Report back**: the saved path, and a one-paragraph summary of
   what's now spec'd vs. what (if anything) is still open.

## Spec doc structure

```markdown
# <Feature Name>

## Problem statement
Tightly scoped: what specifically is being built, for whom, and why now.
State what's explicitly out of scope — as important as what's in.

## Functional requirements
Numbered, testable statements of behavior. What the system does, not
implementation detail.

## Non-functional requirements
Only what's actually relevant to this feature (performance, scale,
observability, security posture) — don't pad with boilerplate NFRs that
don't apply. Explicitly note anything from CLAUDE.md's "Out of scope by
default" that this feature is deliberately *not* adding, if it's a point
of likely ambiguity.

## Data model
New/changed SQLAlchemy models (`backend/app/models.py`) — fields, types,
required/optional, defaults, relationships, cascade behavior on delete.
Note the Alembic migration this implies.

## API contracts
Per endpoint: method, path, request schema, response schema (referencing
`backend/app/schemas.py` shapes), status codes including error cases,
and which router file it lives in.

## Constraints
Technical or business constraints shaping the design — existing schema,
the stack choices already locked in by CLAUDE.md, timeline, data volume
assumptions, etc.

## Error handling and edge cases
Concrete cases: null/empty input, duplicate/concurrent calls, missing
parent entity, boundary values — each mapped to the expected response
(404 for missing parent, 409 via IntegrityError for conflicts, etc., per
CLAUDE.md).

## Acceptance criteria
Given/when/then or a checklist, specific enough that "done" is
unambiguous and specific enough to become pytest cases directly.

## Files to be changed
Concrete file list with a one-line purpose each, e.g.:
- `backend/app/models.py` — add `Item` model
- `backend/alembic/versions/...` — migration (via `make db-revision`)
- `backend/app/schemas.py` — add `ItemCreate`, `ItemRead`
- `backend/app/routers/items.py` — new router
- `backend/app/main.py` — register router
- `backend/tests/test_items.py` — new tests (created only via the
  `generate-tests` skill, when the user invokes it)
- `frontend/src/api.ts` — new fetch functions
- `frontend/src/App.tsx` — UI wiring

## Feature-specific rules
Decisions specific to this feature only, not general CLAUDE.md
conventions — cross-reference CLAUDE.md rather than repeating it.

## Open questions
Anything genuinely still unresolved after clarification, with an
"assumed X, confirm before build" note — don't let ambiguity hide
silently in the spec.
```
