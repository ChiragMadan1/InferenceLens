# 009 — Frontend: Foundation, App Shell & Conversations

Depends on: backend spec **001-conversations**.
Blocks: **010-frontend-chat**, **015-frontend-logs**.

> **This spec supersedes the original 009.** The original committed to zero npm
> dependencies, no router, inline `style={{…}}` objects, and no logs UI. Those
> commitments were reversed as an explicit project-level decision (CLAUDE.md's
> "Stack" section: a genuine need is a decision to make explicitly). What
> replaces them is recorded in "Stack decisions" below. Nothing else about the
> backend contracts changed.

## Problem statement

The backend can create and list conversations; the frontend is still the Vite
scaffold — one `App.tsx` rendering a health check, an `api.ts` with one
`fetch`. There is no design system, no navigation model, no loading or error
vocabulary, and no place to put a second or third screen.

Three screens are coming: conversations, chat (010), and an inference-log
dashboard (015). Building them on inline styles and a `selectedId` boolean
would mean three inconsistent visual languages and no deep links. So this
spec builds the **foundation** — dependencies, design tokens, router, app
shell, shared hooks and UI primitives, motion and loading vocabulary — and
then the first screen that uses it: the **conversation rail and conversations
index page**.

**In scope:** dependency additions; the token layer and its light/dark
themes; typography; the router and its route table; the app shell (desktop
rail / mobile drawer, header, theme toggle, the *signal ribbon* signature);
the shared `api.ts` foundation (`ApiError`, `request<T>`, `Page<T>`,
conversation types and functions); shared hooks; the shared UI primitive set;
the motion and loading-state specification that 010 and 015 inherit; the
conversation rail; the conversations index page.

**Out of scope:** the chat page (010 — this spec routes to it and renders a
placeholder), the logs dashboard and any chart code (015), streaming (012),
message rendering of any kind, auth, and the backend (no file under
`backend/` is touched).

## Stack decisions

Four runtime dependencies are added. Each earns its place; nothing else is
added by this spec or by 010.

| Package | Why this, and why not hand-rolled |
|---|---|
| `react-router-dom` ^6 | Three screens with deep-linkable, shareable URLs and a working browser Back button. Hand-rolling `history.pushState` for a nested layout route with a `:id` param and a 404 is strictly worse than the library. |
| `tailwindcss` ^4 + `@tailwindcss/vite` | A single token layer (`@theme`) consumed identically by three screens, with variants for dark mode, hover, focus-visible, and breakpoints. Inline style objects cannot express `:focus-visible`, media queries, or a shared scale. v4's CSS-first config means the design system **is** one file, not a JS object. |
| `framer-motion` ^11 | Enter/exit animation (`AnimatePresence`) and shared-layout transitions are not expressible in CSS without unmount hacks. It reads `prefers-reduced-motion` natively via `MotionConfig`. |
| `recharts` ^2 | **Installed by spec 015, not this one.** Listed here so the total dependency budget is visible in one place. |

Deliberately **not** added: TanStack Query (data fetching is hand-rolled
hooks — see "Shared hooks"), a component library (shadcn/Radix/MUI), a date
library, an icon package, a state-management library, a markdown renderer, a
form library, a test runner.

**Fonts** are loaded from Google Fonts via `<link rel="preconnect">` +
`<link rel="stylesheet">` in `index.html` with `display=swap`. This is the
one place the spec knowingly takes the convenient option over the
production-correct one: self-hosting via `@fontsource-variable/*` would
remove a render-blocking third-party request and a privacy dependency. It is
three more packages and is recorded as the documented hardening step, not as
a v1 requirement. Flagged in "Open questions".

## Functional requirements

### Routing and shell

1. **FR1** — The app is routed with `react-router-dom` using
   `createBrowserRouter`. The route table is exactly:

   | Path | Element | Rail |
   |---|---|---|
   | `/` | `ConversationsIndexPage` | visible |
   | `/c/:conversationId` | `ChatPage` (spec 010; placeholder until then) | visible |
   | `/logs` | `LogsDashboardPage` (spec 015; placeholder until then) | hidden |
   | `/logs/:requestId` | `LogDetailPage` (spec 015; placeholder until then) | hidden |
   | `*` | `NotFoundPage` | visible |

2. **FR2** — Every route is deep-linkable and reload-safe: pasting
   `/c/12` loads that conversation directly, and the browser Back button
   moves between visited screens rather than leaving the app.
