import { useState, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { Skeleton } from '../ui/Skeleton'
import { BAR_RADIUS, SEGMENT_GAP } from '../../lib/chartTheme'

export type ChartPanelStatus = 'loading' | 'error' | 'empty' | 'ready'

type ChartPanelProps = {
  title: string
  subtitle?: string
  ariaLabel: string
  legend?: ReactNode
  status: ChartPanelStatus
  errorMessage?: string
  onRetry?: () => void
  emptyMessage?: string
  height?: number
  table: ReactNode
  children: ReactNode
}

// FR29 — every panel owns its own loading/empty/error state and keeps the
// same geometry across all four (skeleton, empty, error, ready), so the
// page never reflows when data arrives and one failing panel never blanks
// the rest of the dashboard.
export function ChartPanel({
  title,
  subtitle,
  ariaLabel,
  legend,
  status,
  errorMessage,
  onRetry,
  emptyMessage,
  height = 260,
  table,
  children,
}: ChartPanelProps) {
  const [showTable, setShowTable] = useState(false)

  return (
    <Panel className="flex flex-col gap-3 overflow-x-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-h2 font-display text-ink">{title}</h3>
          {subtitle && <p className="text-sm text-ink-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3">
          {status === 'ready' && legend}
          {status === 'ready' && (
            <Button size="sm" variant="ghost" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Chart' : 'Table'}
            </Button>
          )}
        </div>
      </div>

      <div style={{ height }} className="relative min-w-[16rem]">
        {status === 'loading' && (
          <div className="flex h-full flex-col border-b border-l border-hairline p-2">
            <Skeleton variant="block" className="h-full w-full" />
          </div>
        )}

        {status === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="max-w-xs text-sm text-ink-secondary">
              {errorMessage ?? 'Cannot reach the backend. Is it running?'}
            </p>
            {onRetry && (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        )}

        {status === 'empty' && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm text-ink-secondary">{emptyMessage ?? 'No calls in this window.'}</p>
          </div>
        )}

        {status === 'ready' && (
          <div role="img" aria-label={ariaLabel} className="h-full w-full">
            {showTable ? table : children}
          </div>
        )}
      </div>
    </Panel>
  )
}

export type LegendItem = { key: string; label: string; color: string }

// FR20/FR22 — legend swatches are marks, legend text wears text tokens.
// Rendered in the panel header rather than recharts' built-in <Legend/>,
// which colours its own label text to match the series (FR22 violation).
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-3">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

type StackEdge = 'top' | 'middle' | 'bottom' | 'only'

type BarGeometry = { x: number; y: number; width: number; height: number; fill: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

// recharts' Bar `shape` prop is typed `(props: unknown) => JSX.Element` (one
// arm of its ActiveShape union) — the props bag isn't otherwise typed, so
// this narrows it explicitly rather than casting to a fixed shape.
function readBarGeometry(props: unknown): BarGeometry {
  if (!isRecord(props)) return { x: 0, y: 0, width: 0, height: 0, fill: 'currentColor' }
  return {
    x: numberOr(props.x, 0),
    y: numberOr(props.y, 0),
    width: numberOr(props.width, 0),
    height: numberOr(props.height, 0),
    fill: typeof props.fill === 'string' ? props.fill : 'currentColor',
  }
}

// FR19 — every stacked-column segment is inset by half the surface gap on
// its touching edges (insetting the geometry, never stroking the mark), and
// only the outermost tip of the whole stack gets the rounded "data-end"
// corner; the shared baseline and every inter-segment border stay square.
export function makeVerticalBarShape(edge: StackEdge) {
  return function VerticalBarShape(props: unknown): JSX.Element {
    const { x, y, width, height, fill } = readBarGeometry(props)
    if (width <= 0 || height <= 0) return <g />

    const half = SEGMENT_GAP / 2
    const insetTop = edge === 'middle' || edge === 'bottom'
    const insetBottom = edge === 'middle' || edge === 'top'
    const ry = y + (insetTop ? half : 0)
    const rHeight = Math.max(0, height - (insetTop ? half : 0) - (insetBottom ? half : 0))
    if (rHeight <= 0) return <g />

    const roundTop = edge === 'only' || edge === 'top'
    const r = Math.max(0, Math.min(BAR_RADIUS, width / 2, rHeight))

    const d = roundTop
      ? `M${x},${ry + rHeight} L${x},${ry + r} Q${x},${ry} ${x + r},${ry} ` +
        `L${x + width - r},${ry} Q${x + width},${ry} ${x + width},${ry + r} ` +
        `L${x + width},${ry + rHeight} Z`
      : `M${x},${ry} L${x + width},${ry} L${x + width},${ry + rHeight} L${x},${ry + rHeight} Z`

    return <path d={d} fill={fill} />
  }
}

// Panel 5's horizontal bars — rounded right tip (the data end), square left
// baseline. Categories are separate rows rather than a stack, so no
// inter-segment gap logic is needed here.
export function HorizontalBarShape(props: unknown): JSX.Element {
  const { x, y, width, height, fill } = readBarGeometry(props)
  if (width <= 0 || height <= 0) return <g />
  const r = Math.max(0, Math.min(BAR_RADIUS, width, height / 2))
  const d =
    `M${x},${y} L${x + Math.max(width - r, 0)},${y} ` +
    `Q${x + width},${y} ${x + width},${y + r} ` +
    `L${x + width},${y + height - r} Q${x + width},${y + height} ${x + Math.max(width - r, 0)},${y + height} ` +
    `L${x},${y + height} Z`
  return <path d={d} fill={fill} />
}
