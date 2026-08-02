import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { ApiError, createConversation } from '../api'
import { Composer } from '../components/chat/Composer'
import { NoticeBanner } from '../components/ui/NoticeBanner'

const DUR_BASE = 0.24
const EASE_OUT = [0.22, 1, 0.36, 1] as const

// The landing screen (spec 019 FR7-10): no conversation exists yet here.
// Sending the first message creates one, sends into it, and navigates to
// /c/:id carrying the draft so ChatPage can pick up the stream (see its
// initialDraft handling) — a refresh of "/" never litters an empty
// conversation because nothing is created until Send is pressed.
export function NewChatPage() {
  const navigate = useNavigate()
  const reducedMotion = useReducedMotion()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  async function handleSend() {
    if (starting || draft.trim() === '') return
    const content = draft.trim()
    setStarting(true)
    setError(null)
    try {
      const created = await createConversation()
      navigate(`/c/${created.id}`, { state: { initialDraft: content } })
    } catch (err) {
      setStarting(false)
      setError(err instanceof ApiError ? err.detail : 'Could not start a new conversation.')
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-4">
      <div className="relative flex w-full max-w-3xl flex-col items-center gap-6 text-center">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center">
          <div className="h-72 w-72 rounded-full bg-signal/15 blur-3xl" />
          <div className="absolute h-56 w-56 -translate-x-10 translate-y-6 rounded-full bg-accent/15 blur-3xl" />
        </div>

        <motion.h1
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR_BASE, ease: EASE_OUT }}
          className="text-display-lg font-display text-ink"
        >
          How can I help you today?
        </motion.h1>

        {error && (
          <div className="w-full max-w-md">
            <NoticeBanner kind="error" onDismiss={() => setError(null)}>
              {error}
            </NoticeBanner>
          </div>
        )}
      </div>

      <div className="w-full">
        <Composer
          ref={textareaRef}
          draft={draft}
          sending={starting}
          disabled={false}
          onDraftChange={setDraft}
          onSend={() => void handleSend()}
        />
      </div>
    </div>
  )
}
