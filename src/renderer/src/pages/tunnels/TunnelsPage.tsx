import { AnimatePresence, motion } from 'framer-motion'
import { FileDown, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router'
import type { EnvironmentMeta, RegionMeta } from '../../../../shared/inventory'
import type { TunnelMeta, TunnelState } from '../../../../shared/tunnels'
import { regionById } from '../../inventory/regions'
import { useInventory } from '../../inventory/store'
import { tunnelStore } from '../../tunnels/store'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { exitFast, fast, spring, useMotionSafe } from '../../ui/motion'
import { RegionChip } from '../../ui/RegionChip'
import { Skeleton } from '../../ui/Skeleton'
import { ImportDialog } from '../hosts/ImportDialog'
import { ConfigTransferMenu } from '../settings/ConfigTransfer'
import { isRunning, TunnelCard } from './TunnelCard'
import { tunnelDeleteRequest } from './deleteRequest'
import { TunnelDialog, type TunnelRequest } from './TunnelDialog'

type Filter = 'all' | 'running' | 'failed'

const FILTERS: { id: Filter; label: string; test: (state: TunnelState) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'running', label: 'Running', test: isRunning },
  { id: 'failed', label: 'Failed', test: (s) => s === 'failed' },
]

const IMPORT_LABEL = 'Import from ssh config'

/**
 * What the page was asked to open. The import dialog is drawn here; the tunnel dialog and the delete
 * confirmation take the other requests.
 */
export type TunnelsAction = { kind: 'import' } | { kind: 'new' } | { kind: 'edit' | 'duplicate' | 'delete'; id: string }

interface Group {
  hostId: string
  label: string
  address?: string
  region?: RegionMeta
  environments: EnvironmentMeta[]
  tunnels: TunnelMeta[]
}

/** `3 up · 1 retrying · 1 failed`, leaving out the states nothing is in. */
function summary(tunnels: TunnelMeta[], stateOf: (id: string) => TunnelState): string {
  const count = (s: TunnelState) => tunnels.filter((t) => stateOf(t.id) === s).length
  const parts = (['up', 'connecting', 'retrying', 'failed'] as const).flatMap((s) => (count(s) ? [`${count(s)} ${s}`] : []))
  return parts.length ? parts.join(' · ') : 'All stopped'
}

