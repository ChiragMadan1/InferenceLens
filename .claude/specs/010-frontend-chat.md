# 010 — Frontend: Chat Page

Depends on: backend spec **004-chat-endpoint**, frontend spec **009**
(foundation, design system, router, app shell, `api.ts`).
Blocks: **012-streaming**.

> **This spec supersedes the original 010.** The original committed to no
> router, no dependencies, inline `style={{…}}`, no cross-link to logs, and a
> Cancel control wired to a backend `POST /cancel` endpoint. Routing,
> dependencies, and styling were reversed by spec 009's stack decision.
> Cancellation has been descoped from the project entirely — spec 009 was
> removed and will not be built — so this page has no Cancel control: a send
> is a single request that runs to completion, success, or failure, same as
> any other POST in this app.

## Problem statement

Spec 009 routes `/c/:conversationId` to a placeholder. This spec builds the
chat page: message history, the composer, the pending state while the
assistant generates, error presentation, and the states for a conversation
that is empty or gone.

Two things make this the hardest screen in the app and drive most of the
spec:

1. `GET /conversations/{id}/messages` returns messages **chronologically
   ascending with `offset` counting from the oldest** — but a chat opens onto
   the *newest* messages.
2. A chat is a scroll container whose content changes underneath the user. Auto-
   scroll that fights the reader is worse than none, so scroll behaviour is
   specified per event rather than left to a `scrollIntoView` on every render.

**In scope:** the `/c/:conversationId` page and everything on it. **Out of
scope:** streaming (012 — nothing here may pre-empt it), cancelling an
in-flight generation (descoped project-wide; there is no backend endpoint to
call), message editing or deletion, retry-send, search, attachments, a
markdown renderer (see FR12), and the logs dashboard itself (015 — this spec
only links to it).

## Functional requirements

### Route and header

1. **FR1** — The page reads `conversationId` from `useParams`. A param that is
   not a positive integer renders the not-found panel **without issuing any
   request**.
2. **FR2** — On mount the page fetches the conversation (`getConversation`,
   for the header) and the **newest page** of messages (FR3). The header shows
   the title, or `Conversation #{id}` until it loads, plus a status chip and
   the message count in mono.
3. **FR3** — Newest-messages load, given the API's ascending order: call
   `listMessages(id, 50, 0)`; if the returned `total <= 50` those items are the
   whole conversation and are used as-is; if `total > 50`, immediately issue a
   second call with `offset = total - 50` and use that page. This spec
   **commits to the two-call approach** — one round trip in the common case,
   two only once a conversation exceeds 50 messages. (Rejected: an `order=desc`
   query param — a backend change, and spec 002 committed to ASC.)
4. **FR4** — When the loaded window does not start at the beginning
   (`oldestOffset > 0`), a "Load older messages" control appears above the
   history. It fetches `listMessages(id, oldestOffset - newOffset, newOffset)`
   where `newOffset = Math.max(0, oldestOffset - 50)` — a non-overlapping
   slice — and **prepends** the items **without moving the reader's scroll
   position** (FR17). The control disappears at `oldestOffset === 0`, replaced
   by a hairline "Beginning of conversation" marker.
5. **FR5** — The header carries a "← Conversations" link to `/`, and — once
   spec 015 lands — a "View inference logs" link to
   `/logs?conversation_id={id}`. Both are available at all times, including
   while a send is pending.

### Message history

6. **FR6** — Messages render oldest-at-top, newest-at-bottom. Role is encoded
   **three ways, not by colour alone**: alignment (user right, assistant
   left), surface (user on a signal-tinted surface, assistant on
   `--color-surface`), and a role label in `micro` type. Each message shows
   its `created_at` in mono `sm`.
7. **FR7** — Message content preserves line breaks and cannot overflow
   horizontally: `whitespace-pre-wrap` plus `overflow-wrap: anywhere`.
   Assistant content renders as **plain text**, never as HTML, and never via
   `dangerouslySetInnerHTML` — model output is untrusted input.
8. **FR8** — A conversation with zero messages shows the empty state "Send
   the first message" with one line of body copy and focus placed in the
   composer. This is the normal state right after "New conversation", not an
   error.
9. **FR9** — Each message has a hover/focus-revealed "Copy" action that copies
   its raw text via `navigator.clipboard` and confirms with a 1.5s "Copied"
   state on the control itself. The control is keyboard-reachable, not
   hover-only.
