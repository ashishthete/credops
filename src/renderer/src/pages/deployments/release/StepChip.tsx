import { motion } from 'framer-motion'
import { Ban, Check, Circle, CircleDashed, LoaderCircle, Undo2, X, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChipState } from '../../../deploy/pipeline'
import { spring, useMotionSafe, useShake } from '../../../ui/motion'

export type ChipView = ChipState['state'] | 'cancelling'

/** The state as words, for the label and the live region. */
export const STATE_WORD: Record<ChipView, string> = {
  pending: 'pending',
  running: 'running',
  ok: 'done',
  warn: 'warning',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
  rolled_back: 'rolled back',
  cancelling: 'cancelling',
}

export const STATE_ICON: Record<ChipView, { icon: LucideIcon; name: string }> = {
  pending: { icon: Circle, name: 'pending' },
  running: { icon: LoaderCircle, name: 'spinner' },
  ok: { icon: Check, name: 'check' },
  warn: { icon: TriangleAlert, name: 'triangle' },
  failed: { icon: X, name: 'cross' },
  skipped: { icon: CircleDashed, name: 'dashed' },
  cancelled: { icon: Ban, name: 'slash' },
  rolled_back: { icon: Undo2, name: 'undo' },
  cancelling: { icon: LoaderCircle, name: 'spinner' },
}

const TONE: Record<ChipView, string> = {
  pending: 'border-line text-muted',
  running: 'border-accent/50 text-fg',
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/50 bg-warn/10 text-warn',
  failed: 'border-err/60 bg-err/12 text-err shadow-[0_0_10px_color-mix(in_oklab,var(--err)_35%,transparent)]',
  skipped: 'border-dashed border-muted/50 text-muted',
  cancelled: 'border-line bg-surface-2 text-muted',
  rolled_back: 'border-warn/40 text-warn',
  cancelling: 'border-muted/50 text-muted',
}

/** The done fill draining away when a step is rolled back. */
export const DRAIN_TRANSITION = spring

/** `m:ss` from milliseconds. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Ticks every second while `on`; returns the current time. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** `"<step> on <host>: <state>"`, or `"<step>: <state>"` for a release-wide step. */
export const chipLabel = (label: string, host: string | null, view: ChipView) => `${label}${host ? ` on ${host}` : ''}: ${STATE_WORD[view]}`

export function StepChip({
  chip,
  host,
  cancelling = false,
  selected = false,
  onSelect,
}: {
  chip: ChipState
  host: string | null
  /** A cancel was asked for; the running step shows that until it stops. */
  cancelling?: boolean
  selected?: boolean
  onSelect?: (stepId: string) => void
}) {
  const motionSafe = useMotionSafe()
  const view: ChipView = cancelling && (chip.state === 'running' || chip.state === 'pending') ? 'cancelling' : chip.state
  // A chip shakes when it turns failed, not when it mounts already failed.
  const [shakes, setShakes] = useState(0)
  const prevState = useRef(chip.state)
  useEffect(() => {
    if (chip.state === 'failed' && prevState.current !== 'failed') setShakes((n) => n + 1)
    prevState.current = chip.state
  }, [chip.state])
  const scope = useShake<HTMLButtonElement>(shakes)
  const now = useNow(view === 'running')
  const { icon: Icon, name } = STATE_ICON[view]
  const timer =
    view === 'running' && chip.startedAt !== null ? clock(now - chip.startedAt) : chip.durationMs !== null && view !== 'pending' ? clock(chip.durationMs) : null

  return (
    <button
      ref={scope}
      type="button"
      data-step={chip.stepId}
      data-state={view}
      aria-label={chipLabel(chip.label, host, view)}
      aria-pressed={selected}
      // a warning's message (a custom step's `warn`), as the step list shows it
      title={view === 'warn' && chip.error ? `${chipLabel(chip.label, host, view)} — ${chip.error}` : chipLabel(chip.label, host, view)}
      onClick={() => onSelect?.(chip.stepId)}
      className={`relative inline-flex h-6 shrink-0 items-center gap-1 overflow-hidden rounded-md border px-1.5 text-[11.5px] font-medium ${TONE[view]} ${
        view === 'running' && motionSafe ? 'od-chip-running' : ''
      } ${selected ? 'ring-2 ring-accent/60' : ''}`}
    >
      {view === 'rolled_back' && motionSafe && (
        // The done fill draining right to left.
        <motion.span
          aria-hidden
          data-reverse
          className="absolute inset-0 origin-left bg-ok/15"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={DRAIN_TRANSITION}
        />
      )}
      {view === 'ok' && motionSafe ? (
        <motion.span data-icon={name} className="relative inline-flex" initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={spring}>
          <Icon aria-hidden className="size-3" strokeWidth={2.6} />
        </motion.span>
      ) : (
        <span data-icon={name} className="relative inline-flex">
          {/* Still: the sweep is the one looping motion a running step has. */}
          <Icon aria-hidden className="size-3" strokeWidth={2.4} />
        </span>
      )}
      <span className="relative">{chip.label}</span>
      {timer && <span className="relative font-mono text-[10.5px] tabular-nums opacity-80">{timer}</span>}
    </button>
  )
}
