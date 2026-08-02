import { useEffect } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useResource } from '../../hooks/useResource'
import type { ResolvedTheme, ThemePreference } from '../../hooks/useTheme'
import { listConversations } from '../../api'
import { subscribe } from '../../lib/events'
import { formatDateTime, isDefaultTitle } from '../../lib/format'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Skeleton } from '../ui/Skeleton'
import { NoticeBanner } from '../ui/NoticeBanner'
import { Tooltip } from '../ui/Tooltip'
import { SignalRibbon } from './SignalRibbon'

const RAIL_LIMIT = 20

// Framer's layout-transition spec for the active-row indicator (FR22).
// Used only here, so it's a local constant rather than a shared file.
const SPRING_LAYOUT = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 } as const

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Theme: system. Click for light.',
  light: 'Theme: light. Click for dark.',
  dark: 'Theme: dark. Click for system.',
}

const collapseIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

const moonIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
)

const sunIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
)

const userIcon = (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <circle cx="10" cy="7.2" r="3.2" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M3.3 16.2c1.2-3.1 4-4.7 6.7-4.7s5.5 1.6 6.7 4.7"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
)

type ConversationRailProps = {
  onToggleRail: () => void
  themePreference: ThemePreference
  themeResolved: ResolvedTheme
  onCycleTheme: () => void
}

// The sidebar is the app's only persistent chrome (no top bar) — brand,
// theme, and the latency signal all live here now alongside conversations.
// Theme state is owned by AppShell (which never unmounts) and passed down —
// a second independent useTheme() instance here would drift out of sync
// with AppShell's own (used for the /logs floating theme toggle) since
// each instance only re-reads localStorage on its own mount.
export function ConversationRail({
  onToggleRail,
  themePreference,
  themeResolved,
  onCycleTheme,
}: ConversationRailProps) {
  const navigate = useNavigate()
  const { data, error, isFirstLoad, reload } = useResource(
    () => listConversations(RAIL_LIMIT, 0),
    [],
  )

  // FR24 — conversations:changed is the only cross-component invalidation.
  useEffect(() => subscribe('conversations:changed', reload), [reload])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton aria-label="Collapse sidebar" onClick={onToggleRail}>
            {collapseIcon}
          </IconButton>
          <Link
            to="/"
            className="truncate font-display text-h2 text-ink transition-opacity duration-[var(--dur-instant)] ease-out hover:opacity-80"
          >
            InferenceLens
          </Link>
        </div>
        <IconButton aria-label={THEME_LABEL[themePreference]} onClick={onCycleTheme}>
          {themeResolved === 'dark' ? moonIcon : sunIcon}
        </IconButton>
      </div>

      <div className="px-3 pb-3">
        <Button onClick={() => navigate('/')} className="w-full">
          New chat
        </Button>
      </div>

      <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-3">
        {isFirstLoad && (
          <ul className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <li key={index}>
                <Skeleton variant="block" className="rounded-md" style={{ height: '2.25rem' }} />
              </li>
            ))}
          </ul>
        )}

        {!isFirstLoad && error && (
          <NoticeBanner
            kind="error"
            action={
              <Button size="sm" variant="secondary" onClick={reload}>
                Try again
              </Button>
            }
          >
            {error}
          </NoticeBanner>
        )}

        {!isFirstLoad && !error && data && data.items.length === 0 && (
          <p className="px-2 text-sm text-ink-muted">No conversations yet.</p>
        )}

        {!isFirstLoad && !error && data && data.items.length > 0 && (
          <ul className="space-y-1">
            {data.items.map((conversation) => (
              <li key={conversation.id}>
                <NavLink
                  to={`/c/${conversation.id}`}
                  end
                  title={conversation.title}
                  className={({ isActive }) =>
                    [
                      'relative flex items-center justify-between gap-2 rounded-lg py-2 pl-4 pr-2 text-sm',
                      'transition-colors duration-[var(--dur-instant)] ease-out',
                      isActive
                        ? 'bg-signal-soft text-ink'
                        : isDefaultTitle(conversation.title)
                          ? 'text-ink-muted hover:bg-surface-sunken'
                          : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink',
                    ].join(' ')
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <motion.span
                          layoutId="rail-active-indicator"
                          transition={SPRING_LAYOUT}
                          aria-hidden="true"
                          className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-signal"
                        />
                      )}
                      <span className="truncate">{conversation.title}</span>
                      <span className="font-data text-micro shrink-0 text-ink-muted">
                        {formatDateTime(conversation.updated_at)}
                      </span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="px-3 pt-2">
        <SignalRibbon />
      </div>

      <div className="flex flex-col gap-1 border-t border-hairline p-3">
        <Link
          to="/logs"
          className="rounded-md px-2 py-2 text-sm text-ink-secondary transition-colors duration-[var(--dur-instant)] ease-out hover:bg-surface-sunken hover:text-ink"
        >
          Inference logs
        </Link>

        <Tooltip label="Coming soon" className="w-full">
          <button
            type="button"
            onClick={() => {}}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-ink-secondary transition-colors duration-[var(--dur-instant)] ease-out hover:bg-surface-sunken hover:text-ink"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-ink-muted">
              {userIcon}
            </span>
            Account
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
