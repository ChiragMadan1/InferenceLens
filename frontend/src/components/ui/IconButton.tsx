import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  'aria-label': string
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={[
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
        'text-ink-secondary hover:bg-surface-sunken hover:text-ink',
        'transition-colors duration-[var(--dur-instant)] ease-out',
        'disabled:opacity-50 disabled:pointer-events-none',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </button>
  )
})
