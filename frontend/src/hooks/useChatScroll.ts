import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'

// FR17's threshold for "the reader is at/near the bottom".
const NEAR_BOTTOM_PX = 120

export type ChatScroll = {
  containerRef: React.RefObject<HTMLDivElement>
  unreadCount: number
  reducedMotion: boolean
  markInitialLoad: () => void
  markAppend: () => void
  markPrependStart: () => void
  jumpToLatest: () => void
}

// FR17's scroll rules, kept out of ChatPage's render body. Each `mark*`
// function is called synchronously in an event handler, *before* the state
// update that changes the DOM — "near bottom" has to be measured at that
// moment (old scrollHeight), not after render (new scrollHeight would shift
// the threshold). The actual scroll/unread decision runs in a layout effect
// with no dependency array, which fires after every render of the calling
// component and no-ops unless one of the `mark*` refs was armed.
export function useChatScroll(): ChatScroll {
  const containerRef = useRef<HTMLDivElement>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const reducedMotion = useReducedMotion() ?? false

  const pendingInitialLoadRef = useRef(false)
  const pendingAppendRef = useRef(false)
  const nearBottomAtMarkRef = useRef(true)
  const pendingPrependAnchorRef = useRef<number | null>(null)

  const isNearBottom = () => {
    const el = containerRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  }

  const scrollToBottom = (smooth: boolean) => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion ? 'smooth' : 'auto' })
  }

  const markInitialLoad = () => {
    pendingInitialLoadRef.current = true
  }

  const markAppend = () => {
    nearBottomAtMarkRef.current = isNearBottom()
    pendingAppendRef.current = true
  }

  const markPrependStart = () => {
    pendingPrependAnchorRef.current = containerRef.current?.scrollHeight ?? null
  }

  const jumpToLatest = () => {
    scrollToBottom(true)
    setUnreadCount(0)
  }

  useLayoutEffect(() => {
    if (pendingInitialLoadRef.current) {
      pendingInitialLoadRef.current = false
      pendingAppendRef.current = false
      scrollToBottom(false)
      return
    }

    if (pendingPrependAnchorRef.current !== null) {
      const el = containerRef.current
      const before = pendingPrependAnchorRef.current
      pendingPrependAnchorRef.current = null
      if (el) el.scrollTop += el.scrollHeight - before
      return
    }

    if (pendingAppendRef.current) {
      pendingAppendRef.current = false
      if (nearBottomAtMarkRef.current) {
        scrollToBottom(true)
      } else {
        setUnreadCount((count) => count + 1)
      }
    }
  })

  // Manually scrolling back to the bottom dismisses the pill too, not only
  // clicking it (FR18).
  useEffect(() => {
    const el = containerRef.current
    if (!el || unreadCount === 0) return
    const onScroll = () => {
      if (isNearBottom()) setUnreadCount(0)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [unreadCount])

  return {
    containerRef,
    unreadCount,
    reducedMotion,
    markInitialLoad,
    markAppend,
    markPrependStart,
    jumpToLatest,
  }
}
