import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getLogStats,
  getLogTimeseries,
  listLogs,
  type InferenceLogSummary,
  type LogStatsRead,
  type LogStatus,
  type LogTimeseriesRead,
  type Page,
} from '../api'
import { useLogFilters, type LogFilters, type ResolvedWindow } from '../hooks/useLogFilters'
import { useResource, type Resource } from '../hooks/useResource'
import { formatCost, formatPercent, formatTokens, formatMs } from '../lib/format'
import { Button } from '../components/ui/Button'
import { NoticeBanner } from '../components/ui/NoticeBanner'
import { PageHeader } from '../components/ui/PageHeader'
import { KpiTile } from '../components/logs/KpiTile'
import { FilterBar } from '../components/logs/FilterBar'
import { LogTable } from '../components/logs/LogTable'
import { BreakdownTable } from '../components/logs/BreakdownTable'
import type { ChartPanelStatus } from '../components/charts/ChartPanel'
import { CallsByStatusChart } from '../components/charts/CallsByStatusChart'
import { LatencyPercentileChart } from '../components/charts/LatencyPercentileChart'
import { ErrorRateChart } from '../components/charts/ErrorRateChart'
import { TokensChart } from '../components/charts/TokensChart'
import { CostByModelChart } from '../components/charts/CostByModelChart'

const LIST_LIMIT = 25 // spec 007 permits up to 100; assumed page size (open question)
const DEBOUNCE_MS = 250

const RANGE_LABELS: Record<LogFilters['range'], string> = {
  '15m': 'last 15 minutes',
  '1h': 'last 1 hour',
  '6h': 'last 6 hours',
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  custom: 'custom range',
}

function baseParams(f: LogFilters) {
  return {
    conversation_id: f.conversation_id,
    status: f.status,
    call_type: f.call_type,
    model: f.model,
    provider: f.provider,
  }
}

type DebouncedQuery = { resolvedWindow: ResolvedWindow | null; filters: LogFilters; key: string }

// FR11 — rapid filter changes are debounced 250ms before a new request is
// issued; useResource's own request counter discards a superseded response.
function useDebouncedQuery(resolvedWindow: ResolvedWindow | null, filters: LogFilters): DebouncedQuery {
  const key = JSON.stringify({
    from: resolvedWindow?.from,
    to: resolvedWindow?.to,
    bucket: resolvedWindow?.bucket,
    status: filters.status,
    call_type: filters.call_type,
    model: filters.model,
    provider: filters.provider,
    conversation_id: filters.conversation_id,
  })
  const [debounced, setDebounced] = useState<DebouncedQuery>({ resolvedWindow, filters, key })

  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ resolvedWindow, filters, key }), DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // key alone captures every field that matters; resolvedWindow/filters are
    // read fresh inside the timeout closure below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return debounced
}

function panelStatus(resource: Resource<unknown>, noCalls: boolean): ChartPanelStatus {
  if (resource.error) return 'error'
  if (resource.isFirstLoad) return 'loading'
  if (noCalls) return 'empty'
  return 'ready'
}

