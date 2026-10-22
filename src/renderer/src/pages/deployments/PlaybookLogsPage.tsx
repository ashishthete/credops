import { ArrowLeft } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { PLAYBOOK_NOT_STORED_MESSAGE, type ReleaseStatus } from '../../../../shared/deploy'
import { isHelperTask, playbookSteps } from '../../../../shared/playbook-steps'
import { lineDiff } from '../../deploy/line-diff'
import type { LogFilter } from '../../deploy/log-buffer'
import { releaseStore, retainRelease, startReleaseSync, useCancelling, usePipeline } from '../../deploy/releases'
import { taskRows, type TaskRow } from '../../deploy/task-rows'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { attempt, errorText } from '../../ui/common'
import { ICON, rowTimer, rowTitle, rowView, SAY, TINT, WORD } from './release/AnsibleSteps'
import { FailurePanel, StepOutput } from './release/FailurePanel'
import { LiveLog } from './release/LiveLog'
import { STATUS_TONE, STATUS_WORD } from './release/ReleaseHistory'
import { useNow } from './release/StepChip'

const ALL = 'all'

interface StoredPlaybook {
  text: string | null
  loaded: boolean
  /** Left out by the Hub: it covers deployments this viewer can't see. */
  hidden: boolean
  /** Why the read failed; Retry reads it again. */
  error: string | null
  /** The text as generated, when the release ran an edited one. */
  generated: string | null
}

/**
 * The playbook text the release stored (`release:get` masks it again in main): read once, and again when the
 * status moves on while there is none yet (a release opened before it started has no playbook), or on Retry.
 */
function useStoredPlaybook(releaseId: string, status: ReleaseStatus | undefined): StoredPlaybook & { retry: () => void } {
  const [read, setRead] = useState<StoredPlaybook>({ text: null, loaded: false, hidden: false, error: null, generated: null })
  const [tries, setTries] = useState(0)
  const have = read.text !== null
  useEffect(() => {
    if (have) return
    let live = true
    void (async () => {
      try {
        const detail = await api.invoke('release:get', releaseId)
        if (live) setRead({ text: detail.playbook, loaded: true, hidden: detail.playbookHidden === true, error: null, generated: detail.playbookSource === 'edited' ? detail.playbookGenerated : null })
      } catch (err) {
        if (live) setRead({ text: null, loaded: true, hidden: false, error: errorText(err), generated: null })
      }
    })()
    return () => {
      live = false
    }
  }, [releaseId, status, have, tries])
  return { ...read, retry: () => setTries((n) => n + 1) }
}

const NAME_LINE = /^\s*"name":\s*"(?:[^"\\]|\\.)*"\s*,?\s*$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The line of each task's `"name": …` in the playbook text, by name and in order, for marking the picked task. Only
 * the tasks the step list shows count (as `playbookSteps` reads them, less the helper tasks): not a play's or a
 * deployment block's name, nor a rescue task's. The text is the generator's indented JSON, so its n-th `"name"` line
 * is the n-th string `name` met walking the parsed value in key order; anything else marks nothing.
 */
function taskNameLines(text: string, lines: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  let plays: unknown
  try {
    plays = JSON.parse(text)
  } catch {
    return out
  }
  const tasks = new Set<unknown>()
  for (const play of Array.isArray(plays) ? plays.filter(isObj) : []) {
    for (const t of Array.isArray(play.tasks) ? play.tasks.filter(isObj) : []) {
      const steps = 'block' in t ? (Array.isArray(t.block) ? t.block.filter(isObj) : []) : [t]
      for (const step of steps) if (typeof step.name === 'string' && !isHelperTask(step.name)) tasks.add(step)
    }
  }
  const names: (string | null)[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (!isObj(v)) return
    for (const [k, child] of Object.entries(v)) {
      if (k === 'name' && typeof child === 'string') names.push(tasks.has(v) ? child : null)
      else walk(child)
    }
  }
  walk(plays)
  const at = lines.flatMap((line, i) => (NAME_LINE.test(line) ? [i] : []))
  if (at.length !== names.length) return out
  names.forEach((name, n) => {
    if (name !== null) out.set(name, [...(out.get(name) ?? []), at[n]!])
  })
  return out
}

