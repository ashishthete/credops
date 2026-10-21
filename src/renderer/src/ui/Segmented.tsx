import { motion } from 'framer-motion'
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { spring, useMotionSafe } from './motion'

/** A segmented radio group; the arrow keys move the choice. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
  controls,
}: {
  label: string
  options: readonly { id: T; label: string; icon?: ReactNode }[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  /** Id of the panel the choice shows, for aria-controls. */
  controls?: string
}) {
  const motionSafe = useMotionSafe()
  const id = useId()
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({})
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = options.findIndex((o) => o.id === value)
    const next = options[(i + step + options.length) % options.length].id
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-line bg-surface/60 p-0.5"
    >
      {options.map((o) => {
        const checked = o.id === value
        return (
          <motion.button
            key={o.id}
            ref={(el: HTMLButtonElement | null) => {
              refs.current[o.id] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-controls={controls}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.id)}
            whileTap={motionSafe ? { scale: 0.95 } : undefined}
            transition={spring}
            className={`relative flex items-center justify-center rounded-md px-2.5 font-medium transition-colors ${
              size === 'sm' ? 'h-6 text-[12px]' : 'h-7 text-[12.5px]'
            } ${checked ? 'text-fg' : 'text-muted hover:text-fg'}`}
          >
            {checked && (
              <motion.span
                layoutId={motionSafe ? `${id}-seg` : undefined}
                transition={spring}
                className="absolute inset-0 rounded-md bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]"
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {o.icon}
              {o.label}
            </span>
          </motion.button>
        )
      })}
    </div>
  )
}
