import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, Cable, Filter, Laptop, Lock, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { deployStore } from '../deploy/store'
import { regionsOfEnvironment } from '../inventory/regions'
import { useInventory, type InventoryData } from '../inventory/store'
import { environmentKey, ROLE_ORDER } from '../inventory/tree'
import { OS_META } from '../pages/hosts/HostDialog'
import { PRODUCT_ICON } from '../pages/products/ProductDialog'
import { GlowDot, ROLE_LABEL } from '../pages/products/ProductView'
import { RouteLine } from '../pages/tunnels/RouteLine'
import { StatusLine, TUNNEL_TYPE, TunnelStateWord, TunnelSwitch } from '../pages/tunnels/TunnelCard'
import { useConnect } from '../terminal/connect'
import { tunnelStore, useTunnel } from '../tunnels/store'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { plural } from '../ui/common'
import { RegionChip } from '../ui/RegionChip'
import { exitFast, fast, spring, useMotionSafe } from '../ui/motion'
import type { EnvironmentNodeData, HostNodeData, MapGraph, MapNode, MapScope, ProductNodeData, TunnelEdgeData } from './graph'
import { REACH_TEXT, useHostPresence } from './presence'

export type MapSelection = { kind: 'node'; id: string } | { kind: 'edge'; id: string }

export interface DetailPanelProps {
  selection: MapSelection | null
  graph: MapGraph
  onClose: () => void
  onFilter: (scope: MapScope) => void
}

export const PANEL_W = 340

type Subject = { kind: 'node'; node: MapNode } | { kind: 'edge'; id: string; data: TunnelEdgeData }

/** What the selection points at in this graph; null once it is gone, or for an edge that has no panel. */
export function selectionSubject(selection: MapSelection | null, graph: MapGraph): Subject | null {
  if (!selection) return null
  if (selection.kind === 'node') {
    const node = graph.nodes.find((n) => n.id === selection.id)
    return node ? { kind: 'node', node } : null
  }
  const edge = graph.edges.find((e) => e.id === selection.id)
  return edge?.data.kind === 'tunnel' ? { kind: 'edge', id: edge.id, data: edge.data } : null
}

/**
 * The selected node or tunnel's details, sliding in over the right of the canvas. Shows only what the
 * other pages already show: names, addresses, roles, vault names and tunnel state, never a credential.
 */
