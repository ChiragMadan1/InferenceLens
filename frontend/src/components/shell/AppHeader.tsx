import type { RefObject } from 'react'
import { useTheme, type ThemePreference } from '../../hooks/useTheme'
import { IconButton } from '../ui/IconButton'
import { SignalRibbon } from './SignalRibbon'

type AppHeaderProps = {
  onToggleRail: () => void
  menuButtonRef: RefObject<HTMLButtonElement>
}

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Theme: system. Click for light.',
  light: 'Theme: light. Click for dark.',
  dark: 'Theme: dark. Click for system.',
}

export function AppHeader({ onToggleRail, menuButtonRef }: AppHeaderProps) {
  const { preference, resolved, cycle } = useTheme()

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-hairline bg-surface px-4">
      <div className="flex items-center gap-3">
        <IconButton
          ref={menuButtonRef}
          aria-label="Toggle conversation menu"
          onClick={onToggleRail}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path
              d="M2 5h14M2 9h14M2 13h14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
        <span className="font-display text-h2 text-ink">Ollive</span>
      </div>

      <div className="flex items-center gap-4">
        <SignalRibbon />
        <IconButton aria-label={THEME_LABEL[preference]} onClick={cycle}>
          {resolved === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          )}
        </IconButton>
      </div>
    </header>
  )
}
