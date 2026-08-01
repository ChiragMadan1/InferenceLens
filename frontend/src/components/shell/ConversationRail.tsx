import { useEffect, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useResource } from '../../hooks/useResource'
import { ApiError, createConversation, listConversations } from '../../api'
import { subscribe } from '../../lib/events'
import { formatDateTime, isDefaultTitle } from '../../lib/format'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { NoticeBanner } from '../ui/NoticeBanner'

const RAIL_LIMIT = 20

// Framer's layout-transition spec for the active-row indicator (FR22).
// Used only here, so it's a local constant rather than a shared file.
const SPRING_LAYOUT = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 } as const

export function ConversationRail() {
  const navigate = useNavigate()
  const { data, error, isFirstLoad, reload } = useResource(
    () => listConversations(RAIL_LIMIT, 0),
    [],
  )
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // FR24 — conversations:changed is the only cross-component invalidation.
  useEffect(() => subscribe('conversations:changed', reload), [reload])

  const handleCreate = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      const created = await createConversation()
      navigate(`/c/${created.id}`)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.detail : 'Could not create a conversation.')
      setCreating(false)
    }
  }

  return (
    <nav aria-label="Conversations" className="flex h-full flex-col gap-3 p-3">
      <Button onClick={handleCreate} loading={creating} disabled={creating} className="w-full">
        {creating ? 'Creating…' : 'New conversation'}
      </Button>

      {createError && (
        <NoticeBanner kind="error" onDismiss={() => setCreateError(null)}>
          {createError}
        </NoticeBanner>
      )}

      <div className="flex-1 overflow-y-auto">
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
                      'relative flex items-center justify-between gap-2 rounded-md py-2 pl-4 pr-2 text-sm',
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
      </div>

      <Link
        to="/logs"
        className="rounded-md px-2 py-2 text-sm text-ink-secondary transition-colors duration-[var(--dur-instant)] ease-out hover:bg-surface-sunken hover:text-ink"
      >
        Inference logs
      </Link>
    </nav>
  )
}
