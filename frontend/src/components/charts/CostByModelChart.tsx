import { useReducedMotion } from 'framer-motion'
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { LogGroupStat } from '../../api'
import { formatCost } from '../../lib/format'
import {
  AXIS_LINE_PROPS,
  AXIS_TICK_STYLE,
  BAR_MAX_THICKNESS,
  CATEGORICAL_SLOTS,
  GRID_PROPS,
  INK_SECONDARY,
} from '../../lib/chartTheme'
import { ChartPanel, HorizontalBarShape, type ChartPanelStatus } from './ChartPanel'
import { ChartTooltip } from './ChartTooltip'
import { SeriesTable } from './SeriesTable'

type Row = { key: string; label: string; costNum: number; costLabel: string; isOther: boolean }

// Edge case #14 — a 60-character model name is truncated on the axis; the
// full value is still available via the tooltip and the table view.
function truncateLabel(name: string, max = 22): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

// A bar has no length for a null cost, so unpriced models can't be plotted
// here — they're still visible in full via BreakdownTable, and the panel
// says how many were left out rather than silently dropping them.
function buildRows(groups: LogGroupStat[]): Row[] {
  return groups
    .filter((g): g is LogGroupStat & { cost_usd: string } => g.cost_usd !== null)
    .map((g) => ({
      key: g.key,
      label: g.is_other ? 'Other' : g.key,
      costNum: Number(g.cost_usd),
      costLabel: formatCost(g.cost_usd),
      isOther: g.is_other,
    }))
    .sort((a, b) => b.costNum - a.costNum)
}

type CostByModelChartProps = {
  status: ChartPanelStatus
  groups: LogGroupStat[]
  errorMessage?: string
  onRetry?: () => void
  onSelectModel: (model: string) => void
}

// FR18 — every bar is the same colour (categorical slot 1). Models are
// nominal categories with no natural order; colouring them by size would
// double-encode magnitude as hue on top of the bar length that already
// shows it.
export function CostByModelChart({
  status,
  groups,
  errorMessage,
  onRetry,
  onSelectModel,
}: CostByModelChartProps) {
  const reducedMotion = useReducedMotion()
  const rows = buildRows(groups)
  const excluded = groups.length - rows.length
  const effectiveStatus = status === 'ready' && rows.length === 0 ? 'empty' : status

  return (
    <ChartPanel
      title="Cost by model"
      subtitle={excluded > 0 ? `${excluded} unpriced model${excluded === 1 ? '' : 's'} excluded` : undefined}
      ariaLabel="Horizontal bar chart of total cost by model for the selected window; every bar is the same colour."
      status={effectiveStatus}
      errorMessage={errorMessage}
      onRetry={onRetry}
      emptyMessage="No priced calls in this window."
      height={Math.max(180, rows.length * 36 + 40)}
      table={
        <SeriesTable
          caption="Cost by model"
          columns={[
            { key: 'label', label: 'Model' },
            { key: 'cost', label: 'Cost', numeric: true },
          ]}
          rows={rows.map((r) => ({ label: r.label, cost: r.costLabel }))}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 48 }}>
          <CartesianGrid {...GRID_PROPS} horizontal={false} />
          <XAxis
            type="number"
            tick={AXIS_TICK_STYLE}
            axisLine={AXIS_LINE_PROPS}
            tickLine={false}
            tickFormatter={(v: number) => formatCost(String(v))}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS_TICK_STYLE}
            axisLine={AXIS_LINE_PROPS}
            tickLine={false}
            width={140}
            tickFormatter={(v: string) => truncateLabel(v)}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-surface-sunken)' }}
            content={<ChartTooltip formatValue={(v) => formatCost(String(v))} />}
          />
          <Bar
            dataKey="costNum"
            name="Cost"
            fill={CATEGORICAL_SLOTS[0]}
            maxBarSize={BAR_MAX_THICKNESS}
            shape={HorizontalBarShape}
            onClick={(data: { payload: Row }) => {
              if (!data.payload.isOther) onSelectModel(data.payload.key)
            }}
            className="cursor-pointer"
            isAnimationActive={!reducedMotion}
          >
            <LabelList dataKey="costLabel" position="right" fill={INK_SECONDARY} fontSize={11} className="font-data" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  )
}
