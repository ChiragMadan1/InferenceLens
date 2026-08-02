import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { BucketSize, CallType, LogStatus } from '../api'

export type LogRangePreset = '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom'

export type LogFilters = {
  range: LogRangePreset
  from?: string
  to?: string
  status?: LogStatus
  call_type?: CallType
  model?: string
  provider?: string
  conversation_id?: number
  offset: number
}

const RANGE_MS: Record<Exclude<LogRangePreset, 'custom'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const VALID_RANGES = new Set<string>(['15m', '1h', '6h', '24h', '7d', '30d', 'custom'])
const VALID_STATUSES = new Set<string>(['success', 'error', 'cancelled'])
const VALID_CALL_TYPES = new Set<string>(['chat', 'title'])

const BUCKET_LABELS: Record<BucketSize, string> = { minute: 'minutely', hour: 'hourly', day: 'daily' }

// FR10 — bucket size is derived from the window, never chosen by the user,
// so spec 014's MAX_BUCKETS 422 is unreachable by construction.
function deriveBucket(windowMs: number): BucketSize {
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  if (windowMs <= 6 * HOUR) return 'minute'
  if (windowMs <= 7 * DAY) return 'hour'
  return 'day'
}

function parseFilters(params: URLSearchParams): LogFilters {
  const rangeParam = params.get('range')
  const range = (VALID_RANGES.has(rangeParam ?? '') ? rangeParam : '24h') as LogRangePreset

  const statusParam = params.get('status')
  const callTypeParam = params.get('call_type')
  const conversationIdParam = params.get('conversation_id')
  const offsetParam = params.get('offset')

  return {
    range,
    from: range === 'custom' ? (params.get('from') ?? undefined) : undefined,
    to: range === 'custom' ? (params.get('to') ?? undefined) : undefined,
    status: VALID_STATUSES.has(statusParam ?? '') ? (statusParam as LogStatus) : undefined,
    call_type: VALID_CALL_TYPES.has(callTypeParam ?? '') ? (callTypeParam as CallType) : undefined,
    model: params.get('model') ?? undefined,
    provider: params.get('provider') ?? undefined,
    conversation_id:
      conversationIdParam && /^\d+$/.test(conversationIdParam) ? Number(conversationIdParam) : undefined,
    offset: offsetParam && /^\d+$/.test(offsetParam) ? Number(offsetParam) : 0,
  }
}

export type ResolvedWindow = {
  from: string
  to: string
  bucket: BucketSize
  bucketLabel: string
}

export type FilterChipKey = 'status' | 'call_type' | 'model' | 'provider' | 'conversation_id'

export type UseLogFiltersResult = {
  filters: LogFilters
  // null when a custom range is missing or invalid (from >= to) — callers
  // must not issue a request in that state (edge case #17).
  resolvedWindow: ResolvedWindow | null
  rangeError: string | null
  setRange: (range: LogRangePreset) => void
  setCustomRange: (from: string, to: string) => void
  setStatus: (status: LogStatus | undefined) => void
  setCallType: (callType: CallType | undefined) => void
  setModel: (model: string | undefined) => void
  setProvider: (provider: string | undefined) => void
  removeFilter: (key: FilterChipKey) => void
  clearAll: () => void
  setOffset: (offset: number) => void
}

// URL-backed filter state (FR5) — the single place a filter is interpreted.
// There is no duplicate copy of filter state in React state.
export function useLogFilters(): UseLogFiltersResult {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => parseFilters(searchParams), [searchParams])

  const resolvedWindow = useMemo<ResolvedWindow | null>(() => {
    if (filters.range === 'custom') {
      if (!filters.from || !filters.to) return null
      const fromMs = Date.parse(filters.from)
      const toMs = Date.parse(filters.to)
      if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) return null
      const bucket = deriveBucket(toMs - fromMs)
      return { from: filters.from, to: filters.to, bucket, bucketLabel: BUCKET_LABELS[bucket] }
    }
    const toMs = Date.now()
    const fromMs = toMs - RANGE_MS[filters.range]
    const bucket = deriveBucket(toMs - fromMs)
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      bucket,
      bucketLabel: BUCKET_LABELS[bucket],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.range, filters.from, filters.to])

  const rangeError =
    filters.range === 'custom' && filters.from && filters.to && resolvedWindow === null
      ? 'The start of a custom range must be earlier than the end.'
      : null

  function updateParams(mutate: (params: URLSearchParams) => void, resetOffset = true) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      mutate(next)
      if (resetOffset) next.delete('offset') // FR11 — any filter change resets to page 1
      return next
    })
  }

  function setRange(range: LogRangePreset) {
    updateParams((params) => {
      params.set('range', range)
      if (range !== 'custom') {
        params.delete('from')
        params.delete('to')
      }
    })
  }

  function setCustomRange(from: string, to: string) {
    updateParams((params) => {
      params.set('range', 'custom')
      params.set('from', from)
      params.set('to', to)
    })
  }

  function setStatus(status: LogStatus | undefined) {
    updateParams((params) => (status ? params.set('status', status) : params.delete('status')))
  }

  function setCallType(callType: CallType | undefined) {
    updateParams((params) => (callType ? params.set('call_type', callType) : params.delete('call_type')))
  }

  function setModel(model: string | undefined) {
    updateParams((params) => (model ? params.set('model', model) : params.delete('model')))
  }

  function setProvider(provider: string | undefined) {
    updateParams((params) => (provider ? params.set('provider', provider) : params.delete('provider')))
  }

  function removeFilter(key: FilterChipKey) {
    updateParams((params) => params.delete(key))
  }

  function clearAll() {
    setSearchParams(new URLSearchParams())
  }

  function setOffset(offset: number) {
    updateParams((params) => {
      if (offset > 0) params.set('offset', String(offset))
      else params.delete('offset')
    }, false)
  }

  return {
    filters,
    resolvedWindow,
    rangeError,
    setRange,
    setCustomRange,
    setStatus,
    setCallType,
    setModel,
    setProvider,
    removeFilter,
    clearAll,
    setOffset,
  }
}
