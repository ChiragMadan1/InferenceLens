import { useSyncExternalStore } from 'react'
import { getLatencySnapshot, subscribeLatencyBuffer } from '../../lib/latencyBuffer'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { Tooltip } from '../ui/Tooltip'

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// The app's own live telemetry about itself (FR8-FR10). Fed by api.ts's
// latency ring buffer, read here via useSyncExternalStore — no polling.
export function SignalRibbon() {
  const entries = useSyncExternalStore(subscribeLatencyBuffer, getLatencySnapshot)
  const isNarrow = useMediaQuery('(max-width: 359px)')
  const visible = isNarrow ? entries.slice(-16) : entries
  const isIdle = entries.length < 2
  const maxMs = Math.max(1, ...visible.map((entry) => entry.ms))

  const summary = isIdle
    ? 'No requests recorded yet.'
    : `Last ${entries.length} requests: median ${Math.round(
        median(entries.map((entry) => entry.ms)),
      )} ms, ${entries.filter((entry) => !entry.ok).length} failed`

  return (
    <div className="flex items-center gap-[2px]">
      <div className="flex h-6 items-end gap-[2px]" aria-hidden="true">
        {isIdle ? (
          <div className="h-[3px] w-24 rounded-full bg-ink-muted opacity-[0.12]" />
        ) : (
          visible.map((entry, index) => (
            <Tooltip
              key={index}
              label={`${entry.method} ${entry.path} · ${Math.round(entry.ms)}ms`}
            >
              <span
                className={[
                  'block w-[3px] rounded-full',
                  entry.ok ? 'bg-signal' : 'bg-status-error',
                ].join(' ')}
                style={{ height: `${Math.max(12, Math.round((entry.ms / maxMs) * 100))}%` }}
              />
            </Tooltip>
          ))
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {summary}
      </span>
    </div>
  )
}
