import { useSyncExternalStore, type ComponentType } from 'react'
import { useReleaseLog } from '../../../deploy/releases'
import type { ChipState } from '../../../deploy/pipeline'
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

/** The failed step's error and its last log lines. */
export function FailurePanel({ releaseId, chip, host }: { releaseId: string; chip: ChipState; host: string | null }) {
  const registered = useSyncExternalStore(actions.subscribe, actions.get)
  const { buffer, version } = useReleaseLog(releaseId)
  void version
  const filter = { stepId: chip.stepId }
  const n = buffer?.count(filter) ?? 0
  const lines = buffer ? buffer.slice(n - TAIL, n, filter).map((l) => l.text) : []
  const error = chip.error ?? 'The step failed'
  return (
    <section role="region" aria-label={`${chip.label}${host ? ` on ${host}` : ''} failed`} data-failure={chip.stepId} className="flex flex-col gap-2 rounded-lg border border-err/40 bg-err/6 px-3 py-2">
      <p className="text-[12.5px] font-medium text-err">{`${chip.label}${host ? ` on ${host}` : ''} failed: ${error}`}</p>
      {lines.length > 0 && (
        <pre className="max-h-40 overflow-auto font-mono text-[11.5px] leading-[18px] text-fg/85">
          {lines.map((l, i) => (
            <div key={i}>
              <LogText line={l} />
            </div>
          ))}
        </pre>
      )}
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
