import { useSyncExternalStore, type ComponentType } from 'react'
import { useReleaseLog } from '../../../deploy/releases'
import type { ChipState } from '../../../deploy/pipeline'
import { plural } from '../../../ui/common'
import { createStore } from '../../../ui/store'
import { LogText } from './LiveLog'

export interface FailureActionProps {
  releaseId: string
  stepId: string
  error: string
  /** The step's last log lines, already redacted by main. */
  lines: string[]
}

const actions = createStore<ComponentType<FailureActionProps>[]>([])

/** Phase 9 adds "Explain & fix" here; the panel renders nothing extra until something registers. */
export function registerFailureAction(component: ComponentType<FailureActionProps>): () => void {
  actions.set([...actions.get(), component])
  return () => actions.set(actions.get().filter((c) => c !== component))
}

const TAIL = 12
/** Lines a step's output shows in place; the rest are in All logs. */
export const OUTPUT_LINES = 300

/** A step's own output (stdout and stderr, redacted by main), its exit code and any message. */
export function StepOutput({
  releaseId,
  stepId,
  rc = null,
  message = null,
  onShowLog,
}: {
  releaseId: string
  stepId: string
  rc?: number | null
  message?: string | null
  onShowLog?: (stepId: string) => void
}) {
  const { buffer, version } = useReleaseLog(releaseId)
  void version
  const filter = { stepId }
  const n = buffer?.count(filter) ?? 0
  const lines = buffer ? buffer.slice(Math.max(0, n - OUTPUT_LINES), n, filter) : []
  const earlier = n - lines.length
  return (
    <div data-output={stepId} className="flex flex-col gap-1.5">
      {(rc !== null || onShowLog) && (
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          {rc !== null && <span className={`font-mono tabular-nums ${rc === 0 ? '' : 'text-err'}`}>{`exit code ${rc}`}</span>}
          {onShowLog && (
            <button type="button" onClick={() => onShowLog(stepId)} className="ml-auto rounded px-1.5 text-[11.5px] text-muted hover:text-fg">
              Show in All logs
            </button>
          )}
        </div>
      )}
      {message && <p className="text-[12px] whitespace-pre-wrap text-fg/90">{message}</p>}
      {earlier > 0 && <p className="text-[11.5px] text-muted">{`${plural(earlier, 'earlier line')} in All logs`}</p>}
      {lines.length > 0 ? (
        <pre className="max-h-60 overflow-auto rounded-md bg-canvas/70 px-2 py-1 font-mono text-[11.5px] leading-[18px] text-fg/85">
          {lines.map((l) => (
            <div key={l.index} className={l.stream === 'err' ? 'text-err/90' : l.stream === 'ansible' ? 'text-muted' : undefined}>
              <LogText line={l.text} />
            </div>
          ))}
        </pre>
      ) : (
        <p className="text-[11.5px] text-muted">No output</p>
      )}
    </div>
  )
}

/** The failed step's error, its output and exit code, and the registered actions (the AI help). */
export function FailurePanel({
  releaseId,
  chip,
  host,
  rc = null,
  onShowLog,
}: {
  releaseId: string
  chip: Pick<ChipState, 'stepId' | 'label' | 'error'>
  host: string | null
  rc?: number | null
  onShowLog?: (stepId: string) => void
}) {
  const registered = useSyncExternalStore(actions.subscribe, actions.get)
  const { buffer, version } = useReleaseLog(releaseId)
  void version
  const filter = { stepId: chip.stepId }
  const n = buffer?.count(filter) ?? 0
  const lines = buffer ? buffer.slice(n - TAIL, n, filter).map((l) => l.text) : []
  const error = chip.error ?? 'The step failed'
  return (
    <section role="region" aria-label={`${chip.label}${host ? ` on ${host}` : ''} failed`} data-failure={chip.stepId} className="flex flex-col gap-2 rounded-lg border border-err/40 bg-err/6 px-3 py-2">
      <p className="text-[12.5px] font-medium whitespace-pre-wrap text-err">{`${chip.label}${host ? ` on ${host}` : ''} failed: ${error}`}</p>
      <StepOutput releaseId={releaseId} stepId={chip.stepId} rc={rc} onShowLog={onShowLog} />
      {registered.length > 0 && (
        <div className="flex gap-2">
          {registered.map((Action, i) => (
            <Action key={i} releaseId={releaseId} stepId={chip.stepId} error={error} lines={lines} />
          ))}
        </div>
      )}
    </section>
  )
}
