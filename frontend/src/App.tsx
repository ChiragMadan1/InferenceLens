import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ConversationRail } from './components/shell/ConversationRail'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useTheme } from './hooks/useTheme'

const expandIcon = (
  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

const RAIL_COLLAPSED_KEY = 'inferencelens:rail-collapsed'
const RAIL_WIDTH_KEY = 'inferencelens:rail-width'
const RAIL_WIDTH_DEFAULT = 288
const RAIL_WIDTH_MIN = 200
const RAIL_WIDTH_MAX = 480

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function clampRailWidth(width: number): number {
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, width))
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed) ? clampRailWidth(parsed) : RAIL_WIDTH_DEFAULT
  } catch {
    return RAIL_WIDTH_DEFAULT
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
  const [railWidth, setRailWidth] = useState(readStoredWidth)
  const [isResizingRail, setIsResizingRail] = useState(false)

  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? '1' : '0')
    } catch {
      // localStorage unavailable — collapse state just won't persist
    }
  }, [railCollapsed])

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth))
    } catch {
      // localStorage unavailable — width just won't persist
    }
  }, [railWidth])

  const handleRailResizeStart = (event: React.MouseEvent) => {
    event.preventDefault()
    resizeStartRef.current = { x: event.clientX, width: railWidth }
    setIsResizingRail(true)
  }

  useEffect(() => {
    if (!isResizingRail) return
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (event: MouseEvent) => {
      const start = resizeStartRef.current
      if (!start) return
      setRailWidth(clampRailWidth(start.width + (event.clientX - start.x)))
    }
    const onMouseUp = () => {
      resizeStartRef.current = null
      setIsResizingRail(false)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [isResizingRail])

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
        <aside
          className="relative shrink-0 border-r border-hairline bg-surface"
          style={{ width: railWidth }}
        >
          <ConversationRail
            onToggleRail={handleToggleRail}
            themePreference={preference}
            themeResolved={resolved}
            onCycleTheme={cycle}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onMouseDown={handleRailResizeStart}
            className={[
              'absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize',
              isResizingRail ? 'bg-signal' : 'bg-transparent hover:bg-signal/40',
            ].join(' ')}
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

      <main
        className={[
          'min-h-0 min-w-0 flex-1 overflow-y-auto',
          // Reserves room for the floating expand-sidebar button (h-9 at
          // top-3, i.e. 48px) so it never sits on top of page content.
          showFloatingToggle ? 'pt-12' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Outlet />
      </main>
    </div>
  )
}
