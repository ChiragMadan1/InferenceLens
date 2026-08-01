import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useResource } from '../hooks/useResource'
import { ApiError, createConversation, listConversations, type ConversationRead } from '../api'
import { formatDateTime, isDefaultTitle } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { NoticeBanner } from '../components/ui/NoticeBanner'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Skeleton } from '../components/ui/Skeleton'

const PAGE_SIZE = 20
const SKELETON_COUNT = 6

const dotIcon = (
  <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="3" r="3" />
  </svg>
)

const pendingIcon = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

function CardSkeleton() {
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <Skeleton variant="text" className="h-5 w-3/4" />
      <Skeleton variant="text" className="h-4 w-1/3" />
      <Skeleton variant="block" className="h-5 w-16" />
    </Panel>
  )
}

function ConversationCard({ conversation }: { conversation: ConversationRead }) {
  const untitled = isDefaultTitle(conversation.title)
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <h2
        title={conversation.title}
        className={[
          'truncate text-h2 font-display',
          untitled ? 'text-ink-muted' : 'text-ink',
        ].join(' ')}
      >
        {conversation.title}
      </h2>
      <p className="font-data text-sm text-ink-muted">{formatDateTime(conversation.updated_at)}</p>
      <div className="flex items-center gap-2">
        <Chip tone="signal" icon={dotIcon}>
          {conversation.status}
        </Chip>
        {untitled && (
          <Chip tone="neutral" icon={pendingIcon}>
            untitled
          </Chip>
        )}
      </div>
    </Panel>
  )
}

export function ConversationsIndexPage() {
  const navigate = useNavigate()
  const [offset, setOffset] = useState(0)
  const { data, error, loading, isFirstLoad, reload } = useResource(
    () => listConversations(PAGE_SIZE, offset),
    [offset],
  )
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

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

  const newConversationAction = (
    <Button onClick={handleCreate} loading={creating} disabled={creating || loading}>
      {creating ? 'Creating…' : 'New conversation'}
    </Button>
  )

  const total = data?.total ?? 0
  const items = data?.items ?? []
  const hasPrev = offset > 0
  const hasNext = offset + PAGE_SIZE < total

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Conversations"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={reload} loading={loading && !isFirstLoad} disabled={loading}>
              Refresh
            </Button>
            {newConversationAction}
          </div>
        }
      />

      {createError && (
        <NoticeBanner kind="error" onDismiss={() => setCreateError(null)}>
          {createError}
        </NoticeBanner>
      )}

      {isFirstLoad && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
            <CardSkeleton key={index} />
          ))}
        </div>
      )}

      {!isFirstLoad && error && !data && (
        <ErrorState
          heading="Couldn't load conversations"
          message={error}
          action={
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      )}

      {!isFirstLoad && data && (
        <>
          {error && (
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

          {total === 0 ? (
            <EmptyState
              heading="Start your first conversation"
              body="Conversations you create will show up here."
              action={newConversationAction}
            />
          ) : (
            <>
              <div
                aria-busy={loading || undefined}
                className={[
                  'grid grid-cols-1 gap-4 transition-opacity duration-[var(--dur-fast)] ease-out sm:grid-cols-2 xl:grid-cols-3',
                  loading ? 'opacity-60' : 'opacity-100',
                ].join(' ')}
              >
                {items.map((conversation) => (
                  <ConversationCard key={conversation.id} conversation={conversation} />
                ))}
              </div>

              {items.length === 0 && (
                <p className="text-body text-ink-secondary">No conversations on this page.</p>
              )}

              <div className="flex items-center justify-between gap-4">
                <p className="font-data text-sm text-ink-muted">
                  Showing {offset + 1}–{offset + items.length} of {total}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!hasPrev || loading}
                    onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                  >
                    Prev
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!hasNext || loading}
                    onClick={() => setOffset((current) => current + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
