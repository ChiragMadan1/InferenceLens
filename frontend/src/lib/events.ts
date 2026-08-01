// The app's only cross-component invalidation channel (FR24). If a second
// event is ever needed it belongs here too — this file stays a one-line
// emit/subscribe pair, not a pub/sub framework.

export type AppEventName = 'conversations:changed'

const target = new EventTarget()

export function emit(name: AppEventName): void {
  target.dispatchEvent(new Event(name))
}

export function subscribe(name: AppEventName, listener: () => void): () => void {
  target.addEventListener(name, listener)
  return () => target.removeEventListener(name, listener)
}
