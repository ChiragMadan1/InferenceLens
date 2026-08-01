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
      throw new ApiError(res.status, await parseErrorDetail(res))
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
