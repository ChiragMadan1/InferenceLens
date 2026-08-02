import { useEffect, useState } from 'react'
import type { CallType, LogStatus } from '../../api'
import type { FilterChipKey, LogFilters, LogRangePreset } from '../../hooks/useLogFilters'
import { formatDateTime } from '../../lib/format'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'

const RANGE_PRESETS: { value: LogRangePreset; label: string }[] = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'custom', label: 'Custom' },
]

const STATUS_OPTIONS: LogStatus[] = ['success', 'error', 'cancelled']
const CALL_TYPE_OPTIONS: CallType[] = ['chat', 'title']

const removeIcon = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
    <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

// Isoformat -> the value a <input type="datetime-local"> needs (no timezone
// suffix, minute precision).
function toDatetimeLocal(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type FilterBarProps = {
  filters: LogFilters
  bucketLabel?: string
  rangeError: string | null
  modelOptions: string[]
  providerOptions: string[]
  onSetRange: (range: LogRangePreset) => void
  onSetCustomRange: (from: string, to: string) => void
  onSetStatus: (status: LogStatus | undefined) => void
  onSetCallType: (callType: CallType | undefined) => void
  onSetModel: (model: string | undefined) => void
  onSetProvider: (provider: string | undefined) => void
  onRemoveFilter: (key: FilterChipKey) => void
  onClearAll: () => void
  onRefresh: () => void
  refreshing: boolean
  lastLoadedAt: string | null
}

// FR2/FR6-FR9 — sticky filter bar governing the KPI row, every chart, and
// the table (FR4); no per-panel filter. FR5 — every control writes straight
// through useLogFilters into the URL, there is no local copy of the filter.
export function FilterBar({
  filters,
  bucketLabel,
  rangeError,
  modelOptions,
  providerOptions,
  onSetRange,
  onSetCustomRange,
  onSetStatus,
  onSetCallType,
  onSetModel,
  onSetProvider,
  onRemoveFilter,
  onClearAll,
  onRefresh,
  refreshing,
  lastLoadedAt,
}: FilterBarProps) {
  const [draftFrom, setDraftFrom] = useState(toDatetimeLocal(filters.from))
  const [draftTo, setDraftTo] = useState(toDatetimeLocal(filters.to))

  useEffect(() => {
    setDraftFrom(toDatetimeLocal(filters.from))
    setDraftTo(toDatetimeLocal(filters.to))
  }, [filters.from, filters.to])

  function commitCustomRange(from: string, to: string) {
    if (!from || !to) return
    onSetCustomRange(new Date(from).toISOString(), new Date(to).toISOString())
  }

  const chips: { key: FilterChipKey; label: string }[] = []
  if (filters.status) chips.push({ key: 'status', label: `Status: ${filters.status}` })
  if (filters.call_type) chips.push({ key: 'call_type', label: `Call type: ${filters.call_type}` })
  if (filters.model) chips.push({ key: 'model', label: `Model: ${filters.model}` })
  if (filters.provider) chips.push({ key: 'provider', label: `Provider: ${filters.provider}` })
  if (filters.conversation_id !== undefined) {
    chips.push({ key: 'conversation_id', label: `Conversation #${filters.conversation_id}` })
  }

  return (
    <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-hairline bg-canvas/95 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-hairline bg-surface p-1">
          {RANGE_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => onSetRange(preset.value)}
              aria-pressed={filters.range === preset.value}
              className={[
                'rounded-sm px-2.5 py-1 text-sm transition-colors duration-[var(--dur-instant)] ease-out',
                filters.range === preset.value
                  ? 'bg-signal-soft text-ink'
                  : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink',
              ].join(' ')}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {filters.range === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              value={draftFrom}
              onChange={(e) => {
                setDraftFrom(e.target.value)
                commitCustomRange(e.target.value, draftTo)
              }}
              className="rounded-md border border-hairline bg-surface px-2 py-1 font-data text-sm text-ink"
              aria-label="Custom range start"
            />
            <span className="text-ink-muted">→</span>
            <input
              type="datetime-local"
              value={draftTo}
              onChange={(e) => {
                setDraftTo(e.target.value)
                commitCustomRange(draftFrom, e.target.value)
              }}
              className="rounded-md border border-hairline bg-surface px-2 py-1 font-data text-sm text-ink"
              aria-label="Custom range end"
            />
          </div>
        )}

        {bucketLabel && !rangeError && (
          <span className="text-sm text-ink-muted">{bucketLabel}</span>
        )}

        <select
          value={filters.status ?? ''}
          onChange={(e) => onSetStatus(e.target.value === '' ? undefined : (e.target.value as LogStatus))}
          className="rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm text-ink"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={filters.call_type ?? ''}
          onChange={(e) => onSetCallType(e.target.value === '' ? undefined : (e.target.value as CallType))}
          className="rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm text-ink"
          aria-label="Filter by call type"
        >
          <option value="">All call types</option>
          {CALL_TYPE_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={filters.model ?? ''}
          onChange={(e) => onSetModel(e.target.value === '' ? undefined : e.target.value)}
          className="max-w-[10rem] rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm text-ink"
          aria-label="Filter by model"
        >
          <option value="">All models</option>
          {modelOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <select
          value={filters.provider ?? ''}
          onChange={(e) => onSetProvider(e.target.value === '' ? undefined : e.target.value)}
          className="max-w-[10rem] rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm text-ink"
          aria-label="Filter by provider"
        >
          <option value="">All providers</option>
          {providerOptions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-3">
          {lastLoadedAt && (
            <span className="font-data text-sm text-ink-muted">Loaded {formatDateTime(lastLoadedAt)}</span>
          )}
          <Button variant="secondary" size="sm" onClick={onRefresh} loading={refreshing} disabled={refreshing}>
            Refresh
          </Button>
        </div>
      </div>

      {rangeError && <p className="text-sm text-status-error">{rangeError}</p>}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <button key={chip.key} type="button" onClick={() => onRemoveFilter(chip.key)} className="group">
              <Chip tone="signal" icon={removeIcon} className="group-hover:opacity-80">
                {chip.label}
              </Chip>
            </button>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
