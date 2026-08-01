import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'

type ScrollAreaProps = HTMLAttributes<HTMLDivElement>

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
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
})
