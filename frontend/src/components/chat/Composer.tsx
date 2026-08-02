import { forwardRef, useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Tooltip } from '../ui/Tooltip'

const MAX_HEIGHT_PX = 200

const attachIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M10.5 3.5 4.8 9.2a2.2 2.2 0 1 0 3.1 3.1L13.3 6.9a3.6 3.6 0 1 0-5.1-5.1L3.4 6.6"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const micIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="6" y="1.5" width="4" height="7.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)

const chevronIcon = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

type ComposerProps = {
  draft: string
  sending: boolean
  disabled: boolean
  onDraftChange: (value: string) => void
  onSend: () => void
}

// FR13/FR14. Two state booleans only (`sending`, `disabled`) — everything
// else about the conversation (messages, notice, gone) stays in the caller;
// focus placement (FR8's empty state) comes in imperatively via the
// forwarded ref rather than a third boolean prop.
//
// Shared between the landing (new-chat) screen and ChatPage (spec 019) —
// a single rounded, centered pill rather than an edge-to-edge bar. Attach,
// model-chooser, and voice controls are inert placeholders (spec 019
// FR13-14): normal-looking, tooltipped "Coming soon", no-op on click.
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
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2">
      <div className="flex flex-col gap-2 rounded-3xl border border-hairline bg-surface p-3 shadow-panel transition-shadow duration-[var(--dur-instant)] ease-out focus-within:shadow-focus">
        <label htmlFor="composer-textarea" className="sr-only">
          Message
        </label>
        <AutoGrowTextarea
          ref={ref}
          value={draft}
          onChange={onDraftChange}
          onKeyDown={handleKeyDown}
          disabled={blocked}
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Tooltip label="Coming soon">
              <IconButton aria-label="Attach a file" onClick={() => {}}>
                {attachIcon}
              </IconButton>
            </Tooltip>
            <Tooltip label="Coming soon">
              <button
                type="button"
                onClick={() => {}}
                className="flex items-center gap-1 rounded-full border border-hairline px-3 py-1.5 text-sm text-ink-secondary transition-colors duration-[var(--dur-instant)] ease-out hover:bg-surface-sunken hover:text-ink"
              >
                Model {chevronIcon}
              </button>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1">
            <Tooltip label="Coming soon">
              <IconButton aria-label="Voice to text" onClick={() => {}}>
                {micIcon}
              </IconButton>
            </Tooltip>
            <Button onClick={onSend} disabled={!canSend} loading={sending}>
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
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
    // the caller forwards (object or callback) — the resize effect needs a
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
        placeholder="Message InferenceLens…"
        style={{ maxHeight: MAX_HEIGHT_PX }}
        className="w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-body text-ink placeholder:text-ink-muted focus-visible:outline-none disabled:opacity-50"
      />
    )
  },
)
