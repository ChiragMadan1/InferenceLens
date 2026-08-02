import type { LogStatus } from '../api'

// The only place chart colours exist (spec 015). Every value here is a CSS
// custom-property reference into theme.css's token layer, so a chart
// re-paints for free on theme toggle — no `resolved` theme threaded through
// every chart component. Validated with the dataviz skill's
// validate_palette.js against this app's real chart surfaces (#12171F dark,
// #FFFFFF light); slot order is load-bearing for the CVD adjacency checks.

// Categorical — identity (model, provider, input-vs-output). Fixed order,
// never cycled; a 6th distinct value folds into "other" (FR28).
export const CATEGORICAL_SLOTS = [
  'var(--color-chart-cat-1)',
  'var(--color-chart-cat-2)',
  'var(--color-chart-cat-3)',
  'var(--color-chart-cat-4)',
  'var(--color-chart-cat-5)',
] as const

export const OTHER_COLOR = 'var(--color-ink-muted)'

// Status — reserved state, spec 009's tokens unchanged. Never used for a
// non-status series; no categorical slot is ever used for a status.
export const STATUS_COLORS: Record<LogStatus, string> = {
  success: 'var(--color-status-success)',
  cancelled: 'var(--color-status-cancelled)',
  error: 'var(--color-status-error)',
}

// Ordinal — the latency percentile ramp. One hue, monotone steps; not three
// categorical slots (percentiles are an ordered sequence).
export const ORDINAL_RAMP: Record<'p50' | 'p95' | 'p99', string> = {
  p50: 'var(--color-chart-ordinal-p50)',
  p95: 'var(--color-chart-ordinal-p95)',
  p99: 'var(--color-chart-ordinal-p99)',
}

// Mark specification (FR19), fixed across every chart.
export const BAR_MAX_THICKNESS = 24
export const BAR_RADIUS = 4
export const SEGMENT_GAP = 2
export const LINE_WIDTH = 2
export const MARKER_SIZE = 8
export const MARKER_RING = 2
export const AREA_OPACITY = 0.1

// Chart chrome — gridlines, axes, tooltip surface.
export const HAIRLINE = 'var(--color-hairline)'
export const INK_MUTED = 'var(--color-ink-muted)'
export const INK_SECONDARY = 'var(--color-ink-secondary)'
export const SURFACE = 'var(--color-surface)'

export const AXIS_TICK_STYLE = {
  fill: INK_MUTED,
  fontSize: 11,
  fontFamily:
    '"IBM Plex Mono", ui-monospace, "SF Mono", monospace',
} as const

export const AXIS_LINE_PROPS = { stroke: HAIRLINE, strokeWidth: 1 } as const
export const GRID_PROPS = { stroke: HAIRLINE, strokeDasharray: '0', vertical: false } as const

// FR28 — a model/provider's hue is assigned from a stable ordering of its
// key, never from row index or call volume, so filtering a series out never
// repaints the survivors. Only the first 5 (alphabetically) get a distinct
// hue; everything past that — including any `is_other` row spec 014 already
// folded — renders muted. No hue is ever generated or cycled.
export function assignCategoricalColors(keys: string[]): Map<string, string> {
  const sorted = [...new Set(keys)].sort((a, b) => a.localeCompare(b))
  const map = new Map<string, string>()
  sorted.forEach((key, index) => {
    map.set(key, index < CATEGORICAL_SLOTS.length ? CATEGORICAL_SLOTS[index] : OTHER_COLOR)
  })
  return map
}
