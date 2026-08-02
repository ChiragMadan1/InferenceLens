import { useReducedMotion } from 'framer-motion'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { Tooltip as InfoTooltip } from '../ui/Tooltip'

const infoIcon = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 5.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="6" cy="3.75" r="0.6" fill="currentColor" />
  </svg>
)

type KpiTileProps = {
  label: string
  value: string
  unit?: string
  caption?: string
  warning?: boolean
  tooltip?: string
  sparkline?: (number | null)[]
}

// FR12/FR13/FR15 — a large value in the display face, unit in mono, a
// micro uppercase label, and an optional hairline sparkline (Calls and p95
// latency only — a sparkline on every tile is decoration, not information).
export function KpiTile({ label, value, unit, caption, warning = false, tooltip, sparkline }: KpiTileProps) {
  const reducedMotion = useReducedMotion()
  const data = sparkline?.map((v) => ({ v }))

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-surface p-4 shadow-panel">
      <p className="text-micro uppercase text-ink-muted">{label}</p>
      <div className="flex items-baseline gap-1.5">
        <span className={['text-display font-display', warning ? 'text-status-error' : 'text-ink'].join(' ')}>
          {value}
        </span>
        {unit && <span className="font-data text-sm text-ink-muted">{unit}</span>}
      </div>
      {caption && (
        <p className={['flex items-center gap-1 text-sm', warning ? 'text-status-error' : 'text-ink-muted'].join(' ')}>
          {caption}
          {tooltip && (
            <InfoTooltip label={tooltip}>
              <span tabIndex={0} aria-label="More info" className="inline-flex cursor-help">
                {infoIcon}
              </span>
            </InfoTooltip>
          )}
        </p>
      )}
      {data && data.length > 0 && (
        <div className="mt-1 h-6 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <Area
                type="monotone"
                dataKey="v"
                stroke="var(--color-signal)"
                strokeWidth={1.5}
                fill="var(--color-signal)"
                fillOpacity={0.12}
                dot={false}
                connectNulls={false}
                isAnimationActive={!reducedMotion}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
