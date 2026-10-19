import { motion } from 'framer-motion'
import { LoaderCircle } from 'lucide-react'
import { spring, useMotionSafe } from './motion'

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** The accessible name. */
  label: string
  /** A change is in flight: shows a spinner in the knob and ignores clicks. */
  busy?: boolean
  /** Something is underway that a click may still cancel: shows the spinner but stays clickable. */
  pending?: boolean
  disabled?: boolean
}

const TRAVEL = 16

/** A toggle button (`role="switch"`); Space and Enter work as on any button. */
export function Switch({ checked, onChange, label, busy = false, pending = false, disabled = false }: SwitchProps) {
  const motionSafe = useMotionSafe()
  const spinning = busy || pending
  const knob = 'absolute top-0.5 left-0.5 grid size-4 place-items-center rounded-full bg-white shadow-sm'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={spinning || undefined}
      disabled={disabled}
      onClick={() => {
        if (!busy) onChange(!checked)
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full border border-line transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-surface-2'
      }`}
    >
      {motionSafe ? (
        <motion.span aria-hidden className={knob} initial={false} animate={{ x: checked ? TRAVEL : 0 }} transition={spring}>
          {spinning && <LoaderCircle className="size-3 animate-spin text-accent" />}
        </motion.span>
      ) : (
        <span aria-hidden className={knob} style={{ left: checked ? 2 + TRAVEL : 2 }}>
          {spinning && <LoaderCircle className="size-3 text-accent" />}
        </span>
      )}
    </button>
  )
}
