# 011 — Frontend: Chat View

Depends on: backend specs **004-chat-endpoint** and **009-cancellation**,
frontend spec **010-frontend-conversations** (app shell + `api.ts`
foundation). Blocks: **012-streaming**.

## Problem statement

Spec 010 gives the user a conversation list and an app shell that
switches to a chat view when a conversation is selected — but the chat
view itself is a placeholder. This spec builds it: message history, a
send box, the pending state while the assistant is generating, a Cancel
control, error display, and a way back to the list.

Two backend behaviours make this non-trivial and drive most of the spec:

1. `GET /conversations/{id}/messages` returns messages **chronologically
   ascending with `offset` counting from the oldest** — but a chat view
   wants the *newest* messages on open.
2. Cancellation (spec 009) aborts the server-side generation task, which
   **breaks the in-flight `sendMessage` HTTP request**. The pending
   promise rejects with a network-level failure that must be presented as
   "cancelled", not as a crash.

## Functional requirements

1. **FR1** — When `selectedConversationId` is a number, `App.tsx` renders
   `<ChatView conversationId={id} onBack={…} />` instead of the list.
2. **FR2** — On mount the chat view fetches the conversation
   (`getConversation`, for the header title) and the **newest page** of
   messages (see FR3). Header shows the title, or `Conversation #{id}`
   until it loads.
3. **FR3** — Newest-messages load, given the API's ascending order:
   call `listMessages(id, 50, 0)`; if the returned `total <= 50` those
   items are the whole conversation and are used as-is; if `total > 50`,
   immediately issue a second call with `offset = total - 50` and use
   that page. This spec **commits to this two-call approach** — one
   round trip in the common case, two only once a conversation exceeds
   50 messages. (Rejected alternative: adding an `order=desc` query
   param — that is a backend change and spec 002 committed to ASC.)
4. **FR4** — When the loaded window does not start at the beginning
   (`oldestOffset > 0`), a "Load older messages" button appears above the
   history. Clicking it fetches
   `listMessages(id, oldestOffset - newOffset, newOffset)` where
   `newOffset = Math.max(0, oldestOffset - 50)` — a non-overlapping
   slice — and **prepends** the items without changing scroll position.
   The button disappears at `oldestOffset === 0`.
5. **FR5** — Messages render oldest-at-top, newest-at-bottom, each
   labelled by role (`user` / `assistant`) with visually distinct
   alignment or background, plus its `created_at` formatted via
   `toLocaleString()`. Content preserves line breaks
   (`whiteSpace: 'pre-wrap'`).
6. **FR6** — A conversation with zero messages shows "No messages yet.
   Send the first one below." — this is the normal state right after
   "New conversation", not an error.
7. **FR7** — The send box is a `<textarea>` plus a "Send" button. Enter
   sends; Shift+Enter inserts a newline.