10. **FR10** — New messages enter with the 009 motion vocabulary: opacity plus
    a 6px upward translate over `--dur-base` with `--ease-out`. Messages
    already on screen do not re-animate. Under reduced motion, opacity only.
11. **FR11** — A new assistant message is announced to assistive technology
    via an `aria-live="polite"` region containing the assistant's text. The
    pending indicator announces "Assistant is responding" once, not
    repeatedly.
12. **FR12** — **Fenced code blocks are detected and rendered as code**
    without a markdown dependency: content is split on the ``` fence pattern,
    fence segments render in a `--color-surface-sunken` block with mono type,
    horizontal scroll, the language label if present, and a copy button; text
    segments render as FR7 plain text. **No other markdown is interpreted** —
    no headings, bold, links, tables, or lists. This is the deliberate 80%
    solution: fenced code is the one construct whose loss makes model output
    genuinely unreadable, and detecting a fence is a `split()`, whereas
    real markdown means `react-markdown` + `rehype-sanitize` + a highlighter.
    See "Open questions".

### Composer

13. **FR13** — The composer is an auto-growing `<textarea>` (min 1 row, max
    200px then internal scroll) plus a send control. Enter sends;
    Shift+Enter inserts a newline. The composer is sticky to the bottom of the
    page and never covered by the history.
14. **FR14** — Send is **disabled** when `draft.trim() === ''` and while a
    send is in flight. Empty content is never sent — the backend would return
    a guaranteed 422 (spec 004's `MessageCreate` validator), so the round trip
    is skipped by design.
15. **FR15** — On send: the draft clears and the user's text renders
    **optimistically** at the bottom of the history in a pending style —
    reduced opacity plus a mono "sending" label — before the response arrives.
16. **FR16** — While a send is in flight: an "Assistant is responding"
    indicator appears below the optimistic message, and the textarea and send
    control are disabled. There is no Cancel control — a pending generation
    always runs to completion.

### Scroll behaviour

17. **FR17** — Scroll rules, one per event, and no `scrollIntoView` on every
    render:

    | Event | Behaviour |
    |---|---|
    | Initial history load | Jump to bottom, no animation |
    | A message is appended, reader is at/near the bottom (within 120px) | Smooth-scroll to bottom |
    | A message is appended, reader has scrolled up | **Do not scroll.** Show a "Jump to latest" pill with an unread count |
    | The pending indicator appears | Same near-bottom rule as an appended message |
    | "Load older messages" prepends | **Preserve the reader's viewport anchor** — capture `scrollHeight` before the prepend and restore `scrollTop += (newHeight - oldHeight)` after, so the message under the cursor stays under the cursor |
    | Composer grows | No scroll change; the history's height shrinks and its bottom offset is retained |

18. **FR18** — The "Jump to latest" pill shows a count of messages added while
    scrolled up, scrolls smoothly to the bottom on click, and disappears once
    the bottom is reached. Under reduced motion the scroll is instant.

### Reconciliation and errors

19. **FR19** — On success the response `ChatTurnRead` is reconciled into the
    history: the optimistic entry is dropped and `turn.user_message` and
    `turn.assistant_message` are appended, so the user's message appears
    **exactly once**, with its real server `id` and `created_at`.
20. **FR20** — Failures show a single `NoticeBanner` above the composer with a
    **distinct human-readable message per status**: 404, 502, and
    unreachable-backend are all distinguishable by the user (see "Error
    handling and edge cases"). The banner is dismissible and animates in and
    out.
21. **FR21** — All backend calls go through typed functions in `src/api.ts`.
    No `fetch` in any component.

## Non-functional requirements

- **No new dependencies.** Spec 009's four are the budget; this spec adds
  none — no markdown renderer, no highlighter, no date library, no icon
  package, no virtualiser.
- **Design tokens only.** Every colour, size, radius, duration, and easing
  resolves to a token from spec 009's "Design system". No local values.
- **No polling, no websockets, no auto-refresh timer.** The assistant reply
  arrives as the response to the single POST. Spec 012 replaces this with SSE;
  nothing here may pre-empt that — in particular, no partial-response
  rendering, no chunked reader, and no client-side typewriter effect faking a
  stream.
- **One in-flight send per conversation within a tab**, enforced client-side
  by the disabled send control. There is no server-side guard: spec 004
  explicitly accepts a second, concurrent send (e.g. from a second tab) as v1
  behavior — both proceed independently, and this spec does not add a check
  for it.
- **A 500-message history renders without virtualisation.** At the 50-message
  window plus "Load older" this is a bounded DOM; a virtualiser is a
  dependency and a scroll-anchoring hazard, and is explicitly not added.
- **Accessibility:** the history is a labelled region, new assistant messages
  are announced once (FR11), and the composer has a visible label.
- **TypeScript `strict`**; no `any` in exported signatures.

## Data model

**No database changes.** Frontend-only — no SQLAlchemy model, no Alembic
migration, no backend file touched.

### TypeScript types (added to `src/api.ts`, mirroring backend Pydantic names)

```ts
export type MessageRole = 'user' | 'assistant'

