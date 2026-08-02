import type { TooltipProps } from 'recharts'
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent'

type ChartTooltipProps = TooltipProps<ValueType, NameType> & {
  formatLabel?: (label: string) => string
  formatValue?: (value: ValueType) => string
}

// FR23 — the one themed tooltip used by every panel: mono numbers with
// tabular-nums, the bucket's start time, and (for line/area charts, via
// recharts' default shared-tooltip behaviour) every series at that bucket
// in one crosshair tooltip.
export function ChartTooltip({ active, payload, label, formatLabel, formatValue }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null

  return (
    <div className="rounded-md border border-hairline bg-surface-raised px-3 py-2 shadow-raised">
      {label !== undefined && (
        <p className="mb-1.5 font-data text-micro text-ink-muted">
          {formatLabel ? formatLabel(String(label)) : String(label)}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {payload.map((entry, index) => (
          <li key={index} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-ink-secondary">{entry.name}</span>
            <span className="ml-auto font-data tabular-nums text-ink">
              {entry.value === null || entry.value === undefined
                ? '—'
                : formatValue
                  ? formatValue(entry.value)
                  : String(entry.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