export function DetailPanel({ selection, graph, onClose, onFilter }: DetailPanelProps) {
  const motionSafe = useMotionSafe()
  const data = useInventory()
  const panelRef = useRef<HTMLElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const subject = useMemo(() => selectionSubject(selection, graph), [selection, graph])
  const open = subject !== null
  const subjectId = subject ? (subject.kind === 'node' ? subject.node.id : subject.id) : null

  // Remember what had focus before the panel (unless it is already inside), then move focus in.
  useEffect(() => {
    if (!subjectId) return
    const active = document.activeElement
    const panel = panelRef.current
    if (active instanceof HTMLElement && active !== document.body && !panel?.contains(active)) returnFocus.current = active
    ;(panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel)?.focus()
  }, [subjectId])

  const close = useCallback(() => {
    // Nodes take no focus, so a panel opened by a click hands focus back to the canvas.
    const back = returnFocus.current?.isConnected ? returnFocus.current : panelRef.current?.parentElement?.querySelector<HTMLElement>('.react-flow')
    returnFocus.current = null
    onClose()
    back?.focus()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Dialogs and the palette handle (and prevent) their own Esc first.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const title = subject && data ? titleOf(subject) : null

  return (
    <AnimatePresence>
      {subject && data && title && (
        <motion.aside
          key="panel"
          ref={panelRef}
          aria-label={title}
          tabIndex={-1}
          style={{ width: PANEL_W }}
          className="absolute inset-y-0 right-0 z-10 flex max-w-full flex-col border-l border-line bg-surface/95 shadow-pop backdrop-blur-xl focus:outline-none"
          initial={motionSafe ? { x: PANEL_W, opacity: 0 } : { opacity: 0 }}
          animate={motionSafe ? { x: 0, opacity: 1 } : { opacity: 1 }}
          exit={motionSafe ? { x: PANEL_W, opacity: 0, transition: exitFast } : { opacity: 0, transition: exitFast }}
          transition={motionSafe ? spring : fast}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-5">
            {subject.kind === 'edge' ? (
              <TunnelDetails data={subject.data} hosts={data.hosts} onClose={close} />
            ) : subject.node.data.kind === 'host' ? (
              <HostDetails d={subject.node.data} data={data} onClose={close} />
            ) : subject.node.data.kind === 'environment' ? (
              <EnvironmentDetails id={subject.node.id} d={subject.node.data} graph={graph} data={data} onClose={close} onFilter={onFilter} />
            ) : subject.node.data.kind === 'product' ? (
              <ProductDetails d={subject.node.data} data={data} onClose={close} onFilter={onFilter} />
            ) : (
              <MacDetails graph={graph} onClose={close} />
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function titleOf(subject: Subject): string {
  if (subject.kind === 'edge') return subject.data.label
  const d = subject.node.data
  return d.kind === 'host' ? d.label : d.kind === 'mac' ? 'This Mac' : d.name
}

function Header({ lead, title, sub, onClose }: { lead: ReactNode; title: string; sub?: ReactNode; onClose: () => void }) {
  return (
    <header className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted ring-1 ring-line">{lead}</span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] font-semibold tracking-tight text-fg" title={title}>
          {title}
        </h2>
        {sub && <div className="mt-0.5 min-w-0 text-[12px] text-muted">{sub}</div>}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X aria-hidden className="size-4" />
      </button>
    </header>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10.5px] font-semibold tracking-wider text-muted uppercase">{label}</h3>
      <div className="text-[12.5px] text-fg">{children}</div>
    </section>
  )
}

const Chip = ({ children, accent = false }: { children: ReactNode; accent?: boolean }) => (
  <span
    className={`inline-flex h-5 max-w-full items-center gap-1 rounded-full px-2 text-[11px] leading-none ring-1 ${
      accent ? 'bg-accent/12 text-fg ring-accent/40' : 'bg-surface-2 text-fg/90 ring-line'
    }`}
  >
    {children}
  </span>
)

const Actions = ({ children }: { children: ReactNode }) => <div className="mt-auto flex flex-wrap gap-2 pt-2">{children}</div>

const openIcon = <ArrowUpRight aria-hidden className="size-3.5" />
const filterIcon = <Filter aria-hidden className="size-3.5" />

function HostDetails({ d, data, onClose }: { d: HostNodeData; data: InventoryData; onClose: () => void }) {
  const navigate = useNavigate()
  const { connect } = useConnect()
  const { sessions, reach } = useHostPresence(d.hostId)
  const host = data.hosts.find((h) => h.id === d.hostId)
  const environments = data.environments.filter((e) => e.hosts.some((m) => m.hostId === d.hostId)).sort((a, b) => a.name.localeCompare(b.name))
  const placement = d.environmentId ? data.environments.find((e) => e.id === d.environmentId) : undefined
  // The host's own jump, else its environment's default, as the graph draws it.
  const jumpId = host?.jumpHostId ?? placement?.defaultJumpHostId ?? null
  const jump = jumpId && jumpId !== d.hostId ? data.hosts.find((h) => h.id === jumpId) : undefined
  const os = OS_META[d.osIcon]

  return (
    <>
      <Header
        lead={<os.icon aria-label={os.label} className="size-4" strokeWidth={2} />}
        title={d.label}
        sub={<span className="block truncate font-mono">{d.address}</span>}
        onClose={onClose}
      />
      <Section label="Region">
        {d.region ? (
          <span className="flex items-center gap-2">
            <RegionChip region={d.region} />
            {d.region.displayName}
          </span>
        ) : (
          <span className="text-muted">Unknown</span>
        )}
      </Section>
      <Section label="Role">{d.role ? ROLE_LABEL[d.role] : 'No role'}</Section>
      <Section label="Status">
        {REACH_TEXT[reach]} · {plural(sessions, 'session')}
      </Section>
      <Section label="Environments">
        {environments.length > 0 ? (
          <ul aria-label="Environments" className="flex flex-wrap gap-1.5">
            {environments.map((e) => (
              <li key={e.id}>
                <Chip accent={e.id === d.environmentId}>
                  <span className="truncate">{e.name}</span>
                  {e.id === d.environmentId && <span className="text-muted">· this placement</span>}
                </Chip>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted">None</span>
        )}
      </Section>
      <Section label="Vaults">
        {d.vaultNames.length ? (
          <span className="flex flex-wrap gap-1.5">
            {/* Names can repeat across vaults and carry no ids, so position is the key. */}
            {d.vaultNames.map((name, i) => (
              <Chip key={i}>
                <span className="truncate">{name}</span>
              </Chip>
            ))}
          </span>
        ) : (
          <span className="text-muted">None</span>
        )}
      </Section>
      <Section label="Jump">
        {jump ? (
          <>
            via {jump.label}
            {host?.jumpHostId === null && <span className="text-muted"> · environment default</span>}
          </>
        ) : (
          <span className="text-muted">Direct</span>
        )}
      </Section>
      <HostTunnelList hostId={d.hostId} />
      <Actions>
        <Button data-autofocus icon={<SquareTerminal aria-hidden className="size-3.5" />} onClick={() => void connect(d.hostId, d.environmentId ?? undefined)}>
          Connect
        </Button>
        <Button variant="ghost" icon={openIcon} onClick={() => navigate(`/hosts?host=${d.hostId}`)}>
          Open host page
        </Button>
      </Actions>
    </>
  )
}

/** The host's tunnels. Reads the tunnel list itself, so runtime churn never touches the canvas. */
function HostTunnelList({ hostId }: { hostId: string }) {
  const tunnels = useSyncExternalStore(tunnelStore.subscribe, () => tunnelStore.get().tunnels)
  const mine = useMemo(() => tunnels.filter((t) => t.hostId === hostId).sort((a, b) => a.label.localeCompare(b.label)), [tunnels, hostId])
  if (!mine.length) return null
  return (
    <Section label="Tunnels">
      <TunnelList ids={mine.map((t) => t.id)} />
    </Section>
  )
}

function TunnelList({ ids }: { ids: string[] }) {
  return (
    <ul aria-label="Tunnels" className="flex flex-col gap-1">
      {ids.map((id) => (
        <TunnelRow key={id} id={id} />
      ))}
    </ul>
  )
}

function TunnelRow({ id }: { id: string }) {
  const { meta, runtime } = useTunnel(id)
  if (!meta) return null
  const state = runtime?.state ?? 'stopped'
  const kind = TUNNEL_TYPE[meta.type]
  return (
    <li aria-label={meta.label} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface/50 px-2.5 py-1.5">
      <span title={kind.title} className="shrink-0 font-mono text-[10.5px] font-semibold" style={{ color: kind.color }}>
        {kind.chip}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={meta.label}>
        {meta.label}
      </span>
      <TunnelStateWord state={state} />
      <TunnelSwitch id={id} label={meta.label} state={state} />
    </li>
  )
}

function EnvironmentDetails({
  id,
  d,
  graph,
  data,
  onClose,
  onFilter,
}: {
  id: string
  d: EnvironmentNodeData
  graph: MapGraph
  data: InventoryData
  onClose: () => void
  onFilter: (scope: MapScope) => void
}) {
  const navigate = useNavigate()
  const env = d.environmentId ? data.environments.find((e) => e.id === d.environmentId) : undefined
  // Derived from its member, checkout and via-hosts, as the Products page shows them.
  const checkouts = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().deployments)
  const services = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().services)
  const regions = useMemo(() => (env ? regionsOfEnvironment(data, env.id, checkouts, services) : []), [data, env, checkouts, services])
  // The count and the breakdown both come from the group's drawn host nodes, so they always agree.
  const { hostCount, roles } = useMemo(() => {
    const count = new Map<string, number>()
    let hostCount = 0
    for (const n of graph.nodes) {
      if (n.parentId !== id || n.data.kind !== 'host') continue
      hostCount++
      if (n.data.role) count.set(n.data.role, (count.get(n.data.role) ?? 0) + 1)
    }
    const roles = ROLE_ORDER.flatMap((r) => (count.get(r) ? [`${ROLE_LABEL[r]} ${count.get(r)}`] : [])).join(' · ')
    return { hostCount, roles }
  }, [graph, id])

  return (
    <>
      <Header
        lead={<GlowDot color={d.color} />}
        title={d.name}
        sub={
          d.protected && (
            <Badge tone="warn">
              <Lock aria-hidden className="size-3" />
              Protected
            </Badge>
          )
        }
        onClose={onClose}
      />
      {env && <Section label="Product">{d.productName ?? <span className="text-muted">None</span>}</Section>}
      {env && (
        <Section label="Regions">
          {regions.length ? (
            <ul aria-label="Regions" className="flex flex-wrap gap-1.5">
              {regions.map((r) => (
                <li key={r.id}>
                  <RegionChip region={r} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted">None yet</span>
          )}
        </Section>
      )}
      <Section label="Hosts">
        {plural(hostCount, 'host')}
        {roles && <span className="block text-muted">{roles}</span>}
      </Section>
      {env && (
        <Actions>
          <Button icon={filterIcon} onClick={() => onFilter({ kind: 'environment', environmentId: env.id })}>
            Filter to this environment
          </Button>
          <Button variant="ghost" icon={openIcon} onClick={() => navigate(`/products?node=${environmentKey(env)}`)}>
            Open in Products
          </Button>
        </Actions>
      )}
    </>
  )
}

function ProductDetails({
  d,
  data,
  onClose,
  onFilter,
}: {
  d: ProductNodeData
  data: InventoryData
  onClose: () => void
  onFilter: (scope: MapScope) => void
}) {
  const navigate = useNavigate()
  const description = data.products.find((p) => p.id === d.productId)?.description
  const Icon = PRODUCT_ICON[d.icon]
  return (
    <>
      <Header lead={<Icon aria-hidden className="size-4" style={{ color: d.color }} />} title={d.name} onClose={onClose} />
      {description && <p className="text-[12.5px] leading-relaxed text-fg/90">{description}</p>}
      <Section label="Environments">{plural(d.environmentCount, 'environment')}</Section>
      <Actions>
        <Button icon={filterIcon} onClick={() => onFilter({ kind: 'product', productId: d.productId })}>
          Filter to this product
        </Button>
        <Button variant="ghost" icon={openIcon} onClick={() => navigate(`/products?node=p:${d.productId}`)}>
          Open in Products
        </Button>
      </Actions>
    </>
  )
}

function MacDetails({ graph, onClose }: { graph: MapGraph; onClose: () => void }) {
  const ids = useMemo(
    () =>
      graph.edges
        .flatMap((e) => (e.data.kind === 'tunnel' ? [e.data] : []))
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((t) => t.tunnelId),
    [graph],
  )
  return (
    <>
      <Header lead={<Laptop aria-hidden className="size-4" />} title="This Mac" sub={plural(ids.length, 'tunnel')} onClose={onClose} />
      <Section label="Tunnels">
        <TunnelList ids={ids} />
      </Section>
    </>
  )
}

function TunnelDetails({ data: d, hosts, onClose }: { data: TunnelEdgeData; hosts: InventoryData['hosts']; onClose: () => void }) {
  const navigate = useNavigate()
  const { meta, runtime } = useTunnel(d.tunnelId)
  if (!meta) return null
  const state = runtime?.state ?? 'stopped'
  const kind = TUNNEL_TYPE[meta.type]
  const hostLabel = hosts.find((h) => h.id === meta.hostId)?.label ?? 'Unknown host'
  return (
    <>
      <Header lead={<Cable aria-hidden className="size-4" />} title={meta.label} sub={kind.title} onClose={onClose} />
      <RouteLine
        tunnelId={meta.id}
        type={meta.type}
        hostLabel={hostLabel}
        bindAddress={meta.bindAddress}
        bindPort={runtime?.boundPort ?? meta.bindPort}
        targetHost={meta.targetHost}
        targetPort={meta.targetPort}
        state={state}
        errorCode={runtime?.error?.code}
      />
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <StatusLine runtime={runtime} />
        </div>
        <TunnelSwitch id={meta.id} label={meta.label} state={state} />
      </div>
      <Actions>
        <Button variant="ghost" icon={openIcon} onClick={() => navigate('/tunnels')}>
          Open in Tunnels
        </Button>
      </Actions>
    </>
  )
}
