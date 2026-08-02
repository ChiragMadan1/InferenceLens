import type { ReactNode } from 'react'

function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="text-ink-muted">—</span>
  if (typeof value === 'object') {
    // FR40 — a nested object falls back to formatted, scrollable JSON; the
    // page never renders [object Object].
    return (
      <pre className="max-h-48 overflow-auto rounded-md bg-surface-sunken p-2 font-data text-sm text-ink">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  return <span className="font-data text-sm text-ink">{String(value)}</span>
}

type KeyValueGridProps = {
  title: string
  data: Record<string, unknown> | null
}

// FR40 — request_params, provider_metadata, and config_hash render as a
// key/value grid with mono values and null shown as an em-dash.
export function KeyValueGrid({ title, data }: KeyValueGridProps) {
  const entries = data ? Object.entries(data) : []

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-h2 font-display text-ink">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-muted">—</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-sm text-ink-secondary">{key}</dt>
              <dd className="min-w-0">{renderValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
