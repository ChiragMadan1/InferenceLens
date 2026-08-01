import type { HTMLAttributes } from 'react'

type PanelProps = HTMLAttributes<HTMLDivElement>

export function Panel({ className, children, ...rest }: PanelProps) {
  return (
    <div
      {...rest}
      className={['rounded-lg border border-hairline bg-surface shadow-panel', className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}
