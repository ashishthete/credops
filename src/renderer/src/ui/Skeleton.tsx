import { useMotionSafe } from './motion'

/** Placeholder block with a shimmer; size it with className (e.g. "h-4 w-40"). */
export function Skeleton({ className = '' }: { className?: string }) {
  const motionSafe = useMotionSafe()
  return (
    <div
      aria-hidden
      className={`rounded-md ${motionSafe ? 'skeleton-shimmer' : 'bg-surface-2'} ${className}`}
    />
  )
}
