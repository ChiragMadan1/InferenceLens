import type { LogGroupStat } from '../../api'
import { formatCost, formatPercent, formatTokens } from '../../lib/format'
import { assignCategoricalColors, OTHER_COLOR } from '../../lib/chartTheme'
import { Panel } from '../ui/Panel'

type BreakdownTableProps = {
  title: string
  rows: LogGroupStat[]
}

// Constraints — "the breakdowns by model / provider / call type are a table
// with inline proportion bars, not a donut": a sorted table with the real
// numbers answers "which is biggest, and by how much" directly.
export function BreakdownTable({ title, rows }: BreakdownTableProps) {
  if (rows.length === 0) {
    return (
      <Panel className="flex flex-col gap-3 p-4">
        <h3 className="text-h2 font-display text-ink">{title}</h3>
        <p className="text-sm text-ink-muted">No data in this window.</p>
      </Panel>
    )
  }

  const maxCalls = Math.max(1, ...rows.map((r) => r.calls))
  // FR28 — hue from a stable ordering of the key, never row index, so
  // filtering a series out never repaints the survivors.
  const colorMap = assignCategoricalColors(rows.filter((r) => !r.is_other).map((r) => r.key))

  return (
    <Panel className="flex flex-col gap-3 overflow-x-auto p-4">
      <h3 className="text-h2 font-display text-ink">{title}</h3>
      <table className="w-full min-w-[26rem] border-collapse">
        <caption className="sr-only">{`${title} — calls, error rate, and cost`}</caption>
        <thead>
          <tr className="border-b border-hairline text-micro uppercase text-ink-muted">
            <th scope="col" className="py-2 pr-3 text-left font-medium">
              Key
            </th>
            <th scope="col" className="py-2 pr-3 text-left font-medium">
              Calls
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Error rate
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const color = row.is_other ? OTHER_COLOR : (colorMap.get(row.key) ?? OTHER_COLOR)
            const pct = Math.round((row.calls / maxCalls) * 100)
            return (
              <tr key={row.key} className="border-b border-hairline last:border-0">
                <td className="max-w-[10rem] truncate py-2 pr-3 text-sm text-ink-secondary" title={row.key}>
                  {row.is_other ? 'Other' : row.key}
                </td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="font-data text-sm tabular-nums text-ink">{formatTokens(row.calls)}</span>
                    <span className="h-1.5 min-w-[3rem] flex-1 rounded-full bg-surface-sunken">
                      <span
                        className="block h-1.5 rounded-full"
                        style={{ width: `${pct}%`, backgroundColor: color }}
                      />
                    </span>
                  </div>
                </td>
                <td className="py-2 pr-3 text-right font-data text-sm tabular-nums text-ink">
                  {formatPercent(row.error_rate)}
                </td>
                <td className="py-2 text-right font-data text-sm tabular-nums text-ink">
                  {row.cost_usd === null ? 'not priced' : formatCost(row.cost_usd)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}
