import { useReducedMotion } from 'framer-motion'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { BucketSize, TimeseriesPoint } from '../../api'
import { formatBucketTick, formatDateTime, formatPercent } from '../../lib/format'
import {
  AREA_OPACITY,
  AXIS_LINE_PROPS,
  AXIS_TICK_STYLE,
  GRID_PROPS,
  LINE_WIDTH,
  MARKER_RING,
  MARKER_SIZE,
  STATUS_COLORS,
} from '../../lib/chartTheme'
import { ChartPanel, type ChartPanelStatus } from './ChartPanel'
import { ChartTooltip } from './ChartTooltip'
import { SeriesTable } from './SeriesTable'

type Row = { t: string; rate: number | null }

// FR24 — a bucket with zero calls has no rate to report (a break in the
// line), which is different from a rate that was genuinely 0. Dividing two
// numbers already returned for the *same* bucket mirrors what spec 014
// itself does for the window-level error_rate — it is not a cross-bucket
// aggregation, sum, average, or percentile.
function buildRows(points: TimeseriesPoint[]): Row[] {
  return points.map((p) => ({ t: p.t, rate: p.calls === 0 ? null : p.error_count / p.calls }))
}

type ErrorRateChartProps = {
  status: ChartPanelStatus
  points: TimeseriesPoint[]
  bucket: BucketSize
  bucketLabel: string
  errorMessage?: string
  onRetry?: () => void
}

export function ErrorRateChart({
  status,
  points,
  bucket,
  bucketLabel,
  errorMessage,
  onRetry,
}: ErrorRateChartProps) {
  const reducedMotion = useReducedMotion()
  const rows = buildRows(points)

  return (
    <ChartPanel
      title="Error rate over time"
      subtitle={`${bucketLabel} buckets`}
      ariaLabel={`Line chart of error rate over time, in ${bucketLabel} buckets.`}
      status={status}
      errorMessage={errorMessage}
      onRetry={onRetry}
      table={
        <SeriesTable
          caption="Error rate over time"
          columns={[
            { key: 't', label: 'Bucket' },
            { key: 'rate', label: 'Error rate', numeric: true },
          ]}
          rows={rows.map((r) => ({
            t: formatDateTime(r.t),
            rate: r.rate === null ? '—' : formatPercent(r.rate),
          }))}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows}>
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
            width={48}
            domain={[0, 'auto']}
            tickFormatter={(v: number) => formatPercent(v)}
          />
          <Tooltip
            content={
              <ChartTooltip
                formatLabel={(t) => formatDateTime(t)}
                formatValue={(v) => formatPercent(Number(v))}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="rate"
            name="Error rate"
            stroke={STATUS_COLORS.error}
            fill={STATUS_COLORS.error}
            fillOpacity={AREA_OPACITY}
            strokeWidth={LINE_WIDTH}
            dot={false}
            connectNulls={false}
            activeDot={{ r: MARKER_SIZE / 2, stroke: 'var(--color-surface)', strokeWidth: MARKER_RING }}
            isAnimationActive={!reducedMotion}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartPanel>
  )
}
