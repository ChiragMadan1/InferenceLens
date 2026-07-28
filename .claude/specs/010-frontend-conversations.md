# 010 — Frontend: Conversation List

Depends on: backend spec **001-conversations**. Blocks: **011-frontend-chat**.

## Problem statement

The backend can create and list conversations, but there is no UI. The
scaffold's `App.tsx` renders only a health check and `api.ts` has only
`checkHealth`. A user needs to open the app, see their conversations
ordered by recent activity, start a new one, and open an existing one to
resume it.

This spec builds the **app shell** (which view is on screen) and the
**conversation list view**, plus the `api.ts` foundation — the shared
error helper and the conversation types/functions — that spec 011 reuses.
It does **not** build the chat view; selecting a conversation renders a
placeholder that 011 replaces.

## Functional requirements

1. **FR1** — On app load the conversation list view is shown, fetching
   `GET /conversations?limit=20&offset=0`.
2. **FR2** — Conversations render as a vertical list, one row each,
   showing `title` and `updated_at`, in the order the backend returned
   them (`updated_at DESC`). The frontend does not re-sort.
3. **FR3** — While the first (or a subsequent) fetch is in flight, the
   list area shows a "Loading conversations…" indicator and the
   pagination controls are disabled.
4. **FR4** — When the list is empty (`total === 0`), the list area shows
   an empty state: "No conversations yet. Click 'New conversation' to
   start one." The "New conversation" button remains enabled.
5. **FR5** — When the fetch fails, the list area shows the error message
   from the API helper plus a "Retry" button that re-runs the same
   fetch with the same `limit`/`offset`.
6. **FR6** — A "New conversation" button calls `createConversation()`
   with no title (server applies the default `"New conversation"`).
   On success the app immediately switches to the chat view for the
   returned `id`. The list is **not** re-fetched at this point — the
   navigation supersedes it.
7. **FR7** — While `createConversation` is in flight the button is
   disabled and reads "Creating…". On failure the button re-enables and
   the error message is shown above the list; the view stays on the list.
8. **FR8** — Clicking a conversation row switches to the chat view for
   that conversation's `id` (resume — design doc Flow 3).
9. **FR9** — A "Refresh" button in the list header re-fetches the current
   page (same `limit`/`offset`). This is the manual refresh path by which
   an auto-generated title (backend spec 008) becomes visible.
10. **FR10** — Returning from the chat view to the list re-fetches the
    first page (`offset=0`). Implemented by App.tsx rendering the list
    component **only** when `selectedConversationId === null`, so the
    component unmounts on navigate-in and its mount effect refetches on
    navigate-back. This is the second path by which a new auto-title
    appears.
11. **FR11** — Pagination: "Prev" and "Next" buttons under the list,
    stepping `offset` by `limit` (fixed at 20). "Prev" is disabled when
    `offset === 0`; "Next" is disabled when `offset + limit >= total`.
    A label shows `Showing {offset + 1}–{offset + items.length} of {total}`,
    hidden when `total === 0`.
12. **FR12** — A conversation whose `title` is still the literal default
    `"New conversation"` renders in a muted colour with the suffix
    "(untitled)" so the user knows the auto-title has not landed yet.
13. **FR13** — All backend calls go through typed functions in
    `src/api.ts`. No `fetch` appears in any component (CLAUDE.md rule).

## Non-functional requirements

- No new npm dependencies. No router, no UI library, no CSS framework,
  no state-management library. React `useState`/`useEffect` only.
- Styling matches the existing scaffold: inline `style={{…}}` objects,
  `fontFamily: 'sans-serif'`, ~24px page padding.
- No polling, no websockets, no auto-refresh timers (CLAUDE.md
  out-of-scope default). Every data refresh is user- or
  navigation-triggered.
- `VITE_API_URL` remains the only configuration knob; `api.ts` keeps its
  existing `BASE_URL` fallback of `http://localhost:8000`.
- TypeScript `strict` stays on; no `any` in exported signatures.

## Data model

**No database changes.** This is a frontend-only spec — no SQLAlchemy
model, no Alembic migration, no backend file is touched.

