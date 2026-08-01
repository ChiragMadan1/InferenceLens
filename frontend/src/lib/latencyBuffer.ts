// The signal ribbon's data source (FR8/FR9). Written only by api.ts's
// request<T>; read via useSyncExternalStore, never polled.

export type LatencyEntry = {
  method: string
  path: string
  ms: number
  ok: boolean
}

const CAPACITY = 40

let entries: LatencyEntry[] = []
const listeners = new Set<() => void>()

export function pushLatencyEntry(entry: LatencyEntry): void {
  entries = [...entries, entry].slice(-CAPACITY)
  for (const listener of listeners) listener()
}

export function subscribeLatencyBuffer(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getLatencySnapshot(): LatencyEntry[] {
  return entries
}
