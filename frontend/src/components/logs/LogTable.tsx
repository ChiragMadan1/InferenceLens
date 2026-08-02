import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { InferenceLogSummary, LogStatus } from '../../api'
import { formatCost, formatDateTime, formatMs, formatTokens } from '../../lib/format'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { ScrollArea } from '../ui/ScrollArea'
import { Skeleton } from '../ui/Skeleton'

const successIcon = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
    <path d="M1.5 4.2 3.2 6l3.3-3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const errorIcon = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
    <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)
const cancelledIcon = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
    <path d="M1.5 4h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const STATUS_ICON: Record<LogStatus, React.ReactNode> = {
  success: successIcon,
  error: errorIcon,
  cancelled: cancelledIcon,
}
const STATUS_TONE: Record<LogStatus, 'success' | 'error' | 'cancelled'> = {
  success: 'success',
  error: 'error',
  cancelled: 'cancelled',
}

function CopyRequestId({ requestId }: { requestId: string }) {
  const [copied, setCopied] = useState(false)

  const copy = (event: React.MouseEvent) => {
    event.stopPropagation()
    navigator.clipboard
      .writeText(requestId)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
      .finally(() => setTimeout(() => setCopied(false), 1200))
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy request id"
      className="font-data text-sm tabular-nums text-ink-secondary underline decoration-hairline decoration-dotted underline-offset-2 hover:text-ink"
    >
      {copied ? 'copied' : requestId.slice(0, 8)}
    </button>
  )
}

function RowSkeleton() {
  return (
    <tr className="border-b border-hairline">
      {Array.from({ length: 9 }).map((_, index) => (
        <td key={index} className="py-3 pr-4">
          <Skeleton variant="text" className="h-4 w-16" />
        </td>
      ))}
    </tr>
  )
}

type LogTableProps = {
  items: InferenceLogSummary[]
  total: number
  limit: number
  offset: number
  isFirstLoad: boolean
  loading: boolean
  error: string | null
  hasActiveFilters: boolean
  onRetry: () => void
  onPageChange: (offset: number) => void
  onClearFilters: () => void
}

// FR30-FR35 — the paginated log table, honouring the same filter state as
// the KPI row and charts (FR4); no per-panel filter.
export function LogTable({
  items,
  total,
  limit,
  offset,
  isFirstLoad,
  loading,
  error,
  hasActiveFilters,
  onRetry,
  onPageChange,
  onClearFilters,
}: LogTableProps) {
  const navigate = useNavigate()
  const hasPrev = offset > 0
  const hasNext = offset + items.length < total

  if (isFirstLoad) {
    return (
      <ScrollArea className="w-full">
        <table className="w-full min-w-[56rem] border-collapse">
          <thead>
            <tr className="border-b border-hairline text-left text-micro uppercase text-ink-muted">
              <th className="py-2 pr-4 font-medium">Time</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Call type</th>
              <th className="py-2 pr-4 font-medium">Model</th>
              <th className="py-2 pr-4 text-right font-medium">Latency</th>
              <th className="py-2 pr-4 text-right font-medium">Tokens</th>
              <th className="py-2 pr-4 text-right font-medium">Cost</th>
              <th className="py-2 pr-4 font-medium">Input</th>
              <th className="py-2 font-medium">Request ID</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, index) => (
              <RowSkeleton key={index} />
            ))}
          </tbody>
        </table>
      </ScrollArea>
    )
  }

  if (error && items.length === 0) {
    return (
      <ErrorState
        heading="Couldn't load logs"
        message={error}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    )
  }

  if (total === 0) {
    return hasActiveFilters ? (
      <EmptyState
        heading="No logs match these filters"
        body="Try widening the time range or removing a filter."
        action={
          <Button variant="secondary" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState heading="No logs yet" body="Inference logs will show up here once calls are made." />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ScrollArea className="w-full">
        <table
          aria-busy={loading || undefined}
          className={[
            'w-full min-w-[56rem] border-collapse transition-opacity duration-[var(--dur-fast)] ease-out',
            loading ? 'opacity-60' : 'opacity-100',
          ].join(' ')}
        >
          <thead>
            <tr className="border-b border-hairline text-left text-micro uppercase text-ink-muted">
              <th className="py-2 pr-4 font-medium">Time</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Call type</th>
              <th className="py-2 pr-4 font-medium">Model</th>
              <th className="py-2 pr-4 text-right font-medium">Latency</th>
              <th className="py-2 pr-4 text-right font-medium">Tokens</th>
              <th className="py-2 pr-4 text-right font-medium">Cost</th>
              <th className="py-2 pr-4 font-medium">Input</th>
              <th className="py-2 font-medium">Request ID</th>
            </tr>
          </thead>
          <tbody>
            {items.map((log) => (
              <tr
                key={log.id}
                onClick={() => navigate(`/logs/${log.request_id}`)}
                className="cursor-pointer border-b border-hairline last:border-0 hover:bg-surface-sunken"
              >
                <td className="py-2.5 pr-4 font-data text-sm tabular-nums text-ink-muted">
                  {formatDateTime(log.requested_at)}
                </td>
                <td className="py-2.5 pr-4">
                  <Chip tone={STATUS_TONE[log.status]} icon={STATUS_ICON[log.status]}>
                    {log.status}
                  </Chip>
                </td>
                <td className="py-2.5 pr-4 text-sm text-ink-secondary">{log.call_type}</td>
                <td className="max-w-[10rem] truncate py-2.5 pr-4 text-sm text-ink-secondary" title={log.model}>
                  {log.model}
                </td>
                <td className="py-2.5 pr-4 text-right font-data text-sm tabular-nums text-ink">
                  {formatMs(log.latency_ms)}
                </td>
                <td className="py-2.5 pr-4 text-right font-data text-sm tabular-nums text-ink">
                  {log.input_tokens === null && log.output_tokens === null
                    ? '—'
                    : `${formatTokens(log.input_tokens ?? 0)} / ${formatTokens(log.output_tokens ?? 0)}`}
                </td>
                <td className="py-2.5 pr-4 text-right font-data text-sm tabular-nums text-ink">
                  {log.cost_usd === null ? 'not priced' : formatCost(log.cost_usd)}
                </td>
                <td className="max-w-[18rem] truncate py-2.5 text-sm text-ink-secondary" title={log.input_preview ?? undefined}>
                  {log.input_preview ?? '—'}
                </td>
                <td className="py-2.5 pl-2" onClick={(e) => e.stopPropagation()}>
                  <CopyRequestId requestId={log.request_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>

      <div className="flex items-center justify-between gap-4">
        <p className="font-data text-sm text-ink-muted">
          Showing {offset + 1}–{offset + items.length} of {total}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasPrev || loading}
            onClick={() => onPageChange(Math.max(0, offset - limit))}
          >
            Prev
          </Button>
          <Button variant="secondary" size="sm" disabled={!hasNext || loading} onClick={() => onPageChange(offset + limit)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
