---
name: design-doc
description: Produce an industry-standard requirement & design doc (problem statement, scope, FR/NFR, data model, APIs, user flows, edge cases, error handling) from a raw product idea, ending with an ordered feature breakdown that feeds /generate-spec. Use whenever the user describes a new project, product, or multi-feature capability, asks for a design doc, PRD, requirements doc, or HLD, or wants to plan work before splitting it into specs — even if they don't say "design doc" explicitly.
allowed-tools: Read, Grep, Glob, Write, Bash(mkdir:*), Bash(ls:*), AskUserQuestion
---

# Generate design doc

Produce the project-level requirement & design doc that sits *above*
feature specs: one doc that captures the whole problem, then breaks it
into small, ordered features — each sized to become one
`/generate-spec` spec and one implementation pass. This doc is where
cross-feature decisions get made once, so individual specs never have
to re-litigate them.

## Input

An idea from the conversation, or a path to a notes/PRD file. If
neither exists yet, ask what's being built before doing anything else.

## Steps

1. **Research before asking anything:**
   - Read `CLAUDE.md` at the project root. The stack is locked (FastAPI
     + SQLAlchemy + SQLite + Alembic, React + Vite frontend) and auth,
     rate limiting, caching, and realtime are out of scope by default —
     the design must work within that, and must call out explicitly if
     it genuinely needs an exception (that's a project-level decision
     for the user, not a default to reach for).
   - Glob `.claude/designs/*.md` and `.claude/specs/*.md` for prior
     decisions this design should stay consistent with.
   - Skim `backend/app/models.py` and `backend/app/routers/` for what
     already exists that this design extends or must not break.

2. **Interview the user — at least the top 10 questions.** Compile the
   ten (or more) highest-leverage questions for *this specific idea* —
   context-specific, not a generic checklist. A question earns a slot
   because its answer changes the design. Cover at minimum:
   - Who the users/actors are and what each can do.
   - Core entities, their relationships, and which are
     required vs. optional.
   - Cascade behavior on delete (delete children, orphan, or block).
   - Uniqueness rules and what happens on duplicate/concurrent actions.
   - Expected data volumes (drives the pagination call per CLAUDE.md's
     ~1k-row default).
   - Lifecycle/state transitions, if entities have states.
   - Scope confirmations: anything from CLAUDE.md's out-of-scope
     defaults that the user might be silently assuming (e.g. "no login
     — correct?").
   - Edge cases, flagged explicitly and phrased concretely ("what
     should happen when X is deleted while Y still references it?" —
     never "any edge cases?").
   - What "done" looks like — success criteria.

   Use `AskUserQuestion` for multi-choice decisions (up to 4 per call,
   multiple rounds as needed); plain text for open-ended ones. Batch
   rather than trickle. Where the input already implies an answer, pose
   it as confirm-or-correct — nothing gets assumed silently.

3. **Draft the doc** using the structure below. Every unresolved answer
   lands in Open questions, not in a silent assumption.

4. **Save it** to `.claude/designs/<kebab-case-name>.md`, creating the
   directory if needed.

5. **Report back**: the saved path, a one-paragraph summary, and the
   recommended next step — run `/generate-spec` with this design doc as
   the input file, starting with feature breakdown item 1.

## Doc structure

```markdown
# <Name> — Design Doc

## Problem statement
What's being built, for whom, and why now. Tightly scoped.

## Scope
**In scope:** ...
**Out of scope:** ... (including CLAUDE.md defaults deliberately not
built — auth, rate limiting, caching, realtime — listed explicitly so
no one wonders later whether they were forgotten)

## Users and user flows
Each actor and their key flows, step by step ("user creates X, sees Y,
can then Z"). Flows are what specs and tests get derived from — be
concrete.

## Functional requirements
Numbered, testable statements of behavior.

## Non-functional requirements
Only ones that actually apply (data volume, latency expectations,
observability). Don't pad with boilerplate NFRs.

## Data model
Entities, fields (required/optional, defaults), relationships, cascade
behavior on delete, uniqueness constraints. Enough detail that specs
can reference it; migrations come per-feature via Alembic.

## API surface
One table: method, path, purpose, request/response schema names.
Details live in each feature's spec — this is the map, not the
territory.

## Edge cases
Enumerated, each mapped to expected behavior — including the ones
surfaced during the interview.

## Error handling
How errors map to this project's conventions: 404 for missing parents,
409 via IntegrityError for conflicts, 422 for validation.

## Feature breakdown
Ordered list of small features, one line each, with dependencies noted
("003 needs 001's model"). Each item must be small enough for one
/generate-spec spec and one implementation pass — if an item needs the
word "and" twice, split it.

## Open questions
Anything still unresolved, with "assumed X, confirm before build".
```
