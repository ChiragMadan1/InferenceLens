import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ApiError,
  getConversation,
  listMessages,
  streamMessage,
  type ChatTurnRead,
  type MessageRead,
} from '../api'
import { useResource } from '../hooks/useResource'
import { useChatScroll } from '../hooks/useChatScroll'
import { isDefaultTitle } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { NoticeBanner } from '../components/ui/NoticeBanner'
import { ScrollArea } from '../components/ui/ScrollArea'
import { Skeleton } from '../components/ui/Skeleton'
import { MessageBubble } from '../components/chat/MessageBubble'
import { Composer } from '../components/chat/Composer'
import { PendingIndicator } from '../components/chat/PendingIndicator'
import { NotFoundPage } from './NotFoundPage'

const POSITIVE_INTEGER = /^[1-9]\d*$/
const PAGE_SIZE = 50
const NOTICE_MOTION = { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const }

const dotIcon = (
  <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="3" r="3" />
  </svg>
)

const pendingIcon = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

type Notice = { kind: 'info' | 'error'; text: string }

function mapHistoryLoadError(err: ApiError | null): string {
  if (!err) return 'Something went wrong.'
  if (err.status === 0) return 'Cannot reach the backend. Is it running?'
  if (err.status === 404) return 'This conversation no longer exists.'
  return err.detail || 'Something went wrong.'
}

// FR25 — the mid-stream provider-failure notice, reused verbatim from
// 010's old 502 case. It's a fixed string, not derived from the SSE
// error event's `detail`, because there's no HTTP status to key off once
// streaming has started (see the endpoint's own "200 doesn't mean success"
// contract).
const MID_STREAM_FAILURE_NOTICE =
  'The model provider failed to respond. Your message was saved — you can send it again.'

// Maps a thrown ApiError from a pre-stream failure (404/409/422/status-0 —
// FR11's validation, which all happen before a single SSE byte is sent).
// 502 no longer appears here: the streaming endpoint never returns it, since
// a post-start provider failure is reported via the `error` SSE event
// (MID_STREAM_FAILURE_NOTICE above), not a thrown ApiError.
function mapSendError(err: ApiError | null): string {
  if (!err) return 'Something went wrong. Your message may not have been saved.'
  if (err.status === 0) return 'Cannot reach the backend — your message may not have been saved.'
  if (err.status === 404) return 'This conversation no longer exists.'
  if (err.status === 409) {
    return 'A response is already being generated for this conversation. Wait for it to finish.'
  }
  if (err.status === 422) return 'Message could not be sent (invalid content).'
  return err.detail || 'Something went wrong. Your message may not have been saved.'
}

// FR1 — an invalid param never issues a request: the regex check happens
// before any hook that could fetch, and the fetching component only mounts
// once the id is known-valid.
export function ChatPage() {
  const { conversationId } = useParams()

  if (!conversationId || !POSITIVE_INTEGER.test(conversationId)) {
    return <NotFoundPage />
  }

  // Keyed by conversationId: React Router reuses this component across a
  // param-only navigation, so without a key change a still-in-flight fetch
  // for the old conversation can resolve after the new one's state has
  // already reset and overwrite it with stale data.
  return <ChatPageContent key={conversationId} conversationId={Number(conversationId)} />
}

