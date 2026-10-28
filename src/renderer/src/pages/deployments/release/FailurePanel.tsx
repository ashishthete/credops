import { memo } from 'react'
import type { LogFilter, LogLine } from '../../../deploy/log-buffer'
import { useReleaseLog } from '../../../deploy/releases'
import type { ChipState } from '../../../deploy/pipeline'
import { FailureActionSlot } from '../../../deploy/slots'
import type { RowOutput } from '../../../deploy/task-rows'
import { plural } from '../../../ui/common'
import { LogText } from './LiveLog'

const TAIL = 12
/** Lines a step's output shows in place; the rest are in All logs. */
export const OUTPUT_LINES = 300

const filterOf = (o: RowOutput): LogFilter => ('taskKey' in o ? { taskKey: o.taskKey } : { stepId: o.stepId })

/** One output line; a kept line never changes, so it renders once. */
const OutputLine = memo(function OutputLine({ text, stream }: Pick<LogLine, 'text' | 'stream'>) {
  return (
    <div className={stream === 'err' ? 'text-err/90' : stream === 'ansible' ? 'text-muted' : undefined}>
      <LogText line={text} />
    </div>
  )
})

/**
 * A task's own output (stdout and stderr, redacted by main), its exit code and any message. `output` says which
 * lines are the task's; when they are the whole step's (a release from before per-task lines), it says so.
 */
export function StepOutput({
  releaseId,
  stepId,
  output = { stepId },
  rc = null,
  message = null,
  onShowLog,
}: {
  releaseId: string
  stepId: string
  output?: RowOutput
  rc?: number | null
  message?: string | null
  onShowLog?: (stepId: string) => void
}) {
  const { buffer, version } = useReleaseLog(releaseId)
  void version
  const filter = filterOf(output)
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
      {'wholeStep' in output && output.wholeStep && <p className="text-[11.5px] text-muted">Output for the whole step</p>}
      {message && <p className="text-[12px] whitespace-pre-wrap text-fg/90">{message}</p>}
      {earlier > 0 && <p className="text-[11.5px] text-muted">{`${plural(earlier, 'earlier line')} in All logs`}</p>}
      {lines.length > 0 ? (
        <pre className="max-h-60 overflow-auto rounded-md bg-canvas/70 px-2 py-1 font-mono text-[11.5px] leading-[18px] text-fg/85">
          {lines.map((l) => (
            <OutputLine key={l.index} text={l.text} stream={l.stream} />
          ))}
        </pre>
      ) : (
        <p className="text-[11.5px] text-muted">No output</p>
      )}
    </div>
  )
}

/** The failed step's error, its output and exit code, and the failure action slot (the AI's Explain). */
export function FailurePanel({
  releaseId,
  chip,
  host,
  output = { stepId: chip.stepId },
  rc = null,
  onShowLog,
}: {
  releaseId: string
  chip: Pick<ChipState, 'stepId' | 'label' | 'error'>
  host: string | null
  output?: RowOutput
  rc?: number | null
  onShowLog?: (stepId: string) => void
}) {
  const { buffer, version } = useReleaseLog(releaseId)
  void version
  const filter = filterOf(output)
  const n = buffer?.count(filter) ?? 0
  const lines = buffer ? buffer.slice(n - TAIL, n, filter).map((l) => l.text) : []
  const error = chip.error ?? 'The step failed'
  return (
    <section role="region" aria-label={`${chip.label}${host ? ` on ${host}` : ''} failed`} data-failure={chip.stepId} className="flex flex-col gap-2 rounded-lg border border-err/40 bg-err/6 px-3 py-2">
      <p className="text-[12.5px] font-medium whitespace-pre-wrap text-err">{`${chip.label}${host ? ` on ${host}` : ''} failed: ${error}`}</p>
      <StepOutput releaseId={releaseId} stepId={chip.stepId} output={output} rc={rc} onShowLog={onShowLog} />
      <div className="flex gap-2 empty:hidden">
        <FailureActionSlot releaseId={releaseId} stepId={chip.stepId} error={error} lines={lines} />
      </div>
    </section>
  )
}
