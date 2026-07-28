---
name: postman-collection
description: Generate or refresh a Postman collection (v2.1 JSON) covering every backend endpoint, with realistic test data in request bodies and sample success/error responses, saved to backend/postman_collection.json. Use when the user asks for a Postman collection or API collection export, wants to manually test or demo the API, or after new routers/endpoints have been added and the collection needs regenerating.
allowed-tools: Read, Grep, Glob, Write, Bash(uv run:*), Bash(ls:*)
---

# Generate Postman collection

Produce one importable Postman Collection v2.1 JSON at
`backend/postman_collection.json` covering every registered endpoint,
with request bodies a human could send as-is and example responses
showing what success and each documented failure look like.

Always regenerate the whole file rather than hand-patching it — it's a
generated artifact, and partial edits drift from the actual API.

## Steps

1. **Dump the OpenAPI schema as ground truth.** Don't enumerate
   endpoints by reading router files — an unregistered router or a
   forgotten endpoint would silently go missing. The app itself knows
   its routes. From `backend/`:

       uv run python -c "import json; from app.main import app; print(json.dumps(app.openapi(), indent=2))" > <scratchpad>/openapi.json

   Every path+method in that file must appear in the collection
   (including `/health`); verify this before finishing.

2. **Read for realism.** Skim `backend/app/schemas.py`,
   `backend/app/models.py`, and `backend/app/routers/` to write example
   values that make domain sense (a project named "Q3 roadmap", not
   "string") and to know which endpoints can return 404 (missing
   parent), 409 (IntegrityError conflict), and 422 (validation) — those
   error shapes come from `app/core/errors.py` and FastAPI defaults.

3. **Build the collection** (v2.1 format):
   - `info`: `name` from the app title, `schema` set to
     `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`,
     a fresh UUID for `_postman_id`.
   - Collection-level `variable`: `baseUrl` defaulting to
     `http://localhost:8000` (what `make backend` serves). All request
     URLs use `{{baseUrl}}/...`; path parameters become Postman path
     variables (`:item_id`) with a sample value.
   - One folder per resource/router, requests ordered so a human can
     run top-to-bottom: create → list → get → update → delete, parents
     before children (so the FK sample values actually exist).
   - POST/PUT/PATCH requests: `body.mode = "raw"` with JSON matching
     the request schema — required fields present, realistic values,
     `Content-Type: application/json` header.
   - Each request's `response` array: one saved example for success
     (correct status code, body matching the `response_model` shape)
     plus one per meaningful error — 404 with the router's actual
     detail message, 409 with the generic conflict body from
     `errors.py`, 422 with FastAPI's validation shape — only where
     that endpoint can actually produce them.

4. **Write** to `backend/postman_collection.json` (overwrite if it
   exists — regeneration is the point).

5. **Validate before declaring done:**
   - It parses: `uv run python -c "import json; json.load(open('postman_collection.json'))"` from `backend/`.
   - Coverage: every `paths` entry in the OpenAPI dump has a matching
     request (a quick script comparing the two beats eyeballing).
   Report the endpoint count, folders created, and the file path.
