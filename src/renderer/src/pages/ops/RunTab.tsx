import { AnimatePresence, motion } from 'framer-motion'
import { History, Play, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { MAX_RUNS_KEPT, type RunRequest, type RunSummary } from '../../../../shared/ops'
import { useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { requestProtection } from '../../ops/protect'
import { removeRun, requestFor, runStore, selectRun } from '../../ops/runs'
import { snippetStore } from '../../ops/snippets'
import { isBad } from '../../ops/status'
import { attempt, ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { Composer } from './run/Composer'
import { confirmFor, launch } from './run/launch'
import { RunView } from './run/RunView'
import { ResizablePanel } from '../../ui/ResizablePanel'

/** The Run tab: targets, a command and options on the left; the selected run on the right. */
export function RunTab() {
  const { runs, selectedId } = useSyncExternalStore(runStore.subscribe, runStore.get)
  const selected = runs.find((r) => r.id === selectedId)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const inv = useInventory()
  const { snippets } = useSyncExternalStore(snippetStore.subscribe, snippetStore.get)
  const again = async (req: RunRequest) => {
    // Protection as it is now: the environment may have become protected, or stopped being. A snippet is judged
    // by its rendered text, as main does; a render that fails (a template error) is main's to refuse.
    const cmd = req.command
    const rendered = cmd.kind === 'snippet' ? await attempt("Couldn't check the snippet", () => api.invoke('snippets:render', cmd.snippetId, cmd.values)) : undefined
    if (cmd.kind === 'snippet' && rendered === undefined) return
    const { needed, labels } = requestProtection(req, inv?.environments ?? [], inv?.hosts ?? [], snippets, rendered)
    const { confirm: _was, ...fresh } = req
    if (!needed) return void launch(fresh, setConfirm)
    setConfirm(confirmFor(needed, labels, (name) => launch({ ...fresh, confirm: name }, setConfirm)))
  }
  const req = selected && requestFor(selected.id)

  return (
    <div className="flex min-h-0 flex-1">
      <ResizablePanel panel="ops-run" defaultWidth={340} className="flex flex-col overflow-y-auto border-r border-line">
        <Composer onConfirm={setConfirm} />
        <RecentRuns runs={runs} selectedId={selectedId} />
      </ResizablePanel>
      <section aria-label="Run" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {selected ? (
          <RunView key={selected.id} run={selected} onAgain={req ? () => again(req) : undefined} />
        ) : (
          <div className="flex flex-1 items-center justify-center pb-16">
            <EmptyState icon={Play} title="Run a command on many hosts" text="Pick an environment or hosts, write a command, and watch each host answer here." />
          </div>
        )}
      </section>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

/** Running runs, then the last finished ones, newest first: open one, or dismiss a finished one. */
function RecentRuns({ runs, selectedId }: { runs: RunSummary[]; selectedId: string | null }) {
  const motionSafe = useMotionSafe()
  const dismiss = async (id: string) => {
    const done = await attempt("Couldn't dismiss the run", async () => {
      await api.invoke('runs:dismiss', id)
      return true
    })
    if (done) removeRun(id)
  }
  // A long run started before many short ones is still worth finding.
  const shown = [...runs.filter((r) => r.state === 'running'), ...runs.filter((r) => r.state !== 'running').slice(0, MAX_RUNS_KEPT)]
  return (
    <section className="flex flex-col gap-2 px-5 py-4">
      <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-muted uppercase">
        <History aria-hidden className="size-3.5" />
        Recent runs
      </h2>
      {runs.length === 0 && <p className="text-[12px] text-muted">Runs you start show up here.</p>}
      <ul aria-label="Recent runs" className="flex flex-col gap-0.5">
        <AnimatePresence initial={false}>
          {shown.map((r) => {
            const bad = r.hosts.filter((h) => isBad(h.state)).length
            return (
              <motion.li
                key={r.id}
                layout={motionSafe ? 'position' : false}
                initial={motionSafe ? { opacity: 0, x: -8 } : { opacity: 0 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: fast }}
                transition={motionSafe ? spring : fast}
                className={`group flex items-center rounded-lg transition-colors ${r.id === selectedId ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
              >
                <button
                  type="button"
                  aria-current={r.id === selectedId || undefined}
                  onClick={() => selectRun(r.id)}
                  className="flex min-w-0 flex-1 flex-col items-start px-2.5 py-1.5 text-left"
                >
                  <span className="w-full truncate font-mono text-[12px] text-fg/90">{r.title}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${r.state === 'running' ? `bg-accent ${motionSafe ? 'od-pulse' : ''}` : bad ? 'bg-err' : r.state === 'cancelled' ? 'bg-muted' : 'bg-ok'}`}
                    />
                    {plural(r.hosts.length, 'host')}
                    {r.environmentName ? ` · ${r.environmentName}` : ''}
                    {r.state === 'running' ? ' · running' : bad ? ` · ${bad} failed` : r.state === 'cancelled' ? ' · cancelled' : ''}
                  </span>
                </button>
                {r.state !== 'running' && (
                  <button
                    type="button"
                    aria-label={`Dismiss ${r.title}`}
                    title="Dismiss"
                    onClick={() => void dismiss(r.id)}
                    className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                )}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </section>
  )
}
