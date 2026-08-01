import type { ReactNode } from 'react'
import { Panel } from './Panel'

type ErrorStateProps = {
  heading: string
  message: string
  action?: ReactNode
}

export function ErrorState({ heading, message, action }: ErrorStateProps) {
  return (
    <Panel className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        className="text-status-error"
      >
        <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.5" />
        <path d="M20 12v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="20" cy="27" r="1.25" fill="currentColor" />
      </svg>
      <div className="space-y-1">
        <h2 className="text-display font-display text-ink">{heading}</h2>
        <p className="text-body text-ink-secondary">{message}</p>
      </div>
      {action}
    </Panel>
  )
}
