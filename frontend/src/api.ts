import { emit } from './lib/events'
import { pushLatencyEntry } from './lib/latencyBuffer'

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export class ApiError extends Error {
  status: number // HTTP status; 0 means the request never reached the server
  detail: string // the backend's ErrorResponse.detail, or a fallback

  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

export type Page<T> = {
  items: T[]
  total: number
  limit: number
  offset: number
}

export type ConversationStatus = 'active'

export type ConversationRead = {
  id: number
  title: string
  status: ConversationStatus
  created_at: string // ISO-8601 from the backend
  updated_at: string
}

export type ConversationCreate = {
  title?: string | null
}

async function parseErrorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const detail = (body as { detail: unknown }).detail
      if (typeof detail === 'string') return detail
      if (Array.isArray(detail)) return 'Invalid request.'
    }
  } catch {
    // error page may not be JSON — fall through to the HTTP-status fallback
  }
  return `HTTP ${res.status}`
}

// Shared with streamMessage (FR21) — its response body isn't JSON, so it
// can't go through request<T>, but a non-ok status uses the same rules.
async function buildApiError(res: Response): Promise<ApiError> {
  return new ApiError(res.status, await parseErrorDetail(res))
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const t0 = performance.now()
  let ok = false
  try {
    let res: Response
    try {
      res = await fetch(`${BASE_URL}${path}`, init)
    } catch {
      throw new ApiError(0, 'Cannot reach the backend. Is it running?')
    }

    if (!res.ok) {
      throw await buildApiError(res)
    }
    ok = true

    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  } finally {
    pushLatencyEntry({ method, path, ms: performance.now() - t0, ok })
  }
}

export async function checkHealth(): Promise<{ status: string }> {
  return request<{ status: string }>('/health')
}

// ---------------------------------------------------------------------------
// Model catalog (spec 020)
// ---------------------------------------------------------------------------

export type ModelRead = {
  id: string
  provider: string
  display_name: string
  is_default: boolean
}

export async function getModels(): Promise<ModelRead[]> {
  return request<ModelRead[]>('/models')
}

// ---------------------------------------------------------------------------
// Inference logs (spec 007/014 backend, spec 015 frontend)
// ---------------------------------------------------------------------------

export type LogStatus = 'success' | 'error' | 'cancelled'
export type CallType = 'chat' | 'title'
export type BucketSize = 'minute' | 'hour' | 'day'
export type LogGroupBy = 'none' | 'status' | 'model' | 'provider' | 'call_type'

export type InferenceLogSummary = {
  id: number
  request_id: string
  conversation_id: number | null
  call_type: CallType
  model: string
  provider: string
  status: LogStatus
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  time_to_first_token_ms: number | null
  cost_usd: string | null // Decimal serialises as a string — never parse to float for display
  error_type: string | null
  config_hash: string | null
  requested_at: string
  completed_at: string | null
  created_at: string
  input_preview: string | null
  output_preview: string | null
}

export type InferenceLogRead = InferenceLogSummary & {
  schema_version: number
  input_messages: Array<{ role: string; content: unknown }>
  output_text: string | null
  request_params: Record<string, unknown> | null
  provider_metadata: Record<string, unknown> | null
  error_message: string | null
}

export type TimeWindow = { from: string; to: string }
export type LatencyStats = { p50_ms: number; p95_ms: number; p99_ms: number; avg_ms: number; max_ms: number }
export type TokenStats = { input: number; output: number; total: number }

export type LogGroupStat = {
  key: string
  is_other: boolean
  calls: number
  error_count: number
  error_rate: number
  latency_p95_ms: number | null
  input_tokens: number
  output_tokens: number
  cost_usd: string | null
}

export type LogStatsRead = {
  window: TimeWindow
  total_calls: number
  success_count: number
  error_count: number
  cancelled_count: number
  error_rate: number
  latency: LatencyStats | null
  ttft: LatencyStats | null
  tokens: TokenStats
  cost_usd: string | null
  cost_coverage: number
  by_model: LogGroupStat[]
  by_provider: LogGroupStat[]
  by_call_type: LogGroupStat[]
  by_status: LogGroupStat[]
}

export type TimeseriesPoint = {
  t: string
  calls: number
  error_count: number
  cancelled_count: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
  input_tokens: number
  output_tokens: number
  cost_usd: string | null
}

export type TimeseriesSeries = { key: string; is_other: boolean; points: TimeseriesPoint[] }

export type LogTimeseriesRead = {
  window: TimeWindow
  bucket: BucketSize
  group_by: LogGroupBy
  bucket_count: number
  series: TimeseriesSeries[]
}

