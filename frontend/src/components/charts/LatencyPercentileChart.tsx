import { useReducedMotion } from 'framer-motion'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { BucketSize, TimeseriesPoint } from '../../api'
import { formatBucketTick, formatDateTime, formatMs } from '../../lib/format'
import {
  AXIS_LINE_PROPS,
  AXIS_TICK_STYLE,
  GRID_PROPS,
  INK_SECONDARY,
  LINE_WIDTH,
  MARKER_RING,
  MARKER_SIZE,
  ORDINAL_RAMP,
} from '../../lib/chartTheme'
import { ChartLegend, ChartPanel, type ChartPanelStatus } from './ChartPanel'
import { ChartTooltip } from './ChartTooltip'
import { SeriesTable } from './SeriesTable'

type Row = { t: string; p50: number | null; p95: number | null }

function buildRows(points: TimeseriesPoint[]): Row[] {
  return points.map((p) => ({ t: p.t, p50: p.latency_p50_ms, p95: p.latency_p95_ms }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// FR21 — direct end-label at the right-hand end of each percentile line,
// never a label on every point. recharts' Line `label` content function is
// loosely typed (its props bag isn't a fixed shape), so this narrows it
// explicitly rather than casting.
function makeEndLabel(text: string, total: number) {
  return function EndLabel(props: unknown): JSX.Element {
    if (!isRecord(props)) return <g />
    const { x, y, index } = props
    if (typeof index !== 'number' || index !== total - 1 || typeof x !== 'number' || typeof y !== 'number') {
      return <g />
    }
    return (
      <text x={x + 6} y={y} dy={4} fontSize={11} className="font-data" fill={INK_SECONDARY}>
        {text}
      </text>
    )
  }
}

type LatencyPercentileChartProps = {
  status: ChartPanelStatus
  points: TimeseriesPoint[]
  bucket: BucketSize
  bucketLabel: string
  errorMessage?: string
  onRetry?: () => void
}

// Deviation flagged: FR16/the ordinal palette describe a p50/p95/p99 ramp,
// but spec 014's TimeseriesPoint only carries latency_p50_ms/latency_p95_ms
// per bucket (p99 exists only in the stats endpoint's window-level
// LatencyStats, not per bucket). Inventing a per-bucket p99 client-side
// would violate the "no client-side aggregation" rule this dashboard is
// built around, so this chart plots the two fields the API actually
// returns. Adding a per-bucket p99 is a spec 014 change, not a frontend one.
export function LatencyPercentileChart({
  status,
  points,
  bucket,
  bucketLabel,
  errorMessage,
  onRetry,
}: LatencyPercentileChartProps) {
  const reducedMotion = useReducedMotion()
  const rows = buildRows(points)
  const p50Label = makeEndLabel('p50', rows.length)
  const p95Label = makeEndLabel('p95', rows.length)

  return (
    <ChartPanel
      title="Latency percentiles over time"
      subtitle={`${bucketLabel} buckets · p50 / p95`}
      ariaLabel={`Line chart of p50 and p95 latency over time, in ${bucketLabel} buckets.`}
      status={status}
      errorMessage={errorMessage}
      onRetry={onRetry}
      legend={
        <ChartLegend
          items={[
            { key: 'p50', label: 'p50', color: ORDINAL_RAMP.p50 },
            { key: 'p95', label: 'p95', color: ORDINAL_RAMP.p95 },
          ]}
        />
      }
      table={
        <SeriesTable
          caption="Latency percentiles over time"
          columns={[
            { key: 't', label: 'Bucket' },
            { key: 'p50', label: 'p50', numeric: true },
            { key: 'p95', label: 'p95', numeric: true },
          ]}
          rows={rows.map((r) => ({
            t: formatDateTime(r.t),
            p50: r.p50 === null ? '—' : formatMs(r.p50),
            p95: r.p95 === null ? '—' : formatMs(r.p95),
          }))}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ right: 32 }}>
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
            tickFormatter={(v: number) => formatMs(v)}
          />
          <Tooltip
            content={
              <ChartTooltip formatLabel={(t) => formatDateTime(t)} formatValue={(v) => formatMs(Number(v))} />
            }
          />
          <Line
            type="monotone"
            dataKey="p50"
            name="p50"
            stroke={ORDINAL_RAMP.p50}
            strokeWidth={LINE_WIDTH}
            dot={false}
            connectNulls={false}
            activeDot={{ r: MARKER_SIZE / 2, stroke: 'var(--color-surface)', strokeWidth: MARKER_RING }}
            isAnimationActive={!reducedMotion}
            label={p50Label}
          />
          <Line
            type="monotone"
            dataKey="p95"
            name="p95"
            stroke={ORDINAL_RAMP.p95}
            strokeWidth={LINE_WIDTH}
            dot={false}
            connectNulls={false}
            activeDot={{ r: MARKER_SIZE / 2, stroke: 'var(--color-surface)', strokeWidth: MARKER_RING }}
            isAnimationActive={!reducedMotion}
            label={p95Label}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartPanel>
  )
}