8. **FR8** — "Send" is **disabled** when the draft is empty or
   whitespace-only (`draft.trim() === ''`), and while a send is in
   flight. Empty content is never sent — the backend would return a
   guaranteed 422 (spec 004's `MessageCreate` validator) and the round
   trip is pointless.
9. **FR9** — On send: the draft is cleared and the user's text is
   rendered **optimistically** at the bottom of the history in a
   visually pending style, before the response arrives.
10. **FR10** — While a send is in flight, a pending indicator
    ("Assistant is thinking…") shows below the optimistic message, the
    textarea and Send are disabled, and a **Cancel** button is visible.
11. **FR11** — On success the response `ChatTurnRead` is reconciled into
    the history: the optimistic entry is dropped and
    `turn.user_message` and `turn.assistant_message` are appended, so
    the user message appears exactly once, with its real server `id` and
    `created_at`.
12. **FR12** — The Cancel button is rendered **only** while a send is in
    flight. Clicking it calls `cancelGeneration(id)` and puts the view
    into a "cancel requested" mode (see "Cancellation wiring").
13. **FR13** — A successful cancellation shows the neutral, non-alarming
    notice "Generation cancelled. Your message was kept." — never a raw
    network error — and the history is re-synced from the server so the
    stored user message is shown with no assistant reply.
14. **FR14** — Failures show a single notice area above the send box,
    with a **distinct human-readable message per status**: 404, 409 on
    send, 409 on cancel, 502, and unreachable-backend are all
    distinguishable by the user (see "Error handling and edge cases").
15. **FR15** — A "← Conversations" button in the header returns to the
    list by setting `selectedConversationId` to `null` (which per spec
    010's FR10 re-fetches the list, surfacing any auto-generated title).
    It is available at all times, including while a send is pending.
16. **FR16** — The history auto-scrolls to the bottom when a message is
    added or the pending indicator appears; it does **not** auto-scroll
    after "Load older messages".
17. **FR17** — All backend calls go through typed functions in
    `src/api.ts`. No `fetch` in any component.

## Non-functional requirements

- No new npm dependencies (no markdown renderer, no date library, no UI
  kit). Assistant content renders as plain text — **not** as HTML, and
  never via `dangerouslySetInnerHTML`; model output is untrusted input.
- Styling matches the scaffold: inline `style={{…}}` objects,
  `fontFamily: 'sans-serif'`.
- No polling, no websockets, no auto-refresh timer. The assistant reply
  arrives as the response to the single `POST` — spec 012 replaces this
  with SSE streaming later; nothing here should pre-empt that.
- One in-flight send per conversation at a time, enforced client-side by
  the disabled Send button; the backend's 409 (spec 009) is the
  authoritative guard.
- TypeScript `strict`; no `any` in exported signatures.

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

export type CancelResult = {
  conversation_id: number
  cancelled: boolean
}
```

`Page<T>`, `ConversationRead`, `ApiError` and the private `request<T>`
helper come from spec 010 and are **reused unchanged** — do not
redefine them, do not add a second error type.

### Component state shape

All chat state lives in `ChatView.tsx`. `App.tsx` gains nothing beyond
the `selectedConversationId` it already has from spec 010; `ChatView`
takes exactly two props: `conversationId: number` and `onBack: () => void`.

| State | Type | Purpose |
|---|---|---|
| `conversation` | `ConversationRead \| null` | header title |
| `messages` | `MessageRead[]` | loaded window, ascending |
| `total` | `number` | envelope `total`, drives the newest-page jump |
| `oldestOffset` | `number` | offset of `messages[0]`; drives FR4 |
| `historyLoading` | `boolean` | initial load / resync in flight |
| `historyError` | `string \| null` | history load failed; shows a "Reload messages" button |
| `gone` | `boolean` | conversation 404'd — send box hidden, back button emphasised |
| `draft` | `string` | textarea content |
| `sending` | `boolean` | `sendMessage` in flight; gates Send/Cancel/textarea |
| `pendingUserText` | `string \| null` | the optimistic user message (FR9) |
| `cancelling` | `boolean` | the cancel POST itself is in flight; disables Cancel |
| `notice` | `{ kind: 'info' \| 'error'; text: string } \| null` | the single notice area (FR14) |

Plus two refs:

| Ref | Type | Why a ref, not state |
|---|---|---|
| `cancelRequestedRef` | `useRef<boolean>` | read inside the async `sendMessage` `catch`, which closes over stale state; **this ref is what makes the cancel path work** |
| `suppressAutoScrollRef` | `useRef<boolean>` | set before a "Load older" fetch so FR16's scroll effect skips once |

**Why `pendingUserText` is separate from `messages`** (rather than
pushing a fake `MessageRead` with a placeholder id): the optimistic entry
is rendered *after* the `messages` array, so reconciliation (FR11) is
"append the two real messages, clear `pendingUserText`" — there is no
splice-by-fake-id step and therefore no way to duplicate or orphan it.

## API contracts

Appended to `src/api.ts`, all built on spec 010's `request<T>` helper.

| Function | Backend endpoint | Signature |
|---|---|---|
| `listMessages` | `GET /conversations/{id}/messages` | `(conversationId: number, limit: number, offset: number) => Promise<Page<MessageRead>>` |
| `sendMessage` | `POST /conversations/{id}/messages` | `(conversationId: number, content: string) => Promise<ChatTurnRead>` |
| `cancelGeneration` | `POST /conversations/{id}/cancel` | `(conversationId: number) => Promise<CancelResult>` |

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

export async function cancelGeneration(conversationId: number): Promise<CancelResult> {
  return request<CancelResult>(`/conversations/${conversationId}/cancel`, { method: 'POST' })
}
```

`sendMessage` has **no client timeout and no `AbortController`** — see
"Cancellation wiring" for why.

## Constraints

- **No router** (spec 010's decision). Navigation stays
  `selectedConversationId` in `App.tsx`. Consequences restated because
  they bite hardest here: a chat is **not deep-linkable**, the browser
  Back button **leaves the app** rather than returning to the list, and
  a page reload during a pending generation drops the client's view of
  it (the server-side generation continues; the message lands in the DB
  and appears on the next load).
- **No `AbortController` on `sendMessage`.** Cancellation must be
  server-side: the backend has to receive `POST /cancel` so it can abort
  the provider call and emit the `status=cancelled` inference log (spec
  009). Aborting the fetch client-side would leave the server generating
  and burning tokens. This is the one place an implementer's instinct is
  wrong — do not "improve" it.
- **No log-viewing UI in v1.** The `/logs` API is API-only per the design
  doc (Flow 6). Do not add a "view logs for this conversation" link,
  panel, request-id badge, or debug drawer. The observability surface is
  the API and the DB.
- No streaming. The assistant reply appears all at once when the POST
  resolves. SSE is spec 012.
- No markdown/HTML rendering of model output; plain text only.
- No message editing, deletion, retry-button, or copy-to-clipboard
  affordances — none are in scope for v1.
- No new npm dependencies.

## Cancellation wiring

The trickiest part of this feature. Two independent HTTP requests are in
play: the pending `sendMessage` POST, and the `cancelGeneration` POST.

**What actually happens on the wire.** When the backend cancels the
generation task, the request handling `sendMessage` never produces a
normal response. The client sees *either* a closed connection (the
browser's `fetch` rejects with a `TypeError`, which spec 010's helper
maps to `ApiError(status: 0)`) *or*, depending on how the ASGI server
unwinds the cancelled task, a `5xx`. **The spec deliberately does not
depend on which one occurs.** The rule is written to cover both.

**The rule:** while `cancelRequestedRef.current === true`, *any*
non-success outcome of the pending `sendMessage` — rejection or error
status — is presented as a cancellation, not as an error.

### Send handler

1. Guard: return early if `sending` or `draft.trim() === ''`.
2. `const content = draft.trim()`; clear `draft`; set
   `pendingUserText = content`, `sending = true`, `notice = null`,
   `cancelRequestedRef.current = false`.
3. `await sendMessage(conversationId, content)`.
   - **Success**: append `turn.user_message` and `turn.assistant_message`
     to `messages`, `total += 2`, clear `notice` (this discards a stale
     "nothing to cancel" notice from a lost race).
   - **Failure**: if `cancelRequestedRef.current` → set
     `notice = { kind: 'info', text: 'Generation cancelled. Your message was kept.' }`.
     Otherwise map the status per the error table below.
     Then, in both cases, `await resyncNewest()` (the FR3 load) so the
     history reflects exactly what the server stored. Awaiting *inside*
     the catch means step 4 runs after the resync, so the optimistic
     message is only removed once the real one is on screen — no flicker,
     no gap. If the resync itself fails, leave `messages` untouched and
     set `historyError` so the "Reload messages" button appears.
4. `finally`: `sending = false`, `pendingUserText = null`,
   `cancelRequestedRef.current = false`, `cancelling = false`.

### Cancel handler

1. Only reachable while `sending === true` (the button is not rendered
   otherwise) and `cancelling === false` (it disables itself).
2. Set `cancelRequestedRef.current = true` **before** awaiting the cancel
   POST — the `sendMessage` rejection can arrive first.
3. Set `cancelling = true`; `await cancelGeneration(conversationId)`.
   - **Success** (`cancelled: true`): do nothing further. The pending
     `sendMessage` rejection (step 3 above) renders the cancelled notice.
   - **409** — the generation already finished, or was never registered
     (the cancel raced completion; design doc edge case 5). Reset
     `cancelRequestedRef.current = false` so a genuine later failure is
     not mislabelled as a cancellation, and show
     `{ kind: 'info', text: 'Nothing to cancel — the response may have already arrived.' }`.
     Do **not** touch `sending`; let the in-flight send resolve normally,
     which clears this notice on success.
   - **404** — reset `cancelRequestedRef.current = false`, set `gone = true`,
     show "This conversation no longer exists."
   - **status 0 / anything else** — reset
     `cancelRequestedRef.current = false` and show
     `{ kind: 'error', text: 'Could not cancel: ' + err.detail }`. The
     pending send then reports its own outcome honestly.
4. `finally`: `cancelling = false`.

`cancelled: false` in a 200 `CancelResult` is not expected (spec 009
returns 409 for that case); if it occurs, treat it exactly like the 409
branch.

## Error handling and edge cases

| # | Case | UI behaviour |
|---|---|---|
| 1 | Empty chat (conversation exists, zero messages) | FR6 empty-state text. Send box enabled. Not an error. |
| 2 | Empty / whitespace-only draft | Send button `disabled`; Enter does nothing. **No request is made** — the backend's 422 is guaranteed, so the round trip is skipped by design (FR8). |
| 3 | Double-clicking Send | Send is `disabled` while `sending === true`, so the second click is a no-op. No debounce; no second POST. |
| 4 | Backend unreachable on history load (`ApiError.status === 0`) | History area shows "Cannot reach the backend. Is it running?" and a "Reload messages" button. Send box is disabled while `historyError` is set and `messages` is empty. |
| 5 | Backend unreachable on send | Notice (error): "Cannot reach the backend — your message may not have been saved." Then a resync attempt; if it succeeds the history shows the truth either way. |
| 6 | **404** on load / send / cancel | `gone = true`. Notice (error): "This conversation no longer exists." Send box and Cancel are hidden; the "← Conversations" button is emphasised as the only action. |
| 7 | **409 on send** — a generation is already in flight for this conversation | Notice (error): "A response is already being generated for this conversation. Wait for it to finish, or cancel it." Reachable when a second browser tab has the same conversation open, or a server-side registry entry is stuck. The optimistic message is dropped by the resync (nothing new was stored). |
| 8 | **409 on cancel** — nothing in progress | Notice (info): "Nothing to cancel — the response may have already arrived." Not styled as an error; it is usually a race the user won. |
| 9 | **502** — provider error | Notice (error): "The model provider failed to respond. Your message was saved — you can send it again." Then resync: the user message reappears (the backend kept it, per design doc edge case 6) with **no** assistant reply, and it is **not duplicated** because the optimistic entry was never in `messages`. |
| 10 | 422 on send | Notice (error): "Message could not be sent (invalid content)." Should be unreachable given #2; if seen, treat as a bug in the client-side guard. |
| 11 | Cancel clicked after the response already arrived | The Cancel button is only rendered while `sending === true`, so it is gone. The narrow race — a click in the instant before the response resolves — lands in the 409 branch (#8), and the assistant reply still renders. |
| 12 | Cancel clicked twice | Cancel is `disabled` while `cancelling === true`; the second click is a no-op (a real second POST would 409). |
| 13 | Cancel succeeds | Notice (info) per FR13, resync shows the stored user message with no assistant reply, `sending` clears, the send box re-enables and the user can send again immediately (design doc Flow 4). **No raw network error text ever reaches the screen.** |
| 14 | Very long message typed | No client-side length cap (the backend imposes none). The textarea has `maxHeight: 200, overflowY: 'auto'`; bubbles use `whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'` so nothing overflows horizontally. A message large enough to exceed the provider's context or token limits fails as a 502 (#9) with the provider's detail. |
| 15 | Very long assistant reply | Same wrapping rules; the history container scrolls, the page does not grow horizontally. |
| 16 | Conversation title is still the default `"New conversation"` | Header renders it as-is with a muted "(untitled)" suffix, matching spec 010's FR12. Auto-titling (spec 008) is asynchronous and the header does **not** poll for it; the current title is whatever `getConversation` returned on mount. |
| 17 | More than 50 messages | FR3's two-call newest-page load; "Load older messages" (FR4) walks backwards 50 at a time. |
| 18 | Second newest-page call returns an empty page (`total` shrank between the two calls) | Keep the first call's items rather than rendering an empty history. Single-user v1 makes this near-impossible; the guard is one line. |
| 19 | User clicks "← Conversations" while a send is pending | Navigation proceeds; `ChatView` unmounts. The server-side generation continues to completion and the assistant message is stored — it will be there on the next open. State updates from the unmounted component must be guarded (a `mountedRef` checked before each `setState` in async paths) so React does not warn. |

## Acceptance criteria

Verified **manually** against a running backend (`make backend`) and
frontend (`make frontend`) with a real `ANTHROPIC_API_KEY`. The project
has **no frontend test setup** (no vitest, no jest, no
testing-library) and this spec does not add one.

- [ ] Given a brand-new conversation, when I open it, then the header
      shows its title and "No messages yet. Send the first one below."
- [ ] Given an empty draft, when I look at the Send button, then it is
      disabled; typing only spaces keeps it disabled; typing a character
      enables it.
- [ ] Given a typed message, when I press Enter, then the draft clears,
      my message appears immediately at the bottom in a pending style,
      "Assistant is thinking…" appears, and the Cancel button appears.
- [ ] Given the assistant replies, when the response arrives, then my
      message appears **exactly once** (not twice) followed by the
      assistant's reply, the pending indicator and Cancel button are
      gone, and the send box is re-enabled.
- [ ] Given I press Shift+Enter, then a newline is inserted and nothing
      is sent.
- [ ] Given a reply is pending, when I click Cancel, then within a
      moment the screen shows "Generation cancelled. Your message was
      kept." — **no** "Failed to fetch", "NetworkError", or 500 text
      anywhere — my message is still in the history, there is no
      assistant reply, and I can immediately send another message.
- [ ] Given a reply is pending, when I click Cancel twice quickly, then
      the button is disabled after the first click and no "nothing to
      cancel" error is produced by my own second click.
- [ ] Given a reply that arrives just as I click Cancel, then I see
      "Nothing to cancel — the response may have already arrived." (or
      the reply simply renders) and the assistant message is preserved.
- [ ] Given an invalid `ANTHROPIC_API_KEY` (forcing a 502), when I send,
      then I see "The model provider failed to respond. Your message was
      saved — you can send it again.", my message is in the history
      exactly once, and sending again works after fixing the key.
- [ ] Given the backend is stopped, when I send, then I see the
      unreachable-backend message, not a blank screen or a console-only
      error.
- [ ] Given a second browser tab sends to the same conversation while
      this tab has a send pending, then the losing tab shows "A response
      is already being generated for this conversation…".
- [ ] Given a conversation with 60+ messages, when I open it, then the
      **most recent** messages are on screen (not the oldest) and a
      "Load older messages" button is present; clicking it prepends
      older messages without jumping the scroll position, and disappears
      once the first message is loaded.
- [ ] Given a 3000-character message, when I send it, then neither the
      send box nor the history causes horizontal page scrolling.
- [ ] Given I click "← Conversations", then I return to the list and the
      list has re-fetched (an auto-generated title is now visible).
- [ ] Given the conversation was auto-titled after I opened the chat,
      when I look at the chat header, then it still shows the old title
      — expected: there is no polling. It updates on the next open.
- [ ] There is no logs UI anywhere in the app.
- [ ] `grep -rn "fetch(" frontend/src --include=*.tsx` returns nothing;
      `grep -rn "AbortController" frontend/src` returns nothing.

## Files to be changed

| File | Change | Purpose |
|---|---|---|
| `frontend/src/api.ts` | modify | Add `MessageRole`, `MessageRead`, `MessageCreate`, `ChatTurnRead`, `CancelResult` and the three functions `listMessages`, `sendMessage`, `cancelGeneration`. Reuses spec 010's `request<T>`, `ApiError`, and `Page<T>` — nothing shared is redefined. |
| `frontend/src/App.tsx` | modify | Replace spec 010's placeholder branch with `<ChatView conversationId={selectedConversationId} onBack={() => setSelectedConversationId(null)} />`. No new state. |
| `frontend/src/components/ChatView.tsx` | **new** | The whole chat view: history load (FR3/FR4), message rendering, send box, optimistic send + reconciliation, pending state, cancel wiring, notice area, back control, auto-scroll. |

**Justifying one new file, not several:** the chat view is a single
cohesive unit of state — splitting `MessageList`, `SendBox`, and
`NoticeBar` into separate components would mean threading ~8 pieces of
state through props for no reuse, which CLAUDE.md's
no-premature-abstraction rule prohibits. It sits in `components/`
alongside spec 010's `ConversationList.tsx` so `App.tsx` stays a thin
shell. No barrel file, no shared UI layer, no custom hooks module.

**Not changed:** nothing under `backend/`. No `package.json` change. No
frontend test file — the project has no frontend test setup, and per
CLAUDE.md tests are created only via the `generate-tests` skill, which
covers pytest only.

## Feature-specific rules

- **No router.** `selectedConversationId` in `App.tsx` remains the only
  navigation mechanism (spec 010's decision). No deep links to a
  conversation, no working browser Back button, no URL state. Do not add
  `react-router` or `history.pushState` handling as part of this spec.
- **Styling**: inline style objects matching the existing scaffold. No
  UI library, no CSS framework, no CSS-in-JS, no icon package.
- **No polling, no websockets, no auto-refresh.** The chat view fetches
  on mount and on explicit user action only. A title generated by spec
  008 while the chat is open will not appear until the view is
  re-opened; that is the accepted design.
- **No log-viewing UI in v1** — the `/logs` API is API-only (design doc
  Flow 6). No logs link, panel, drawer, or request-id display.
- **No client-side abort** of `sendMessage`; cancellation is a
  server-side operation via `POST /conversations/{id}/cancel`.
- **No inline `fetch` in components** (CLAUDE.md); everything goes
  through `src/api.ts`.
- **No new npm dependencies.**
- Model output renders as plain text — never `dangerouslySetInnerHTML`.

## Open questions

- **What the browser sees when the server cancels mid-request.** Assumed
  the `sendMessage` fetch either rejects at the network layer or returns
  a `5xx`; the spec's rule ("any failure while `cancelRequestedRef` is
  true is a cancellation") covers both, so no behaviour depends on the
  answer. Worth **observing once during implementation** and recording
  the actual outcome in the code comment — it matters for spec 012,
  where an SSE stream fails differently.
- **History page size.** Assumed 50 messages per window for both the
  newest-page load and "Load older"; confirm before build.
- **Timestamp timezone.** Same open question as spec 010: if the backend
  serialises naive UTC datetimes without an offset, message times
  display with a skew. Assumed acceptable for a single-user demo;
  confirm — the fix is backend-side.