export type MessageRead = {
  id: number
  conversation_id: number
  role: MessageRole
  content: string
  created_at: string
}

export type MessageCreate = {
  content: string
}

export type ChatTurnRead = {
  user_message: MessageRead
  assistant_message: MessageRead
}
```

`Page<T>`, `ConversationRead`, `ApiError` and the private `request<T>` helper
come from spec 009 and are **reused unchanged** — do not redefine them, and do
not add a second error type.

### Component state

Chat state lives in `ChatPage.tsx`. The page takes **no props** — it reads
`conversationId` from the URL (spec 009's FR-routing decision), which is what
makes a chat deep-linkable.

| State | Type | Purpose |
|---|---|---|
| `conversation` | `ConversationRead \| null` | header title and status |
| `messages` | `MessageRead[]` | loaded window, ascending |
| `total` | `number` | envelope `total`; drives the newest-page jump |
| `oldestOffset` | `number` | offset of `messages[0]`; drives FR4 |
| `historyLoading` | `boolean` | initial load / resync in flight |
| `loadingOlder` | `boolean` | the FR4 fetch, separate so it does not blank the history |
| `historyError` | `string \| null` | history load failed → "Reload messages" |
| `gone` | `boolean` | conversation 404'd — composer hidden, back link emphasised |
| `draft` | `string` | textarea content |
| `sending` | `boolean` | `sendMessage` in flight; gates send / textarea |
| `pendingUserText` | `string \| null` | the optimistic user message (FR15) |
| `notice` | `{ kind: 'info' \| 'error'; text: string } \| null` | the single notice slot (FR20) |
| `unreadCount` | `number` | drives the "Jump to latest" pill (FR18) |

Plus two refs:

| Ref | Why a ref, not state |
|---|---|
| `scrollAnchorRef` | Holds `scrollHeight` across a "Load older" fetch so FR17's anchor restoration is exact |
| `mountedRef` | Guards every `setState` in an async path (edge case 17) |

**Why `pendingUserText` is separate from `messages`** rather than pushing a
fake `MessageRead` with a placeholder id: the optimistic entry renders *after*
the `messages` array, so reconciliation (FR19) is "append the two real
messages, clear `pendingUserText`". There is no splice-by-fake-id step and
therefore no way to duplicate or orphan it.

Whether the reader is near the bottom is **measured on the scroll container at
the moment of the event**, not stored in state — storing it would go stale
between a scroll and a render.

## API contracts

Appended to `src/api.ts`, all built on spec 009's `request<T>` helper (and
therefore all instrumented into the signal ribbon for free).

| Function | Backend endpoint | Signature |
|---|---|---|
| `listMessages` | `GET /conversations/{id}/messages` | `(conversationId: number, limit: number, offset: number) => Promise<Page<MessageRead>>` |
| `sendMessage` | `POST /conversations/{id}/messages` | `(conversationId: number, content: string) => Promise<ChatTurnRead>` |

```ts
export async function listMessages(
  conversationId: number, limit: number, offset: number,
): Promise<Page<MessageRead>> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return request<Page<MessageRead>>(`/conversations/${conversationId}/messages?${qs}`)
}

