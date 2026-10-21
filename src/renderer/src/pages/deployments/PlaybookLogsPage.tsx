import { ArrowLeft } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { PLAYBOOK_NOT_STORED_MESSAGE, type ReleaseStatus } from '../../../../shared/deploy'
import { playbookSteps } from '../../../../shared/playbook-steps'
import type { LogFilter } from '../../deploy/log-buffer'
import { releaseStore, retainRelease, startReleaseSync, usePipeline } from '../../deploy/releases'
import { taskRows, type TaskRow } from '../../deploy/task-rows'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { attempt } from '../../ui/common'
import { ICON, rowTimer, rowTitle, rowView, SAY, TINT, WORD } from './release/AnsibleSteps'
import { FailurePanel, StepOutput } from './release/FailurePanel'
import { LiveLog } from './release/LiveLog'
import { STATUS_TONE, STATUS_WORD } from './release/ReleaseHistory'
import { useNow } from './release/StepChip'

const ALL = 'all'

/**
 * The playbook text the release stored (`release:get` redacts it again on read): read once, and again when the
 * status moves on while there is none yet (a release opened before it started has no playbook).
 */
function useStoredPlaybook(releaseId: string, status: ReleaseStatus | undefined): { text: string | null; loaded: boolean } {
  const [read, setRead] = useState<{ text: string | null; loaded: boolean }>({ text: null, loaded: false })
  const have = read.text !== null
  useEffect(() => {
    if (have) return
    let live = true
    void (async () => {
      const detail = await api.invoke('release:get', releaseId).catch(() => null)
      if (live) setRead({ text: detail?.playbook ?? null, loaded: true })
    })()
    return () => {
      live = false
    }
  }, [releaseId, status, have])
  return read
}

/** The line of each task's `"name": …` in the playbook text, in order, for marking the picked task. */
function nameLines(lines: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  lines.forEach((line, i) => {
    const m = /^\s*"name":\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/.exec(line)
    if (!m) return
    try {
      const name = JSON.parse(m[1]) as string
      out.set(name, [...(out.get(name) ?? []), i])
    } catch {
      // not a JSON string after all: not a task name
    }
  })
  return out
}

/** One line of the playbook; only the marked one changes. */
const PlaybookLine = memo(function PlaybookLine({ text, last, marked }: { text: string; last: boolean; marked: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (marked) ref.current?.scrollIntoView?.({ block: 'center' })
  }, [marked])
  return (
    <span ref={ref} data-highlight={marked || undefined} className={`block px-3 ${marked ? 'bg-accent/15 text-fg' : ''}`}>
      {last ? text : `${text}\n`}
    </span>
  )
})

/** The stored playbook, read-only, with the picked task marked; or why there is none. */
function PlaybookPane({ releaseId, text, loaded, mark }: { releaseId: string; text: string | null; loaded: boolean; mark: number | null }) {
  const lines = useMemo(() => (text === null ? [] : text.split('\n')), [text])
  const save = () => void attempt("Couldn't save the playbook", () => api.invoke('release:savePlaybook', releaseId))
  return (
    <section role="region" aria-label="Playbook" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[12px] font-semibold tracking-wide text-muted uppercase">Playbook</h2>
        {text !== null && (
          <Button size="sm" variant="ghost" onClick={save}>
            Save as .yml…
          </Button>
        )}
      </div>
      {text !== null ? (
        <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-canvas/70 py-3 font-mono text-[11.5px] leading-[18px] whitespace-pre text-fg/85">
          {lines.map((line, i) => (
            <PlaybookLine key={i} text={line} last={i === lines.length - 1} marked={i === mark} />
          ))}
        </pre>
      ) : (
        <p className="text-[12.5px] text-muted">{loaded ? PLAYBOOK_NOT_STORED_MESSAGE : 'Loading the playbook'}</p>
      )}
    </section>
  )
}

/** A task in the side list: its state, and pressed while its output is shown. */
function StepButton({ row, host, pressed, onPick }: { row: TaskRow; host: string | null; pressed: boolean; onPick: (key: string) => void }) {
  const view = rowView(row, false)
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
  const { text, loaded } = useStoredPlaybook(id, status)
  const plays = useMemo(() => (text !== null ? playbookSteps(text) : (state?.plays ?? [])), [text, state?.plays])
  const rows = useMemo(() => (state ? taskRows(state, plays) : null), [state, plays])
  // Opened from a step's "Show in All logs": the full log, filtered to that step.
  const fromStep = params.get('step')
  const [picked, setPicked] = useState<string | null>(fromStep ? ALL : null)
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
  const names = useMemo(() => nameLines(lines), [lines])
  const mark = useMemo(() => {
    if (!shown?.row.name) return null
    const same = flat.filter((x) => x.row.name === shown.row.name)
    return names.get(shown.row.name)?.[same.indexOf(shown)] ?? null
  }, [shown, flat, names])

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
          <PlaybookPane releaseId={id} text={text} loaded={loaded} mark={mark} />
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
                              <StepButton key={r.key} row={r} host={h.host} pressed={r.key === selected} onPick={setPicked} />
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
