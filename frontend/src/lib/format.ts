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

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function isDefaultTitle(title: string): boolean {
  return title === 'New conversation'
}
