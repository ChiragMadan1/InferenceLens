import type { ReactNode } from 'react'

type ChipTone = 'neutral' | 'signal' | 'success' | 'cancelled' | 'error'

type ChipProps = {
  tone?: ChipTone
  icon: ReactNode
  children: ReactNode
  className?: string
}

// Status colours are reserved and never carry meaning alone — icon is a
// required prop, not optional, so a Chip can't be built colour-only.
const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: 'bg-surface-sunken text-ink-secondary',
  signal: 'bg-signal-soft text-signal',
  success: 'bg-surface-sunken text-status-success',
  cancelled: 'bg-surface-sunken text-status-cancelled',
  error: 'bg-surface-sunken text-status-error',
}

export function Chip({ tone = 'neutral', icon, children, className }: ChipProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'text-micro uppercase font-medium',
        TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      {children}
    </span>
  )
}
