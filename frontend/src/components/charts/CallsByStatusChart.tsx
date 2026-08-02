import { useReducedMotion } from 'framer-motion'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { BucketSize, LogStatus, TimeseriesSeries } from '../../api'
import { formatBucketTick, formatDateTime, formatTokens } from '../../lib/format'
import { AXIS_LINE_PROPS, AXIS_TICK_STYLE, BAR_MAX_THICKNESS, GRID_PROPS, STATUS_COLORS } from '../../lib/chartTheme'
import { ChartLegend, ChartPanel, makeVerticalBarShape, type ChartPanelStatus } from './ChartPanel'
import { ChartTooltip } from './ChartTooltip'
import { SeriesTable } from './SeriesTable'

type Row = { t: string; success: number; cancelled: number; error: number }

const STATUS_ORDER: LogStatus[] = ['success', 'cancelled', 'error']
const STATUS_LABEL: Record<LogStatus, string> = {
  success: 'Success',
  cancelled: 'Cancelled',
  error: 'Error',
}

// FR24 — a bucket with no calls of a given status still needs a 0 so the
// column renders at zero height rather than skipping that stack segment.
function buildRows(series: TimeseriesSeries[]): Row[] {
  const reference = series[0]?.points ?? []
  const byKey = new Map(series.map((s) => [s.key, s.points]))
  return reference.map((point, index) => ({
    t: point.t,
    success: byKey.get('success')?.[index]?.calls ?? 0,
    cancelled: byKey.get('cancelled')?.[index]?.calls ?? 0,
    error: byKey.get('error')?.[index]?.calls ?? 0,
  }))
}

type CallsByStatusChartProps = {
  status: ChartPanelStatus
  series: TimeseriesSeries[]
  bucket: BucketSize
  bucketLabel: string
  errorMessage?: string
  onRetry?: () => void
  onSelectStatus: (status: LogStatus) => void
}

export function CallsByStatusChart({
  status,
  series,
  bucket,
  bucketLabel,
  errorMessage,
  onRetry,
  onSelectStatus,
}: CallsByStatusChartProps) {
  const reducedMotion = useReducedMotion()
  const rows = buildRows(series)

  return (
    <ChartPanel
      title="Calls over time, by status"
      subtitle={`${bucketLabel} buckets`}
      ariaLabel={`Stacked column chart of calls over time broken down by status, in ${bucketLabel} buckets.`}
      status={status}
      errorMessage={errorMessage}
      onRetry={onRetry}
      legend={
        <ChartLegend
          items={STATUS_ORDER.map((s) => ({ key: s, label: STATUS_LABEL[s], color: STATUS_COLORS[s] }))}
        />
      }
      table={
        <SeriesTable
          caption="Calls over time, by status"
          columns={[
            { key: 't', label: 'Bucket' },
            { key: 'success', label: 'Success', numeric: true },
            { key: 'cancelled', label: 'Cancelled', numeric: true },
            { key: 'error', label: 'Error', numeric: true },
          ]}
          rows={rows.map((r) => ({
            t: formatDateTime(r.t),
            success: formatTokens(r.success),
            cancelled: formatTokens(r.cancelled),
            error: formatTokens(r.error),
          }))}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} barCategoryGap="20%">
          <CartesianGrid {...GRID_PROPS} />
          <XAxis
            dataKey="t"
            tickFormatter={(t: string) => formatBucketTick(t, bucket)}
            tick={AXIS_TICK_STYLE}
            axisLine={AXIS_LINE_PROPS}
            tickLine={false}
          />
          <YAxis
            tick={AXIS_TICK_STYLE}
            axisLine={AXIS_LINE_PROPS}
            tickLine={false}
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-surface-sunken)' }}
            content={
              <ChartTooltip
                formatLabel={(t) => formatDateTime(t)}
                formatValue={(v) => formatTokens(Number(v))}
              />
            }
          />
          <Bar
            dataKey="success"
            name={STATUS_LABEL.success}
            stackId="calls"
            fill={STATUS_COLORS.success}
            maxBarSize={BAR_MAX_THICKNESS}
            shape={makeVerticalBarShape('bottom')}
            onClick={() => onSelectStatus('success')}
            className="cursor-pointer"
            isAnimationActive={!reducedMotion}
          />
          <Bar
            dataKey="cancelled"
            name={STATUS_LABEL.cancelled}
            stackId="calls"
            fill={STATUS_COLORS.cancelled}
            maxBarSize={BAR_MAX_THICKNESS}
            shape={makeVerticalBarShape('middle')}
            onClick={() => onSelectStatus('cancelled')}
            className="cursor-pointer"
            isAnimationActive={!reducedMotion}
          />
          <Bar
            dataKey="error"
            name={STATUS_LABEL.error}
            stackId="calls"
            fill={STATUS_COLORS.error}
            maxBarSize={BAR_MAX_THICKNESS}
            shape={makeVerticalBarShape('top')}
            onClick={() => onSelectStatus('error')}
            className="cursor-pointer"
            isAnimationActive={!reducedMotion}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  )
}