// FR1/FR2 — full-bleed dashboard (no conversation rail — AppShell already
// hides it on /logs*): header, sticky filter bar, KPI row, chart grid, table.
export function LogsDashboardPage() {
  const navigate = useNavigate()
  const {
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
  } = useLogFilters()

  const debounced = useDebouncedQuery(resolvedWindow, filters)
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)

  // FR9 — fetched once, unfiltered on model/provider (and every other
  // dimension), so picking a model doesn't collapse the option list to
  // itself. Not part of FR11's per-filter-change request budget.
  const optionsResource = useResource(() => getLogStats({}), [])
  const modelOptions = [...new Set((optionsResource.data?.by_model ?? []).filter((g) => !g.is_other).map((g) => g.key))].sort()
  const providerOptions = [
    ...new Set((optionsResource.data?.by_provider ?? []).filter((g) => !g.is_other).map((g) => g.key)),
  ].sort()

  const statsResource = useResource<LogStatsRead | null>(async () => {
    if (!debounced.resolvedWindow) return null
    return getLogStats({
      from: debounced.resolvedWindow.from,
      to: debounced.resolvedWindow.to,
      ...baseParams(debounced.filters),
    })
  }, [debounced.key])

  const tsStatusResource = useResource<LogTimeseriesRead | null>(async () => {
    if (!debounced.resolvedWindow) return null
    return getLogTimeseries({
      from: debounced.resolvedWindow.from,
      to: debounced.resolvedWindow.to,
      bucket: debounced.resolvedWindow.bucket,
      group_by: 'status',
      ...baseParams(debounced.filters),
    })
  }, [debounced.key])

  const tsNoneResource = useResource<LogTimeseriesRead | null>(async () => {
    if (!debounced.resolvedWindow) return null
    return getLogTimeseries({
      from: debounced.resolvedWindow.from,
      to: debounced.resolvedWindow.to,
      bucket: debounced.resolvedWindow.bucket,
      group_by: 'none',
      ...baseParams(debounced.filters),
    })
  }, [debounced.key])

  // Note — spec 007's GET /logs takes no from/to params, so the table is
  // scoped by every filter except the time range; a change to spec 007
  // would be needed to window it the way the KPI row and charts are.
  const logsResource = useResource<Page<InferenceLogSummary>>(
    () => listLogs({ limit: LIST_LIMIT, offset: filters.offset, ...baseParams(debounced.filters) }),
    [debounced.key, filters.offset],
  )

  useEffect(() => {
    if (statsResource.data) setLastLoadedAt(new Date().toISOString())
  }, [statsResource.data])

  function handleRefresh() {
    statsResource.reload()
    tsStatusResource.reload()
    tsNoneResource.reload()
    logsResource.reload()
  }

  const refreshing =
    (statsResource.loading && !statsResource.isFirstLoad) ||
    (tsStatusResource.loading && !tsStatusResource.isFirstLoad) ||
    (tsNoneResource.loading && !tsNoneResource.isFirstLoad) ||
    (logsResource.loading && !logsResource.isFirstLoad)

  const backendUnreachable = [statsResource, tsStatusResource, tsNoneResource, logsResource].some(
    (r) => r.error === 'Cannot reach the backend. Is it running?',
  )

  const stats = statsResource.data
  const noCalls = stats ? stats.total_calls === 0 : false
  const allSeries = tsNoneResource.data?.series[0]
  const allPoints = allSeries?.points ?? []

  // FR15 — total_calls === 0 renders every tile with an em-dash and a
  // caption, never 0 / 0ms / 0% / $0.00.
  let costValue = '—'
  let costCaption: string | undefined
  let costWarning = false
  if (stats && !noCalls) {
    costValue = stats.cost_usd !== null ? formatCost(stats.cost_usd) : 'not priced'
    if (stats.cost_coverage < 1) {
      costWarning = true
      const pct = Math.round(stats.cost_coverage * 100)
      costCaption = stats.cost_usd === null ? 'not priced' : `partial — ${pct}% of calls priced`
    }
  } else if (stats) {
    costCaption = 'no calls in this window'
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Inference logs"
        actions={
          <Button variant="ghost" onClick={() => navigate('/')}>
            ← Back to chat
          </Button>
        }
      />

      {backendUnreachable && (
        <NoticeBanner kind="error">Cannot reach the backend. Is it running?</NoticeBanner>
      )}

      <FilterBar
        filters={filters}
        bucketLabel={resolvedWindow ? `${RANGE_LABELS[filters.range]} · ${resolvedWindow.bucketLabel}` : undefined}
        rangeError={rangeError}
        modelOptions={modelOptions}
        providerOptions={providerOptions}
        onSetRange={setRange}
        onSetCustomRange={setCustomRange}
        onSetStatus={setStatus}
        onSetCallType={setCallType}
        onSetModel={setModel}
        onSetProvider={setProvider}
        onRemoveFilter={removeFilter}
        onClearAll={clearAll}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        lastLoadedAt={lastLoadedAt}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 min-[1440px]:grid-cols-5">
        <KpiTile
          label="Calls"
          value={noCalls || !stats ? '—' : formatTokens(stats.total_calls)}
          caption={!stats || noCalls ? 'no calls in this window' : undefined}
          sparkline={allPoints.length > 0 ? allPoints.map((p) => p.calls) : undefined}
        />
        <KpiTile
          label="Error rate"
          value={noCalls || !stats ? '—' : formatPercent(stats.error_rate)}
          caption={!stats || noCalls ? 'no calls in this window' : undefined}
        />
        <KpiTile
          label="p95 latency"
          value={noCalls || !stats || !stats.latency ? '—' : formatMs(stats.latency.p95_ms)}
          caption={!stats || noCalls ? 'no calls in this window' : undefined}
          sparkline={allPoints.length > 0 ? allPoints.map((p) => p.latency_p95_ms) : undefined}
        />
        <KpiTile
          label="Total cost"
          value={costValue}
          caption={costCaption}
          warning={costWarning}
          tooltip={costWarning ? 'Calls whose model was not in the price map have no cost.' : undefined}
        />
        <KpiTile
          label="Total tokens"
          value={noCalls || !stats ? '—' : formatTokens(stats.tokens.total)}
          caption={!stats || noCalls ? 'no calls in this window' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CallsByStatusChart
          status={panelStatus(tsStatusResource, noCalls)}
          series={tsStatusResource.data?.series ?? []}
          bucket={resolvedWindow?.bucket ?? 'hour'}
          bucketLabel={resolvedWindow?.bucketLabel ?? 'hourly'}
          errorMessage={tsStatusResource.error ?? undefined}
          onRetry={tsStatusResource.reload}
          onSelectStatus={(status: LogStatus) => setStatus(status)}
        />
        <LatencyPercentileChart
          status={panelStatus(tsNoneResource, noCalls)}
          points={allPoints}
          bucket={resolvedWindow?.bucket ?? 'hour'}
          bucketLabel={resolvedWindow?.bucketLabel ?? 'hourly'}
          errorMessage={tsNoneResource.error ?? undefined}
          onRetry={tsNoneResource.reload}
        />
        <ErrorRateChart
          status={panelStatus(tsNoneResource, noCalls)}
          points={allPoints}
          bucket={resolvedWindow?.bucket ?? 'hour'}
          bucketLabel={resolvedWindow?.bucketLabel ?? 'hourly'}
          errorMessage={tsNoneResource.error ?? undefined}
          onRetry={tsNoneResource.reload}
        />
        <TokensChart
          status={panelStatus(tsNoneResource, noCalls)}
          points={allPoints}
          bucket={resolvedWindow?.bucket ?? 'hour'}
          bucketLabel={resolvedWindow?.bucketLabel ?? 'hourly'}
          errorMessage={tsNoneResource.error ?? undefined}
          onRetry={tsNoneResource.reload}
        />
        <CostByModelChart
          status={panelStatus(statsResource, noCalls)}
          groups={stats?.by_model ?? []}
          errorMessage={statsResource.error ?? undefined}
          onRetry={statsResource.reload}
          onSelectModel={(model: string) => setModel(model)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownTable title="By provider" rows={stats?.by_provider ?? []} />
        <BreakdownTable title="By call type" rows={stats?.by_call_type ?? []} />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-h2 font-display text-ink">Logs</h2>
        <LogTable
          items={logsResource.data?.items ?? []}
          total={logsResource.data?.total ?? 0}
          limit={LIST_LIMIT}
          offset={filters.offset}
          isFirstLoad={logsResource.isFirstLoad}
          loading={logsResource.loading}
          error={logsResource.error}
          hasActiveFilters={Boolean(
            filters.status || filters.call_type || filters.model || filters.provider || filters.conversation_id,
          )}
          onRetry={logsResource.reload}
          onPageChange={setOffset}
          onClearFilters={clearAll}
        />
      </div>
    </div>
  )
}
