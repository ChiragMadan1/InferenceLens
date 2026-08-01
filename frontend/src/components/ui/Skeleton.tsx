import type { CSSProperties } from 'react'

type SkeletonVariant = 'text' | 'block' | 'circle'

type SkeletonProps = {
  variant?: SkeletonVariant
  className?: string
  style?: CSSProperties
}

// Deliberately no default width/height here — Tailwind resolves same-
// property class conflicts by stylesheet order, not JSX order, and this
// project has no tailwind-merge to arbitrate. Every caller supplies its
// own size via className or (for a computed value) style.
const VARIANT_CLASSES: Record<SkeletonVariant, string> = {
  text: 'rounded-sm',
  block: 'rounded-md',
  circle: 'aspect-square rounded-full',
}

export function Skeleton({ variant = 'block', className, style }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={['skeleton-shimmer bg-surface-sunken', VARIANT_CLASSES[variant], className]
        .filter(Boolean)
        .join(' ')}
    />
  )
}
