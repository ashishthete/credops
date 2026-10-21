import { CircleCheck, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PlaybookPlay } from '../../../../../shared/playbook-steps'
import type { PipelineState } from '../../../deploy/pipeline'
import { taskRows, type RowState, type TaskRow } from '../../../deploy/task-rows'
import { FailurePanel, StepOutput } from './FailurePanel'
import { clock, STATE_ICON, STATE_WORD, useNow } from './StepChip'

type RowView = RowState | 'cancelling'

const ICON: Record<RowView, (typeof STATE_ICON)[keyof typeof STATE_ICON]> = { ...STATE_ICON, changed: { icon: CircleCheck, name: 'check-changed' } }
const WORD: Record<RowView, string> = { ...STATE_WORD, changed: 'changed' }
const TINT: Record<RowView, string> = {
  pending: 'text-muted',
  running: 'text-accent',
  ok: 'text-ok',
  changed: 'text-ok',
  warn: 'text-warn',
  failed: 'text-err',
  skipped: 'text-muted',
  cancelled: 'text-muted',
  rolled_back: 'text-warn',
  cancelling: 'text-muted',
}

/** States the icon alone doesn't tell apart, shown as a word too (all of them are in the row's label). */
const SAY = new Set<RowView>(['changed', 'warn', 'skipped', 'cancelled', 'rolled_back'])

function Row({
  releaseId,
  row,
  host,
  open,
  cancelling,
  onToggle,
  onShowLog,
}: {
  releaseId: string
  row: TaskRow
  host: string | null
  open: boolean
  cancelling: boolean
  onToggle: () => void
  onShowLog: (stepId: string) => void
}) {
  const view: RowView = cancelling && (row.state === 'running' || row.state === 'pending') ? 'cancelling' : row.state
  const now = useNow(view === 'running')
  const { icon: Icon, name: iconName } = ICON[view]
  const timer = view === 'running' && row.startedAt !== null ? clock(now - row.startedAt) : row.durationMs !== null ? clock(row.durationMs) : null
  const title = `${row.label}${row.name ? ` ${row.name}` : ''}${host ? ` on ${host}` : ''}: ${WORD[view]}`
  return (
    <li data-task={row.name || row.label} data-task-step={row.stepId} data-state={view} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={onToggle}
        className={`flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-[12px] hover:bg-surface-2 ${row.failure ? 'bg-err/6' : ''}`}
      >
        <ChevronRight aria-hidden className={`size-3 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <span data-icon={iconName} className={`inline-flex shrink-0 ${TINT[view]}`}>
          <Icon aria-hidden className={`size-3.5 ${view === 'running' || view === 'cancelling' ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={2.4} />
        </span>
        <span className="font-medium text-fg">{row.label}</span>
        {row.name && <span className="truncate font-mono text-[11px] text-muted">{row.name}</span>}
        {SAY.has(view) && <span className={`text-[11px] ${TINT[view]}`}>{WORD[view]}</span>}
        {row.attempts !== null && <span className="rounded-full border border-line px-1.5 text-[10.5px] text-muted">{`${row.attempts} attempts`}</span>}
        {timer && <span className="ml-auto font-mono text-[11px] text-muted tabular-nums">{timer}</span>}
      </button>
      {open && (
        <div className="py-1.5 pr-1 pl-7">
          {row.failure ? (
            <FailurePanel releaseId={releaseId} chip={row} host={host} rc={row.rc} onShowLog={onShowLog} />
          ) : (
            <StepOutput releaseId={releaseId} stepId={row.stepId} rc={row.rc} message={row.error} onShowLog={onShowLog} />
          )}
        </div>
      )}
    </li>
  )
}

/**
 * The release as its Ansible tasks: per host and deployment, one row per task in playbook order with its state,
 * time and retries. A row opens to its step's own output; a failed one opens by itself with the failure panel
 * (and the AI help registered there). It follows the pipeline live and reads the same from stored events.
 */
export function AnsibleSteps({
  releaseId,
  state,
  plays,
  selected = null,
  cancelling = false,
  onShowLog,
}: {
  releaseId: string
  state: PipelineState
  plays: PlaybookPlay[]
  /** The step picked in the pipeline: its rows open. */
  selected?: string | null
  cancelling?: boolean
  onShowLog: (stepId: string) => void
}) {
  const { hosts, release } = useMemo(() => taskRows(state, plays), [state, plays])
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const isOpen = (r: TaskRow) => toggled[r.key] ?? (r.failure || r.stepId === selected)
  const rows = (list: TaskRow[], host: string | null) =>
    list.map((r) => (
      <Row
        key={r.key}
        releaseId={releaseId}
        row={r}
        host={host}
        open={isOpen(r)}
        cancelling={cancelling}
        onToggle={() => setToggled((t) => ({ ...t, [r.key]: !isOpen(r) }))}
        onShowLog={onShowLog}
      />
    ))

  return (
    <section role="region" aria-label="Ansible steps" className="flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">Steps</h3>
      {hosts.map((h) => (
        <div key={h.hostId} data-steps-host={h.hostId} className="flex flex-col gap-1 rounded-lg border border-line bg-surface/60 px-2 py-1.5">
          <span className="px-1.5 text-[12.5px] font-semibold text-fg">{h.hostLabel}</span>
          {h.before.length > 0 && <ol className="flex flex-col">{rows(h.before, h.hostLabel)}</ol>}
          {h.runs.map((run) => (
            <div key={run.runId} data-steps-run={run.runId} className="flex flex-col pl-2">
              <span className="px-1.5 text-[12px] text-fg/90">{run.title}</span>
              <ol className="flex flex-col">{rows(run.rows, h.hostLabel)}</ol>
            </div>
          ))}
          {h.after.length > 0 && <ol className="flex flex-col">{rows(h.after, h.hostLabel)}</ol>}
        </div>
      ))}
      {release.length > 0 && (
        <div data-steps-host="release" className="flex flex-col gap-1 px-2">
          <span className="px-1.5 text-[12.5px] font-semibold text-fg">Release</span>
          <ol className="flex flex-col">{rows(release, null)}</ol>
        </div>
      )}
    </section>
  )
}
