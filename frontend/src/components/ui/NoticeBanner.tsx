import type { ReactNode } from 'react'
import { IconButton } from './IconButton'

type NoticeBannerKind = 'info' | 'error'

type NoticeBannerProps = {
  kind?: NoticeBannerKind
  children: ReactNode
  action?: ReactNode
  onDismiss?: () => void
}

const KIND_CLASSES: Record<NoticeBannerKind, string> = {
  info: 'border-signal/40 bg-signal-soft text-ink',
  error: 'border-status-error/40 bg-surface text-status-error',
}

export function NoticeBanner({ kind = 'info', children, action, onDismiss }: NoticeBannerProps) {
  return (
    <div
      role="status"
      className={[
        'flex items-start gap-3 rounded-md border px-4 py-3 text-body',
        KIND_CLASSES[kind],
      ].join(' ')}
    >
      <div className="flex-1">{children}</div>
      {action}
      {onDismiss && (
        <IconButton aria-label="Dismiss" onClick={onDismiss} className="h-7 w-7">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M2 2l10 10M12 2 2 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      )}
    </div>
  )
}