export async function sendMessage(
  conversationId: number, content: string,
): Promise<ChatTurnRead> {
  const body: MessageCreate = { content }
  return request<ChatTurnRead>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
```

`sendMessage` has **no client timeout and no `AbortController`**: the request
runs until the backend responds, one way or another. There is nothing on the
client that can, or should, interrupt it.

**Note on `useResource`.** The history is *not* fetched through spec 009's
`useResource`: it is not a single request but a two-call newest-page load
(FR3) plus a prepending window walk (FR4) plus a resync path, over a
`messages` array that `sendMessage` mutates. `useResource` is used for
`getConversation` (the header) only. This is a stated exception, not an
oversight — do not force the history through it, and do not generalise
`useResource` to cover it.

### Send handler

1. Guard: return early if `sending` or `draft.trim() === ''`.
2. `const content = draft.trim()`; clear `draft`; set
   `pendingUserText = content`, `sending = true`, `notice = null`.
3. `await sendMessage(conversationId, content)`.
   - **Success**: append `turn.user_message` and `turn.assistant_message` to
     `messages`, `total += 2`, clear `notice`.
   - **Failure**: map the status per the error table below, then
     `await resyncNewest()` (the FR3 load) so the history reflects exactly
     what the server stored. Awaiting *inside* the catch means step 4 runs
     after the resync, so the optimistic message is only removed once the
     real one (or its absence) is confirmed on screen — no flicker, no gap.
     If the resync itself fails, leave `messages` untouched and set
     `historyError` so "Reload messages" appears.
4. `finally`: `sending = false`, `pendingUserText = null`.

## Constraints

- **No streaming, and nothing that imitates it.** The reply appears at once
  when the POST resolves. No typewriter effect over the completed text: it
  would have to be deleted for spec 012 and it lies about what is happening.
- **No markdown or HTML rendering of model output** beyond FR12's fenced-code
  split. Never `dangerouslySetInnerHTML`.
- **No message editing, deletion, or retry-send.** Copy (FR9) is the one
  affordance added over the original spec, because it is expected in a chat UI
  and costs one clipboard call.
- **No virtualisation** of the history (see NFRs).
- **No new npm dependencies.**
- Design tokens and motion rules come from spec 009 and are not re-decided
  here.
- A page reload during a pending generation drops the client's view of it. The
  server-side generation continues, the assistant message is stored, and it
  appears on the next load. Accepted, and now less painful than in the
  original spec: the URL is stable, so the reload returns to the same chat.

## Error handling and edge cases

| # | Case | Behaviour |
|---|---|---|
| 1 | Empty chat (conversation exists, zero messages) | FR8 empty state, composer focused and enabled. Not an error. |
| 2 | Empty / whitespace-only draft | Send disabled; Enter does nothing. **No request is made** — the backend's 422 is guaranteed, so the round trip is skipped (FR14). |
| 3 | Double-clicking Send | Disabled while `sending`, so the second click is a no-op. No debounce, no second POST. |
| 4 | Backend unreachable on history load (`ApiError.status === 0`) | History area shows "Cannot reach the backend. Is it running?" with "Reload messages". The composer is disabled while `historyError` is set **and** `messages` is empty. |
| 5 | Backend unreachable on send | Notice (error): "Cannot reach the backend — your message may not have been saved." Then a resync; if it succeeds the history shows the truth either way. |
| 6 | **404** on load / send | `gone = true`. Notice (error): "This conversation no longer exists." Composer hidden; "← Conversations" emphasised as the only action. |
| 7 | **502** — provider error | Notice (error): "The model provider failed to respond. Your message was saved — you can send it again." Then resync: the user message reappears (the backend kept it, per design doc edge case 6) with **no** assistant reply, and is **not duplicated** because the optimistic entry was never in `messages`. |
| 8 | 422 on send | Notice (error): "Message could not be sent (invalid content)." Should be unreachable given #2; if seen, it is a bug in the client-side guard. |
| 9 | Very long message typed | No client-side length cap (the backend imposes none). Textarea caps at 200px then scrolls internally; bubbles use `whitespace-pre-wrap` + `overflow-wrap: anywhere`. A message large enough to exceed the provider's context or token limits fails as a 502 (#7) with the provider's detail. |
| 10 | Very long assistant reply | Same wrapping. The history scrolls; the page never scrolls horizontally. |
| 11 | Assistant reply containing a fenced code block | FR12: the fence renders as a scrollable mono block with a copy button; surrounding text renders as plain text. Unbalanced fences (an odd number of ```) render the trailing segment as plain text rather than swallowing it. |
| 12 | Title still the default `"New conversation"` | Header renders it with an "untitled" chip, matching spec 009's FR19. Auto-titling (008) is asynchronous and the header does **not** poll; the title is whatever `getConversation` returned on mount. |
| 13 | More than 50 messages | FR3's two-call newest-page load; "Load older messages" (FR4) walks backwards 50 at a time, preserving the scroll anchor (FR17). |
| 14 | Second newest-page call returns an empty page (`total` shrank between the two calls) | Keep the first call's items rather than rendering an empty history. Single-user v1 makes this near-impossible; the guard is one line. |
| 15 | User navigates away while a send is pending | Navigation proceeds; `ChatPage` unmounts. The server-side generation continues to completion and the assistant message is stored — it is there on the next open. `mountedRef` guards every `setState` in an async path so React does not warn and no state is written to an unmounted tree. |
| 16 | User scrolled up when a reply arrives | **Do not scroll** (FR17). The "Jump to latest" pill appears with a count. |
| 17 | `/c/abc`, `/c/-1`, `/c/0` | Not-found panel, no request issued (FR1). |
| 18 | Clipboard write fails or `navigator.clipboard` is unavailable (non-secure origin) | The copy control shows "Copy failed" for 1.5s. It never throws and never breaks the message it belongs to. |
| 19 | Reduced motion enabled | Message entrance is opacity-only; "Jump to latest" scrolls instantly. All state remains conveyed by text and `aria-live`. |

