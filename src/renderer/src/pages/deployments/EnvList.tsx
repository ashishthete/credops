import { Check, Cloud, Lock, Plus, Rocket, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { DeploymentMeta, EnvLastRelease } from '../../../../shared/deploy'
import type { HubCatalogEnv } from '../../../../shared/hub'
import type { ServiceMeta } from '../../../../shared/services'
import type { InventoryData } from '../../inventory/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { plural, useMenuPopover } from '../../ui/common'
import { relativeTime } from '../../ui/time'

/** The group holding the team environments this machine has no copy of. */
export const TEAM_GROUP = 'Team (Hub)'
/** Hosts named on a row before the rest are counted. */
const HOSTS_SHOWN = 2

type ReleaseState = 'running' | 'failed' | 'succeeded' | 'cancelled' | 'none'

export interface EnvRow {
  id: string
  name: string
  color?: string
  protected: boolean
  /** A team environment: deployable here, changed only where it is published from. */
  hub: boolean
  productName: string
  hosts: { label: string; address?: string }[]
  /** What Deploy ticks: each service, and each checkout with none. */
  units: number
  last?: EnvLastRelease
}

export interface EnvGroup {
  id: string
  name: string
  rows: EnvRow[]
}

function stateOf(last: EnvLastRelease | undefined): ReleaseState {
  if (!last) return 'none'
  if (last.status === 'running' || last.status === 'rolling_back') return 'running'
  if (last.status === 'failed' || last.status === 'rolled_back') return 'failed'
  if (last.status === 'cancelled') return 'cancelled'
  return 'succeeded'
}

const WORD: Record<Exclude<ReleaseState, 'none' | 'running'>, string> = { failed: 'failed', succeeded: 'succeeded', cancelled: 'was cancelled' }
const DOT: Record<ReleaseState, string> = { running: 'bg-accent', failed: 'bg-err', succeeded: 'bg-ok', cancelled: 'bg-muted', none: 'bg-muted/40' }
/** Running first, then failed; the rest keep the product's order. */
const RANK: Record<ReleaseState, number> = { running: 0, failed: 1, succeeded: 2, cancelled: 2, none: 2 }

const when = (r: EnvLastRelease) => r.finishedAt ?? r.startedAt ?? r.createdAt
const short = (sha: string | null) => sha?.slice(0, 7) ?? null

/** The row's accessible name: the environment, its status and its last release. */
export function rowLabel(row: EnvRow): string {
  const state = stateOf(row.last)
  // A team environment's releases may have run elsewhere: with none seen here it is not known to have none.
  const last = !row.last
    ? row.hub
      ? 'last release unknown'
      : 'no releases yet'
    : state === 'running'
      ? `running, started ${relativeTime(row.last.startedAt ?? row.last.createdAt)}`
      : `last release ${WORD[state as keyof typeof WORD]} ${relativeTime(when(row.last))}${row.last.version ? `, ${row.last.version}` : ''}`
  return `${row.name}, ${last}${row.protected ? ', protected' : ''}`
}

/** Environments by product (a product's own order), then those in no product, then the team's. */
export function envGroups(
  data: InventoryData,
  team: HubCatalogEnv[],
  deployments: DeploymentMeta[],
  services: ServiceMeta[],
  latest: Record<string, EnvLastRelease>,
): EnvGroup[] {
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const units = (envId: string) => {
    const checkouts = deployments.filter((d) => d.environmentId === envId)
    const apps = services.filter((s) => s.kind === 'service' && s.environmentId === envId)
    return checkouts.reduce((n, d) => n + (apps.filter((s) => s.kind === 'service' && s.deploymentId === d.id).length || 1), 0)
  }
  const byId = new Map(data.environments.map((e) => [e.id, e]))
  const placed = new Set<string>()
  const local = (e: InventoryData['environments'][number], productName: string): EnvRow => ({
    id: e.id,
    name: e.name,
    color: e.color,
    protected: e.protected,
    hub: false,
    productName,
    hosts: e.hosts.flatMap((m) => {
      const h = hostById.get(m.hostId)
      return h ? [{ label: h.label, address: h.address }] : []
    }),
    units: units(e.id),
    last: latest[e.id],
  })
  const out: EnvGroup[] = data.products.flatMap((p) => {
    const rows = p.environmentIds.flatMap((id) => {
      const e = byId.get(id)
      if (!e) return []
      placed.add(id)
      return [local(e, p.name)]
    })
    return rows.length ? [{ id: p.id, name: p.name, rows }] : []
  })
  const loose = data.environments.filter((e) => !placed.has(e.id)).map((e) => local(e, 'No product'))
  if (loose.length) out.push({ id: 'none', name: 'No product', rows: loose })
  if (team.length) {
    out.push({
      id: 'hub',
      name: TEAM_GROUP,
      rows: team.map((c) => ({
        id: c.environment.id,
        name: c.environment.name,
        protected: c.environment.protected,
        hub: true,
        productName: TEAM_GROUP,
        hosts: c.hosts.map((h) => ({ label: h.label })),
        units: units(c.environment.id),
        last: latest[c.environment.id],
      })),
    })
  }
  return out
}

/** Keeps the rows matching `query` (environment, product or host) in `productId` ('' for all), running and failed first. */
export function filterGroups(groups: EnvGroup[], query: string, productId: string): EnvGroup[] {
  const q = query.trim().toLowerCase()
  const hit = (g: EnvGroup, r: EnvRow) =>
    !q || [r.name, g.name, ...r.hosts.flatMap((h) => [h.label, h.address ?? ''])].some((s) => s.toLowerCase().includes(q))
  return groups.flatMap((g) => {
    if (productId && g.id !== productId) return []
    const rows = g.rows
      .filter((r) => hit(g, r))
      .map((r, i) => ({ r, i }))
      .sort((a, b) => RANK[stateOf(a.r.last)] - RANK[stateOf(b.r.last)] || a.i - b.i)
      .map(({ r }) => r)
    return rows.length ? [{ ...g, rows }] : []
  })
}

export interface EnvListProps {
  groups: EnvGroup[]
  /** Every product with environments, for the filter. */
  products: { id: string; name: string }[]
  query: string
  productId: string
  onQuery: (q: string) => void
  onProduct: (id: string) => void
  onOpen: (envId: string) => void
  onDeploy: (envId: string) => void
  onAddService: (envId: string) => void
  /** The environment just left: its row takes focus when the list comes back. */
  focusEnvId?: string | null
}

export function EnvListFilters({ products, query, productId, onQuery, onProduct }: Pick<EnvListProps, 'products' | 'query' | 'productId' | 'onQuery' | 'onProduct'>) {
  const control =
    'h-8 rounded-lg border border-line bg-canvas/60 text-[12.5px] text-fg transition-[border-color,box-shadow] focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none'
  return (
    <div className="flex items-center gap-2">
      <label className="relative block">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
        <input
          type="search"
          aria-label="Search environments"
          placeholder="Environment, product or host"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || !query) return
            e.preventDefault()
            onQuery('')
          }}
          spellCheck={false}
          autoComplete="off"
          className={`${control} w-56 pr-2.5 pl-8 placeholder:text-muted/60`}
        />
      </label>
      {products.length > 1 && (
        <select aria-label="Product" value={productId} onChange={(e) => onProduct(e.target.value)} className={`${control} px-2`}>
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** How often the rows' relative times are brought up to date. */
const TICK_MS = 30_000

/** The landing view: one compact row per environment, grouped by product. */
export function EnvList({ groups, query, productId, onQuery, onProduct, onOpen, onDeploy, onAddService, focusEnvId }: Omit<EnvListProps, 'products'>) {
  const root = useRef<HTMLDivElement>(null)
  // Re-renders the rows so "5 minutes ago" keeps moving.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (focusEnvId) root.current?.querySelector<HTMLElement>(`[data-env="${CSS.escape(focusEnvId)}"] [data-row-open]`)?.focus()
    // Only as the list appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!groups.length) {
    return (
      <div className="flex flex-col items-center gap-2 pt-16 text-center text-[12.5px] text-muted">
        <p>No environments match</p>
        {(query || productId) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<X aria-hidden className="size-3" />}
            onClick={() => {
              onQuery('')
              onProduct('')
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
    )
  }
  // Up and Down move between the rows, across products, and Home and End to the first and last; Tab still reaches each row's buttons.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row-open]')]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1)
    rows[to].focus()
  }
  return (
    <div ref={root} className="flex flex-col gap-6" onKeyDown={onKeyDown}>
      {groups.map((g) => (
        <section key={g.id} role="group" aria-label={g.name}>
          <div className="mb-2 flex items-center gap-2.5">
            <h2 className="flex items-center gap-1.5 text-[12.5px] font-semibold tracking-tight text-fg/90">
              {g.id === 'hub' && <Cloud aria-hidden className="size-3" />}
              {g.name}
            </h2>
            <span className="text-[11.5px] text-muted tabular-nums">{g.rows.length}</span>
            <span aria-hidden className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
          </div>
          <ul className="overflow-hidden rounded-[14px] border border-line bg-surface/60">
            {g.rows.map((r) => (
              <EnvListRow key={r.id} row={r} onOpen={onOpen} onDeploy={onDeploy} onAddService={onAddService} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function EnvListRow({ row, onOpen, onDeploy, onAddService }: { row: EnvRow; onOpen: (id: string) => void; onDeploy: (id: string) => void; onAddService: (id: string) => void }) {
  const state = stateOf(row.last)
  const shown = row.hosts.slice(0, HOSTS_SHOWN).map((h) => h.label)
  const more = row.hosts.length - shown.length
  const hosts = row.hosts.length ? `${shown.join(', ')}${more > 0 ? ` +${more}` : ''}` : 'No hosts'
  const prev = short(row.last?.previousCommit ?? null)
  const next = short(row.last?.deployedCommit ?? null)
  return (
    <li
      aria-label={row.name}
      data-env={row.id}
      className="group relative flex min-h-12 items-center gap-3 border-b border-line/60 pr-3 transition-colors last:border-0 hover:bg-white/[0.022]"
    >
      <button
        type="button"
        aria-label={rowLabel(row)}
        data-row-open
        onClick={() => onOpen(row.id)}
        className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-2.5 pl-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset"
      >
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[state]} ${state === 'running' ? 'animate-pulse' : ''}`} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-fg">{row.name}</span>
            {row.protected && <Lock role="img" aria-label="Protected" className="size-3 shrink-0 text-warn" />}
          </span>
          <span className="truncate text-[11.5px] text-muted">
            {row.units ? `${hosts} · ${plural(row.units, 'service')}` : 'No services yet'}
          </span>
        </span>
        {row.last && state !== 'running' && (
          <span className="hidden shrink-0 items-center gap-2 text-[11.5px] text-muted tabular-nums sm:flex">
            {state === 'failed' ? (
              <X aria-hidden className="size-3 text-err" />
            ) : state === 'succeeded' ? (
              <Check aria-hidden className="size-3 text-ok" />
            ) : null}
            <span>{relativeTime(when(row.last))}</span>
            {next && (
              <span className="font-mono text-fg/80">
                {prev ? `${prev}→` : ''}
                {next}
              </span>
            )}
            {row.last.version && <span className="font-mono text-fg/80">{row.last.version}</span>}
          </span>
        )}
      </button>
      {state === 'running' && (
        <Badge tone="info" dot="pulse">
          Running
        </Badge>
      )}
      {row.units > 0 ? (
        <Button size="sm" variant="ghost" aria-label={`Deploy to ${row.name}`} icon={<Rocket aria-hidden className="size-3.5" />} onClick={() => onDeploy(row.id)}>
          Deploy
        </Button>
      ) : (
        !row.hub && (
          <Button size="sm" variant="ghost" aria-label={`Add service to ${row.name}`} icon={<Plus aria-hidden className="size-3.5" />} onClick={() => onAddService(row.id)}>
            Add service
          </Button>
        )
      )}
    </li>
  )
}

/** "New deployment" on the list: picks the environment first. */
export function NewDeploymentMenu({ groups, onPick }: { groups: EnvGroup[]; onPick: (envId: string) => void }) {
  const { open, setOpen, close, triggerProps, menuProps } = useMenuPopover()
  const local = groups.filter((g) => g.id !== 'hub')
  if (!local.length) return null
  return (
    <div className="relative">
      <Button {...triggerProps} size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setOpen((o) => !o)}>
        New deployment
      </Button>
      {open && (
        <div
          {...menuProps}
          aria-label="New deployment in"
          className="absolute top-full right-0 z-40 mt-1 max-h-80 w-[220px] overflow-y-auto rounded-ui border border-line bg-surface-2/95 p-1 shadow-pop backdrop-blur-xl"
        >
          {local.map((g) => (
            <div key={g.id} role="group" aria-label={g.name}>
              <p className="px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium text-muted">{g.name}</p>
              {g.rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close()
                    onPick(r.id)
                  }}
                  className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] text-fg/90 transition-colors hover:bg-white/6 focus:bg-white/6 focus:outline-none"
                >
                  <span aria-hidden className="size-1.5 rounded-full" style={{ background: r.color }} />
                  {r.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
