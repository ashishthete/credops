import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { ChevronRight, CircleDashed, Database, FileDown, Fingerprint, Globe2, Plus, Search, Server, ShieldHalf, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import type { EnvironmentMeta, HostMeta, HostRole, RegionMeta } from '../../../../shared/inventory'
import type { HostsAction } from '../../inventory/commands'
import { hostsByRegion } from '../../inventory/regions'
import { useInventory } from '../../inventory/store'
import { useConnect } from '../../terminal/connect'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { exitFast, fast, spring, staggerDelay, useMotionSafe } from '../../ui/motion'
import { useShortcut } from '../../ui/shortcuts'
import { plural } from '../../ui/common'
import { Skeleton } from '../../ui/Skeleton'
import { createStore } from '../../ui/store'
import { ROLE_LABEL, ROLE_ORDER } from '../products/ProductView'
import { HostDialog } from './HostDialog'
import { openKnownHosts } from '../terminals/KnownHostsDialog'
import { HostView } from './HostView'
import { ImportDialog } from './ImportDialog'
import { RegionsDialog } from './RegionsDialog'

const ROLE_ICON: Record<HostRole, LucideIcon> = { bastion: ShieldHalf, app: Server, db: Database, other: CircleDashed }

/** The role a host shows in the list: its most significant one across environments. */
const primaryRole = (h: HostMeta): HostRole | null =>
  ROLE_ORDER.find((r) => h.environments.some((m) => m.role === r)) ?? null

function matchesQuery(h: HostMeta, q: string, region: RegionMeta | undefined): boolean {
  if (!q) return true
  return [h.label, h.address, ...h.tags, ...(region ? [region.code, region.displayName] : [])].some((s) => s.toLowerCase().includes(q))
}

type RegionGroup = ReturnType<typeof hostsByRegion<HostMeta>>[number]
/** A group's region id; a group always has a host, and hosts whose region is missing still group by its id. */
const groupKey = (g: RegionGroup) => g.hosts[0]!.regionId

const IMPORT_LABEL = 'Import from ~/.ssh/config'

export function HostsPage() {
  const data = useInventory()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [regionId, setRegionId] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [dialog, setDialog] = useState<HostsAction | null>(null)
  // The region a new host starts in: the group its "New host" was clicked in, else the one in view.
  const [newIn, setNewIn] = useState<string | undefined>()
  // Rows cascade in on the first view only, not on every selection or filter.
  const [fresh, setFresh] = useState(true)
  const search = useRef<HTMLInputElement>(null)

  const hosts = useMemo(() => [...(data?.hosts ?? [])].sort((a, b) => a.label.localeCompare(b.label)), [data])
  const allTags = useMemo(() => [...new Set(hosts.flatMap((h) => h.tags))].sort((a, b) => a.localeCompare(b)), [hosts])
  const regions = useMemo(() => [...(data?.regions ?? [])].sort((a, b) => a.code.localeCompare(b.code)), [data])
  // A filter left on a region that has since gone shows everything.
  const regionFilter = regions.some((r) => r.id === regionId) ? regionId : ''
  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const byId = new Map(regions.map((r) => [r.id, r]))
    const shown = hosts.filter(
      (h) => (!regionFilter || h.regionId === regionFilter) && matchesQuery(h, q, byId.get(h.regionId)) && tags.every((t) => h.tags.includes(t)),
    )
    return hostsByRegion(regions, shown)
  }, [hosts, regions, regionFilter, q, tags])
  // What the list shows, in its order: hosts in a collapsed group are left out.
  const visible = useMemo(() => groups.flatMap((g) => (collapsed.has(groupKey(g)) ? [] : g.hosts)), [groups, collapsed])

  const wanted = params.get('host')
  const selected = wanted && hosts.some((h) => h.id === wanted) ? wanted : (visible[0]?.id ?? null)
  const selectedRegion = hosts.find((h) => h.id === selected)?.regionId

  const updateParams = useCallback(
    (change: (p: URLSearchParams) => void) =>
      setParams(
        (p) => {
          const out = new URLSearchParams(p)
          change(out)
          return out
        },
        { replace: true },
      ),
    [setParams],
  )
  const select = useCallback(
    (id: string | null) => {
      setFresh(false)
      updateParams((p) => (id ? p.set('host', id) : p.delete('host')))
    },
    [updateParams],
  )

  // Palette commands arrive as ?action=new|import|regions; open the dialog and drop the param.
  const action = params.get('action')
  useEffect(() => {
    if (action !== 'new' && action !== 'import' && action !== 'regions') return
    setNewIn(undefined)
    setDialog(action)
    updateParams((p) => p.delete('action'))
  }, [action, updateParams])

  const newHost = (inRegion?: string) => {
    setNewIn(inRegion)
    setDialog('new')
  }
  useShortcut('mod+n', () => newHost())
  useShortcut('mod+f', () => search.current?.focus())

  const toggleTag = (t: string) => setTags((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))
  const toggleGroup = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const dialogs = (
    <>
      <HostDialog
        open={dialog === 'new'}
        presetRegionId={newIn ?? (regionFilter || selectedRegion)}
        onClose={() => setDialog(null)}
        onSaved={(h) => {
          setDialog(null)
          select(h.id)
        }}
      />
      <ImportDialog open={dialog === 'import'} onClose={() => setDialog(null)} onImported={(first) => first && select(first)} />
      <RegionsDialog open={dialog === 'regions'} onClose={() => setDialog(null)} />
    </>
  )

  // The dialogs keep one place in the tree, so an import that fills an empty page keeps its result screen.
  const body =
    data && hosts.length === 0 ? (
      <div className="flex h-full flex-col">
        <PageTitle />
        <div data-testid="hosts-empty" className="flex flex-1 flex-col items-center justify-center pb-16">
          <EmptyState
            icon={Server}
            title="No hosts yet"
            text="Add one by hand, or bring in everything from your SSH config at once."
            actions={
              <>
                <Button variant="ghost" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => newHost()}>
                  New host
                </Button>
                <Button icon={<FileDown aria-hidden className="size-3.5" />} onClick={() => setDialog('import')}>
                  {IMPORT_LABEL}
                </Button>
              </>
            }
          />
        </div>
      </div>
    ) : (
      <div className="flex h-full">
        <aside aria-label="Host list" className="flex w-[340px] shrink-0 flex-col border-r border-line bg-surface/40">
          <PageTitle count={data ? hosts.length : undefined} />
          <div className="flex flex-col gap-2 px-3 pb-2">
            <label className="relative block">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
              <input
                ref={search}
                type="search"
                aria-label="Search hosts"
                placeholder="Label, address, tag or region"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape' || !query) return
                  e.preventDefault()
                  setQuery('')
                }}
                spellCheck={false}
                autoComplete="off"
                className="h-8 w-full rounded-lg border border-line bg-canvas/60 pr-2.5 pl-8 text-[12.5px] text-fg placeholder:text-muted/60 transition-[border-color,box-shadow] focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none"
              />
            </label>
            {(regions.length > 1 || allTags.length > 0) && (
              <div className="flex items-start gap-1.5">
                {regions.length > 1 && <RegionFilter regions={regions} value={regionFilter} onChange={setRegionId} />}
                {allTags.length > 0 && <TagFilter tags={allTags} active={tags} onToggle={toggleTag} />}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {data ? (
              <HostList
                groups={groups}
                collapsed={collapsed}
                hosts={visible}
                environments={data.environments}
                selected={selected}
                stagger={fresh}
                onSelect={select}
                onToggleGroup={toggleGroup}
                onNewIn={newHost}
                onClearFilters={() => {
                  setQuery('')
                  setTags([])
                  setRegionId('')
                }}
              />
            ) : (
              <div className="flex flex-col gap-1.5 px-2 pt-1">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-12 rounded-lg" />
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-0.5 border-t border-line/70 p-2.5">
            <RailButton icon={Plus} label="New host" onClick={() => newHost()} />
            <RailButton icon={FileDown} label={IMPORT_LABEL} onClick={() => setDialog('import')} />
            <RailButton icon={Globe2} label="Regions…" onClick={() => setDialog('regions')} />
            <RailButton icon={Fingerprint} label="Known hosts…" onClick={openKnownHosts} />
          </div>
        </aside>

        <section aria-label="Details" className="flex min-w-0 flex-1 flex-col">
          {!data ? (
            <div className="flex flex-col gap-4 px-8 pt-8">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          ) : selected ? (
            <motion.div key={selected} className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fast}>
              <HostView hostId={selected} onDeleted={() => select(null)} />
            </motion.div>
          ) : (
            <p className="m-auto text-[13px] text-muted">Pick a host to see how to reach it.</p>
          )}
        </section>
      </div>
    )

  return (
    <>
      {body}
      {dialogs}
    </>
  )
}

function PageTitle({ count }: { count?: number }) {
  return (
    <div className="app-drag flex h-16 shrink-0 items-end justify-between px-5 pb-3">
      <h1 className="text-[19px] font-semibold tracking-tight text-fg">Hosts</h1>
      {!!count && <Badge tone="info">{count}</Badge>}
    </div>
  )
}

function RegionFilter({ regions, value, onChange }: { regions: RegionMeta[]; value: string; onChange: (id: string) => void }) {
  return (
    <select
      aria-label="Region"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-6 max-w-32 shrink-0 rounded-md border-0 px-1.5 font-mono text-[11.5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
        value ? 'bg-accent/18 text-fg' : 'bg-white/[0.04] text-muted hover:text-fg'
      }`}
    >
      <option value="">All regions</option>
      {regions.map((r) => (
        <option key={r.id} value={r.id}>
          {r.code}
        </option>
      ))}
    </select>
  )
}

function TagFilter({ tags, active, onToggle }: { tags: string[]; active: string[]; onToggle: (tag: string) => void }) {
  const motionSafe = useMotionSafe()
  return (
    <div role="group" aria-label="Tags" className="flex flex-wrap gap-1">
      {tags.map((t) => {
        const on = active.includes(t)
        return (
          <motion.button
            key={t}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(t)}
            whileTap={motionSafe ? { scale: 0.92 } : undefined}
            transition={spring}
            className={`h-6 rounded-md px-2 font-mono text-[11.5px] transition-colors ${
              on ? 'bg-accent/18 text-fg shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_50%,transparent)]' : 'bg-white/[0.04] text-muted hover:bg-white/[0.07] hover:text-fg'
            }`}
          >
            {t}
          </motion.button>
        )
      })}
    </div>
  )
}

interface HostListProps {
  groups: RegionGroup[]
  /** Region ids whose group is folded away. */
  collapsed: ReadonlySet<string>
  /** The rows in view, in list order: what the arrow keys move through. */
  hosts: HostMeta[]
  environments: EnvironmentMeta[]
  selected: string | null
  stagger: boolean
  onSelect: (id: string) => void
  onToggleGroup: (regionId: string) => void
  onNewIn: (regionId: string) => void
  onClearFilters: () => void
}

type ListSelection = { selected: string | null; tabbable: string | null }
type SelectionStore = ReturnType<typeof createStore<ListSelection>>

/** True while `id` is the store's `which`; a row re-renders only when its own answer changes. */
const useIs = (store: SelectionStore, which: keyof ListSelection, id: string) =>
  useSyncExternalStore(store.subscribe, () => store.get()[which] === id)

/**
 * A listbox: arrows, Home and End move the selection, which follows focus. The rows are built once per
 * list and read the selection from a store, so moving it re-renders two rows, not every row.
 */
function HostList({ groups, collapsed, hosts, environments, selected, stagger, onSelect, onToggleGroup, onNewIn, onClearFilters }: HostListProps) {
  const list = useRef<HTMLUListElement>(null)
  const envById = useMemo(() => new Map(environments.map((e) => [e.id, e])), [environments])
  const focusId = useRef<string | null>(null)
  const { connect } = useConnect()
  // With nothing selected in view, the first row takes Tab.
  const tabbable = hosts.some((h) => h.id === selected) ? selected : (hosts[0]?.id ?? null)
  const [selection] = useState(() => createStore<ListSelection>({ selected, tabbable }))
  useLayoutEffect(() => {
    const cur = selection.get()
    if (cur.selected !== selected || cur.tabbable !== tabbable) selection.set({ selected, tabbable })
  }, [selection, selected, tabbable])
  const onSelectRef = useRef(onSelect)
  useLayoutEffect(() => {
    onSelectRef.current = onSelect
  })
  const pick = useCallback((id: string) => onSelectRef.current(id), [])

  // Focus lands on the newly selected row once it has rendered as selected.
  useEffect(() => {
    if (!focusId.current) return
    list.current?.querySelector<HTMLElement>(`[data-host-id="${CSS.escape(focusId.current)}"]`)?.focus()
    focusId.current = null
  }, [selected])

  const onKeyDown = (e: KeyboardEvent) => {
    const i = hosts.findIndex((h) => h.id === selected)
    const to =
      e.key === 'ArrowDown' ? Math.min(i + 1, hosts.length - 1) : e.key === 'ArrowUp' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? hosts.length - 1 : null
    if (to === null || !hosts[to]) return
    e.preventDefault()
    focusId.current = hosts[to].id
    onSelect(hosts[to].id)
  }

  const rows = useMemo(() => {
    const index = new Map(hosts.map((h, i) => [h.id, i]))
    return groups.map((g) => {
      const key = groupKey(g)
      const open = !collapsed.has(key)
      const code = g.region?.code ?? 'Unknown region'
      return (
        <li key={key} role="group" aria-label={code} className="flex flex-col gap-0.5">
          <div role="presentation" className="group/region flex h-7 items-center gap-1 pr-1 pl-1.5">
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${code}, ${plural(g.hosts.length, 'host')}`}
              title={g.region?.displayName}
              onClick={() => onToggleGroup(key)}
              className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 text-[11.5px] text-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
            >
              <ChevronRight aria-hidden className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
              <span className="truncate font-mono">{code}</span>
              {g.region?.displayName && g.region.displayName !== code && <span className="truncate text-muted/70">{g.region.displayName}</span>}
              <span className="rounded-full bg-white/[0.05] px-1.5 text-[10.5px] tabular-nums">{g.hosts.length}</span>
            </button>
            {g.region && (
              <button
                type="button"
                aria-label={`New host in ${code}`}
                title={`New host in ${code}`}
                onClick={() => onNewIn(key)}
                className="ml-auto grid size-6 place-items-center rounded-md text-muted opacity-0 transition-opacity group-hover/region:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
              >
                <Plus aria-hidden className="size-3" />
              </button>
            )}
          </div>
          {open && (
            <ul role="presentation" className="flex flex-col gap-0.5">
              <AnimatePresence initial={false}>
                {g.hosts.map((h) => (
                  <HostRow
                    key={h.id}
                    host={h}
                    envs={h.environments.flatMap((m) => envById.get(m.environmentId) ?? [])}
                    index={index.get(h.id) ?? 0}
                    stagger={stagger}
                    selection={selection}
                    onSelect={pick}
                    onConnect={connect}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </li>
      )
    })
  }, [groups, collapsed, hosts, envById, stagger, selection, pick, connect, onToggleGroup, onNewIn])

  return (
    <>
      <ul ref={list} role="listbox" aria-label="Hosts" onKeyDown={onKeyDown} className="flex flex-col gap-2">
        {rows}
      </ul>
      {groups.length === 0 && (
        <div className="flex flex-col items-center gap-2 pt-10 text-center text-[12.5px] text-muted">
          No hosts match.
          <Button size="sm" variant="ghost" icon={<X aria-hidden className="size-3" />} onClick={onClearFilters}>
            Clear filters
          </Button>
        </div>
      )}
    </>
  )
}

interface HostRowProps {
  host: HostMeta
  envs: EnvironmentMeta[]
  index: number
  stagger: boolean
  selection: SelectionStore
  onSelect: (id: string) => void
  onConnect: (id: string) => Promise<void>
}

function HostRow({ host, envs, index, stagger, selection, onSelect, onConnect: connect }: HostRowProps) {
  const motionSafe = useMotionSafe()
  // Rows filtered away fade out; while they do, they're out of reach (F19).
  const present = useIsPresent()
  const selected = useIs(selection, 'selected', host.id)
  const tabbable = useIs(selection, 'tabbable', host.id)
  const role = primaryRole(host)
  const RoleIcon = role ? ROLE_ICON[role] : Server
  const delay = stagger && motionSafe ? staggerDelay(index) : 0

  return (
    <motion.li
      role="option"
      aria-label={host.label}
      aria-selected={selected}
      aria-hidden={present ? undefined : true}
      inert={!present}
      data-host-id={host.id}
      tabIndex={present && tabbable ? 0 : -1}
      onClick={() => onSelect(host.id)}
      onDoubleClick={() => void connect(host.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) void connect(host.id)
      }}
      layout={motionSafe ? 'position' : false}
      initial={motionSafe ? { opacity: 0, y: 8 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
      exit={motionSafe ? { opacity: 0, x: -12, transition: exitFast } : { opacity: 0, transition: exitFast }}
      transition={motionSafe ? { ...spring, delay } : fast}
      className={`group relative flex cursor-default items-start gap-3 rounded-lg px-3 py-2.5 transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
        present ? '' : 'pointer-events-none'
      } ${selected ? 'text-fg' : 'text-fg/85 hover:bg-white/[0.03]'}`}
    >
      {selected &&
        (motionSafe ? (
          <motion.span
            layoutId="hosts-selected"
            transition={spring}
            className="absolute inset-0 rounded-lg bg-accent/10 shadow-[inset_2px_0_0_0_var(--accent)]"
          />
        ) : (
          <span className="absolute inset-0 rounded-lg bg-accent/10 shadow-[inset_2px_0_0_0_var(--accent)]" />
        ))}
      <span
        title={role ? ROLE_LABEL[role] : 'In no environment'}
        className={`relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.05] ${role ? 'text-fg/80' : 'text-muted/60'}`}
      >
        <RoleIcon aria-hidden className="size-3.5" />
      </span>
      <span className="relative flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-medium">{host.label}</span>
          <span className="truncate font-mono text-[11.5px] text-muted">{host.address}</span>
        </span>
        {(envs.length > 0 || host.tags.length > 0) && (
          <span className="flex flex-wrap items-center gap-1">
            {envs.map((e) => (
              <span
                key={e.id}
                className="inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 text-[11px] font-medium text-fg/90"
                style={{ background: `color-mix(in oklab, ${e.color} 16%, transparent)` }}
              >
                <span aria-hidden className="size-1.5 rounded-full" style={{ background: e.color }} />
                {e.name}
              </span>
            ))}
            {host.tags.map((t) => (
              <span key={t} className="rounded bg-white/[0.04] px-1 font-mono text-[10.5px] leading-[18px] text-muted">
                {t}
              </span>
            ))}
          </span>
        )}
      </span>
      <button
        type="button"
        tabIndex={present ? 0 : -1}
        aria-label={`Connect to ${host.label}`}
        title="Connect"
        onClick={(e) => {
          e.stopPropagation()
          void connect(host.id)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg text-muted opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
      >
        <SquareTerminal aria-hidden className="size-3.5" />
      </button>
    </motion.li>
  )
}

function RailButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-white/[0.04] hover:text-fg"
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </button>
  )
}
