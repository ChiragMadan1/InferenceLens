import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, getLog, type InferenceLogRead, type LogStatus } from '../api'
import { formatCost, formatDateTime, formatMs, formatTokens } from '../lib/format'
import { CodeSegment, splitFencedContent, TextSegment } from '../components/chat/MessageBubble'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { ErrorState } from '../components/ui/ErrorState'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Skeleton } from '../components/ui/Skeleton'
import { KeyValueGrid } from '../components/logs/KeyValueGrid'
import { PromptTranscript } from '../components/logs/PromptTranscript'
import { TimingStrip } from '../components/logs/TimingStrip'

const successIcon = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
    <path d="M1.5 4.2 3.2 6l3.3-3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const errorIcon = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
    <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)
const cancelledIcon = (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
    <path d="M1.5 4h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)
const STATUS_ICON: Record<LogStatus, React.ReactNode> = { success: successIcon, error: errorIcon, cancelled: cancelledIcon }
const STATUS_TONE: Record<LogStatus, 'success' | 'error' | 'cancelled'> = {
  success: 'success',
  error: 'error',
  cancelled: 'cancelled',
}

function useCopyStatus(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
      .finally(() => setTimeout(() => setCopied(false), 1500))
  }
  return [copied, copy]
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, copy] = useCopyStatus()
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className="text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-surface p-3">
      <p className="text-micro uppercase text-ink-muted">{label}</p>
      <p className="font-data text-body tabular-nums text-ink">{value}</p>
    </div>
  )
}

// FR39/edge case #21 — spec 010's FR12 fenced-code treatment so a
// completion containing code is readable; scrolls internally with a max
// height rather than growing the page unbounded, with a "show all" escape
// hatch for a genuinely long completion.
function OutputPanel({ log }: { log: InferenceLogRead }) {
  const [copied, copy] = useCopyStatus()
  const [expanded, setExpanded] = useState(false)

  return (
    <Panel className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-h2 font-display text-ink">Completion</h3>
        {log.output_text !== null && (
          <button
            type="button"
            onClick={() => copy(log.output_text ?? '')}
            className="text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>

      {log.output_text === null ? (
        <p className="text-sm text-ink-muted">
          No output —{' '}
          {log.status === 'cancelled'
            ? 'this call was cancelled.'
            : log.status === 'error'
              ? 'this call errored.'
              : 'no output was recorded.'}
        </p>
      ) : (
        <>
          <div className={expanded ? 'overflow-auto' : 'max-h-[32rem] overflow-auto'}>
            {splitFencedContent(log.output_text).map((segment, index) =>
              segment.type === 'code' ? (
                <CodeSegment key={index} language={segment.language} content={segment.content} />
              ) : (
                <TextSegment key={index} content={segment.content} />
              ),
            )}
          </div>
          {!expanded && log.output_text.length > 2000 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="self-start text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
            >
              Show all
            </button>
          )}
        </>
      )}
    </Panel>
  )
}

// Edge case #23 — bounded, scrollable error block with a copy action.
function ErrorBlock({ log }: { log: InferenceLogRead }) {
  const [copied, copy] = useCopyStatus()
  if (!log.error_type && !log.error_message) return null

  return (
    <Panel className="flex flex-col gap-2 border-status-error/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-h2 font-display text-status-error">Error</h3>
        {log.error_message && (
          <button
            type="button"
            onClick={() => copy(log.error_message ?? '')}
            className="text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {log.error_type && <p className="font-data text-sm text-ink">{log.error_type}</p>}
      {log.error_message && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-sunken p-2 font-data text-sm text-status-error">
          {log.error_message}
        </pre>
      )}
    </Panel>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton variant="text" className="h-6 w-64" />
      <Skeleton variant="block" style={{ height: '4rem' }} />
      <Skeleton variant="block" style={{ height: '10rem' }} />
      <Skeleton variant="block" style={{ height: '10rem' }} />
    </div>
  )
}

// FR1's route table requires /logs/:requestId to resolve to something even
// with no requestId param (shouldn't happen given the route definition,
// but keeps this component total).
export function LogDetailPage() {
  const { requestId } = useParams()
  if (!requestId) return <LogDetailNotFound />
  return <LogDetailPageContent key={requestId} requestId={requestId} />
}

function LogDetailNotFound() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Log detail"
        actions={
          <Button variant="ghost" onClick={() => navigate('/logs')}>
            ← Back to logs
          </Button>
        }
      />
      <ErrorState
        heading="Inference log not found"
        message="No inference log matches this request id."
        action={
          <Button variant="secondary" onClick={() => navigate('/logs')}>
            Back to logs
          </Button>
        }
      />
    </div>
  )
}