### TypeScript types (in `src/api.ts`, mirroring backend Pydantic names)

```ts
export type Page<T> = {
  items: T[]
  total: number
  limit: number
  offset: number
}

export type ConversationStatus = 'active'

export type ConversationRead = {
  id: number
  title: string
  status: ConversationStatus
  created_at: string   // ISO-8601 from the backend
  updated_at: string
}

export type ConversationCreate = {
  title?: string | null
}
```

`ConversationCreate` is declared even though `createConversation` takes a
plain optional argument, so the request body shape stays name-matched to
the backend schema per CLAUDE.md.

### Error type (in `src/api.ts` — 011 reuses it unchanged)

```ts
export class ApiError extends Error {
  status: number   // HTTP status; 0 means the request never reached the server
  detail: string   // the backend's ErrorResponse.detail, or a fallback
  constructor(status: number, detail: string) { … }
}
```

### Component state shape

| Component | State | Notes |
|---|---|---|
| `App.tsx` | `selectedConversationId: number \| null` | `null` → list view; a number → chat view. The **only** navigation state in the app. |
| `ConversationList.tsx` | `page: Page<ConversationRead> \| null` | last successful response; `null` before the first load |
| | `offset: number` | current page offset; `limit` is a module constant `20` |
| | `loading: boolean` | list fetch in flight |
| | `error: string \| null` | list fetch failure message |
| | `creating: boolean` | `createConversation` in flight |
| | `createError: string \| null` | create failure message |

No state is lifted above these. `ConversationList` receives one prop:
`onOpen(id: number): void`.

## API contracts

All in `src/api.ts`. `BASE_URL` and `checkHealth` stay as they are.

