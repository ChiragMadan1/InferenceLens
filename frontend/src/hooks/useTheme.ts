import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'inferencelens:theme'
const MEDIA_QUERY = '(prefers-color-scheme: dark)'

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // localStorage unavailable (private mode, disabled) — fall back to system
  }
  return 'system'
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light'
  }
  return preference
}

// Preference + resolved theme + setter (FR5). The pre-paint script in
// index.html applies the initial data-theme before first render; this
// hook takes over from there and keeps `system` live against the OS.
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference))

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)
  }, [resolved])

  useEffect(() => {
    setResolved(resolveTheme(preference))
    if (preference !== 'system') return

    const mql = window.matchMedia(MEDIA_QUERY)
    const onChange = () => setResolved(resolveTheme('system'))
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // localStorage unavailable — preference still applies for this session
    }
  }, [])

  const cycle = useCallback(() => {
    setPreference(preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system')
  }, [preference, setPreference])

  return { preference, resolved, setPreference, cycle }
}
