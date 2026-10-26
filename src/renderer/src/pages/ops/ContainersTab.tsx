import { AnimatePresence, motion } from 'framer-motion'
import { Boxes, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router'
import type { ContainerAction, ContainerMeta } from '../../../../shared/ops'
import { useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { runProtection } from '../../ops/protect'
import { containerAction, containerKey, containerStore, loadContainers } from '../../ops/containers'
import { useConnect } from '../../terminal/connect'
import { Button } from '../../ui/Button'
import { ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { SelectField, TextField } from '../../ui/Field'
import { fast, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'
import { Switch } from '../../ui/Switch'
import { toast } from '../../ui/Toaster'
import { vaultStatusStore } from '../../vault/status'
import { ContainerRow } from './containers/ContainerRow'
import { LogsDrawer, type LogsTarget } from './containers/LogsDrawer'

const STANDALONE = 'standalone'
const REFRESH_MS = 10_000
const LAST_KEY = 'opsdeck.containers.target'
const PAST: Record<ContainerAction, string> = { start: 'Started', stop: 'Stopped', restart: 'Restarted' }

interface Choice {
  value: string
  hostId: string
  environmentId: string | null
  label: string
}

const valueOf = (hostId: string, environmentId: string | null) => `${hostId}|${environmentId ?? ''}`

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

function remember(value: string): void {
  try {
    localStorage.setItem(LAST_KEY, value)
  } catch {
    // Not remembered; the picker still works.
  }
}

/** Compose projects by name, then standalone containers last. */
function group(list: ContainerMeta[]): [string | null, ContainerMeta[]][] {
  const by = new Map<string | null, ContainerMeta[]>()
  for (const c of list) by.set(c.project, [...(by.get(c.project) ?? []), c])
  const named = [...by.entries()].filter(([p]) => p !== null).sort(([a], [b]) => a!.localeCompare(b!))
  return by.has(null) ? [...named, [null, by.get(null)!]] : named
}

/** The Containers tab: one host's docker containers, with logs, shells and start/stop/restart. */
export function ContainersTab() {
  const data = useInventory()
  const [params] = useSearchParams()
  const motionSafe = useMotionSafe()
  const { connectContainer } = useConnect()

  const choices = useMemo<Choice[]>(() => {
    if (!data) return []
    const out: Choice[] = []
    const inEnv = new Set<string>()
    for (const e of data.environments)
      for (const m of e.hosts) {
        const h = data.hosts.find((x) => x.id === m.hostId)
        if (!h) continue
        inEnv.add(h.id)
        out.push({ value: valueOf(h.id, e.id), hostId: h.id, environmentId: e.id, label: `${h.label} · ${e.name}` })
      }
    for (const h of data.hosts) if (!inEnv.has(h.id)) out.push({ value: valueOf(h.id, null), hostId: h.id, environmentId: null, label: h.label })
    return out
  }, [data])

  // The link's host (and environment), else the last choice, else the first.
  // A pick holds only for the link it was made under: a new link (a palette entry, Host view) wins.
  const link = params.toString()
  const [pick, setPick] = useState<{ value: string; link: string } | null>(null)
  const picked = pick?.link === link ? pick.value : null
  const wanted = (() => {
    const host = params.get('host')
    if (!host) return null
    const env = params.get('env')
    return choices.find((c) => c.hostId === host && c.environmentId === env) ?? choices.find((c) => c.hostId === host) ?? null
  })()
  const choice = choices.find((c) => c.value === picked) ?? wanted ?? choices.find((c) => c.value === remembered()) ?? choices[0]
  const hostId = choice?.hostId
  const environmentId = choice?.environmentId ?? null
  const env = data?.environments.find((e) => e.id === environmentId) ?? null
  const hostLabel = choice ? (data?.hosts.find((h) => h.id === choice.hostId)?.label ?? '') : ''

  const all = useSyncExternalStore(containerStore.subscribe, containerStore.get)
  const state = hostId ? all[containerKey(hostId, environmentId)] : undefined
  const list = state?.list ?? null

  const refresh = useCallback(() => {
    if (hostId) void loadContainers(hostId, environmentId)
  }, [hostId, environmentId])
  useEffect(refresh, [refresh])
  // Every 10 s while visible; skipped when the window is hidden, the vault is locked,
  // or a list is still on its way (a newer request would discard a slow host's answer).
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden' || vaultStatusStore.get()?.unlocked === false) return
      if (hostId && containerStore.get()[containerKey(hostId, environmentId)]?.loading) return
      refresh()
    }, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh, hostId, environmentId])

  // Rows cascade in on the first list of a host only.
  const staggered = useRef<string | null>(null)
  const key = hostId ? containerKey(hostId, environmentId) : null
  const stagger = !!list && staggered.current !== key
  useEffect(() => {
    if (list) staggered.current = key
  }, [list, key])

  const [filter, setFilter] = useState('')
  const [runningOnly, setRunningOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [logs, setLogs] = useState<{ hostId: string; environmentId: string | null; ref: string } | null>(null)

  const logsTarget = useMemo(() => (logs ? containerLogs(logs) : null), [logs])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (list?.containers ?? []).filter(
      (c) =>
        (!runningOnly || c.state === 'running') &&
        (!q || [c.name, c.image, c.project ?? '', c.service ?? ''].some((s) => s.toLowerCase().includes(q))),
    )
  }, [list, filter, runningOnly])
  const groups = useMemo(() => group(shown), [shown])

  /** A refusal from main comes back as `{ refused }` for the confirm dialog to show inline; otherwise it toasts. */
  const run = async (c: ContainerMeta, action: ContainerAction, confirmName?: string, inline = false) => {
    if (!hostId) return
    let message: string | undefined
    const done = await containerAction(hostId, environmentId, c.name, action, confirmName, inline ? (m) => (message = m) : undefined)
    if (done) toast({ title: `${PAST[action]} ${c.name} on ${hostLabel}`, tone: 'success' })
    return message === undefined ? undefined : { refused: message }
  }
  const act = (c: ContainerMeta, action: ContainerAction) => {
    if (action !== 'start' && hostId) {
      // Main's rule, mirrored: a host's protected environment counts even when the pick is another one.
      const { needed, refused } = runProtection(env, data?.environments ?? [], [hostId], 1, true)
      const title = `${action === 'stop' ? 'Stop' : 'Restart'} ${c.name}?`
      const confirmLabel = action === 'stop' ? 'Stop container' : 'Restart container'
      if (refused) {
        setConfirm({ title, description: refused, confirmLabel, blocked: true, run: async () => {} })
        return
      }
      if (needed) {
        setConfirm({
          title,
          description: `${c.name} is running in ${needed}, a protected environment.`,
          confirmLabel,
          typeToConfirm: needed,
          run: () => run(c, action, needed, true),
        })
        return
      }
    }
    void run(c, action)
  }

  const toggle = (name: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (!next.delete(name)) next.add(name)
      return next
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-4 border-b border-line px-8 py-3">
        <div className="w-64">
          <SelectField
            label="Host"
            value={choice?.value ?? ''}
            onChange={(e) => {
              setPick({ value: e.target.value, link })
              remember(e.target.value)
            }}
            disabled={!choices.length}
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="w-56">
          <TextField label="Filter" placeholder="Name, image or project" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <label className="flex h-9 items-center gap-2 text-[12.5px] text-fg/85">
          <Switch label="Running only" checked={runningOnly} onChange={setRunningOnly} />
          Running only
        </label>
        <Button
          variant="ghost"
          aria-label="Refresh containers"
          loading={!!state?.loading && !!list}
          disabled={!hostId}
          icon={<RefreshCw aria-hidden className="size-3.5" />}
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
        {!hostId ? (
          <EmptyState icon={Boxes} title="No hosts yet" text="Add a host to see its containers." />
        ) : state?.error ? (
          <EmptyState icon={Boxes} title="Couldn't list containers" text={state.error} action={{ label: 'Retry', run: refresh }} />
        ) : !list ? (
          <div aria-label="Loading containers" className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.containers.length === 0 ? (
          <EmptyState icon={Boxes} title="No containers" text={`Docker on ${hostLabel} has no containers.`} />
        ) : shown.length === 0 ? (
          <EmptyState icon={Search} title="Nothing matches" text="Change the filter, or show containers that aren't running." />
        ) : (
          <div className="flex flex-col gap-4">
            {list.truncated && <p className="text-[12px] text-muted">Showing the first containers only; filter to narrow down.</p>}
            {groups.map(([project, items]) => {
              const name = project ?? 'Standalone'
              // The standalone group has its own key, so a project named "Standalone" stays apart from it.
              const id = project === null ? STANDALONE : `project:${project}`
              const open = !collapsed.has(id)
              return (
                <section key={id} aria-label={name}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggle(id)}
                    className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-muted uppercase hover:text-fg"
                  >
                    <ChevronRight aria-hidden className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
                    {name}
                    <span className="font-normal tracking-normal normal-case">{plural(items.length, 'container')}</span>
                  </button>
                  <AnimatePresence initial={stagger}>
                    {open && (
                      <motion.ul
                        aria-label={`${name} containers`}
                        initial={motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: motionSafe ? 0 : 'auto', transition: fast }}
                        transition={fast}
                        className="overflow-hidden rounded-xl border border-line/70 bg-surface/40"
                      >
                        {items.map((c, i) => (
                          <ContainerRow
                            key={c.id}
                            c={c}
                            index={i}
                            stagger={stagger}
                            busy={state?.busy[c.name]}
                            actions={{
                              logs: () => setLogs({ hostId: hostId!, environmentId, ref: c.name }),
                              shell: () => void connectContainer(hostId!, environmentId, c.name),
                              act: (a) => act(c, a),
                            }}
                          />
                        ))}
                      </motion.ul>
                    )}
                  </AnimatePresence>
                </section>
              )
            })}
          </div>
        )}
      </div>

      <LogsDrawer target={logsTarget} onClose={() => setLogs(null)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

/** One container's logs: a tail snapshot, with a Follow switch for the live stream. */
function containerLogs({ hostId, environmentId, ref }: { hostId: string; environmentId: string | null; ref: string }): LogsTarget {
  return {
    title: `Logs of ${ref}`,
    snapshot: (tail) => api.invoke('containers:logs', hostId, environmentId, ref, tail),
    follow: (tail) => api.invoke('containers:follow', hostId, environmentId, ref, tail),
  }
}
