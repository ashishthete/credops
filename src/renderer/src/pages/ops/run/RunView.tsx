import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, RotateCcw, Square } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RunHostMeta, RunHostState, RunSummary } from '../../../../../shared/ops'
import { api } from '../../../lib/api'
import { HostChip, STATE_WORD, isBad, isLive } from '../../../ops/HostChip'
import { NO_MERGE, interleave, type Merged } from '../../../ops/interleave'
import { OutputPane } from '../../../ops/OutputPane'
import { runOutputStore, type HostOutput } from '../../../ops/runs'
import { Badge } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { attempt, plural } from '../../../ui/common'
import { fast, spring, useMotionSafe } from '../../../ui/motion'
import { Segmented } from '../../../ui/Segmented'

type Layout = 'grouped' | 'interleaved'

const CANCELLED_NOTE = 'Cancelled (the command may still be running on the host)'
const TIMED_OUT_NOTE = 'Timed out (the command may still be running on the host)'

/** Ticks every second while `live`, for elapsed timers. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  return now
}

function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(s / 60)
  if (mm === 0) return `${s}s`
  const pad = (n: number) => String(n).padStart(2, '0')
  return mm < 60 ? `${mm}:${pad(s % 60)}` : `${Math.floor(mm / 60)}:${pad(mm % 60)}:${pad(s % 60)}`
}

const SEGMENTS = [
  { state: 'ok', label: 'ok', bar: 'bg-ok' },
  { state: 'failed', label: 'failed', bar: 'bg-err' },
  { state: 'timeout', label: 'timed out', bar: 'bg-warn' },
  { state: 'cancelled', label: 'cancelled', bar: 'bg-muted/60' },
] as const

/** "1 running · 4 queued", then "3 ok · 1 failed · 1 cancelled" */
function countsText(hosts: RunHostMeta[]): string {
  const n = (f: (s: RunHostState) => boolean) => hosts.filter((h) => f(h.state)).length
  return [
    [n(isLive), 'running'],
    [n((s) => s === 'queued'), 'queued'],
    ...SEGMENTS.map((s) => [n((x) => x === s.state), s.label] as const),
  ]
    .filter(([c]) => c)
    .map(([c, l]) => `${c} ${l}`)
    .join(' · ')
}

function SummaryBar({ hosts }: { hosts: RunHostMeta[] }) {
  const motionSafe = useMotionSafe()
  const total = Math.max(1, hosts.length)
  const live = hosts.filter((h) => isLive(h.state)).length
  return (
    <div aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      {SEGMENTS.map((s) => (
        <motion.span
          key={s.state}
          className={`h-full ${s.bar}`}
          initial={false}
          animate={{ width: `${(hosts.filter((h) => h.state === s.state).length / total) * 100}%` }}
          transition={motionSafe ? spring : { duration: 0 }}
        />
      ))}
      <motion.span
        className={`h-full bg-accent/60 ${live && motionSafe ? 'od-pulse' : ''}`}
        initial={false}
        animate={{ width: `${(live / total) * 100}%` }}
        transition={motionSafe ? spring : { duration: 0 }}
      />
    </div>
  )
}

