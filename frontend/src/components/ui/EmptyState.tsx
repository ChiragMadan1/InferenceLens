import type { ReactNode } from 'react'
import { Panel } from './Panel'

type EmptyStateProps = {
  heading: string
  body: string
  action?: ReactNode
}

export function EmptyState({ heading, body, action }: EmptyStateProps) {
  return (
    <Panel className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        className="text-ink-muted"
      >
        <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.5" />
        <path d="M14 20h12M20 14v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <div className="space-y-1">
        <h2 className="text-display font-display text-ink">{heading}</h2>
        <p className="text-body text-ink-secondary">{body}</p>
      </div>
      {action}
    </Panel>
  )
}
