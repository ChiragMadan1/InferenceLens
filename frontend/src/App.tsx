import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AppHeader } from './components/shell/AppHeader'
import { ConversationRail } from './components/shell/ConversationRail'
import { useMediaQuery } from './hooks/useMediaQuery'

const RAIL_COLLAPSED_KEY = 'ollive:rail-collapsed'

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

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <AppHeader onToggleRail={handleToggleRail} menuButtonRef={menuButtonRef} />

      <div className="flex min-h-0 flex-1">
        {showRailColumn && (
          <aside className="w-[288px] shrink-0 border-r border-hairline bg-surface">
            <ConversationRail />
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
              <ConversationRail />
            </motion.div>
          )}
        </AnimatePresence>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
