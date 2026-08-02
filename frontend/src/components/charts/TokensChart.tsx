import { useReducedMotion } from 'framer-motion'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { BucketSize, TimeseriesPoint } from '../../api'
import { formatBucketTick, formatDateTime, formatTokens } from '../../lib/format'
import { AXIS_LINE_PROPS, AXIS_TICK_STYLE, BAR_MAX_THICKNESS, CATEGORICAL_SLOTS, GRID_PROPS } from '../../lib/chartTheme'
import { ChartLegend, ChartPanel, makeVerticalBarShape, type ChartPanelStatus } from './ChartPanel'
import { ChartTooltip } from './ChartTooltip'
import { SeriesTable } from './SeriesTable'

type Row = { t: string; input_tokens: number; output_tokens: number }

function buildRows(points: TimeseriesPoint[]): Row[] {
  return points.map((p) => ({ t: p.t, input_tokens: p.input_tokens, output_tokens: p.output_tokens }))
}

type TokensChartProps = {
  status: ChartPanelStatus
  points: TimeseriesPoint[]
  bucket: BucketSize
  bucketLabel: string
  errorMessage?: string
  onRetry?: () => void
}

export function TokensChart({ status, points, bucket, bucketLabel, errorMessage, onRetry }: TokensChartProps) {
  const reducedMotion = useReducedMotion()
  const rows = buildRows(points)

  return (
    <ChartPanel
      title="Tokens over time, input vs output"
      subtitle={`${bucketLabel} buckets`}
      ariaLabel={`Stacked column chart of input and output tokens over time, in ${bucketLabel} buckets.`}
      status={status}
      errorMessage={errorMessage}
      onRetry={onRetry}
      legend={
        <ChartLegend
          items={[
            { key: 'input', label: 'Input', color: CATEGORICAL_SLOTS[0] },
            { key: 'output', label: 'Output', color: CATEGORICAL_SLOTS[1] },
          ]}
        />
      }
      table={
        <SeriesTable
          caption="Tokens over time, input vs output"
          columns={[
            { key: 't', label: 'Bucket' },
            { key: 'input_tokens', label: 'Input', numeric: true },
            { key: 'output_tokens', label: 'Output', numeric: true },
          ]}
          rows={rows.map((r) => ({
            t: formatDateTime(r.t),
            input_tokens: formatTokens(r.input_tokens),
            output_tokens: formatTokens(r.output_tokens),
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
            width={48}
            tickFormatter={(v: number) => formatTokens(v)}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-surface-sunken)' }}
            content={
              <ChartTooltip formatLabel={(t) => formatDateTime(t)} formatValue={(v) => formatTokens(Number(v))} />
            }
          />
          <Bar
            dataKey="input_tokens"
            name="Input"
            stackId="tokens"
            fill={CATEGORICAL_SLOTS[0]}
            maxBarSize={BAR_MAX_THICKNESS}
            shape={makeVerticalBarShape('bottom')}
            isAnimationActive={!reducedMotion}
          />
          <Bar
            dataKey="output_tokens"
            name="Output"
            stackId="tokens"
            fill={CATEGORICAL_SLOTS[1]}
            maxBarSize={BAR_MAX_THICKNESS}
            shape={makeVerticalBarShape('top')}
            isAnimationActive={!reducedMotion}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  )
}
