import { motion, useReducedMotion } from 'framer-motion'

const DOT_DELAYS = [0, 0.12, 0.24]

// FR16's "Assistant is responding" row. `role="status"` +
// `aria-live="polite"` here (not a separate hidden region) means the
// announcement fires exactly once per pending period: the text only enters
// the DOM when this component mounts, and it never changes while mounted,
// so assistive tech doesn't re-announce it on unrelated re-renders (FR11).
export function PendingIndicator() {
  const reducedMotion = useReducedMotion()

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 self-start rounded-md bg-surface px-3 py-2 text-sm text-ink-secondary"
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        {DOT_DELAYS.map((delay, index) =>
          reducedMotion ? (
            <span key={index} className="h-1.5 w-1.5 rounded-full bg-ink-muted" />
          ) : (
            <motion.span
              key={index}
              className="h-1.5 w-1.5 rounded-full bg-ink-muted"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut', delay }}
            />
          ),
        )}
      </span>
      <span>Assistant is responding</span>
    </div>
  )
}
