import { motion } from 'framer-motion'
import { Ban, Check, TimerOff, X, type LucideIcon } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { RunHostMeta, RunHostState } from '../../../shared/ops'
import { fast, spring, useMotionSafe, useShake } from '../ui/motion'
import { isLive } from './status'

export const STATE_WORD: Record<RunHostState, string> = {
  queued: 'Queued',
  connecting: 'Connecting',
  running: 'Running',
  ok: 'OK',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
}

/** The chip's tint per state, as in the tunnel status dots. */
const LOOK: Record<RunHostState, string> = {
  queued: 'border-line text-muted',
  connecting: 'border-warn/40 text-warn',
  running: 'border-accent/45 text-accent',
  ok: 'border-ok/40 text-ok',
  failed: 'border-err/50 text-err',
  cancelled: 'border-line text-muted',
  timeout: 'border-warn/45 text-warn',
}

const ICON: Partial<Record<RunHostState, LucideIcon>> = { ok: Check, failed: X, cancelled: Ban, timeout: TimerOff }


/** Bumps once each time the host turns `failed` after mounting, so a reopened run doesn't shake. */
function useFailures(state: RunHostState): number {
  const prev = useRef(state)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (prev.current !== state && state === 'failed') setN((c) => c + 1)
    prev.current = state
  }, [state])
  return n
}

/** Whether the state has changed since mounting; set during render, so the new icon's first frame knows. */
function useChangedSinceMount(state: RunHostState): boolean {
  const [mounted] = useState(state)
  const [changed, setChanged] = useState(false)
  if (!changed && state !== mounted) setChanged(true)
  return changed || state !== mounted
}

/**
 * One host of a run: label, a state dot or icon, and the exit code. Live states pulse; reaching `ok` pops a
 * check and `failed` shakes once. Clicking it opens that host's output.
 */
export const HostChip = memo(function HostChip({
  host,
  active,
  onSelect,
}: {
  host: RunHostMeta
  active: boolean
  onSelect: (hostId: string) => void
}) {
  const motionSafe = useMotionSafe()
  const shake = useShake<HTMLButtonElement>(useFailures(host.state))
  // A reopened run shows its icons as they are; only a state reached in view pops.
  const changed = useChangedSinceMount(host.state)
  const Icon = ICON[host.state]
  const code = host.exitCode !== null ? `exit ${host.exitCode}` : host.signal ? host.signal : null

  return (
    <motion.li
      layout={motionSafe ? 'position' : false}
      transition={motionSafe ? spring : fast}
      data-state={host.state}
      className="list-none"
    >
      <button
        ref={shake}
        type="button"
        data-state={host.state}
        aria-label={`${host.label}: ${STATE_WORD[host.state]}${code ? `, ${code}` : ''}`}
        aria-pressed={active}
        title={host.error?.message}
        onClick={() => onSelect(host.hostId)}
        className={`flex h-7 items-center gap-1.5 rounded-full border bg-surface/70 pr-2.5 pl-2 text-[12px] font-medium transition-[border-color,color,background-color] duration-300 hover:bg-surface-2 ${LOOK[host.state]} ${
          active ? 'bg-surface-2 shadow-[inset_0_0_0_1px_currentColor]' : ''
        }`}
      >
        <span className="relative grid size-3.5 place-items-center">
          {Icon ? (
            <motion.span
              key={host.state}
              initial={!changed ? false : motionSafe ? { scale: 0.3, opacity: 0 } : { opacity: 0 }}
              animate={motionSafe ? { scale: 1, opacity: 1 } : { opacity: 1 }}
              transition={motionSafe ? { ...spring, damping: 14 } : fast}
              className="grid place-items-center"
            >
              <Icon aria-hidden className="size-3.5" strokeWidth={2.6} />
            </motion.span>
          ) : (
            <span
              aria-hidden
              className={`size-2 rounded-full bg-current transition-opacity ${host.state === 'queued' ? 'opacity-50' : ''} ${isLive(host.state) && motionSafe ? 'od-pulse' : ''}`}
            />
          )}
        </span>
        <span className="max-w-40 truncate text-fg/90">{host.label}</span>
        {code && <span className="font-mono text-[11px] tabular-nums opacity-80">{code}</span>}
      </button>
    </motion.li>
  )
})