/** One line of the playbook; only the marked one changes. `marked` is the pick that marked it (0: not marked). */
const PlaybookLine = memo(function PlaybookLine({ text, last, marked: pick }: { text: string; last: boolean; marked: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const marked = pick > 0
  // Each pick scrolls to its line again, even the same one picked twice.
  useEffect(() => {
    if (pick) ref.current?.scrollIntoView?.({ block: 'center' })
  }, [pick])
  return (
    <span ref={ref} data-highlight={marked || undefined} className={`block px-3 ${marked ? 'bg-accent/15 text-fg' : ''}`}>
      {last ? text : `${text}\n`}
    </span>
  )
})

/** The stored playbook, read-only, with the picked task marked; or why there is none. */
function PlaybookPane({ releaseId, read, lines, mark, pick }: { releaseId: string; read: ReturnType<typeof useStoredPlaybook>; lines: string[]; mark: number | null; pick: number }) {
  const { text, loaded, hidden, error, retry, generated } = read
  const [saved, setSaved] = useState<string | null>(null)
  const [diff, setDiff] = useState(false)
  const changes = useMemo(() => (diff && text !== null && generated !== null ? lineDiff(generated, text) : null), [diff, text, generated])
  const save = async () => {
    const out = await attempt("Couldn't save the playbook", () => api.invoke('release:savePlaybook', releaseId))
    if (out) setSaved(out.path)
  }
  return (
    <section role="region" aria-label="Playbook" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[12px] font-semibold tracking-wide text-muted uppercase">Playbook</h2>
        {text !== null && generated !== null && (
          <Button size="sm" variant="ghost" aria-pressed={diff} onClick={() => setDiff((d) => !d)}>
            {diff ? 'Hide diff' : 'Show diff'}
          </Button>
        )}
        {text !== null && (
          <Button size="sm" variant="ghost" onClick={() => void save()}>
            Save as .yml…
          </Button>
        )}
      </div>
      {saved && (
        <p role="status" className="text-[12px] text-muted">
          Saved to {saved}
        </p>
      )}
      {changes ? (
        <pre aria-label="Changes from the generated playbook" tabIndex={0} className="min-h-0 flex-1 overflow-auto rounded-lg bg-canvas/70 py-3 font-mono text-[11.5px] leading-[18px] whitespace-pre text-fg/85">
          {changes.map((c, i) => (
            <span key={i} data-testid={c.op === ' ' ? undefined : `diff-line-${c.op}`} className={`block px-3 ${c.op === '+' ? 'bg-ok/15 text-fg' : c.op === '-' ? 'bg-err/15 text-fg' : ''}`}>
              {`${c.op} ${c.text}\n`}
            </span>
          ))}
        </pre>
      ) : text !== null ? (
        <pre tabIndex={0} className="min-h-0 flex-1 overflow-auto rounded-lg bg-canvas/70 py-3 font-mono text-[11.5px] leading-[18px] whitespace-pre text-fg/85">
          {lines.map((line, i) => (
            <PlaybookLine key={i} text={line} last={i === lines.length - 1} marked={i === mark ? pick : 0} />
          ))}
        </pre>
      ) : error !== null ? (
        <div className="flex items-center gap-2">
          <p className="text-[12.5px] text-err">{`Couldn't read the playbook: ${error}`}</p>
          <Button size="sm" variant="ghost" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : (
        <p className="text-[12.5px] text-muted">
          {!loaded ? 'Loading the playbook' : hidden ? "This playbook also covers deployments you don't have access to, so it isn't shown." : PLAYBOOK_NOT_STORED_MESSAGE}
        </p>
      )}
    </section>
  )
}

/** A task in the side list: its state, and pressed while its output is shown. */
function StepButton({ row, host, pressed, cancelling, onPick }: { row: TaskRow; host: string | null; pressed: boolean; cancelling: boolean; onPick: (key: string) => void }) {
  const view = rowView(row, cancelling)
  const now = useNow(view === 'running')
  const { icon: Icon, name: iconName } = ICON[view]
  return (
    <li>
      <button
        type="button"
        aria-pressed={pressed}
        aria-current={view === 'running' ? 'step' : undefined}
        aria-label={rowTitle(row, host, view, rowTimer(row, view, now))}
        title={row.name || undefined}
        onClick={() => onPick(row.key)}
        className={`flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] hover:bg-surface-2 ${pressed ? 'bg-accent/12' : ''}`}
      >
        <span data-icon={iconName} className={`inline-flex shrink-0 ${TINT[view]}`}>
          <Icon aria-hidden className={`size-3.5 ${view === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={2.4} />
        </span>
        <span className="truncate font-medium text-fg">{row.label}</span>
        {SAY.has(view) && <span className={`text-[11px] ${TINT[view]}`}>{WORD[view]}</span>}
      </button>
    </li>
  )
}

/**
 * A release's playbook and its logs side by side: the stored playbook on the left; on the right its tasks, the
 * picked one's own output (marked in the playbook too), or the full stream under "All logs". It follows a running
 * release live and reads the same from stored events.
 */
export function PlaybookLogsPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const summary = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().byId[id])
  const state = usePipeline(id)
  useEffect(() => startReleaseSync(), [])
  useEffect(() => retainRelease(id), [id])

  const status = state?.status ?? summary?.status
  const running = status === 'running' || status === 'rolling_back'
  // A cancel sent from the release page: its running tasks show as cancelling here too.
  const cancelling = useCancelling(id) && running
  const read = useStoredPlaybook(id, status)
  const { text } = read
  const plays = useMemo(() => (text !== null ? playbookSteps(text) : (state?.plays ?? [])), [text, state?.plays])
  const rows = useMemo(() => (state ? taskRows(state, plays) : null), [state, plays])
  // Opened from a step's "Show in All logs": the full log, filtered to that step.
  const fromStep = params.get('step')
  const [picked, setPicked] = useState<string | null>(fromStep ? ALL : null)
  // Bumped by each pick, so picking a task again scrolls the playbook back to it.
  const [pick, setPick] = useState(1)
  const [filter, setFilter] = useState<LogFilter>(fromStep ? { stepId: fromStep } : {})

  const listed = useMemo(() => {
    if (!rows) return []
    return [
      ...rows.hosts.map((h) => ({
        key: h.hostId,
        heading: h.hostLabel,
        groups: [
          { key: 'before', heading: null, rows: h.before },
          ...h.runs.map((g) => ({ key: g.runId, heading: g.title, rows: g.rows })),
          { key: 'after', heading: null, rows: h.after },
        ],
        host: h.hostLabel as string | null,
      })),
      { key: 'release', heading: 'Release-wide', groups: [{ key: 'rows', heading: null, rows: rows.release }], host: null },
    ]
  }, [rows])
  const flat = useMemo(() => listed.flatMap((h) => h.groups.flatMap((g) => g.rows.map((row) => ({ row, host: h.host })))), [listed])
  // Until something is picked: the first failed task, else the full log.
  const selected = picked ?? flat.find((x) => x.row.failure)?.row.key ?? ALL
  const shown = selected === ALL ? undefined : flat.find((x) => x.row.key === selected)

  const lines = useMemo(() => (text === null ? [] : text.split('\n')), [text])
  const names = useMemo(() => (text === null ? new Map<string, number[]>() : taskNameLines(text, lines)), [text, lines])
  const mark = useMemo(() => {
    if (!shown?.row.name) return null
    const same = flat.filter((x) => x.row.name === shown.row.name)
    return names.get(shown.row.name)?.[same.indexOf(shown)] ?? null
  }, [shown, flat, names])

  const pickRow = (key: string) => {
    setPicked(key)
    setPick((n) => n + 1)
  }
  const showAll = (stepId?: string) => {
    setPicked(ALL)
    setFilter(stepId ? { stepId } : {})
  }

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end gap-3 px-8 pb-3">
        <Button size="sm" variant="ghost" icon={<ArrowLeft aria-hidden className="size-3.5" />} onClick={() => navigate(`/deployments/release/${id}`)}>
          Release
        </Button>
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">Playbook & logs</h1>
        {summary && <span className="text-[13px] font-semibold text-fg/85">{summary.environmentName}</span>}
        {summary?.playbookSource === 'edited' && <Badge tone="warn">Edited playbook</Badge>}
        {state && (
          <Badge tone={STATUS_TONE[state.status]} dot>
            {STATUS_WORD[state.status]}
          </Badge>
        )}
      </header>
      {!state ? (
        <p className="px-8 text-[12.5px] text-muted">Loading the release</p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4 px-8 pb-8">
          <PlaybookPane releaseId={id} read={read} lines={lines} mark={mark} pick={pick} />
          <div className="flex min-h-0 min-w-0 flex-1 gap-3">
            <nav aria-label="Steps" className="flex w-52 shrink-0 flex-col gap-2 overflow-y-auto">
              <button
                type="button"
                aria-pressed={selected === ALL}
                onClick={() => showAll()}
                className={`flex h-7 items-center rounded-md px-1.5 text-left text-[12px] font-medium text-fg hover:bg-surface-2 ${selected === ALL ? 'bg-accent/12' : ''}`}
              >
                All logs
              </button>
              {listed.map((h) =>
                h.groups.every((g) => !g.rows.length) ? null : (
                  <div key={h.key} className="flex flex-col gap-0.5">
                    <h3 className="px-1.5 text-[12px] font-semibold text-fg">{h.heading}</h3>
                    {h.groups.map((g) =>
                      g.rows.length ? (
                        <div key={g.key} className={g.heading ? 'pl-2' : undefined}>
                          {g.heading && <h4 className="px-1.5 text-[11.5px] text-muted">{g.heading}</h4>}
                          <ul aria-label={g.heading ?? h.heading} className="flex flex-col">
                            {g.rows.map((r) => (
                              <StepButton key={r.key} row={r} host={h.host} pressed={r.key === selected} cancelling={cancelling} onPick={pickRow} />
                            ))}
                          </ul>
                        </div>
                      ) : null,
                    )}
                  </div>
                ),
              )}
            </nav>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              {shown ? (
                <section role="region" aria-label={`${shown.row.label}${shown.host ? ` on ${shown.host}` : ''}`} className="flex flex-col gap-2">
                  {shown.row.failure ? (
                    <FailurePanel releaseId={id} chip={shown.row} host={shown.host} output={shown.row.output} rc={shown.row.rc} onShowLog={showAll} />
                  ) : (
                    <StepOutput releaseId={id} stepId={shown.row.stepId} output={shown.row.output} rc={shown.row.rc} message={shown.row.error} onShowLog={showAll} />
                  )}
                </section>
              ) : (
                <LiveLog releaseId={id} filter={filter} onFilterChange={setFilter} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