function ChatPageContent({ conversationId }: { conversationId: number }) {
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const scroll = useChatScroll()
  const location = useLocation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isFirstLoadRef = useRef(true)
  // Consumed at most once per mount — the landing screen (spec 019) hands
  // off a draft via location.state after creating this conversation.
  const initialDraftHandledRef = useRef(false)

  // FR2 — header only; independent of the messages-driven `gone`/error
  // state below (see "Note on useResource" in the spec).
  const { data: conversation } = useResource(() => getConversation(conversationId), [
    conversationId,
  ])

  const [messages, setMessages] = useState<MessageRead[]>([])
  const [total, setTotal] = useState(0)
  const [oldestOffset, setOldestOffset] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [gone, setGone] = useState(false)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false) // FR24 — now means "a stream is open"
  const [pendingUserText, setPendingUserText] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [liveAnnouncement, setLiveAnnouncement] = useState('')

  // FR3 — newest-page load. Reused for the failure-path resync (FR20/error
  // table), so it never blanks `messages` on failure — it only reports the
  // failure via `historyError` or `gone`.
  async function loadNewestPage(): Promise<boolean> {
    try {
      const first = await listMessages(conversationId, PAGE_SIZE, 0)
      let items = first.items
      let newOffset = 0
      if (first.total > PAGE_SIZE) {
        const second = await listMessages(conversationId, PAGE_SIZE, first.total - PAGE_SIZE)
        // Edge case 14 — total shrank between the two calls; keep the first
        // call's items rather than rendering an empty history.
        if (second.items.length > 0) {
          items = second.items
          newOffset = second.offset
        }
      }
      if (!mountedRef.current) return false

      if (isFirstLoadRef.current) {
        scroll.markInitialLoad()
      } else {
        scroll.markAppend()
      }
      isFirstLoadRef.current = false

      setMessages(items)
      setTotal(first.total)
      setOldestOffset(newOffset)
      setHistoryError(null)
      return true
    } catch (err) {
      if (!mountedRef.current) return false
      const apiErr = err instanceof ApiError ? err : null
      const message = mapHistoryLoadError(apiErr)
      if (apiErr?.status === 404) {
        setGone(true)
        setNotice({ kind: 'error', text: message })
      } else {
        setHistoryError(message)
      }
      return false
    } finally {
      if (mountedRef.current) setHistoryLoading(false)
    }
  }

  function handleReload() {
    setHistoryLoading(true)
    void loadNewestPage()
  }

  // FR4 — non-overlapping backwards walk, anchor-preserving prepend.
  async function loadOlder() {
    if (loadingOlder || oldestOffset <= 0) return
    setLoadingOlder(true)
    const newOffset = Math.max(0, oldestOffset - PAGE_SIZE)
    const limit = oldestOffset - newOffset
    try {
      const page = await listMessages(conversationId, limit, newOffset)
      if (!mountedRef.current) return
      scroll.markPrependStart()
      setMessages((prev) => [...page.items, ...prev])
      setOldestOffset(newOffset)
      setHistoryError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setHistoryError(err instanceof ApiError ? err.detail : 'Something went wrong.')
    } finally {
      if (mountedRef.current) setLoadingOlder(false)
    }
  }

  useEffect(() => {
    isFirstLoadRef.current = true
    setHistoryLoading(true)
    setHistoryError(null)
    setGone(false)
    setMessages([])
    setTotal(0)
    setOldestOffset(0)
    void loadNewestPage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // FR8 — empty conversation gets focus in the composer.
  useEffect(() => {
    if (!historyLoading && !gone && !historyError && messages.length === 0) {
      textareaRef.current?.focus()
    }
  }, [historyLoading, gone, historyError, messages.length])

  // Spec 019 FR8 — the landing screen creates this conversation and hands
  // off the first message via location.state rather than sending it itself,
  // so the send/stream flow only ever lives in one place. Only fires once,
  // and only while the conversation is still genuinely empty — a returning
  // visit (browser back, refresh) to the same history entry has messages
  // by then and this is a no-op.
  useEffect(() => {
    if (initialDraftHandledRef.current) return
    if (historyLoading || gone || historyError || messages.length > 0) return
    const state = location.state as { initialDraft?: string } | null
    const initialDraft = state?.initialDraft
    if (!initialDraft) return
    initialDraftHandledRef.current = true
    void handleSend(initialDraft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoading, gone, historyError, messages.length])

  // "Send handler" — FR24's four numbered steps, adapted for streaming.
  //
  // pendingUserText and streamingText are cleared with different timing on
  // failure: streamingText clears immediately in onError (the growing bubble
  // is *replaced* by the error banner — edge case 6's expected UX), while
  // pendingUserText stays set until the post-error resync's real messages
  // are already on screen, then clears in this function's own tail — same
  // "the optimistic entry is only dropped once the real state is on screen"
  // ordering 010 used (its catch block awaited the resync directly before
  // its finally cleared pendingUserText). Since onError/onDone's types are
  // plain callbacks (not awaited by streamMessage — FR21), that ordering has
  // to be reconstructed here via `needsResync` rather than inside the resync
  // itself.
  async function handleSend(overrideContent?: string) {
    const content = overrideContent ?? draft.trim()
    if (sending || content === '') return
    setDraft('')
    scroll.markAppend()
    scroll.beginStream()
    setPendingUserText(content)
    setStreamingText('')
    setSending(true)
    setNotice(null)
    // Cleared here (a separate commit before the awaited send resolves) so
    // two consecutive assistant replies with identical text still produce a
    // real DOM change on the aria-live region and both get announced (FR11).
    setLiveAnnouncement('')

    let needsResync = false

    try {
      await streamMessage(conversationId, content, {
        onChunk: (delta) => {
          if (mountedRef.current) {
            setStreamingText((prev) => (prev ?? '') + delta)
          }
        },
        onDone: (turn: ChatTurnRead) => {
          if (!mountedRef.current) return
          scroll.endStream()
          scroll.markAppend()
          setMessages((prev) => [...prev, turn.user_message, turn.assistant_message])
          setTotal((prev) => prev + 2)
          setNotice(null)
          setPendingUserText(null)
          setStreamingText(null)
          setLiveAnnouncement(turn.assistant_message.content)
        },
        onError: () => {
          scroll.endStream()
          needsResync = true
          if (mountedRef.current) {
            setStreamingText(null) // discard-partial — replaced by the notice below
            setNotice({ kind: 'error', text: MID_STREAM_FAILURE_NOTICE })
          }
        },
      })
    } catch (err) {
      scroll.endStream()
      needsResync = true
      const apiErr = err instanceof ApiError ? err : null
      if (mountedRef.current) {
        setStreamingText(null)
        setNotice({ kind: 'error', text: mapSendError(apiErr) })
        if (apiErr?.status === 404) setGone(true)
      }
    }

    if (needsResync) {
      await loadNewestPage()
    }

    if (mountedRef.current) {
      setSending(false)
      setPendingUserText(null)
      setStreamingText(null)
    }
  }

  if (gone) {
    return (
      <div className="flex min-h-full flex-col gap-4 p-6">
        {notice && (
          <NoticeBanner kind="error" onDismiss={() => setNotice(null)}>
            {notice.text}
          </NoticeBanner>
        )}
        <ErrorState
          heading="This conversation no longer exists."
          message="It may have been deleted, or the link is wrong."
          action={
            <Link to="/">
              <Button>← Conversations</Button>
            </Link>
          }
        />
      </div>
    )
  }

  const title = conversation?.title ?? `Conversation #${conversationId}`
  const untitled = conversation ? isDefaultTitle(conversation.title) : false
  const isEmpty = !historyLoading && !historyError && messages.length === 0
  const composerDisabled = historyError !== null && messages.length === 0

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 pb-2 pt-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-h2 font-display text-ink">{title}</h1>
          {untitled && (
            <Chip tone="neutral" icon={pendingIcon}>
              untitled
            </Chip>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {conversation && (
            <Chip tone="signal" icon={dotIcon}>
              {conversation.status}
            </Chip>
          )}
          <span className="font-data text-sm text-ink-muted">{total} messages</span>
          <Link
            to={`/logs?conversation_id=${conversationId}`}
            className="text-sm text-ink-secondary transition-colors duration-[var(--dur-instant)] ease-out hover:text-ink"
          >
            View inference logs
          </Link>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea
          ref={scroll.containerRef}
          role="region"
          aria-label="Message history"
          // Chromium's native scroll anchoring otherwise fights the FR17
          // anchor-preserving prepend in useChatScroll — both try to
          // compensate scrollTop for the same DOM growth.
          style={{ overflowAnchor: 'none' }}
          className="flex-1 py-3"
        >
        <div className="mx-auto w-full max-w-3xl px-4">
          {historyLoading && (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className={['flex', index % 2 === 0 ? 'justify-start' : 'justify-end'].join(' ')}>
                  <Skeleton variant="block" className="h-14 w-2/3" />
                </div>
              ))}
            </div>
          )}

          {!historyLoading && historyError && messages.length === 0 && (
            <ErrorState
              heading="Couldn't load messages"
              message={historyError}
              action={
                <Button variant="secondary" onClick={handleReload}>
                  Reload messages
                </Button>
              }
            />
          )}

          {isEmpty && (
            <EmptyState heading="Send the first message" body="Start the conversation below." />
          )}

          {!historyLoading && !isEmpty && !(historyError && messages.length === 0) && (
            <div className="flex flex-col gap-3">
              {historyError && (
                <NoticeBanner
                  kind="error"
                  action={
                    <Button size="sm" variant="secondary" onClick={handleReload}>
                      Try again
                    </Button>
                  }
                >
                  {historyError}
                </NoticeBanner>
              )}

              {oldestOffset > 0 ? (
                <div className="flex justify-center py-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void loadOlder()}
                    loading={loadingOlder}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? 'Loading…' : 'Load older messages'}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-3 py-1 text-micro uppercase text-ink-muted">
                  <span className="h-px flex-1 bg-hairline" />
                  Beginning of conversation
                  <span className="h-px flex-1 bg-hairline" />
                </div>
              )}

              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  role={message.role}
                  content={message.content}
                  createdAt={message.created_at}
                />
              ))}

              {pendingUserText !== null && (
                <MessageBubble role="user" content={pendingUserText} pending />
              )}

              {/* FR27 — before the first chunk, streamingText is still '',
                  so the indicator shows; the first onChunk call makes it
                  non-empty and the growing bubble takes over. Both read from
                  the same MessageBubble presentation (fenced-code split runs
                  again on every re-render) as a stored message. */}
              {streamingText !== null &&
                (streamingText === '' ? (
                  <PendingIndicator />
                ) : (
                  <MessageBubble role="assistant" content={streamingText} pending />
                ))}
            </div>
          )}
        </div>
        </ScrollArea>

        {scroll.unreadCount > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              onClick={scroll.jumpToLatest}
              className="pointer-events-auto rounded-full bg-signal px-4 py-1.5 text-sm font-medium text-canvas shadow-raised transition-opacity duration-[var(--dur-fast)] ease-out"
            >
              Jump to latest · {scroll.unreadCount}
            </button>
          </div>
        )}

        {/* FR11 — a new assistant message is announced once via this
            region's text changing; it never re-fires on unrelated renders. */}
        <span className="sr-only" aria-live="polite">
          {liveAnnouncement}
        </span>
      </div>

      <AnimatePresence>
        {notice && (
          <motion.div
            key="chat-notice"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={NOTICE_MOTION}
            className="mx-auto w-full max-w-3xl px-4 pt-3"
          >
            <NoticeBanner kind={notice.kind} onDismiss={() => setNotice(null)}>
              {notice.text}
            </NoticeBanner>
          </motion.div>
        )}
      </AnimatePresence>

      <Composer
        ref={textareaRef}
        draft={draft}
        sending={sending}
        disabled={composerDisabled}
        onDraftChange={setDraft}
        onSend={() => void handleSend()}
      />
    </div>
  )
}
