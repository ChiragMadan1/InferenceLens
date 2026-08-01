import { useRef, useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  const mqlRef = useRef<MediaQueryList | null>(null)
  if (mqlRef.current === null || mqlRef.current.media !== query) {
    mqlRef.current = window.matchMedia(query)
  }

  const subscribe = (onStoreChange: () => void) => {
    const mql = mqlRef.current!
    mql.addEventListener('change', onStoreChange)
    return () => mql.removeEventListener('change', onStoreChange)
  }
  const getSnapshot = () => mqlRef.current!.matches

  return useSyncExternalStore(subscribe, getSnapshot)
}