## Acceptance criteria

Verified **manually** against a running backend (`make backend`) and frontend
(`make frontend`) with a real `OPENAI_API_KEY`. The project has **no frontend
test setup** and this spec does not add one — per CLAUDE.md, tests come only
from the `generate-tests` skill, which covers pytest.

**Core send/receive**

- [ ] Given a brand-new conversation, when I open it, the header shows its
      title and the history shows "Send the first message" with the composer
      focused.
- [ ] Given an empty draft, Send is disabled; typing only spaces keeps it
      disabled; typing a character enables it.
- [ ] Given a typed message, pressing Enter clears the draft, renders my
      message immediately at the bottom in a pending style, and shows
      "Assistant is responding" with Send disabled.
- [ ] Given the assistant replies, my message appears **exactly once** (not
      twice) followed by the reply, the pending indicator is gone, and the
      composer is re-enabled.
- [ ] Shift+Enter inserts a newline and sends nothing.
- [ ] The textarea grows as I type multiple lines and stops growing at ~200px,
      scrolling internally after that, without ever covering the history.

**Errors**

- [ ] With an invalid `OPENAI_API_KEY` (forcing a 502), sending shows "The
      model provider failed to respond. Your message was saved — you can send
      it again.", my message is in the history exactly once, and sending works
      after fixing the key.
- [ ] With the backend stopped, sending shows the unreachable-backend message
      — not a blank screen and not a console-only error.
- [ ] Visiting `/c/999999` shows "This conversation no longer exists." with
      the back link emphasised and no composer.
- [ ] Visiting `/c/abc` shows the not-found panel and the Network panel shows
      **no** request was issued.

**History and scroll**

- [ ] With a 60+ message conversation, opening it puts the **most recent**
      messages on screen (not the oldest) with "Load older messages" present.
- [ ] Clicking "Load older messages" prepends older messages and the message
      I was looking at stays exactly where it was on screen — no jump.
- [ ] Repeating that until the beginning replaces the control with the
      "Beginning of conversation" marker.
- [ ] Scrolling up and then receiving a reply does **not** move my scroll
      position, and a "Jump to latest" pill appears; clicking it scrolls to
      the bottom and the pill disappears.
- [ ] A 3000-character message causes no horizontal page scrolling in either
      the composer or the history.