### Shared request helper (defined here, reused by 011)

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T>
```

Behaviour, exactly:

1. `fetch(`${BASE_URL}${path}`, init)`. If `fetch` itself rejects
   (backend down, DNS, CORS), throw
   `new ApiError(0, 'Cannot reach the backend. Is it running?')`.
2. If `res.ok`: return `await res.json() as T`. For a `204`/empty body
   return `undefined as T` (no endpoint in v1 needs this, but the guard
   avoids a JSON parse throw).
3. If `!res.ok`: read the body as JSON (guarded by try/catch — an error
   page may not be JSON) and extract `detail`:
   - `detail` is a string → use it. This is the project's
     `ErrorResponse` shape from `app/core/errors.py`.
   - `detail` is an array (FastAPI's 422 validation shape) → use
     `'Invalid request.'`.
   - body unreadable or has no `detail` → use `HTTP ${res.status}`.
   Throw `new ApiError(res.status, detail)`.

Every exported function below is a thin typed wrapper over `request`.
Callers distinguish outcomes with `err instanceof ApiError && err.status === 404`
etc. — no string matching on messages.

### Functions

| Function | Backend endpoint | Signature |
|---|---|---|
| `createConversation` | `POST /conversations` | `(title?: string) => Promise<ConversationRead>` |
| `listConversations` | `GET /conversations` | `(limit: number, offset: number) => Promise<Page<ConversationRead>>` |
| `getConversation` | `GET /conversations/{id}` | `(id: number) => Promise<ConversationRead>` |

```ts
export async function createConversation(title?: string): Promise<ConversationRead> {
  const body: ConversationCreate = { title: title ?? null }
  return request<ConversationRead>('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function listConversations(limit: number, offset: number): Promise<Page<ConversationRead>> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return request<Page<ConversationRead>>(`/conversations?${qs}`)
}

export async function getConversation(id: number): Promise<ConversationRead> {
  return request<ConversationRead>(`/conversations/${id}`)
}
```

`getConversation` is unused by the list view; it exists because spec 011
uses it to render the conversation title in the chat header, and because
CLAUDE.md requires every backend endpoint to have a typed function. Do
not delete it as dead code.

## Constraints

- **No router.** Navigation is `selectedConversationId` in `App.tsx`.
  Accepted tradeoff, stated so nobody "fixes" it later: **no
  deep-linkable URLs** (you cannot bookmark or share a conversation),
  **the browser Back button does not return to the list** (it leaves the
  app), and a page reload always lands on the conversation list. Adding
  `react-router` is a deliberate future decision, not a drive-by change.
- No new npm dependencies at all — not for routing, styling, date
  formatting, or fetching.
- Timestamps are formatted with the platform `Intl`/`Date` API only:
  `new Date(c.updated_at).toLocaleString()`. No relative-time ("3 minutes
  ago") formatting — it needs either a dependency or a ticking timer, and
  a timer is a form of polling.
- The frontend never sorts, filters, or re-paginates client-side. The
  server's ordering and `Page` envelope are authoritative.
- `limit` is a module-level constant (20), not user-configurable.

## Error handling and edge cases

| # | Case | UI behaviour |
|---|---|---|
| 1 | Empty conversation list (`total === 0`) | Empty-state text (FR4). No pagination label, both paging buttons disabled. "New conversation" still enabled. |
| 2 | Backend unreachable (`fetch` rejects → `ApiError.status === 0`) | List area shows "Cannot reach the backend. Is it running?" plus a "Retry" button. Nothing is cleared — a previously loaded page stays rendered above the error if there was one. |
| 3 | `GET /conversations` returns 422 (bad `limit`/`offset`) | Should be unreachable — `limit` is a constant and `offset` only moves in `limit` steps from 0. If it happens, the generic error path (FR5) shows "Invalid request." and Retry. Treat as a bug, not a user-facing flow. |
| 4 | `createConversation` fails (any status, incl. 0) | Button re-enables, `createError` renders above the list in red, view stays on the list, no navigation. |
| 5 | Double-clicking "New conversation" | The button is `disabled` while `creating === true`, so the second click is a no-op. No debounce logic, no second POST. |
| 6 | Opening a conversation that was deleted/never existed | v1 has no delete endpoint, so this only arises from a stale page. The list view does not pre-validate; the chat view (011) surfaces the 404 and offers "Back to conversations". |
| 7 | Title still the default `"New conversation"` | Rendered muted + "(untitled)" (FR12). Not an error. Auto-titling (008) is asynchronous; the title appears after a Refresh (FR9) or on returning from the chat view (FR10). |
| 8 | Very long title (auto-title misbehaves, or a future rename) | Row title is single-line with `overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'` so one row cannot break the layout. |
| 9 | "Next" clicked on the last page / rows deleted between fetches | Buttons are disabled at the boundaries (FR11). If a fetch still returns an out-of-range page, `items` is empty while `total > 0` → show "No conversations on this page." and enable "Prev". |
| 10 | A refresh returns fewer items than before, making the current `offset` past the end | Same as #9. The user clicks "Prev" or "Refresh"; no automatic offset correction (silent jumps are more confusing than an explicit empty page). |
| 11 | Overlapping fetches (rapid Refresh / Prev / Next clicks) | All fetch-triggering buttons are disabled while `loading === true`, so at most one list request is in flight. No request cancellation or sequence-number logic is needed. |

## Acceptance criteria

Verified **manually** against a running backend (`make backend`) and
frontend (`make frontend`) — the project has **no frontend test setup**
(no vitest, no jest, no testing-library) and this spec does not add one.

- [ ] Given the backend is running and has zero conversations, when the
      page loads, then the empty-state text appears and no rows render.
- [ ] Given zero conversations, when I click "New conversation", then a
      conversation is created (verify via `GET /conversations` in another
      tab) and the app switches to the chat view for it.
- [ ] Given the backend is **stopped**, when the page loads, then
      "Cannot reach the backend. Is it running?" and a "Retry" button
      appear — no blank screen, no console-only failure.
- [ ] Given the backend is stopped and the error is shown, when I start
      the backend and click "Retry", then the list loads normally.
- [ ] Given three conversations exist, when the page loads, then all
      three render newest-`updated_at` first, each showing its title and
      a formatted timestamp.
- [ ] Given a conversation whose title is still `"New conversation"`,
      when the list renders, then that row is muted and shows
      "(untitled)".
- [ ] Given a conversation was auto-titled by the backend after I loaded
      the list, when I click "Refresh", then the new title appears.
- [ ] Given I opened a conversation and then click back (011's control),
      when I land on the list, then the list has re-fetched (a title
      updated in the meantime is now visible).
- [ ] Given 25 conversations exist, when the page loads, then 20 rows
      render, "Showing 1–20 of 25" appears, "Prev" is disabled and "Next"
      is enabled; clicking "Next" shows the remaining 5, "Showing 21–25
      of 25", "Next" disabled, "Prev" enabled.
- [ ] Given the list is loading, when I look at the paging buttons and
      Refresh, then they are disabled.
- [ ] Given I double-click "New conversation" quickly, when it settles,
      then exactly **one** conversation was created.
- [ ] Given any row, when I click it, then the app switches views (a
      placeholder before 011 lands, the chat view after).
- [ ] `grep -rn "fetch(" frontend/src --include=*.tsx` returns nothing.

## Files to be changed

| File | Change | Purpose |
|---|---|---|
| `frontend/src/api.ts` | modify | Add `ApiError`, the private `request<T>` helper, `Page<T>`, `ConversationRead`, `ConversationCreate`, `ConversationStatus`, and the three conversation functions. Delete the scaffold's commented `createItem` example. Keep `BASE_URL` and `checkHealth`. |
| `frontend/src/App.tsx` | modify | Becomes the shell: holds `selectedConversationId`, renders `<ConversationList onOpen={setSelectedConversationId} />` when it is `null`, otherwise a placeholder ("Chat view — spec 011") with a "Back to conversations" button that sets it back to `null`. Drops the health-check UI. |
| `frontend/src/components/ConversationList.tsx` | **new** | The list view: fetching, loading/empty/error states, "New conversation", "Refresh", Prev/Next. |

**Justifying the new directory:** the scaffold has no `components/`, and
CLAUDE.md forbids premature abstraction. One file is added, not a
structure: `App.tsx` must stay a thin shell because 011 adds a second,
larger view (`ChatView.tsx`) alongside this one — two sibling views with
independent state in a single file is the harder thing to read. No
`index.ts` barrel, no shared `components/ui/` layer, no props
abstraction beyond `onOpen`.

**Not changed:** nothing under `backend/`. No frontend test file — the
project has no frontend test setup, and per CLAUDE.md tests are created
only via the `generate-tests` skill, which covers pytest only.

## Feature-specific rules

- **No router.** `selectedConversationId` in `App.tsx` is the navigation
  model. Do not add `react-router`, `wouter`, or hand-rolled
  `history.pushState` handling. Consequence (accepted): no deep links,
  no working browser Back.
- **Styling**: inline style objects matching the existing scaffold. No
  CSS framework, no UI component library, no CSS-in-JS library, no new
  `.css` file unless it is a single plain `index.css` — and prefer not
  to add one.
- **No polling / no auto-refresh / no websockets.** Data is refetched
  only on mount, on an explicit "Refresh" click, and on paging. The
  auto-generated title from backend spec 008 is expected to appear
  *later*, on the next such refresh; that latency is by design.
- **No log-viewing UI.** The `/logs` API is API-only in v1 (design doc
  Flow 6). Do not add a logs link, tab, or panel here.
- **No inline `fetch` in components** (CLAUDE.md). Every call goes
  through `src/api.ts`.
- **No new npm dependencies.** `package.json` must be unchanged by this
  spec.

## Open questions

- **Timestamp timezone.** Assumed the backend serialises `created_at` /
  `updated_at` as ISO-8601 strings that JavaScript's `Date` parses
  correctly. If spec 001 stores naive UTC datetimes, FastAPI serialises
  them **without** a `Z`/offset suffix and the browser will read them as
  *local* time, displaying a skew equal to the UTC offset. Assumed
  acceptable for a single-user demo; confirm before build — the fix is
  backend-side (timezone-aware columns), not a frontend workaround.
- **Page size.** Assumed a fixed `limit = 20` (the backend default) with
  no user control; confirm before build.
