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
): Promise<ChatTurnRead> {
  const body: MessageCreate = { content }
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
        body: JSON.stringify({ content } satisfies MessageCreate),
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