- [ ] An assistant reply containing a ```-fenced code block renders it as a
      mono, horizontally scrollable block with a working copy button, and the
      surrounding prose as plain text.
- [ ] Clicking a message's Copy action puts its raw text on the clipboard and
      shows "Copied" for about 1.5s.

**Navigation, a11y, motion**

- [ ] Clicking "← Conversations" returns to `/` and the list has re-fetched
      (an auto-generated title is now visible).
- [ ] The browser Back button returns to the previous screen rather than
      leaving the app.
- [ ] Reloading the page on `/c/{id}` returns to the same conversation.
- [ ] Given the conversation was auto-titled after I opened the chat, the
      header still shows the old title — expected: there is no polling. It
      updates on the next open.
- [ ] A screen reader announces a new assistant message once, and announces
      "Assistant is responding" once when a send starts.
- [ ] Every interactive element on the page — back link, logs link, load-older
      control, each message's copy action, textarea, send — is reachable by
      keyboard with a visible focus ring.
- [ ] With OS "reduce motion" on, no message translates and jump-to-latest
      scrolls instantly.
- [ ] `grep -rn "fetch(" frontend/src --include=*.tsx` returns nothing;
      `grep -rn "AbortController" frontend/src` returns nothing;
      `grep -rn "dangerouslySetInnerHTML" frontend/src` returns nothing.
- [ ] `grep -rn "bg-\[#" frontend/src` returns nothing — no colours outside
      the token layer.

## Files to be changed

| File | Change | Purpose |
|---|---|---|
| `frontend/src/api.ts` | modify | Add `MessageRole`, `MessageRead`, `MessageCreate`, `ChatTurnRead` and `listMessages`, `sendMessage`. Reuses spec 009's `request<T>`, `ApiError`, `Page<T>` — nothing shared is redefined. |
| `frontend/src/pages/ChatPage.tsx` | **modify (replaces 009's placeholder)** | The page: param validation, header, history load (FR3/FR4), send + reconciliation, notice slot, scroll orchestration, gone/empty/error states. |
| `frontend/src/components/chat/MessageBubble.tsx` | **new** | One message: role encoding, timestamp, copy action, entrance animation, fenced-code split (FR12). |
| `frontend/src/components/chat/Composer.tsx` | **new** | Auto-growing textarea, keyboard handling, disabled states while sending. |
| `frontend/src/components/chat/PendingIndicator.tsx` | **new** | "Assistant is responding" with its `aria-live` announcement. |
| `frontend/src/hooks/useChatScroll.ts` | **new** | FR17's scroll rules and the anchor preservation, kept out of the page's render body. |

**On the file split.** The original spec argued for a single file. That held
when the whole view was one state blob with inline styles; it does not hold
now. The split is drawn where state is *not* shared: `MessageBubble` receives
one message, `Composer` receives the draft plus two booleans, and
`PendingIndicator` receives nothing. The scroll logic is a hook because it is
imperative DOM measurement that has no business in a render body. Everything
that shares state — the send handler, the history window, the notice — stays
in `ChatPage.tsx`. **Not created:** a `useChat` hook that re-exports the
page's whole state, a message-list component that only maps, a `NoticeBar`
(spec 009's `NoticeBanner` is used), or a context.

**Not changed:** anything under `backend/`. No `package.json` change. No
frontend test file.

## Feature-specific rules

- **No raw network error text reaches the screen** on any path. Every
  user-visible message comes from this spec's tables.
- **No streaming and no imitation of streaming.** No typewriter effect over a
  completed response — spec 012 owns real streaming and would have to delete
  it.
- **Fenced code is the only markdown construct handled** (FR12). Adding a
  markdown renderer is a dependency decision, not a component decision.
- **Scroll is event-driven, per FR17's table.** No `scrollIntoView` in an
  effect that runs on every render, and no `scroll-behavior: smooth` on the
  container (it would also smooth the initial jump and the anchor
  restoration).
- **The history does not use `useResource`** — see the note under "API
  contracts". Do not generalise `useResource` to accommodate it.
- **Design tokens and motion rules come from spec 009.** No local colour,
  size, duration, or easing.
- **No inline `fetch`, no `dangerouslySetInnerHTML`, no new dependency.**
- The "View inference logs" link (FR5) points at spec 015's route and is the
  **only** logs-related surface in this spec. No inline log panel, no
  request-id badge on messages, no debug drawer.

## Open questions

- **Markdown rendering.** Assumed **fenced code blocks only**, via a
  zero-dependency split (FR12). Full markdown means `react-markdown` +
  `rehype-sanitize` (+ a highlighter for real syntax colouring) — three or
  four packages and an XSS surface that has to be got right. Recommendation:
  ship FR12 in v1 and treat full markdown as its own small spec once there is
  a reason. Confirm before build.
- **History page size.** Assumed 50 messages per window for both the
  newest-page load and "Load older". Confirm before build.
- **Timestamp timezone — resolved, fix ships in spec 014.** Verified: the
  backend serialises timestamps without a UTC offset, so the browser reads them
  as local time and message times show a skew equal to the UTC offset. The fix
  is `014-logs-stats-api.md` → "Prerequisite fix: UTC serialisation". **No
  frontend workaround** — do not append a `Z` or coerce timezones in this spec.
  See spec 009's matching entry for the evidence.
- **"View inference logs" link.** Assumed present once spec 015 lands, deep-
  linking to `/logs?conversation_id={id}`. Confirm the design doc's
  "API-only observability in v1" position is superseded by the decision to
  build spec 015 — this spec assumes it is.
