import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api'

export type Resource<T> = {
  data: T | null // last successful value; retained across refetch
  error: string | null // ApiError.detail of the most recent failure
  loading: boolean // a request is in flight
  isFirstLoad: boolean // loading && data === null -> skeletons vs. dimming
  reload: () => void // repeats the same request
}

// The single async-data primitive (see spec 009 "Shared hooks"). Does not
// cache, dedupe across components, or retry automatically — two components
// fetching the same page issue two requests, an accepted tradeoff for not
// adding TanStack Query.
export function useResource<T>(fetcher: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadTick, setReloadTick] = useState(0)

  const mountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    fetcherRef
      .current()
      .then((result) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        setError(err instanceof ApiError ? err.detail : 'Something went wrong.')
      })
      .finally(() => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        setLoading(false)
      })
    // deps is caller-supplied and fixed-length per call site; reloadTick
    // forces a refetch of the same request without changing deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadTick])

  const reload = useCallback(() => {
    setReloadTick((tick) => tick + 1)
  }, [])

  return {
    data,
    error,
    loading,
    isFirstLoad: loading && data === null,
    reload,
  }
}
