# Chat Shell Redesign (InferenceLens rebrand)

## Problem statement

The chat UI (spec 009/010/012) is functionally complete but visually boxy:
a full-width top header bar, a bordered conversation grid as the landing
page, uniform bordered bubbles for every message, and a full-bleed bottom
composer bar. This feature restyles the existing chat shell to feel more
like a modern assistant UI (rounded, centered, free-flowing — inspired by
Claude's own UI) and renames the product from "Ollive" to "InferenceLens"
everywhere it's user-visible.

This is a **presentation-layer-only** change. Every existing endpoint,
hook, repository, and piece of client-side state management is reused
as-is. No new API calls, no new backend behavior, no new dependencies.

**Explicitly out of scope:**
- Any backend/API change of any kind.
- Real functionality behind the voice-to-text, file-upload, model-chooser,
  or account controls — all four are inert placeholders (spec'd for a
  later feature once multi-model support exists).
- Date-grouped/collapsible sections within the conversation list (sidebar
  collapse stays whole-sidebar, exactly as implemented today).
- Auth/account functionality, rate limiting, caching, or realtime —
  per CLAUDE.md's "Out of scope by default," unaffected by this change.
- Renaming the git repo directory or `frontend/package.json`'s `name`
  field (already the generic `"app-frontend"`, not "ollive").
- Editing historical `.claude/designs/`/`.claude/specs/` documents — they
  record decisions made at the time and are not live branding surfaces.

## Functional requirements

**Shell**
1. `AppHeader` is removed. No full-width top bar is rendered anywhere in
   `AppShell`, on desktop or mobile.
2. The sidebar (renamed conceptually to reflect its expanded role, code
   name TBD at implementation — see "Files to be changed") is the only
   persistent chrome. Top-to-bottom it contains: a top row with the
   sidebar's own collapse toggle icon, the "InferenceLens" wordmark, and
   the theme toggle icon; a prominent rounded "New chat" button; the
   scrollable conversation list; the `SignalRibbon` latency sparkline
   (kept, tucked in low-key above the footer); and a footer with the
   existing "Inference logs" link plus a new inert "Account" row (avatar
   circle + placeholder label).
3. Clicking the "InferenceLens" wordmark navigates to `/` (the landing /
   new-chat screen).
4. When the sidebar is collapsed (desktop) or the drawer is closed
   (mobile), a single small floating icon button — not a bar, no
   background/border strip — appears pinned at the top-left of the
   content area to reopen it. This button is the *only* thing rendered
   outside the sidebar's own column/drawer; it disappears once the
   sidebar is open/expanded.
5. `/logs` continues to hide the sidebar exactly as it hides the rail
   today (`hideRail` check in `App.tsx`) — unaffected by this change.
6. All existing collapse/drawer behavior is preserved as-is: desktop
   collapse state persists via `localStorage` (key renamed, see rebrand
   section below), mobile drawer is closed by default and not persisted,
   focus trap and Escape-to-close behavior in the drawer are unchanged.

**Landing / new-chat flow**
7. Root path `/` renders a new landing view: centered "How can I help you
   today?" greeting with the shared composer directly beneath it,
   vertically and horizontally centered in the content area. No
   conversation exists yet at this point — nothing is created on page
   load or on visiting `/`.
8. Sending the first message from the landing composer: (a) calls the
   existing `createConversation()`, (b) sends/streams the typed message
   into the newly created conversation using the existing send/stream
   flow, (c) navigates the URL to `/c/:id` once the conversation exists,
   with the assistant's reply streaming in — from the user's perspective
   this is one continuous action, not a page reload.
9. `ConversationsIndexPage` (the paginated conversation-card grid) is
   deleted, along with its route. Nothing in the app links to it anymore
   — the sidebar list plus the landing screen cover both of its former
   jobs (browse recent conversations; start a new one).
10. The sidebar's existing "New chat" action, when triggered while
    already on `/`, is a no-op / simply ensures the landing (empty,
    no-conversation) state is showing — it does not create an empty
    conversation eagerly.

**Composer**
11. A single composer component is shared between the landing screen and
    `ChatPage`'s pinned bottom composer — same markup, same behavior,
    used in two places.
12. The composer renders as a rounded (`rounded-3xl`) floating pill,
    centered with a max-width (e.g. `max-w-3xl`, matching the message
    column's width — see requirement 16) rather than stretched
    edge-to-edge.
13. Inside the pill: the existing auto-growing textarea on top, then a
    bottom row within the same rounded container: left side holds an
    inert attach/upload icon button and an inert "Model" chooser pill
    (static label, e.g. "Model"); right side holds an inert
    voice-to-text mic icon button and the real Send button.
14. All four inert controls (attach, model chooser, mic, and the
    sidebar's account row) render with normal active/hover/press visual
    states (not grayed out or `disabled`) and show a "Coming soon"
    tooltip (reusing the existing `Tooltip` component) on hover/focus.
    They are wired to a no-op handler — clicking does nothing, and there
    is no console error, network call, or navigation.
15. The composer's focus state uses the existing `--shadow-focus` token
    (soft glow) instead of the default hard focus-visible outline ring.
    All existing Composer behavior — Enter to send, Shift+Enter for
    newline, disabled/sending states, ref-forwarding for the
    empty-conversation auto-focus (FR8 of spec 010) — is preserved
    unchanged; only the wrapping markup/styling changes.

**Messages**
16. The message list and the composer both render inside the same
    centered, max-width reading column (e.g. `max-w-3xl mx-auto`) inside
    `ChatPage`'s scroll area, rather than edge-to-edge with `px-4`.
17. User messages keep a rounded bubble (`rounded-2xl`, up from
    `rounded-md`), right-aligned, `bg-signal-soft` — unchanged colors,
    larger radius only.
18. Assistant messages drop the bubble entirely: no background, no
    border, left-aligned, full column width, plain flowing text. This is
    the primary fix for the "boxy" complaint.
19. All other per-message behavior is unchanged: role label, the
    copy-to-clipboard control (`CopyControl`), fenced-code-block
    splitting/rendering (`splitFencedContent`, `CodeSegment`,
    `TextSegment`), timestamp, and the pending/streaming opacity
    treatment.

**`ChatPage` header**
20. The "← Conversations" back link is removed (redundant now that the
    sidebar always shows navigation and highlights the active
    conversation).
21. The header's border and background bar are removed in favor of a
    plain, borderless row with generous spacing. The row still shows:
    conversation title, the untitled chip (when applicable), the status
    chip, message count, and the "View inference logs" link — same data,
    same conditions, restyled only.

**Rebrand**
22. All user-visible occurrences of "Ollive" become "InferenceLens":
    `frontend/index.html`'s `<title>`, and the sidebar wordmark.
23. `localStorage` key prefixes are renamed for consistency:
    `ollive:theme` → `inferencelens:theme` (in both `index.html`'s
    pre-paint script and `useTheme.ts`), and
    `ollive:rail-collapsed` → `inferencelens:rail-collapsed` (in
    `App.tsx`). This is a clean rename, not a migration — see "Error
    handling and edge cases" for what happens to existing stored values.

**Small creative additions (deliberately minimal)**
24. The landing greeting has a subtle radial glow behind it, composed
    from the existing `--color-signal`/`--color-accent` tokens — no new
    color tokens introduced.
25. The landing greeting fades/slides in using framer-motion (already a
    dependency) with the existing `--dur-base`/`--ease-out` motion
    tokens used elsewhere in the app (e.g. `MessageBubble`).
26. Nothing beyond requirements 24–25 — no new illustrations, no new
    animation/icon library, no additional npm dependencies.

## Non-functional requirements

- **No backend impact.** No FastAPI routes, Pydantic schemas, SQLAlchemy
  models, or Alembic migrations change. `grep`-verifiable: this feature
  touches only `frontend/`.
- **No new dependencies.** Everything is built from Tailwind utilities
  already available (including Tailwind v4's built-in `rounded-xl`/
  `rounded-2xl`/`rounded-3xl`, which this project's `theme.css` does not
  override) plus the existing `framer-motion` dependency.
- **Accessibility parity.** Every accessibility affordance that exists
  today is preserved: the drawer's focus trap and Escape-to-close, the
  `aria-live` regions in `ChatPage` and `PendingIndicator`, focus-visible
  styling (via the new `shadow-focus` glow instead of the outline, but
  still clearly visible), and `aria-label`s on all icon-only buttons
  (including the four new inert controls and the new floating
  reopen-sidebar button).
- **Responsiveness.** The landing screen, composer, and message column
  must remain usable at the same breakpoints the app already targets
  (`useMediaQuery('(min-width: 1024px)')` is the existing desktop/mobile
  split — reused, not changed).
- Out of scope per CLAUDE.md defaults, unaffected by this feature: auth,
  rate limiting, caching, realtime/websockets.

## Data model

No changes. No new or modified SQLAlchemy models; no Alembic migration.

## API contracts

No changes. This feature calls only existing, already-exported functions
from `frontend/src/api.ts`: `createConversation`, `listConversations`,
`getConversation`, `listMessages`, `streamMessage`. No new endpoints, no
changed request/response shapes.

## Constraints

- Existing design tokens in `frontend/src/styles/theme.css` (colors,
  `--radius-sm/md/lg/full`, `--shadow-panel/raised/focus`, motion
  durations/easings, the three font faces) are reused as-is; this spec
  does not introduce new tokens. The only "new" radius values used
  (`rounded-2xl`, `rounded-3xl`) come from Tailwind's untouched built-in
  scale, not from `theme.css`.
- `framer-motion` is already a dependency (used by `App.tsx`'s drawer
  transition and `MessageBubble`'s fade-in) — reused for the landing
  greeting's fade-in, no new library added.
- The existing streaming chat flow (spec 012) — SSE via `streamMessage`,
  `onChunk`/`onDone`/`onError` callbacks — is reused verbatim for the
  landing screen's first-send-creates-conversation flow (requirement 8);
  this spec does not change the streaming contract.

## Error handling and edge cases

- **Landing composer send fails (network/validation error) before a
  conversation is created:** since `createConversation()` runs first,
  if it throws, no message send is attempted and the user stays on the
  landing screen with the composer's existing error-notice pattern
  (reusing `mapSendError`-style handling) — the draft text is preserved
  in the textarea, not lost, matching today's `ChatPage` send-failure
  behavior of never silently dropping a draft.
- **Landing composer send succeeds at creation but fails at the
  message/stream step:** the conversation now exists (empty) — the user
  is navigated to `/c/:id`, which renders its existing empty-conversation
  state (unaffected by this spec) with the existing notice/error
  handling from spec 012 (`mapSendError`/`MID_STREAM_FAILURE_NOTICE`).
  No new empty-conversation cleanup logic is introduced — an empty
  conversation left behind by a failed first send is the same outcome as
  today's "New conversation" button followed by a failed send.
- **Double-submit from the landing composer** (e.g. rapid Enter presses):
  the composer's existing `sending`/`disabled` guard (Composer's
  `blocked = sending || disabled`) prevents a second concurrent call —
  unchanged from today's `ChatPage` guard, just exercised one screen
  earlier.
- **Renamed `localStorage` keys read by a returning user with the old
  `ollive:*` keys already stored:** the old keys are simply never read
  again (dead entries in `localStorage`, harmless) — the app falls back
  to its existing safe defaults (`system` theme preference, expanded
  sidebar) exactly as it would for any first-time visitor. No migration
  code reads the old key names; this is a clean rename, called out
  explicitly per requirement 23.
- **Floating reopen-sidebar button and drawer/rail state:** clicking it
  calls the exact same `handleToggleRail` logic `AppHeader`'s button
  called today (desktop → `setRailCollapsed(false)`-equivalent via the
  existing toggle function, mobile → opens the drawer) — no new state
  machine, just a relocated trigger.
- **Inert placeholder controls:** clicking attach/mic/model-chooser/
  account never throws, never logs an error, never navigates — a no-op
  handler (e.g. `() => {}` or a shared no-op) wired to each, satisfying
  "never swallow exceptions" trivially since there is no exception path
  to swallow.
- **Empty/whitespace-only draft on the landing composer:** identical to
  today's `ChatPage` composer — `canSend` requires
  `draft.trim() !== ''`, so Send stays disabled and Enter is a no-op.

## Acceptance criteria

- [ ] Visiting `/` shows the centered greeting + composer, no top bar, no
      conversation card grid, and no network request that creates a
      conversation.
- [ ] Typing a message and sending it from `/` creates exactly one
      conversation, streams the assistant's reply, and lands the user on
      `/c/:id` with the full exchange visible.
- [ ] `ConversationsIndexPage`'s route is gone; no remaining link in the
      app points to it.
- [ ] The sidebar (not a header) contains the "InferenceLens" wordmark,
      theme toggle, `SignalRibbon`, "New chat" button, conversation list,
      "Inference logs" link, and the inert "Account" row.
- [ ] Collapsing the sidebar (desktop) or closing the drawer (mobile)
      leaves exactly one small floating icon button visible to reopen
      it — no header, no bar.
- [ ] In `ChatPage`, assistant messages render with no bubble/background
      (plain text); user messages render in a `rounded-2xl` bubble,
      right-aligned.
- [ ] The composer (landing and `ChatPage`) is a centered, `rounded-3xl`
      pill with attach/model-chooser/mic controls that show a "Coming
      soon" tooltip and do nothing on click.
- [ ] The "← Conversations" link and the bordered header bar are gone
      from `ChatPage`; title/chips/message-count/"View inference logs"
      still render.
- [ ] `<title>` reads "InferenceLens"; no remaining "Ollive" string
      exists anywhere under `frontend/src/` or `frontend/index.html`.
- [ ] Existing behaviors are unaffected: Enter/Shift+Enter in the
      composer, drawer focus trap + Escape-to-close, theme cycling,
      copy-to-clipboard on messages, fenced code block rendering,
      load-older-messages, jump-to-latest, streaming text growth, and all
      existing error notices (404/409/422/status-0 mappings).

## Files to be changed

- `frontend/src/components/shell/AppHeader.tsx` — deleted.
- `frontend/src/components/shell/ConversationRail.tsx` — expanded: add
  top row (collapse toggle, wordmark, theme toggle), restyle "New chat"
  button, add `SignalRibbon` + inert "Account" footer row; conversation
  list data/query logic unchanged.
- `frontend/src/App.tsx` — remove `AppHeader` usage; add the floating
  reopen-sidebar icon button (rendered when the rail is collapsed/drawer
  closed); rename `RAIL_COLLAPSED_KEY`.
- `frontend/src/hooks/useTheme.ts` — rename `STORAGE_KEY`.
- `frontend/index.html` — `<title>` and pre-paint script's storage key.
- `frontend/src/pages/ConversationsIndexPage.tsx` — deleted.
- `frontend/src/router.tsx` — remove the `ConversationsIndexPage` route;
  add the new landing view as the `index: true` route.
- `frontend/src/pages/` — new landing view component (e.g.
  `NewChatPage.tsx`) implementing requirements 7–10.
- `frontend/src/components/chat/Composer.tsx` — restyled per requirements
  11–15; extended with the four control buttons and the shared
  no-op/tooltip handling; usable both standalone (landing) and within
  `ChatPage`.
- `frontend/src/pages/ChatPage.tsx` — header simplification (requirements
  20–21), centered max-width column wrapper (requirement 16), reuse of
  the shared `Composer`.
- `frontend/src/components/chat/MessageBubble.tsx` — assistant/user
  visual split (requirements 17–18).
- `frontend/src/components/ui/IconButton.tsx` / `Tooltip.tsx` — reused
  as-is for the new inert controls and floating toggle; no changes
  expected, but confirm existing props cover the new use cases during
  implementation.
- No backend files change.

## Feature-specific rules

- The four inert controls and the floating reopen-sidebar button are the
  only net-new interactive elements; every other interaction in this
  spec re-wires existing handlers (`createConversation`, `streamMessage`,
  `handleToggleRail`-equivalent, theme `cycle`) rather than introducing
  new ones — consistent with "no business logic changes."
- Per CLAUDE.md's data-access-layer convention: this feature adds no new
  resource and touches no repository — it is pure frontend markup/styling
  plus one small piece of new client-side orchestration (requirement 8's
  create-then-send-then-navigate sequence), which is UI orchestration,
  not a backend concern.

## Open questions

None outstanding — all decision points raised during brainstorming (new
Chat creation timing, message bubble asymmetry, retiring the grid page,
sidebar collapse semantics, the reopen-sidebar affordance, and
placeholder-control feel) were resolved with the user before this spec
was drafted; see requirements 7–10, 17–18, 9, and 4/14 respectively for
where each decision landed.
