import { CircleCheck, ChevronRight } from 'lucide-react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
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

interface RowProps {
  releaseId: string
  row: TaskRow
  host: string | null
  open: boolean
  cancelling: boolean
  onToggle: (key: string, open: boolean) => void
  onShowLog: (stepId: string) => void
}

const sameRow = (a: TaskRow, b: TaskRow) => (Object.keys(a) as (keyof TaskRow)[]).every((k) => (k === 'output' ? JSON.stringify(a.output) === JSON.stringify(b.output) : a[k] === b[k]))

/** Rows are rebuilt on every event; one only renders again when something it shows changed. */
const Row = memo(
  function Row({ releaseId, row, host, open, cancelling, onToggle, onShowLog }: RowProps) {
    const view: RowView = cancelling && (row.state === 'running' || row.state === 'pending') ? 'cancelling' : row.state
    const now = useNow(view === 'running')
    const ref = useRef<HTMLLIElement>(null)
    const scrolled = useRef(false)
    useEffect(() => {
      // a failure can be far down the list: bring it into view once
      if (!row.failure || scrolled.current) return
      scrolled.current = true
      ref.current?.scrollIntoView?.({ block: 'nearest' })
    }, [row.failure])
    const { icon: Icon, name: iconName } = ICON[view]
    const timer = view === 'running' && row.startedAt !== null ? clock(now - row.startedAt) : row.durationMs !== null ? clock(row.durationMs) : null
    const where = `${row.label}${host ? ` on ${host}` : ''}`
    const title = `${where}: ${WORD[view]}${row.attempts !== null ? `, ${row.attempts} attempts` : ''}${timer ? `, ${timer}` : ''}`
    return (
      <li ref={ref} data-task={row.name || row.label} data-task-step={row.stepId} data-state={view} className="flex flex-col">
        <button
          type="button"
          aria-expanded={open}
          aria-label={title}
          title={row.name ? `${title} (${row.name})` : title}
          onClick={() => onToggle(row.key, !open)}
          className={`flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-[12px] hover:bg-surface-2 ${row.failure ? 'bg-err/6' : ''}`}
        >
          <ChevronRight aria-hidden className={`size-3 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
          <span data-icon={iconName} className={`inline-flex shrink-0 ${TINT[view]}`}>
            <Icon aria-hidden className={`size-3.5 ${view === 'running' || view === 'cancelling' ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={2.4} />
          </span>
          <span className="font-medium text-fg">{row.label}</span>
          {SAY.has(view) && <span className={`text-[11px] ${TINT[view]}`}>{WORD[view]}</span>}
          {row.attempts !== null && <span className="rounded-full border border-line px-1.5 text-[10.5px] text-muted">{`${row.attempts} attempts`}</span>}
          {timer && <span className="ml-auto font-mono text-[11px] text-muted tabular-nums">{timer}</span>}
        </button>
        {open && (
          <div className="py-1.5 pr-1 pl-7">
            {row.failure ? (
              <FailurePanel releaseId={releaseId} chip={row} host={host} output={row.output} rc={row.rc} onShowLog={onShowLog} />
            ) : (
              <StepOutput releaseId={releaseId} stepId={row.stepId} output={row.output} rc={row.rc} message={row.error} onShowLog={onShowLog} />
            )}
          </div>
        )}
      </li>
    )
  },
  (a, b) =>
    a.releaseId === b.releaseId &&
    a.host === b.host &&
    a.open === b.open &&
    a.cancelling === b.cancelling &&
    a.onToggle === b.onToggle &&
    a.onShowLog === b.onShowLog &&
    sameRow(a.row, b.row),
)

/** A host's or deployment's tasks, named by its heading. */
function Group({ heading, detail, className, children }: { heading: string; detail?: string; className: string; children: (labelledBy: string) => ReactNode }) {
  const id = useId()
  return (
    <div className={className}>
      <div className="flex items-baseline gap-2 px-1.5">
        <h4 id={id} className="text-[12.5px] font-semibold text-fg">
          {heading}
        </h4>
        {detail && <span className="text-[11.5px] text-muted">{detail}</span>}
      </div>
      {children(id)}
    </div>
  )
}

/**
 * The release as its Ansible tasks: per host and deployment, one row per task in playbook order with its state,
 * time and retries, named as the playbook review names them. A row opens to that task's own output; a failed one
 * opens by itself with the failure panel (and the AI help registered there). It follows the pipeline live and
 * reads the same from stored events.
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
  /** The step picked in the pipeline: its first task opens. */
  selected?: string | null
  cancelling?: boolean
  onShowLog: (stepId: string) => void
}) {
  const { lanes, release, tasks } = state
  const { hosts, release: releaseRows } = useMemo(() => taskRows({ lanes, release, tasks }, plays), [lanes, release, tasks, plays])
  const firstOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of [...hosts.flatMap((h) => [...h.before, ...h.runs.flatMap((g) => g.rows), ...h.after]), ...releaseRows]) if (!m.has(r.stepId)) m.set(r.stepId, r.key)
    return m
  }, [hosts, releaseRows])
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const isOpen = (r: TaskRow) => toggled[r.key] ?? (r.failure || (selected !== null && firstOf.get(selected) === r.key))
  const onToggle = useCallback((key: string, open: boolean) => setToggled((t) => ({ ...t, [key]: open })), [])
  const rows = (list: TaskRow[], host: string | null, labelledBy: string) => (
    <ol aria-labelledby={labelledBy} className="flex flex-col">
      {list.map((r) => (
        <Row key={r.key} releaseId={releaseId} row={r} host={host} open={isOpen(r)} cancelling={cancelling} onToggle={onToggle} onShowLog={onShowLog} />
      ))}
    </ol>
  )

  return (
    <section role="region" aria-label="Ansible steps" className="flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">Steps</h3>
      {hosts.map((h) => (
        <Group key={h.hostId} heading={h.hostLabel} className="flex flex-col gap-1 rounded-lg border border-line bg-surface/60 px-2 py-1.5">
          {(id) => (
            <>
              {h.before.length > 0 && rows(h.before, h.hostLabel, id)}
              {h.runs.map((run) => (
                <Group key={run.runId} heading={run.title} detail={run.detail} className="flex flex-col pl-2">
                  {(runHeading) => rows(run.rows, h.hostLabel, runHeading)}
                </Group>
              ))}
              {h.after.length > 0 && rows(h.after, h.hostLabel, id)}
            </>
          )}
        </Group>
      ))}
      {releaseRows.length > 0 && (
        <Group heading="Release-wide" className="flex flex-col gap-1 px-2">
          {(id) => rows(releaseRows, null, id)}
        </Group>
      )}
    </section>
  )
}