/** The selected run: header, host chips, and each host's output. */
export function RunView({ run, onAgain }: { run: RunSummary; onAgain?: () => void }) {
  const running = run.state === 'running'
  const now = useNow(running)
  const started = Date.parse(run.startedAt)
  const ended = run.endedAt ? Date.parse(run.endedAt) : now
  const outputs = useSyncExternalStore(runOutputStore.subscribe, () => runOutputStore.get()[run.id])
  const [layout, setLayout] = useState<Layout>('grouped')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [cancelling, setCancelling] = useState(false)
  const paneRefs = useRef<Record<string, HTMLElement | null>>({})
  const motionSafe = useMotionSafe()

  const isOpen = (h: RunHostMeta) => open[h.hostId] ?? (run.hosts.length === 1 || isBad(h.state))
  // Failed hosts first, the rest in run order.
  const ordered = [...run.hosts.filter((h) => isBad(h.state)), ...run.hosts.filter((h) => !isBad(h.state))]

  const focusHost = (hostId: string) => {
    setLayout('grouped')
    setOpen((o) => ({ ...o, [hostId]: true }))
    requestAnimationFrame(() => paneRefs.current[hostId]?.scrollIntoView?.({ block: 'nearest', behavior: motionSafe ? 'smooth' : 'auto' }))
  }
  const cancel = async () => {
    setCancelling(true)
    await attempt("Couldn't cancel the run", () => api.invoke('runs:cancel', run.id))
    setCancelling(false)
  }

  return (
    <div className="flex flex-col gap-5 px-8 py-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="truncate font-mono text-[15px] font-semibold text-fg">{run.title}</h2>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              {run.environmentName && <Badge tone="info">{run.environmentName}</Badge>}
              <span className="tabular-nums" title="Elapsed">
                {elapsedText(ended - started)}
              </span>
              <span aria-hidden>·</span>
              <span>{plural(run.concurrency, 'host')} at once</span>
            </div>
          </div>
          {running ? (
            <motion.div key="cancel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fast}>
              <Button variant="ghost" size="sm" loading={cancelling} onClick={() => void cancel()} icon={<Square aria-hidden className="size-3" />}>
                Cancel
              </Button>
            </motion.div>
          ) : onAgain ? (
            <motion.div key="again" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fast}>
              <Button variant="ghost" size="sm" onClick={onAgain} icon={<RotateCcw aria-hidden className="size-3.5" />}>
                Run again
              </Button>
            </motion.div>
          ) : null}
        </div>
        <SummaryBar hosts={run.hosts} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="text-fg/80 tabular-nums">{countsText(run.hosts)}</span>
          {run.state === 'cancelled' && run.hosts.some((h) => h.state === 'cancelled' && h.startedAt !== null) && (
            <span className="text-muted">{CANCELLED_NOTE}</span>
          )}
          {run.outputDropped && <span className="text-muted">Older output was dropped to save memory</span>}
        </div>
      </header>

      <ul aria-label="Hosts" className="flex flex-wrap gap-1.5">
        {run.hosts.map((h) => (
          <HostChip key={h.hostId} host={h} active={layout === 'grouped' && isOpen(h)} onSelect={focusHost} />
        ))}
      </ul>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[12.5px] font-medium text-fg/90">Output</h3>
          <Segmented
            label="Show output"
            size="sm"
            value={layout}
            onChange={setLayout}
            options={[
              { id: 'grouped', label: 'Grouped' },
              { id: 'interleaved', label: 'Interleaved' },
            ]}
          />
        </div>
        {layout === 'grouped' ? (
          <ul className="flex flex-col gap-2">
            {ordered.map((h) => (
              <HostPane
                key={h.hostId}
                host={h}
                output={outputs?.[h.hostId]}
                open={isOpen(h)}
                onToggle={() => setOpen((o) => ({ ...o, [h.hostId]: !isOpen(h) }))}
                paneRef={(el) => {
                  paneRefs.current[h.hostId] = el
                }}
              />
            ))}
          </ul>
        ) : (
          <Interleaved runId={run.id} hosts={run.hosts} outputs={outputs} />
        )}
      </div>
    </div>
  )
}

function HostPane({
  host,
  output,
  open,
  onToggle,
  paneRef,
}: {
  host: RunHostMeta
  output: HostOutput | undefined
  open: boolean
  onToggle: () => void
  paneRef: (el: HTMLElement | null) => void
}) {
  const motionSafe = useMotionSafe()
  const code = host.exitCode !== null ? `exit ${host.exitCode}` : host.signal
  // Stopping a host closes its channel; a command it had started may carry on there (F10).
  const stillRunning = host.startedAt === null ? null : host.state === 'cancelled' ? CANCELLED_NOTE : host.state === 'timeout' ? TIMED_OUT_NOTE : null
  return (
    <motion.li
      ref={paneRef}
      layout={motionSafe ? 'position' : false}
      transition={motionSafe ? spring : fast}
      className={`overflow-hidden rounded-xl border bg-surface/50 ${isBad(host.state) ? 'border-err/30' : 'border-line/70'}`}
    >
      <button
        type="button"
        aria-label={`${host.label} output`}
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-10 w-full items-center gap-2.5 px-3.5 text-left text-[12.5px] transition-colors hover:bg-white/[0.025]"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={motionSafe ? spring : { duration: 0 }} className="grid text-muted">
          <ChevronRight aria-hidden className="size-3.5" />
        </motion.span>
        <span className="font-medium text-fg">{host.label}</span>
        <span className={`text-[11.5px] ${isBad(host.state) ? 'text-err' : host.state === 'ok' ? 'text-ok' : 'text-muted'}`}>{STATE_WORD[host.state]}</span>
        {code && <span className="font-mono text-[11px] text-muted tabular-nums">{code}</span>}
        {host.truncated && <span className="ml-auto text-[11px] text-muted">Output trimmed</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={motionSafe ? { height: 0, opacity: 0 } : { opacity: 0 }}
            animate={motionSafe ? { height: 'auto', opacity: 1 } : { opacity: 1 }}
            exit={motionSafe ? { height: 0, opacity: 0, transition: fast } : { opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
          >
            <div className="flex flex-col gap-2 px-3.5 pb-3.5">
              {host.error && <p className="text-[12px] text-err">{host.error.message}</p>}
              {stillRunning && <p className="text-[12px] text-muted">{stillRunning}</p>}
              <OutputPane output={output} label={host.label} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  )
}

function Interleaved({ runId, hosts, outputs }: { runId: string; hosts: RunHostMeta[]; outputs: Record<string, HostOutput> | undefined }) {
  const merged = useRef<Merged>(NO_MERGE)
  const states = hosts.map((h) => h.state).join()
  const seen = useRef('')
  if (merged.current.runId !== runId || merged.current.sources !== outputs || seen.current !== states) {
    merged.current = interleave(merged.current, runId, outputs, hosts)
    seen.current = states
  }
  return <OutputPane output={merged.current.out} label="all hosts" className="max-h-[32rem]" />
}
