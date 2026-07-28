---
name: generate-tests
description: Generate pytest tests for this project's endpoints from their specs and router handlers, then run them to green. This is the ONLY skill/context allowed to create or run tests in this repo - invoke it when the user asks to generate tests, add test coverage, run the test suite, or verify a feature with tests. Never write or run tests outside an invocation of this skill.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(make test:*), Bash(uv run pytest:*), Bash(ls:*), AskUserQuestion
---

# Generate and run tests

Turn specs and router handlers into pytest cases, then run them until
green. Testing in this project happens *only* here, on the user's
explicit invocation — no other skill or workflow writes test files or
runs `make test`/`pytest`. That keeps test generation a deliberate,
reviewable step instead of a side effect scattered across feature work.

## Input

Optionally a spec number, resource name, or test file. With no
argument, cover whatever currently lacks tests: compare
`backend/app/routers/` against `backend/tests/test_*.py` and list the
gaps, then confirm the target with the user if it's more than one
resource (one resource per pass keeps failures attributable).

## Steps

1. **Read the sources of truth, in priority order:**
   - The feature's spec in `.claude/specs/` — its acceptance criteria
     and "Error handling and edge cases" sections are written to
     become test cases directly. If a spec exists, every acceptance
     criterion becomes at least one test.
   - The actual handlers: `backend/app/routers/<resource>.py`,
     `backend/app/schemas.py`, `backend/app/models.py` — for the real
     status codes, response shapes, and constraints. Where the spec
     and the code disagree, flag the discrepancy to the user instead
     of silently testing whichever is easier to pass.
   - `backend/tests/conftest.py` — tests use its `client` fixture and
     the isolated in-memory DB; never touch the dev `app.db`, never
     add fixtures that bypass the schema reset.

2. **Write the tests** in `backend/tests/test_<resource>.py` (extend
   the file if it exists — don't duplicate existing cases). Coverage
   floor per endpoint, beyond the happy path:
   - **Duplicate/conflict**: repeating a unique-constrained create
     returns 409 (via the central IntegrityError handler).
   - **Missing parent**: referencing a nonexistent parent returns 404
     with a clear detail, not a raw DB error.
   - **Empty/null input**: missing required fields return 422; empty
     strings/lists behave per the spec.
   - **Not found**: GET/PUT/DELETE on a nonexistent id returns 404.
   - Any edge case the spec calls out that isn't covered above.
   Name tests after the behavior (`test_create_item_missing_parent_404`),
   assert on status code *and* response body shape, and keep each test
   independent — the schema resets between tests, so create your own
   fixtures inline.

3. **Run to green.** `make test` (or `uv run pytest
   tests/test_<resource>.py -v` from `backend/` while iterating). On
   failure, decide honestly which side is wrong: a test that encodes
   the spec correctly and fails means the *handler* has a bug — report
   it to the user rather than bending the test to match broken
   behavior.

4. **Report**: tests added (file and count), full `make test` output
   showing the final state, any spec/code discrepancies or handler
   bugs found, and anything deliberately not covered.
