import type { LogStatus } from '../../api'
import { formatDateTime, formatMs } from '../../lib/format'

type TimingStripProps = {
  requestedAt: string
  completedAt: string | null
  latencyMs: number
  ttftMs: number | null
  status: LogStatus
}

// FR37 — the detail page's one bespoke visualisation: a single bar spanning
// requested_at -> completed_at, annotated with latency and (when present) a
// TTFT marker. An open request (no completed_at — an error or cancelled
// log) draws open-ended with the reason labelled, never a zero-width bar.
export function TimingStrip({ requestedAt, completedAt, latencyMs, ttftMs, status }: TimingStripProps) {
  const ttftPct = ttftMs !== null && latencyMs > 0 ? Math.min(100, (ttftMs / latencyMs) * 100) : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm text-ink-muted">
        <span className="font-data">{formatDateTime(requestedAt)}</span>
        <span className="font-data">{completedAt ? formatDateTime(completedAt) : 'never completed'}</span>
      </div>

      <div className="relative h-3 w-full overflow-hidden rounded-full bg-surface-sunken">
        {completedAt ? (
          <div className="absolute inset-y-0 left-0 w-full rounded-full bg-signal" />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-full rounded-l-full"
            style={{
              background:
                'repeating-linear-gradient(45deg, var(--color-status-error), var(--color-status-error) 6px, transparent 6px, transparent 12px)',
            }}
          />
        )}
        {ttftPct !== null && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-surface"
            style={{ left: `${ttftPct}%` }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-secondary">
        <span>
          Latency <span className="font-data tabular-nums text-ink">{formatMs(latencyMs)}</span>
        </span>
        <span>
          TTFT{' '}
          <span className="font-data tabular-nums text-ink">
            {ttftMs === null ? '— (available once streaming ships)' : formatMs(ttftMs)}
          </span>
        </span>
        {!completedAt && (
          <span className="text-status-error">
            {status === 'cancelled' ? 'Cancelled before completion' : 'Errored before completion'}
          </span>
        )}
      </div>
    </div>
  )
}
