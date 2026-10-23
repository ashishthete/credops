import type { CSSProperties, ReactNode } from 'react'
import { useMotionSafe } from './motion'
import { toneColor, type Tone } from './tone'

export interface BadgeProps {
  tone?: Tone
  /** Shows a status dot; `pulse` makes it breathe for live states (e.g. a tunnel that is up). */
  dot?: boolean | 'pulse'
  children: ReactNode
  className?: string
}

export function Badge({ tone = 'info', dot = false, children, className = '' }: BadgeProps) {
  const motionSafe = useMotionSafe()
  return (
    <span
      style={{ '--tone': toneColor[tone] } as CSSProperties}
      className={`tone-soft inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] leading-none font-medium whitespace-nowrap ${className}`}
    >
      {dot && (
        <span aria-hidden className="relative flex size-1.5">
          {dot === 'pulse' && motionSafe && (
            <span className="absolute inset-0 animate-ping rounded-full bg-(--tone) opacity-60" />
          )}
          <span className="relative size-1.5 rounded-full bg-(--tone)" />
        </span>
      )}
      {children}
    </span>
  )
}
