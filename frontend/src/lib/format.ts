// Platform Intl/Date only (see spec 009 Constraints). No relative time,
// no timezone coercion — the backend still serialises naive timestamps
// until spec 014's UTC fix lands.

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// Spec 015 — latency values across the logs dashboard (KPI tiles, chart
// tooltips, the timing strip). Same rule as formatDuration: switch to
// seconds above 1000ms so a slow call doesn't read as a five-digit number.
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatTokens(count: number): string {
  return count.toLocaleString()
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

const BUCKET_LABELS: Record<'minute' | 'hour' | 'day', string> = {
  minute: 'minutely',
  hour: 'hourly',
  day: 'daily',
}

export function formatBucketLabel(bucket: 'minute' | 'hour' | 'day'): string {
  return BUCKET_LABELS[bucket]
}

// Short axis-tick label for a timeseries bucket start — granularity-aware so
// a 30-day view doesn't tick in minutes and a 1h view doesn't tick in dates.
export function formatBucketTick(iso: string, bucket: 'minute' | 'hour' | 'day'): string {
  const d = new Date(iso)
  if (bucket === 'minute') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (bucket === 'hour') {
    return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

// cost_usd comes off the wire as a string (Pydantic serialises Decimal as
// a string — spec 015's data model) so formatting it never round-trips
// through a JS float beyond this single display-precision conversion.
export function formatCost(usd: string): string {
  const value = Number(usd)
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function isDefaultTitle(title: string): boolean {
  return title === 'New conversation'
}
