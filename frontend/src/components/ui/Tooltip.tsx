import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'

type TooltipProps = {
  label: string
  children: ReactNode
  className?: string
}

export function Tooltip({ label, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const id = useId()

  const close = () => setOpen(false)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close()
  }

  return (
    <span
      className={['relative inline-flex', className].filter(Boolean).join(' ')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => setOpen(true)}
      onBlur={close}
      onKeyDown={onKeyDown}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-surface-raised px-2 py-1 text-micro text-ink shadow-raised"
        >
          {label}
        </span>
      )}
    </span>
  )
}
