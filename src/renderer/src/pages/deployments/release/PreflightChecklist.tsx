import { motion } from 'framer-motion'
import { CircleCheck, Copy, LoaderCircle, OctagonX, TriangleAlert } from 'lucide-react'
import type { PreflightCheck, PreflightReport } from '../../../../../shared/deploy'
import { Button } from '../../../ui/Button'
import { fast, spring, staggerDelay, useMotionSafe } from '../../../ui/motion'

export interface PreflightFixes {
  /** The checkout's path on its host, for the `git status` hint. */
  repoPath: (deploymentId: string | null) => string | null
  /** A preflight run is in flight: the fixes that start another wait for it. */
  busy?: boolean
  onBreakLock: (hostId: string) => void
  /** Null when there is no further bump to try. */
  onBumpFurther: (() => void) | null
}

const ICON = {
  ok: { Icon: CircleCheck, className: 'text-ok', text: 'Passed' },
  warn: { Icon: TriangleAlert, className: 'text-warn', text: 'Warning' },
  block: { Icon: OctagonX, className: 'text-err', text: 'Blocks the release' },
} as const

/**
 * Preflight rows as they stream in; a blocker carries its fix. `deps` rows are only ever warnings. `checking`
 * is false once the run failed, so nothing says it is still going.
 */
export function PreflightChecklist({
  checks,
  report,
  fixes,
  checking = true,
}: {
  checks: PreflightCheck[]
  report: PreflightReport | null
  fixes: PreflightFixes
  checking?: boolean
}) {
  const motionSafe = useMotionSafe()
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Preflight checks" className="flex flex-col gap-1">
        {checks.map((c, i) => {
          const { Icon, className, text } = ICON[c.level]
          return (
            <motion.li
              key={`${c.id}:${c.deploymentId ?? ''}:${c.hostId}`}
              initial={motionSafe ? { opacity: 0, x: -4 } : { opacity: 0 }}
              animate={{ opacity: 1, x: 0 }}
              transition={motionSafe ? { ...spring, delay: staggerDelay(i) } : fast}
              className="flex flex-col gap-1 rounded-lg px-2 py-1.5 text-[12.5px]"
            >
              <div className="flex items-start gap-2">
                <Icon aria-label={text} className={`mt-0.5 size-3.5 shrink-0 ${className}`} />
                <span className="font-medium text-fg">{c.label}</span>
                {c.message && <span className="min-w-0 text-fg/75">{c.message}</span>}
              </div>
              {c.level === 'block' && <Fix check={c} report={report} fixes={fixes} />}
            </motion.li>
          )
        })}
      </ul>
      {!report && checking && (
        <p role="status" className="flex items-center gap-2 text-[12px] text-muted">
          <LoaderCircle aria-hidden className={`size-3.5 ${motionSafe ? 'animate-spin' : ''}`} />
          Checking
        </p>
      )}
    </div>
  )
}

function Fix({ check, report, fixes }: { check: PreflightCheck; report: PreflightReport | null; fixes: PreflightFixes }) {
  if (check.id === 'clean') {
    const path = fixes.repoPath(check.deploymentId)
    if (!path) return null
    return <Command text={`git -C ${path} status`} />
  }
  if (check.id === 'ansible') return <Command text="brew install ansible" />
  if (check.id === 'lock' && report?.locks[check.hostId]?.stale) {
    return (
      <div className="pl-5.5">
        <Button size="sm" variant="ghost" disabled={fixes.busy} onClick={() => fixes.onBreakLock(check.hostId)}>
          Break lock
        </Button>
      </div>
    )
  }
  if (check.id === 'version-tag' && fixes.onBumpFurther) {
    return (
      <div className="pl-5.5">
        <Button size="sm" variant="ghost" disabled={fixes.busy} onClick={fixes.onBumpFurther}>
          Bump further
        </Button>
      </div>
    )
  }
  return null
}

/** A command to run yourself; CredOps only shows it. */
function Command({ text }: { text: string }) {
  return (
    <div className="ml-5.5 flex items-center gap-2 rounded-md bg-white/[0.04] px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/90">{text}</code>
      <button
        type="button"
        aria-label={`Copy ${text}`}
        onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}
        className="grid size-6 place-items-center rounded-md text-muted hover:bg-white/[0.06] hover:text-fg"
      >
        <Copy aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