export type LogListQuery = {
  limit: number
  offset: number
  conversation_id?: number
  status?: LogStatus
  call_type?: CallType
  model?: string
  provider?: string
}

export type LogStatsQuery = {
  from?: string
  to?: string
  conversation_id?: number
  status?: LogStatus
  call_type?: CallType
  model?: string
  provider?: string
}

export type LogTimeseriesQuery = LogStatsQuery & {
  bucket: BucketSize
  group_by: LogGroupBy
}

// Omits any undefined filter rather than sending an empty value — spec 014
// treats an unparseable or empty enum as a 422, not as "no filter".
function toParams(q: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v))
  return p.toString()
}

export async function listLogs(q: LogListQuery): Promise<Page<InferenceLogSummary>> {
  return request<Page<InferenceLogSummary>>(`/logs?${toParams(q)}`)
}

export async function getLog(requestId: string): Promise<InferenceLogRead> {
  return request<InferenceLogRead>(`/logs/${encodeURIComponent(requestId)}`)
}

export async function getLogStats(q: LogStatsQuery): Promise<LogStatsRead> {
  return request<LogStatsRead>(`/logs/stats?${toParams(q)}`)
}

export async function getLogTimeseries(q: LogTimeseriesQuery): Promise<LogTimeseriesRead> {
  return request<LogTimeseriesRead>(`/logs/timeseries?${toParams(q)}`)
}

export async function createConversation(title?: string): Promise<ConversationRead> {
  const body: ConversationCreate = { title: title ?? null }
  const created = await request<ConversationRead>('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  emit('conversations:changed') // FR24 — the rail's only invalidation channel
  return created
}

export async function listConversations(
  limit: number,
  offset: number,
): Promise<Page<ConversationRead>> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return request<Page<ConversationRead>>(`/conversations?${qs}`)
}

export async function getConversation(id: number): Promise<ConversationRead> {
  return request<ConversationRead>(`/conversations/${id}`)
}

export type MessageRole = 'user' | 'assistant'

export type MessageRead = {
  id: number
  conversation_id: number
  role: MessageRole
  content: string
  created_at: string
}

export type MessageCreate = {
  content: string
  model?: string
}

export type ChatTurnRead = {
  user_message: MessageRead
  assistant_message: MessageRead
}

export type StreamChunk = {
  delta: string
}

export async function listMessages(
  conversationId: number,
  limit: number,
  offset: number,
): Promise<Page<MessageRead>> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return request<Page<MessageRead>>(`/conversations/${conversationId}/messages?${qs}`)
}

export async function sendMessage(
  conversationId: number,
  content: string,
  model?: string,
): Promise<ChatTurnRead> {
  const body: MessageCreate = { content, model }
  return request<ChatTurnRead>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// One complete `event: ...\ndata: ...` block, already split off the `\n\n`
// framing separator (FR22). Returns null for a block missing either field —
// malformed/unrecognized events are ignored, not thrown.
function parseSseEvent(raw: string): { event: string; data: string } | null {
  let event: string | null = null
  let data: string | null = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) data = line.slice('data:'.length).trim()
  }
  if (event === null || data === null) return null
  return { event, data }
}

// Raw fetch, not EventSource — EventSource cannot send a POST body (FR21).
export async function streamMessage(
  conversationId: number,
  content: string,
  model: string | undefined,
  handlers: {
    onChunk: (delta: string) => void
    onDone: (turn: ChatTurnRead) => void
    onError: (detail: string) => void
  },
): Promise<void> {
  const path = `/conversations/${conversationId}/messages/stream`
  const t0 = performance.now()
  let ok = false
  try {
    let res: Response
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, model } satisfies MessageCreate),
      })
    } catch {
      throw new ApiError(0, 'Cannot reach the backend. Is it running?')
    }

    if (!res.ok) {
      throw await buildApiError(res)
    }
    ok = true

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separatorIndex: number
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        const parsed = parseSseEvent(rawEvent)
        if (!parsed) continue // FR22 — unrecognized/malformed events ignored

        if (parsed.event === 'chunk') {
          handlers.onChunk((JSON.parse(parsed.data) as StreamChunk).delta)
        } else if (parsed.event === 'done') {
          handlers.onDone(JSON.parse(parsed.data) as ChatTurnRead)
          void reader.cancel()
          return
        } else if (parsed.event === 'error') {
          handlers.onError((JSON.parse(parsed.data) as { detail: string }).detail)
          void reader.cancel()
          return
        }
      }
    }
  } finally {
    pushLatencyEntry({ method: 'POST', path, ms: performance.now() - t0, ok })
  }
}
