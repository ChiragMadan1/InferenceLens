import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import type { MessageRole } from '../../api'
import { formatDateTime } from '../../lib/format'

// Matches spec 009's --dur-base / --ease-out tokens (FR10). Framer-motion
// needs literal values, not CSS custom properties — same pattern as
// App.tsx's drawer transition.
const DUR_BASE = 0.24
const EASE_OUT = [0.22, 1, 0.36, 1] as const

type CopyStatus = 'idle' | 'copied' | 'failed'

function useCopyStatus(): [CopyStatus, (text: string) => void] {
  const [status, setStatus] = useState<CopyStatus>('idle')

  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => setStatus('copied'))
      .catch(() => setStatus('failed'))
      .finally(() => {
        setTimeout(() => setStatus('idle'), 1500)
      })
  }

  return [status, copy]
}

function CopyControl({ text, label }: { text: string; label: string }) {
  const [status, copy] = useCopyStatus()
  const display = status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : label

  return (
    <button
      type="button"
      onClick={() => copy(text)}
      aria-label={`${label} to clipboard`}
      className={[
        'text-micro uppercase opacity-0 transition-opacity duration-[var(--dur-instant)] ease-out',
        'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
        status === 'failed' ? 'text-status-error' : 'text-ink-muted hover:text-ink',
      ].join(' ')}
    >
      {display}
    </button>
  )
}

export type Segment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string | null }

// FR12 — the zero-dependency 80% solution: split on the ``` fence pattern,
// no other markdown construct is interpreted. An odd number of fences means
// the trailing slot is unterminated; it's reclassified as text (with its
// marker restored) rather than silently dropped.
//
// Exported so spec 015's log detail page can apply the same treatment to
// output_text (FR39) without a second parser.
export function splitFencedContent(content: string): Segment[] {
  const parts = content.split('```')
  const unbalanced = parts.length % 2 === 0
  const lastIndex = parts.length - 1
  const segments: Segment[] = []

  parts.forEach((part, index) => {
    const isFenceSlot = index % 2 === 1
    if (isFenceSlot && !(unbalanced && index === lastIndex)) {
      const newlineIndex = part.indexOf('\n')
      let language: string | null = null
      let code = part
      if (newlineIndex !== -1) {
        const firstLine = part.slice(0, newlineIndex).trim()
        if (firstLine && !firstLine.includes(' ')) {
          language = firstLine
          code = part.slice(newlineIndex + 1)
        }
        code = code.replace(/\n$/, '')
      }
      segments.push({ type: 'code', content: code, language })
      return
    }

    const text = isFenceSlot ? '```' + part : part
    if (text !== '') segments.push({ type: 'text', content: text })
  })

  return segments
}

export function CodeSegment({ language, content }: { language: string | null; content: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-md bg-surface-sunken">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="font-data text-micro uppercase text-ink-muted">{language ?? 'code'}</span>
        <CopyControl text={content} label="Copy" />
      </div>
      <pre className="overflow-x-auto px-3 pb-3">
        <code className="font-data text-sm text-ink">{content}</code>
      </pre>
    </div>
  )
}

export function TextSegment({ content }: { content: string }) {
  return <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{content}</div>
}

type MessageBubbleProps = {
  role: MessageRole
  content: string
  createdAt?: string
  pending?: boolean
}

export function MessageBubble({ role, content, createdAt, pending = false }: MessageBubbleProps) {
  const reducedMotion = useReducedMotion()
  const isUser = role === 'user'
  const segments = splitFencedContent(content)

  return (
    <div className={['flex', isUser ? 'justify-end' : 'justify-start'].join(' ')}>
      <motion.div
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={{ opacity: pending ? 0.6 : 1, y: 0 }}
        transition={{ duration: DUR_BASE, ease: EASE_OUT }}
        className={[
          'group flex flex-col gap-1 text-body text-ink',
          // Spec 019 FR17-18: user messages keep a rounded bubble; assistant
          // replies drop the bubble/background entirely and flow as plain
          // text across the full column — the main fix for the boxy feel.
          isUser ? 'max-w-[80%] rounded-2xl bg-signal-soft px-4 py-2.5' : 'w-full py-1',
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-micro uppercase text-ink-muted">
            {isUser ? 'You' : 'Assistant'}
          </span>
          {!pending && <CopyControl text={content} label="Copy" />}
        </div>

        {segments.map((segment, index) =>
          segment.type === 'code' ? (
            <CodeSegment key={index} language={segment.language} content={segment.content} />
          ) : (
            <TextSegment key={index} content={segment.content} />
          ),
        )}

        <span className="font-data text-sm text-ink-muted">
          {pending ? 'sending' : createdAt ? formatDateTime(createdAt) : ''}
        </span>
      </motion.div>
    </div>
  )
}
