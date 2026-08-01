import type { HTMLAttributes } from 'react'

type ScrollAreaProps = HTMLAttributes<HTMLDivElement>

export function ScrollArea({ className, children, ...rest }: ScrollAreaProps) {
  return (
    <div
      {...rest}
      className={[
        'overflow-auto [scrollbar-color:var(--color-hairline)_transparent] [scrollbar-width:thin]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}
