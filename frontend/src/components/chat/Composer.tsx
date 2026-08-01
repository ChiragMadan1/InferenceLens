import { forwardRef, useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '../ui/Button'

const MAX_HEIGHT_PX = 200

type ComposerProps = {
  draft: string
  sending: boolean
  disabled: boolean
  onDraftChange: (value: string) => void
  onSend: () => void
}

// FR13/FR14. Two state booleans only (`sending`, `disabled`) — everything
// else about the conversation (messages, notice, gone) stays in ChatPage;
// focus placement (FR8's empty state) comes in imperatively via the
// forwarded ref rather than a third boolean prop.
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { draft, sending, disabled, onDraftChange, onSend },
  ref,
) {
  const blocked = sending || disabled
  const canSend = draft.trim() !== '' && !blocked

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (canSend) onSend()
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-hairline bg-surface p-3">
      <label htmlFor="composer-textarea" className="text-micro uppercase text-ink-muted">
        Message
      </label>
      <div className="flex items-end gap-2">
        <AutoGrowTextarea
          ref={ref}
          value={draft}
          onChange={onDraftChange}
          onKeyDown={handleKeyDown}
          disabled={blocked}
        />
        <Button onClick={onSend} disabled={!canSend} loading={sending}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  )
})

type AutoGrowTextareaProps = {
  value: string
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  disabled: boolean
}

const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  function AutoGrowTextarea({ value, onChange, onKeyDown, disabled }, forwardedRef) {
    // A local ref for the resize measurement, merged with whatever ref
    // ChatPage forwards (object or callback) — the resize effect needs a
    // ref it can always read, regardless of the caller's ref shape.
    const innerRef = useRef<HTMLTextAreaElement | null>(null)
    const setRefs = (node: HTMLTextAreaElement | null) => {
      innerRef.current = node
      if (typeof forwardedRef === 'function') {
        forwardedRef(node)
      } else if (forwardedRef) {
        forwardedRef.current = node
      }
    }

    useEffect(() => {
      const el = innerRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value])

    return (
      <textarea
        id="composer-textarea"
        ref={setRefs}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={1}
        placeholder="Send a message…"
        style={{ maxHeight: MAX_HEIGHT_PX }}
        className="flex-1 resize-none overflow-y-auto rounded-md border border-hairline bg-canvas px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:outline-none disabled:opacity-50"
      />
    )
  },
)