export function TunnelsPage() {
  const { tunnels, runtime, loaded } = useSyncExternalStore(tunnelStore.subscribe, tunnelStore.get)
  const inventory = useInventory()
  const [filter, setFilter] = useState<Filter>('all')
  const [action, setAction] = useState<TunnelsAction | null>(null)

  const stateOf = useCallback((id: string): TunnelState => runtime[id]?.state ?? 'stopped', [runtime])
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, tunnels.filter((t) => f.test(stateOf(t.id))).length])) as Record<Filter, number>,
    [tunnels, stateOf],
  )

  const groups = useMemo(() => {
    const hosts = new Map(inventory?.hosts.map((h) => [h.id, h]))
    const envs = new Map(inventory?.environments.map((e) => [e.id, e]))
    const test = FILTERS.find((f) => f.id === filter)!.test
    const byHost = new Map<string, Group>()
    for (const t of [...tunnels].sort((a, b) => a.label.localeCompare(b.label))) {
      if (!test(stateOf(t.id))) continue
      const h = hosts.get(t.hostId)
      const group = byHost.get(t.hostId) ?? {
        hostId: t.hostId,
        label: h?.label ?? 'Unknown host',
        address: h?.address,
        region: h && regionById(inventory?.regions ?? [], h.regionId),
        environments: [],
        tunnels: [],
      }
      byHost.set(t.hostId, group)
      group.tunnels.push(t)
      const env = t.environmentId ? envs.get(t.environmentId) : undefined
      if (env && !group.environments.includes(env)) group.environments.push(env)
    }
    return [...byHost.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [tunnels, inventory, filter, stateOf])

  const envById = useMemo(() => new Map(inventory?.environments.map((e) => [e.id, e])), [inventory])
  const onEdit = useCallback((id: string) => setAction({ kind: 'edit', id }), [])
  const onDuplicate = useCallback((id: string) => setAction({ kind: 'duplicate', id }), [])
  const onDelete = useCallback((id: string) => setAction({ kind: 'delete', id }), [])
  const newTunnel = () => setAction({ kind: 'new' })
  const importConfig = () => setAction({ kind: 'import' })

  // The palette's New tunnel arrives as ?action=new; open the dialog and drop the param.
  const [params, setParams] = useSearchParams()
  const wanted = params.get('action')
  useEffect(() => {
    if (wanted !== 'new') return
    setAction({ kind: 'new' })
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.delete('action')
        return out
      },
      { replace: true },
    )
  }, [wanted, setParams])

  const close = () => setAction(null)
  const tunnelRequest: TunnelRequest | null =
    action?.kind === 'new' ? { kind: 'new' } : action?.kind === 'edit' || action?.kind === 'duplicate' ? { kind: action.kind, id: action.id } : null
  const doomed = action?.kind === 'delete' ? tunnels.find((t) => t.id === action.id) : undefined
  const confirm = useMemo(
    () => (doomed ? tunnelDeleteRequest(doomed, doomed.environmentId ? envById.get(doomed.environmentId) : undefined, isRunning(stateOf(doomed.id))) : null),
    // Built once per opened delete, so a state change mid-confirmation doesn't reset what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doomed?.id],
  )

  const empty = loaded && tunnels.length === 0
  const dialogs = (
    <>
      <ImportDialog open={action?.kind === 'import'} onClose={close} onImported={() => {}} />
      <TunnelDialog request={tunnelRequest} onClose={close} />
      <ConfirmDialog request={confirm} onClose={close} />
    </>
  )

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-[19px] font-semibold tracking-tight text-fg">Tunnels</h1>
          {loaded && tunnels.length > 0 && (
            <p aria-live="polite" className="truncate text-[12.5px] text-muted tabular-nums">
              {summary(tunnels, stateOf)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!empty && (
            <>
              <Button variant="ghost" size="sm" icon={<FileDown aria-hidden className="size-3.5" />} onClick={importConfig}>
                {IMPORT_LABEL}
              </Button>
              <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={newTunnel}>
                New tunnel
              </Button>
            </>
          )}
          {loaded && <ConfigTransferMenu segment="tunnels" />}
        </div>
      </header>

      {!loaded ? (
        <div data-testid="tunnels-loading" className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3 px-8 pt-12">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[150px] rounded-[14px]" />
          ))}
        </div>
      ) : empty ? (
        <div data-testid="tunnels-empty" className="flex flex-1 flex-col items-center justify-center pb-16">
          <EmptyState
            art={<CableArt />}
            title="Port forwards that stay up"
            text="Reach a database or a dashboard on a server as if it ran here. Tunnels reconnect by themselves and show you live traffic."
            actions={
              <>
                <Button variant="ghost" icon={<FileDown aria-hidden className="size-3.5" />} onClick={importConfig}>
                  {IMPORT_LABEL}
                </Button>
                <Button icon={<Plus aria-hidden className="size-3.5" />} onClick={newTunnel}>
                  New tunnel
                </Button>
              </>
            }
          />
        </div>
      ) : (
        <>
          <div className="px-8 pb-4">
            <FilterChips value={filter} counts={counts} onChange={setFilter} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
            <AnimatePresence initial={false}>
              {groups.map((g) => (
                <HostGroup
                  key={g.hostId}
                  group={g}
                  envById={envById}
                  onEdit={onEdit}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                />
              ))}
            </AnimatePresence>
            {groups.length === 0 && (
              <div className="flex flex-col items-center gap-2 pt-16 text-center text-[12.5px] text-muted">
                {filter === 'failed' ? 'Nothing has failed.' : 'No tunnels are running.'}
                <Button size="sm" variant="ghost" icon={<X aria-hidden className="size-3" />} onClick={() => setFilter('all')}>
                  Show all
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {dialogs}
    </div>
  )
}

function FilterChips({ value, counts, onChange }: { value: Filter; counts: Record<Filter, number>; onChange: (f: Filter) => void }) {
  const motionSafe = useMotionSafe()
  return (
    <div role="group" aria-label="Show" className="inline-flex gap-0.5 rounded-lg border border-line bg-surface/60 p-0.5">
      {FILTERS.map((f) => {
        const on = f.id === value
        return (
          <motion.button
            key={f.id}
            type="button"
            aria-pressed={on}
            aria-label={`${f.label} ${counts[f.id]}`}
            onClick={() => onChange(f.id)}
            whileTap={motionSafe ? { scale: 0.94 } : undefined}
            transition={spring}
            className={`relative flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors ${on ? 'text-fg' : 'text-muted hover:text-fg'}`}
          >
            {on &&
              (motionSafe ? (
                <motion.span layoutId="tunnels-filter" transition={spring} className="absolute inset-0 rounded-md bg-white/[0.07] shadow-[inset_0_0_0_1px_var(--border)]" />
              ) : (
                <span className="absolute inset-0 rounded-md bg-white/[0.07] shadow-[inset_0_0_0_1px_var(--border)]" />
              ))}
            <span className="relative">{f.label}</span>
            <span
              className={`relative min-w-4 rounded px-1 text-center text-[11px] tabular-nums ${
                f.id === 'failed' && counts.failed > 0 ? 'bg-err/15 text-err' : 'bg-white/[0.05] text-muted'
              }`}
            >
              {counts[f.id]}
            </span>
          </motion.button>
        )
      })}
    </div>
  )
}

interface HostGroupProps {
  group: Group
  envById: Map<string, EnvironmentMeta>
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

function HostGroup({ group, envById, onEdit, onDuplicate, onDelete }: HostGroupProps) {
  const motionSafe = useMotionSafe()
  return (
    <motion.section
      aria-label={group.label}
      layout={motionSafe ? 'position' : false}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: exitFast }}
      transition={motionSafe ? spring : fast}
      className="mb-7"
    >
      <div className="mb-2.5 flex items-center gap-2.5">
        <h2 className="text-[12.5px] font-semibold tracking-tight text-fg/90">{group.label}</h2>
        {group.region && <RegionChip region={group.region} />}
        {group.environments.map((e) => (
          <span
            key={e.id}
            className="inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 text-[11px] font-medium text-fg/90"
            style={{ background: `color-mix(in oklab, ${e.color} 16%, transparent)` }}
          >
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: e.color }} />
            {e.name}
          </span>
        ))}
        <span aria-hidden className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
        <AnimatePresence initial={false}>
          {group.tunnels.map((t) => (
            <TunnelCard
              key={t.id}
              id={t.id}
              hostLabel={group.label}
              hostAddress={group.address}
              protectedEnv={!!(t.environmentId && envById.get(t.environmentId)?.protected)}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
            />
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  )
}

/** Two plugs and a cable whose dashes stream between them; still under reduced motion. */
function CableArt() {
  const motionSafe = useMotionSafe()
  const cable = 'M30 34 C 54 6, 82 62, 106 34'
  return (
    <div className="relative">
      <span aria-hidden className="absolute inset-0 rounded-full bg-accent/10 blur-2xl" />
      <svg aria-hidden viewBox="0 0 136 68" className="relative h-[68px] w-[136px] overflow-visible text-accent">
        <path d={cable} fill="none" stroke="var(--border)" strokeWidth={4} strokeLinecap="round" />
        <motion.path
          d={cable}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="3 5"
          className={motionSafe ? 'od-flow' : undefined}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        />
        <motion.g
          animate={motionSafe ? { x: [0, 2.5, 0] } : undefined}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <rect x="8" y="25" width="22" height="18" rx="5" fill="var(--surface-2)" stroke="var(--border)" strokeWidth={1.5} />
          <path d="M2 30h6M2 38h6" stroke="var(--muted)" strokeWidth={2} strokeLinecap="round" />
        </motion.g>
        <motion.g
          animate={motionSafe ? { x: [0, -2.5, 0] } : undefined}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <rect x="106" y="25" width="22" height="18" rx="5" fill="var(--surface-2)" stroke="var(--border)" strokeWidth={1.5} />
          <circle cx="117" cy="34" r="3" fill="var(--ok)" />
        </motion.g>
      </svg>
    </div>
  )
}