type FetchStatus = 'loading' | 'ready' | 'not-found' | 'error'

// A hand-rolled fetch (rather than useResource) because FR43 needs the
// underlying ApiError.status to tell "unknown request_id" (404) apart from
// every other failure — useResource only retains the mapped detail string.
function LogDetailPageContent({ requestId }: { requestId: string }) {
  const navigate = useNavigate()
  const [log, setLog] = useState<InferenceLogRead | null>(null)
  const [status, setStatus] = useState<FetchStatus>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    getLog(requestId)
      .then((result) => {
        if (cancelled) return
        setLog(result)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const apiErr = err instanceof ApiError ? err : null
        if (apiErr?.status === 404) {
          setStatus('not-found')
        } else {
          setErrorMessage(apiErr?.detail ?? 'Something went wrong.')
          setStatus('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [requestId, reloadTick])

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-6 p-6">
        <PageHeader
          title="Log detail"
          actions={
            <Button variant="ghost" onClick={() => navigate('/logs')}>
              ← Back to logs
            </Button>
          }
        />
        <DetailSkeleton />
      </div>
    )
  }

  if (status === 'not-found') return <LogDetailNotFound />

  if (status === 'error' || !log) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <PageHeader
          title="Log detail"
          actions={
            <Button variant="ghost" onClick={() => navigate('/logs')}>
              ← Back to logs
            </Button>
          }
        />
        <ErrorState
          heading="Couldn't load this log"
          message={errorMessage ?? 'Something went wrong.'}
          action={
            <Button variant="secondary" onClick={() => setReloadTick((t) => t + 1)}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Log detail"
        actions={
          <Button variant="ghost" onClick={() => navigate('/logs')}>
            ← Back to logs
          </Button>
        }
      />

      <Panel className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Chip tone={STATUS_TONE[log.status]} icon={STATUS_ICON[log.status]}>
              {log.status}
            </Chip>
            <span className="text-sm text-ink-secondary">
              {log.model} · {log.provider} · {log.call_type}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-data text-sm text-ink-muted">{log.request_id}</span>
            <CopyButton text={log.request_id} label="Copy" />
          </div>
        </div>

        <TimingStrip
          requestedAt={log.requested_at}
          completedAt={log.completed_at}
          latencyMs={log.latency_ms}
          ttftMs={log.time_to_first_token_ms}
          status={log.status}
        />
      </Panel>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatBlock label="Input tokens" value={log.input_tokens === null ? '—' : formatTokens(log.input_tokens)} />
        <StatBlock label="Output tokens" value={log.output_tokens === null ? '—' : formatTokens(log.output_tokens)} />
        <StatBlock label="Cost" value={log.cost_usd === null ? 'not priced' : formatCost(log.cost_usd)} />
        <StatBlock
          label="TTFT"
          value={log.time_to_first_token_ms === null ? '— (available once streaming ships)' : formatMs(log.time_to_first_token_ms)}
        />
      </div>

      <PromptTranscript messages={log.input_messages} />

      <OutputPanel log={log} />

      <ErrorBlock log={log} />

      <Panel className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-2">
        <KeyValueGrid title="Request parameters" data={log.request_params} />
        <KeyValueGrid title="Provider metadata" data={log.provider_metadata} />
        <KeyValueGrid title="Config" data={{ config_hash: log.config_hash }} />
        <KeyValueGrid
          title="Timestamps"
          data={{
            requested_at: formatDateTime(log.requested_at),
            completed_at: log.completed_at ? formatDateTime(log.completed_at) : null,
            created_at: formatDateTime(log.created_at),
          }}
        />
      </Panel>

      {log.conversation_id !== null && (
        <div className="flex flex-wrap items-center gap-4 border-t border-hairline pt-4">
          <Link
            to={`/logs?conversation_id=${log.conversation_id}`}
            className="text-sm text-ink-secondary hover:text-ink hover:underline"
          >
            View all logs for this conversation
          </Link>
          <Link
            to={`/c/${log.conversation_id}`}
            title="Logs outlive conversations — this link may no longer resolve"
            className="text-sm text-ink-secondary hover:text-ink hover:underline"
          >
            Open conversation (may no longer exist)
          </Link>
        </div>
      )}
    </div>
  )
}