3. **FR3** — `AppShell` is a layout route rendering the header, the
   conversation rail, and an `<Outlet/>`. The rail is hidden on `/logs*`
   (FR1's Rail column); the dashboard is full-bleed and gets a
   "← Back to chat" control in its own header instead.
4. **FR4** — At `≥1024px` the rail is a persistent 288px column. Below
   `1024px` it is a slide-over drawer, closed by default, opened by a header
   menu button, and dismissed by Escape, a backdrop click, or a successful
   navigation. Rail collapse state on desktop persists in `localStorage`.
5. **FR5** — A theme toggle in the header cycles `system → light → dark` and
   persists the choice in `localStorage` under `ollive:theme`. `system`
   follows `prefers-color-scheme` live. The resolved theme is applied as
   `data-theme="light|dark"` on `<html>`, set by an inline script in
   `index.html` **before** first paint so there is no flash of the wrong
   theme.
6. **FR6** — A `RouteErrorBoundary` is registered as the router's
   `errorElement`. An unhandled render error shows a recoverable panel — what
   failed, a "Reload this view" action, and a link home — never a blank page.
7. **FR7** — Route components are code-split with `React.lazy` and rendered
   inside `<Suspense>` with the route-level skeleton, so the logs dashboard's
   chart bundle is not in the initial payload.

### The signal ribbon (signature element)

8. **FR8** — The header carries a **signal ribbon**: a thin sparkline of the
   duration of the last 40 API calls this browser tab has made, newest at the
   right. It is fed by `api.ts` itself — every `request<T>` records its own
   elapsed milliseconds and outcome into a module-level ring buffer. It is
   live on every route, needs no backend endpoint, and is the app's own
   telemetry about itself.
9. **FR9** — The ribbon is read with `useSyncExternalStore` over the ring
   buffer's subscribe/getSnapshot pair — not with polling and not with a
   timer. Bars are coloured by outcome: ok uses the signal hue, failed uses
   the critical status hue. Hovering a bar shows `METHOD /path · 412ms`.
10. **FR10** — With fewer than two recorded calls the ribbon renders its idle
    state: a flat baseline at 12% opacity, no animation. It is
    `aria-hidden="true"` and has an adjacent visually-hidden text summary
    (`"Last 40 requests: median 180 ms, 1 failed"`) so it is not
    information available only to sighted users.

### Conversations index page (`/`)

11. **FR11** — On mount, `GET /conversations?limit=20&offset=0`. Items render
    in the order the backend returned them (`updated_at DESC`). The frontend
    never re-sorts, re-filters, or re-paginates.
12. **FR12** — Each conversation renders as a card showing the title, a
    formatted `updated_at`, and a status chip. Cards are a responsive grid:
    1 column `<640px`, 2 at `≥640px`, 3 at `≥1280px`.
13. **FR13** — First load renders **skeleton cards** matching the real card
    geometry — not a spinner and not a "Loading…" string. Six skeletons on
    first load; on a refresh or page change the previously loaded cards stay
    on screen at 60% opacity with the refresh control in its busy state
    (stale-while-revalidating, no layout collapse).
14. **FR14** — Empty state (`total === 0`): an illustrated panel with the
    heading "Start your first conversation", one line of body copy, and a
    primary "New conversation" action. Never a bare sentence.
15. **FR15** — Error state: the fetch's message plus a "Try again" action
    that re-runs the same `limit`/`offset`. A previously loaded page is not
    discarded — the error renders as a banner above the retained cards.
16. **FR16** — "New conversation" calls `createConversation()` with no title
    and, on success, navigates to `/c/{id}`. The list is not re-fetched; the
    navigation supersedes it. While in flight the button is disabled, shows a
    spinner, and reads "Creating…". On failure it re-enables and the error
    renders in the page's notice slot; no navigation happens.
17. **FR17** — A "Refresh" control re-fetches the current page. This is the
    path by which an auto-generated title (backend spec 008) becomes visible.
18. **FR18** — Pagination: Prev/Next stepping `offset` by a module constant
    `PAGE_SIZE = 20`. Prev disabled at `offset === 0`; Next disabled when
    `offset + PAGE_SIZE >= total`. Label reads
    `Showing {offset + 1}–{offset + items.length} of {total}`, hidden when
    `total === 0`.
19. **FR19** — A conversation whose title is still the literal default
    `"New conversation"` renders in muted ink with an "untitled" chip, so the
    user can tell the auto-title has not landed yet.
20. **FR20** — Navigating back to `/` from a chat re-fetches the first page.
    `ConversationsIndexPage` unmounts on navigate-away, so its mount effect
    refetches on return. Second path by which a new auto-title appears.

### Conversation rail

21. **FR21** — The rail shows a "New conversation" primary action, the most
    recent 20 conversations as single-line rows (title + relative-free
    timestamp), and a persistent "Inference logs" link to `/logs`.
22. **FR22** — The row matching the current `:conversationId` is marked
    active with `aria-current="page"` and a signal-hue left indicator bar
    that animates between rows via a shared `layoutId`.
23. **FR23** — The rail owns its own fetch, loading skeleton, error, and
    empty states, independent of the index page. Both may be on screen at
    once; each is separately recoverable.
24. **FR24** — The rail refetches on: mount, an explicit refresh click, and
    a `conversations:changed` event published by `api.ts` after a successful
    `createConversation`. This is a one-line event emitter, not a state
    library, and it is the **only** cross-component invalidation channel in
    the app.

### Cross-cutting

25. **FR25** — All backend calls go through typed functions in `src/api.ts`.
    No `fetch` in any component (CLAUDE.md).
26. **FR26** — Every interactive element is reachable and operable by
    keyboard with a visible `focus-visible` ring. The rail is a `<nav>`, the
    conversation rows are links, and the drawer traps focus while open and
    restores it to the opener on close.
27. **FR27** — All motion respects `prefers-reduced-motion`. Under reduced
    motion, transforms and shimmer are removed and only opacity changes
    remain, capped at 120ms.

## Non-functional requirements

- **Bundle discipline.** Route-level code splitting (FR7). The initial route
  must not pull in `recharts`. Target: initial JS under 200KB gzipped.
- **No polling, no websockets, no auto-refresh timers** (CLAUDE.md
  out-of-scope default). Every data refresh is mount-, user-, navigation-, or
  `conversations:changed`-triggered. The signal ribbon is not an exception —
  it is push-driven by `api.ts`, with no timer.
- **No caching layer.** Reads hit the network each time. This is why FR13's
  stale-while-revalidating presentation exists — it buys the perceived
  benefit of a cache without introducing one.
- **Accessibility floor**, non-negotiable and verifiable: WCAG AA contrast on
  body text in both themes, visible focus rings, reduced motion honoured,
  no information conveyed by colour alone, `aria-live="polite"` for async
  status changes.
- **Responsive floor:** usable from 360px to 2560px. No horizontal page
  scroll at any width; wide content scrolls inside its own container.
- **TypeScript `strict` stays on.** No `any` in any exported signature. No
  `@ts-expect-error` without an adjacent comment naming the reason.
- **No auth, no rate limiting, no realtime** (CLAUDE.md defaults).

## Design system

This section is the **canonical token layer**. Specs 010 and 015 consume it
and must not introduce a colour, font size, radius, shadow, duration, or
easing that is not defined here. Adding a token is an edit to this section.

### Direction

**Cool instrument.** The subject is inference observability — a product whose
job is to make opaque, expensive model calls legible. The vernacular it
borrows from is instrumentation: signal traces, telemetry readouts,
monospaced measurements. Not a cockpit pastiche; a calm, cool, precise
surface where numbers are set in a real mono face and colour is spent only on
signal.

The canvas is a desaturated slate-blue, deliberately not black — black plus
one acid accent is the current generic dark-app default, and a cool slate
reads as an instrument rather than a terminal. Boldness is spent in exactly
one place: **the signal ribbon** (FR8–FR10), the app's own live telemetry
about itself, present on every route. Everything around it stays quiet.

### Colour tokens

Defined in `src/styles/theme.css` inside `@theme`. Dark is the primary
composition; light is a designed counterpart, not an inversion.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--color-canvas` | `#12171F` | `#F3F5F9` | Page plane |
| `--color-surface` | `#1A2130` | `#FFFFFF` | Cards, rail, panels |
| `--color-surface-raised` | `#222C3E` | `#FFFFFF` | Menus, drawer, tooltips |
| `--color-surface-sunken` | `#0D1219` | `#E8ECF3` | Wells, code blocks, tracks |
| `--color-hairline` | `#2A3549` | `#DCE2EC` | 1px borders, grid lines |
| `--color-ink` | `#E7ECF3` | `#101A2B` | Primary text |
| `--color-ink-secondary` | `#B3C0D2` | `#3D4B60` | Secondary text |
| `--color-ink-muted` | `#8A97AB` | `#64748B` | Labels, axes, timestamps |
| `--color-signal` | `#38BDF8` | `#0E7FB8` | Primary accent, active state, focus ring |
| `--color-signal-soft` | `#38BDF81F` | `#0E7FB814` | Accent wash |
| `--color-accent` | `#A78BFA` | `#7C3AED` | Secondary accent, used sparingly |
| `--color-status-success` | `#0FA968` | `#047857` | status: success |
| `--color-status-cancelled` | `#94A3B8` | `#64748B` | status: cancelled |
| `--color-status-error` | `#EF4A5E` | `#DC2626` | status: error |

`--color-signal` is the app's single accent. `--color-accent` (violet) exists
for the one case where two accents must be distinguished at once; it is not a
general-purpose second brand colour.

**Status colours are reserved.** They mean `success` / `cancelled` /
`error` — mirroring the backend's `LogStatus` enum (spec 006/007) — and are
never reused to paint a series, a button, or a decoration. Every use pairs
the colour with an icon **and** a text label — never colour alone. `cancelled`
is deliberately a neutral slate rather than an amber warning: an interrupted
call is not the same thing as a fault.

Chart palettes (categorical, ordinal) are **not** defined here — they belong
to the only spec that draws charts, 015, and are validated against these
surfaces there.

### Typography

Three faces, three jobs.

| Role | Face | Usage |
|---|---|---|
| Display | **Space Grotesk** 500/600 | Page titles, KPI values, empty-state headings. Used with restraint — never for body copy. |
| Body | **Inter** 400/500/600 | All prose, labels, buttons, message content. |
| Data | **IBM Plex Mono** 400/500 | Every number that is a measurement, plus ids, hashes, model names, token counts, latencies, and code. Always with `font-variant-numeric: tabular-nums` so columns of figures align. |

The rule that makes the type treatment part of the design rather than a
delivery vehicle: **if a value is measured, it is set in mono.** A latency, a
token count, a cost, a `request_id`, a timestamp. Prose is Inter, headings are
Space Grotesk, and measurements are visibly a different class of thing.

Scale (`--text-*` in `@theme`, each with a paired line-height and tracking):

| Token | Size / line-height | Tracking | Use |
|---|---|---|---|
| `display-lg` | 2.25rem / 1.05 | `-0.02em` | Page hero title |
| `display` | 1.625rem / 1.15 | `-0.015em` | Section / panel titles |
| `h2` | 1.125rem / 1.3 | `-0.01em` | Card titles |
| `body` | 0.9375rem / 1.55 | `0` | Default (15px) |
| `sm` | 0.8125rem / 1.45 | `0` | Secondary text, timestamps |
| `micro` | 0.6875rem / 1.3 | `0.08em`, uppercase | Eyebrows, table headers, chips |
| `data` | 0.8125rem / 1.4 | `0` | Mono measurements, `tabular-nums` |

### Space, radius, elevation

- **Spacing** is Tailwind's 4px scale, restricted in practice to
  `1 2 3 4 6 8 12 16 24`. Section rhythm: 24px inner padding, 32px between
  sections, 16px card padding at `<640px`.
- **Radius**: `--radius-sm 6px` (chips, inputs), `--radius-md 10px`
  (buttons, cards), `--radius-lg 16px` (panels, drawer, modals),
  `--radius-full` (avatars, pills). No zero-radius surfaces — the hairline
  broadsheet look is explicitly not this design.
- **Elevation** is a hairline plus a soft shadow, never a shadow alone:
  `--shadow-panel` (resting card), `--shadow-raised` (menu / drawer /
  tooltip), `--shadow-focus` (a 2px `--color-signal` ring at 40% + 1px inner
  hairline). In dark mode, shadows are near-black at low alpha and the
  hairline does the separating work.

### Motion

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 90ms | Hover, colour, chip toggles |
| `--dur-fast` | 160ms | Enter/exit of small elements, tooltips |
| `--dur-base` | 240ms | Panel and message entrance, route transitions |
| `--dur-slow` | 380ms | Drawer slide, dashboard panel reveal |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Everything entering |
| `--ease-in` | `cubic-bezier(0.55, 0, 1, 0.45)` | Everything leaving |
| `--ease-inout` | `cubic-bezier(0.65, 0, 0.35, 1)` | Position/size changes |
| `--spring-layout` | `{ type: 'spring', stiffness: 420, damping: 34, mass: 0.9 }` | Framer `layout` / `layoutId` transitions only |

Rules, so motion stays orchestrated rather than scattered:

1. **One entrance per surface.** A screen animates its container in; children
   do not each animate independently, except where a stagger is specified.
2. **Staggers are short and capped.** List entrance is a 24ms per-item
   stagger over at most 8 items; item 9 onward appears with no delay. A
   20-item cascade reads as slow, not polished.
3. **Enter with opacity + a ≤8px translate. Never scale text.**
4. **Position changes use `layout`/`layoutId`**, not manual keyframes — the
   rail's active indicator (FR22).
5. **Exit animations only where absence is information** (a dismissed notice,
   a closing drawer). Routine unmounts do not animate.
6. **Reduced motion is a hard switch, not a dimmer.** The app wraps its tree
   in `<MotionConfig reducedMotion="user">`; in addition, every transform and
   every shimmer keyframe is removed under
   `@media (prefers-reduced-motion: reduce)`, leaving opacity fades capped at
   120ms. Any animation that conveys state must have a non-motion equivalent
   (text, icon, or `aria-live`).

### Loading, empty, and error vocabulary

Every async surface in the app — here, in 010, in 015 — picks from this set.
There is no other loading treatment.

| State | Treatment |
|---|---|
| **First load** | Skeletons whose geometry matches the real content (card grid → card skeletons; table → row skeletons; chart → an axis frame with a shimmer plot area). A 1.6s shimmer sweep, removed under reduced motion in favour of a static 8% wash. |
| **Refresh over existing data** | Keep the content mounted at 60% opacity, `aria-busy="true"`, and put the triggering control in its busy state. Never unmount loaded content to show a skeleton. |
| **Inline action pending** | The control keeps its width, swaps its label for a 14px spinner plus present-tense text ("Creating…", "Sending…"), and sets `disabled`. |
| **Empty (no data yet)** | A panel: a restrained mark, a directive heading ("Start your first conversation"), one line of body, and the primary action. An empty screen is an invitation to act. |
| **Empty (filters match nothing)** | Distinct from the above: states what was filtered and offers "Clear filters". Never the first-run empty state. |
| **Error** | A banner or panel with what failed in the interface's voice, and a retry action that repeats *exactly* the failed request. Errors do not apologise and are never vague. Loaded data is retained beneath. |
| **Not found (404)** | A route-level panel: what is missing, and the two navigations out. |

Copy rules: sentence case, active voice, no exclamation marks, no
apologies, and a control's label matches the outcome it produces ("New
conversation" → a new conversation).

### Shared UI primitives

`src/components/ui/` — the only shared component layer in the app. Each is
here because **three or more screens** need it; nothing is added
speculatively.

`Button` (variants `primary | secondary | ghost | danger`, sizes `sm | md`,
`loading`/`disabled` states) · `IconButton` (requires `aria-label`) ·
`Spinner` · `Skeleton` (`variant: text | block | circle`) · `Chip`
(`tone: neutral | signal | success | cancelled | error`, icon + label) ·
`Panel` (surface + hairline + radius) · `EmptyState` · `ErrorState` ·
`NoticeBanner` (`kind: info | error`, dismissible, `role="status"`) ·
`Tooltip` (hover + focus, Escape to close) · `PageHeader` ·
`ScrollArea` (an overflow container with themed scrollbars).

This is a deliberate, bounded exception to CLAUDE.md's
no-premature-abstraction rule, on the same reasoning the backend's repository
layer gets one: three screens sharing one visual language need one
implementation of it, from the start. The bound is the list above — no
barrel file, no compound-component APIs, no `styled()` factory, no theme
context beyond `data-theme`.

## Data model

**No database changes.** Frontend-only — no SQLAlchemy model, no Alembic
migration, no file under `backend/` is touched.

### TypeScript types (`src/api.ts`, mirroring backend Pydantic names)

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

### Error type (`src/api.ts` — 010 and 015 reuse it unchanged)

```ts
export class ApiError extends Error {
  status: number   // HTTP status; 0 means the request never reached the server
  detail: string   // the backend's ErrorResponse.detail, or a fallback
  constructor(status: number, detail: string) { … }
}
```

### Component state

| Component | State | Notes |
|---|---|---|
| `AppShell` | `drawerOpen: boolean` | mobile drawer only |
| | `railCollapsed: boolean` | desktop, persisted in `localStorage` |
| `ThemeProvider` | `preference: 'system' \| 'light' \| 'dark'` | persisted; resolved theme written to `<html data-theme>` |
| `ConversationRail` | `useResource<Page<ConversationRead>>` | own fetch/loading/error |
| `ConversationsIndexPage` | `useResource<Page<ConversationRead>>` | own fetch/loading/error |
| | `offset: number` | `PAGE_SIZE` is a module constant, `20` |
| | `creating: boolean`, `createError: string \| null` | the create action |

Navigation state lives in the URL, not in React state. There is no global
store, no context beyond `ThemeProvider`, and no state lifted above the
components that own it.

## API contracts

All in `src/api.ts`. `BASE_URL` keeps its `VITE_API_URL ?? 'http://localhost:8000'`
fallback. The scaffold's commented `createItem` example is deleted;
`checkHealth` stays and is retyped through `request<T>`.

### Shared request helper (defined here, reused by 010 and 015)

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T>
```

Behaviour, exactly:

1. Record `performance.now()`. Call `fetch(`${BASE_URL}${path}`, init)`.
2. If `fetch` itself rejects (backend down, DNS, CORS), record the attempt in
   the latency buffer as failed and throw
   `new ApiError(0, 'Cannot reach the backend. Is it running?')`.
3. On `res.ok`: return `await res.json() as T`. For `204`/empty body return
   `undefined as T` (no v1 endpoint needs this; the guard avoids a JSON parse
   throw).
4. On `!res.ok`: read the body as JSON inside a `try`/`catch` (an error page
   may not be JSON) and derive `detail`:
   - `detail` is a string → use it (the project's `ErrorResponse` shape from
     `app/core/errors.py`);
   - `detail` is an array (FastAPI's 422 shape) → `'Invalid request.'`;
   - unreadable or absent → `HTTP ${res.status}`.

   Throw `new ApiError(res.status, detail)`.
5. **In every path** (`finally`), push
   `{ method, path, ms: performance.now() - t0, ok }` into the latency ring
   buffer (FR8) and notify its subscribers.

Callers distinguish outcomes with
`err instanceof ApiError && err.status === 404` — never by matching on
message strings.

### Functions

| Function | Endpoint | Signature |
|---|---|---|
| `checkHealth` | `GET /health` | `() => Promise<{ status: string }>` |
| `createConversation` | `POST /conversations` | `(title?: string) => Promise<ConversationRead>` |
| `listConversations` | `GET /conversations` | `(limit: number, offset: number) => Promise<Page<ConversationRead>>` |
| `getConversation` | `GET /conversations/{id}` | `(id: number) => Promise<ConversationRead>` |

```ts
export async function createConversation(title?: string): Promise<ConversationRead> {
  const body: ConversationCreate = { title: title ?? null }
  const created = await request<ConversationRead>('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  emit('conversations:changed')   // FR24 — the rail's only invalidation channel
  return created
}

export async function listConversations(limit: number, offset: number): Promise<Page<ConversationRead>> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return request<Page<ConversationRead>>(`/conversations?${qs}`)
}

export async function getConversation(id: number): Promise<ConversationRead> {
  return request<ConversationRead>(`/conversations/${id}`)
}
```

`getConversation` is unused by this spec's screens; it exists because spec
010 renders the conversation title in the chat header, and because CLAUDE.md
requires a typed function per backend endpoint. Do not remove it as dead
code.

## Shared hooks

`src/hooks/` — four hooks, replacing what TanStack Query would have done.
Each is small enough to read in one screen.

```ts
// useResource — the single async-data primitive. Every screen uses it.
type Resource<T> = {
  data: T | null          // last successful value; retained across refetch
  error: string | null    // ApiError.detail of the most recent failure
  loading: boolean        // a request is in flight
  isFirstLoad: boolean    // loading && data === null  → skeletons vs. dimming
  reload: () => void      // repeats the same request
}
function useResource<T>(fetcher: () => Promise<T>, deps: unknown[]): Resource<T>
```

Contract, because three screens depend on it behaving identically:

- Retains `data` across a refetch (FR13's stale-while-revalidating) and
  across a failure (FR15's retained cards).
- Guards every `setState` behind a mounted ref.
- Ignores a resolved response whose request is not the latest for those
  `deps` (a monotonic request counter), so a slow first response cannot
  overwrite a fast second one.
- Does **not** cache, dedupe across components, or retry automatically.

Also: `useTheme()` (preference + resolved theme + setter, FR5),
`useMediaQuery(query)` (`matchMedia` via `useSyncExternalStore`), and
`useLatencyBuffer()` (the ribbon's `useSyncExternalStore` subscription, FR9).

`useResource`'s eight-line no-cache contract is the accepted cost of not
adding TanStack Query. The tradeoff, stated so it is not rediscovered as a
bug: **two components fetching the same conversations page issue two
requests.** At single-user demo scale that is two cheap SQLite reads; if the
app grows a third or fourth consumer of the same endpoint, adding TanStack
Query is the correct move at that point, not a rewrite.

## Constraints

- **Four runtime dependencies, no more** (see "Stack decisions"). A fifth is
  a project-level decision, not a drive-by `npm install`.
- **Tailwind v4 CSS-first only.** The design system lives in
  `src/styles/theme.css` as `@theme`. No `tailwind.config.js`, no
  `@apply`-heavy component classes, no arbitrary values in JSX for anything
  the token layer already names. Colours are referenced as
  `bg-surface`/`text-ink-muted`, never as `bg-[#1A2130]`.
- **Dark mode is a `data-theme` attribute variant**, declared once:
  `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`
  It is not `prefers-color-scheme` alone, because FR5 requires a manual
  override.
- **No inline `style={{…}}`** except for a genuinely computed value (a
  sparkline bar height, a progress width). Everything else is a utility class.
- **No `fetch` in components** (CLAUDE.md) and no direct `BASE_URL` use
  outside `api.ts`.
- **No client-side sorting, filtering, or re-pagination.** The server's
  ordering and `Page` envelope are authoritative.
- **Timestamps** use the platform `Intl`/`Date` API only —
  `new Date(x).toLocaleString()` and a shared
  `formatDateTime` / `formatDuration` / `formatCost` in `src/lib/format.ts`.
  **No relative-time ("3 minutes ago")**: it needs either a dependency or a
  ticking timer, and a ticking timer is polling.
- **`PAGE_SIZE = 20`** is a module constant, not user-configurable.
- The chart palette and any `recharts` import belong to spec 015. This spec
  must not add either.

## Error handling and edge cases

| # | Case | Behaviour |
|---|---|---|
| 1 | Empty conversation list (`total === 0`) | FR14 first-run empty state. No pagination label; both paging controls disabled; "New conversation" enabled. |
| 2 | Backend unreachable (`fetch` rejects → `ApiError.status === 0`) | "Cannot reach the backend. Is it running?" plus "Try again". A previously loaded page is retained beneath the banner. Rail shows its own compact version of the same. |
| 3 | `GET /conversations` returns 422 | Should be unreachable — `limit` is a constant and `offset` only moves in `PAGE_SIZE` steps from 0. If seen: "Invalid request." + retry, and treat as a client bug. |
| 4 | `createConversation` fails | Button re-enables, error in the page notice slot, no navigation, view unchanged. |
| 5 | Double-clicking "New conversation" | Disabled while `creating`, so the second click is a no-op. No debounce, no second POST. |
| 6 | `/c/:conversationId` where the id is not a positive integer (`/c/abc`) | `ChatPage` renders the 404 panel without issuing a request — the route param is validated before fetching. |
| 7 | `/c/:conversationId` for a conversation that does not exist | 010 surfaces the 404 with a "Back to conversations" action. The index page and rail do not pre-validate. |
| 8 | An unknown path (`/settings`) | `NotFoundPage` inside the shell, so the rail is still available. |
| 9 | A render error inside a route | `RouteErrorBoundary` (FR6). The shell survives; the failing pane is recoverable. |
| 10 | Title still the default `"New conversation"` | Muted ink + "untitled" chip (FR19). Not an error — auto-titling (008) is asynchronous; the title lands on the next refresh (FR17) or return to `/` (FR20). |
| 11 | Very long title | Single-line with `truncate` and a `title` attribute; rail rows and cards cannot be broken by one item. |
| 12 | "Next" clicked on the last page, or rows removed between fetches | Controls are disabled at the boundaries (FR18). If a fetch still returns `items === []` while `total > 0`: "No conversations on this page." with Prev enabled. **No automatic offset correction** — a silent jump is more confusing than an explicit empty page. |
| 13 | Rapid Refresh / Prev / Next clicks | Fetch-triggering controls are disabled while `loading`, so at most one list request is in flight per component. `useResource`'s request counter makes a late response from a superseded request a no-op. |
| 14 | Drawer open, then a navigation occurs | Drawer closes and focus returns to the menu button. Escape and a backdrop click do the same. |
| 15 | `localStorage` unavailable (private mode, disabled) | Theme and rail-collapse reads/writes are wrapped in try/catch; the app falls back to `system` and expanded, and never throws. |
| 16 | Theme toggle before hydration | The `index.html` inline script sets `data-theme` pre-paint (FR5), so there is no flash. |
| 17 | Latency buffer with a single entry, or all-failed entries | FR10 idle state at `< 2` entries; an all-failed ribbon is all-critical-hue bars, which is correct and legible. The ribbon never throws and never blocks a request. |
| 18 | 360px-wide viewport | Rail is a drawer, cards are one column, header collapses to menu + title + theme toggle, and the ribbon shrinks to its last 16 bars. No horizontal page scroll. |

## Acceptance criteria

Verified **manually** against a running backend (`make backend`) and frontend
(`make frontend`). The project has **no frontend test setup** (no vitest, no
jest, no testing-library) and this spec does not add one — per CLAUDE.md,
tests come only from the `generate-tests` skill, which covers pytest.

**Foundation**

- [ ] `npm run build` succeeds with `tsc` clean under `strict`.
- [ ] `npm ls --depth=0` shows exactly `react`, `react-dom`,
      `react-router-dom`, `tailwindcss`, `@tailwindcss/vite`,
      `framer-motion` as runtime additions — no others.
- [ ] Visiting `/c/1` directly loads the chat route (placeholder or 010).
      Browser Back returns to the previous screen, not out of the app.
- [ ] Reloading on `/logs` lands on `/logs`, not `/`.
- [ ] With the theme set to dark and the page reloaded, there is **no flash**
      of the light theme before paint.
- [ ] Setting the theme to `system` and flipping the OS appearance updates
      the app live, with no reload.
- [ ] At 1440px the rail is a persistent column; at 800px it is a drawer that
      opens from the header, closes on Escape, on backdrop click, and after a
      navigation, and returns focus to the menu button.
- [ ] Collapsing the rail and reloading keeps it collapsed.
- [ ] `/logs` renders without the rail and with a "Back to chat" control.
- [ ] An unknown path renders the 404 panel with the rail still usable.
- [ ] Tabbing from the top of the page reaches the menu button, the rail's
      new-conversation action, each conversation row, the logs link, and the
      theme toggle — each with a visible focus ring.
- [ ] With OS "reduce motion" on, no element translates or shimmers; content
      still appears and disappears via short opacity fades.
- [ ] The DevTools Network panel shows the logs route's chunk is **not**
      requested until `/logs` is visited.

**Signal ribbon**

- [ ] On first paint with no requests made, the ribbon is a flat baseline with
      no animation.
- [ ] After loading the conversation list, the ribbon shows one bar per
      request made, newest right, with hover showing method, path, and ms.
- [ ] With the backend stopped, a failed request adds a bar in the error hue.
- [ ] A screen reader reads the ribbon's text summary, not its bars.

**Conversations**

- [ ] With zero conversations, `/` shows the "Start your first conversation"
      panel with a working primary action — not a bare sentence, not a
      spinner.
- [ ] On first load, skeleton **cards** appear (matching real card geometry),
      not a spinner or a "Loading…" string.
- [ ] Clicking Refresh on a loaded list keeps the cards mounted and dimmed;
      they never unmount into skeletons.
- [ ] With the backend stopped, `/` shows "Cannot reach the backend. Is it
      running?" and "Try again"; starting the backend and clicking it loads
      the list.
- [ ] With three conversations, all three render newest-`updated_at` first
      with a formatted timestamp and a status chip.
- [ ] A conversation still titled `"New conversation"` renders muted with an
      "untitled" chip.
- [ ] Clicking "New conversation" creates exactly one conversation and
      navigates to `/c/{id}`; the rail shows the new conversation without a
      manual refresh (FR24).
- [ ] Double-clicking "New conversation" creates exactly **one**
      conversation.
- [ ] With `createConversation` failing (backend stopped), the button
      re-enables, an error appears, and no navigation happens.
- [ ] With 25 conversations, 20 cards render, "Showing 1–20 of 25" appears,
      Prev is disabled, Next is enabled; Next shows the remaining 5 and
      "Showing 21–25 of 25" with Next disabled.
- [ ] While the list is loading, Refresh, Prev, and Next are disabled.
- [ ] The rail's active indicator moves between rows with an animated
      transition when navigating between two conversations.
- [ ] A conversation auto-titled by the backend after load shows its new
      title after Refresh, and after navigating into a chat and back.
- [ ] At 360px width there is no horizontal page scroll on any route.
- [ ] `grep -rn "fetch(" frontend/src --include=*.tsx` returns nothing.
- [ ] `grep -rn "bg-\[#" frontend/src` returns nothing — no hard-coded
      colours outside the token layer.

## Files to be changed

| File | Change | Purpose |
|---|---|---|
| `frontend/package.json` | modify | Add `react-router-dom`, `tailwindcss`, `@tailwindcss/vite`, `framer-motion`. |
| `frontend/vite.config.ts` | modify | Register the `@tailwindcss/vite` plugin. |
| `frontend/index.html` | modify | Font `<link>`s, the pre-paint theme script (FR5), `<title>`, `lang`, viewport meta. |
| `frontend/src/styles/theme.css` | **new** | `@import "tailwindcss"`, the `@theme` token layer, the `dark` custom variant, base resets, reduced-motion overrides, shimmer keyframes. |
| `frontend/src/main.tsx` | modify | Import `theme.css`; mount `RouterProvider` inside `ThemeProvider` and `MotionConfig`. |
| `frontend/src/router.tsx` | **new** | `createBrowserRouter`, the FR1 route table, lazy route elements, `errorElement`. |
| `frontend/src/App.tsx` | **modify → `AppShell`** | The layout route: header, rail, `<Outlet/>`, drawer state, responsive behaviour. Drops the health-check UI. |
| `frontend/src/api.ts` | modify | `ApiError`, `request<T>` (with latency instrumentation), `Page<T>`, conversation types + four functions, the `emit` helper. Delete the `createItem` comment. |
| `frontend/src/lib/latencyBuffer.ts` | **new** | The 40-entry ring buffer with subscribe/getSnapshot; written only by `api.ts`. |
| `frontend/src/lib/events.ts` | **new** | The one-line `emit`/`subscribe` pair for `conversations:changed`. |
| `frontend/src/lib/format.ts` | **new** | `formatDateTime`, `formatDuration`, `formatCost`, `isDefaultTitle`. |
| `frontend/src/hooks/useResource.ts` | **new** | The async-data primitive. |
| `frontend/src/hooks/useTheme.ts` | **new** | Theme preference + resolution + persistence. |
| `frontend/src/hooks/useMediaQuery.ts` | **new** | `matchMedia` via `useSyncExternalStore`. |
| `frontend/src/components/ui/*.tsx` | **new** | The bounded primitive set listed in "Shared UI primitives". |
| `frontend/src/components/shell/AppHeader.tsx` | **new** | Header: menu button, breadcrumb/title, signal ribbon, theme toggle. |
| `frontend/src/components/shell/SignalRibbon.tsx` | **new** | The signature element (FR8–FR10). |
| `frontend/src/components/shell/ConversationRail.tsx` | **new** | Rail: new-conversation action, recent rows, active indicator, logs link. |
| `frontend/src/components/shell/RouteErrorBoundary.tsx` | **new** | Router `errorElement`. |
| `frontend/src/pages/ConversationsIndexPage.tsx` | **new** | The `/` screen: card grid, states, create, refresh, pagination. |
| `frontend/src/pages/NotFoundPage.tsx` | **new** | The `*` route. |
| `frontend/src/pages/ChatPage.tsx` | **new (placeholder)** | Placeholder replaced wholesale by spec 010. |
| `frontend/src/pages/LogsDashboardPage.tsx` | **new (placeholder)** | Placeholder replaced wholesale by spec 015. |
| `frontend/.env.example` | unchanged | `VITE_API_URL` remains the only knob. |

**Not changed:** anything under `backend/`. No frontend test file.

**On the directory count:** this is more structure than CLAUDE.md's
no-premature-abstraction rule would normally allow, and it is justified by
the same reasoning as the backend's repository layer — three screens are
specified (009, 010, 015) and the split is drawn along boundaries they
actually share (`pages/`, `components/shell/`, `components/ui/`, `hooks/`,
`lib/`). What is **not** created: a barrel `index.ts` anywhere, a `types/`
directory (types live with `api.ts`), a `contexts/` directory (one provider,
in `hooks/useTheme.ts`), a `utils/` catch-all, or a per-page directory.

## Feature-specific rules

- **The token layer is the only source of visual values.** A colour, size,
  radius, shadow, duration, or easing used in a component must resolve to a
  token from "Design system". Specs 010 and 015 consume this section and add
  to it by editing it, never by inventing a local value.
- **Status colours are reserved** (`success` / `cancelled` / `error`) and
  always ship with an icon and a text label. `cancelled` is a neutral slate,
  never an amber warning — mirroring the backend's `LogStatus` enum, an
  interrupted call is not the same thing as a fault.
- **Measurements are set in mono.** Latencies, token counts, costs, ids,
  hashes, model names, timestamps — IBM Plex Mono with `tabular-nums`. Prose
  is never mono; measurements are never Inter.
- **Motion follows the six rules** in "Design system → Motion". In
  particular: one entrance per surface, staggers capped at 8 items, position
  changes via `layout`/`layoutId`, and reduced motion as a hard switch.
- **Loading is skeletons on first load and dimming on refresh.** Loaded
  content is never unmounted to show a skeleton. A full-screen spinner is not
  in the vocabulary.
- **`useResource` is the only way a screen fetches.** No bare `useEffect` +
  `fetch`-then-`setState` in a page or component, and no second data-fetching
  abstraction.
- **Navigation state lives in the URL.** No `selectedConversationId`-style
  duplicate in React state, no navigation context.
- **`conversations:changed` is the only cross-component invalidation event.**
  If a second event is needed, it goes in `lib/events.ts` beside it — that
  file does not become a pub/sub framework, a typed event bus with
  middleware, or a store.
- **No polling, no websockets, no auto-refresh timer.** An auto-generated
  title (008) is expected to appear *later*, on the next refresh; that
  latency is by design.
- **No logs UI in this spec.** `/logs` is routed to a placeholder; the
  dashboard is spec 015. Do not add charts, KPI tiles, or `recharts` here.
- **No inline `fetch`, no `dangerouslySetInnerHTML`, no new dependency**
  beyond the four named.

## Open questions

- **Self-hosted fonts.** Assumed Google Fonts `<link>` for v1, with
  `@fontsource-variable/{space-grotesk,inter,ibm-plex-mono}` recorded as the
  production hardening step (removes a render-blocking third-party request
  and a privacy dependency, costs three packages). Confirm before build if
  the deliverable should ship self-hosted from the start.
- **Timestamp timezone — resolved, but the fix ships in spec 014.** This is no
  longer an open question: it was verified against the real models that
  although the columns are declared `DateTime(timezone=True)`, SQLite stores
  `'2026-08-01 14:27:55.282108'` (offset stripped), reads back with
  `tzinfo = None`, and serialises **without** a `Z` or offset — so the browser
  parses every timestamp as *local* time and displays a skew equal to the UTC
  offset. **The fix is backend-side and is specified in
  `014-logs-stats-api.md` → "Prerequisite fix: UTC serialisation"** (a
  `UtcDateTime` type decorator; no migration, no contract change beyond adding
  the offset consumers already assumed). No frontend workaround: `api.ts` and
  `formatDateTime` must **not** append a `Z` or coerce timezones. Order of
  work: if this spec is implemented before 014, timestamps will be visibly
  skewed until 014's fix lands — that is expected, not a frontend bug.
- **Page size.** Assumed a fixed `PAGE_SIZE = 20` (the backend default) with
  no user control. Confirm before build.
- **Rail conversation count.** Assumed the rail shows the most recent 20 and
  does not paginate — "see all" is the `/` page's job. Confirm before build.
- **Relative timestamps.** Assumed **not** built, because a live "3 minutes
  ago" needs a ticking timer, which is a form of polling. If they are wanted,
  the acceptable form is a static relative string computed at render with
  `Intl.RelativeTimeFormat` and refreshed only when the data is refetched;
  confirm which is preferred.
