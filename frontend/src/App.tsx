import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ConversationRail } from './components/shell/ConversationRail'
import { SignalRibbon } from './components/shell/SignalRibbon'
import { IconButton } from './components/ui/IconButton'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useTheme, type ThemePreference } from './hooks/useTheme'

const expandIcon = (
  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Theme: system. Click for light.',
  light: 'Theme: light. Click for dark.',
  dark: 'Theme: dark. Click for system.',
}

const moonIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
)

const sunIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
)

const RAIL_COLLAPSED_KEY = 'inferencelens:rail-collapsed'

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

// The layout route (FR3): header, rail, <Outlet/>. Desktop rail collapse
// persists; the mobile drawer does not (FR4 — closed by default).
export function AppShell() {
  const location = useLocation()
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const { preference, resolved, cycle } = useTheme()
  const hideRail = location.pathname.startsWith('/logs')

  const [railCollapsed, setRailCollapsed] = useState(readStoredCollapsed)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? '1' : '0')
    } catch {
      // localStorage unavailable — collapse state just won't persist
    }
  }, [railCollapsed])

  // Successful navigation closes the drawer and returns focus to the
  // menu button when it was open (FR26, edge case #14).
  useEffect(() => {
    setDrawerOpen((wasOpen) => {
      if (wasOpen) menuButtonRef.current?.focus()
      return false
    })
  }, [location.pathname])

  const closeDrawer = () => {
    setDrawerOpen(false)
    menuButtonRef.current?.focus()
  }

  const handleToggleRail = () => {
    if (isDesktop) {
      setRailCollapsed((collapsed) => !collapsed)
    } else {
      setDrawerOpen((open) => !open)
    }
  }

  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen])

  // Manual focus trap while the drawer is open (FR26) — no new dependency.
  useEffect(() => {
    if (!drawerOpen || !drawerRef.current) return
    const container = drawerRef.current
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    first?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || focusable.length === 0) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    container.addEventListener('keydown', onKeyDown)
    return () => container.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  const showRailColumn = !hideRail && isDesktop && !railCollapsed
  const showDrawer = !hideRail && !isDesktop
  // The only chrome ever rendered outside the sidebar itself — one small
  // icon, no bar — visible exactly when the sidebar isn't (FR4 of spec 019).
  const showFloatingToggle = !hideRail && (isDesktop ? railCollapsed : !drawerOpen)

  return (
    <div className="flex h-screen bg-canvas">
      {/* /logs hides the sidebar entirely (unaffected by this redesign), which
          also hides the theme toggle and SignalRibbon now that they live
          there — this small floating cluster keeps both reachable without
          reintroducing a full top bar. */}
      {hideRail && (
        <div className="fixed right-3 top-3 z-20 flex items-center gap-2 rounded-full border border-hairline bg-surface px-2 py-1 shadow-raised">
          <SignalRibbon />
          <IconButton aria-label={THEME_LABEL[preference]} onClick={cycle}>
            {resolved === 'dark' ? moonIcon : sunIcon}
          </IconButton>
        </div>
      )}

      {showFloatingToggle && (
        <button
          ref={menuButtonRef}
          type="button"
          aria-label="Expand sidebar"
          onClick={handleToggleRail}
          className="fixed left-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-surface text-ink-secondary shadow-raised transition-colors duration-[var(--dur-instant)] ease-out hover:text-ink"
        >
          {expandIcon}
        </button>
      )}

      {showRailColumn && (
        <aside className="w-[288px] shrink-0 border-r border-hairline bg-surface">
          <ConversationRail
            onToggleRail={handleToggleRail}
            themePreference={preference}
            themeResolved={resolved}
            onCycleTheme={cycle}
          />
        </aside>
      )}

      <AnimatePresence>
        {showDrawer && drawerOpen && (
          <motion.div
            key="drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="fixed inset-0 z-20 bg-black/40"
            onClick={closeDrawer}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDrawer && drawerOpen && (
          <motion.div
            key="drawer-panel"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Conversations"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            className="shadow-raised fixed inset-y-0 left-0 z-30 w-[288px] border-r border-hairline bg-surface"
          >
            <ConversationRail
              onToggleRail={handleToggleRail}
              themePreference={preference}
              themeResolved={resolved}
              onCycleTheme={cycle}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
