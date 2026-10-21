import type { DeploymentMeta } from '../../../shared/deploy'
import type { EnvironmentMeta, HostMeta, HostRole, OsIcon, ProductIcon } from '../../../shared/inventory'
import type { ServiceMeta } from '../../../shared/services'
import type { TunnelMeta, TunnelType } from '../../../shared/tunnels'
import type { InventoryData } from '../inventory/store'
import { byName, compareHosts, UNASSIGNED_COLOR } from '../inventory/tree'
// regions-ui: one product per environment, read as a list until the Regions UI.
import { productIdsOf } from '../inventory/regions-stopgap'

export type MapScope = { kind: 'all' } | { kind: 'product'; productId: string } | { kind: 'environment'; environmentId: string }

export const scopeKey = (scope: MapScope): string =>
  scope.kind === 'all' ? 'all' : scope.kind === 'product' ? `p:${scope.productId}` : `e:${scope.environmentId}`

/** `env` wins over `product`; an unknown id gives `all`. */
export function parseScope(params: URLSearchParams, data: InventoryData): MapScope {
  const environmentId = params.get('env')
  if (environmentId !== null) {
    return data.environments.some((e) => e.id === environmentId) ? { kind: 'environment', environmentId } : { kind: 'all' }
  }
  const productId = params.get('product')
  if (productId && data.products.some((p) => p.id === productId)) return { kind: 'product', productId }
  return { kind: 'all' }
}

/** Services are drawn on their host's node as attachments, not as nodes of their own. */
export type MapNodeKind = 'product' | 'environment' | 'host' | 'mac'

/** A service drawn under the host it runs on. */
export interface MapAttachment {
  /** The service id. */
  id: string
  kind: 'service' | 'db'
  label: string
}

/** Per host, then per environment, the services drawn under that placement. */
export type MapAttachments = Record<string, Record<string, MapAttachment[]>>

/**
 * A `service` attaches to its checkout's host; a `db` to the environment's host whose address is its
 * `dbAddress`, and nowhere when none is. Order follows the services' positions.
 */
export function buildAttachments(data: InventoryData, services: ServiceMeta[], deployments: DeploymentMeta[]): MapAttachments {
  const checkoutHost = new Map(deployments.map((d) => [d.id, d.hostId]))
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const envById = new Map(data.environments.map((e) => [e.id, e]))
  const out: MapAttachments = {}
  for (const s of [...services].sort((a, b) => a.position - b.position)) {
    const env = envById.get(s.environmentId)
    if (!env) continue
    const hostId =
      s.kind === 'service'
        ? s.deploymentId ? checkoutHost.get(s.deploymentId) : undefined
        : env.hosts.find((m) => hostById.get(m.hostId)?.address === s.dbAddress)?.hostId
    if (!hostId || !env.hosts.some((m) => m.hostId === hostId)) continue
    ;((out[hostId] ??= {})[env.id] ??= []).push({ id: s.id, kind: s.kind, label: s.name })
  }
  return out
}

export interface ProductNodeData {
  kind: 'product'
  productId: string
  name: string
  color: string
  icon: ProductIcon
  environmentCount: number
}
export interface EnvironmentNodeData {
  kind: 'environment'
  /** Null for the unassigned group. */
  environmentId: string | null
  name: string
  color: string
  protected: boolean
  hostCount: number
  productNames: string[]
}
export interface HostNodeData {
  kind: 'host'
  hostId: string
  environmentId: string | null
  label: string
  address: string
  role: HostRole | null
  osIcon: OsIcon
  tags: string[]
  vaultNames: string[]
  /** Placements of this host in the whole inventory. */
  sharedCount: number
  /** Set only when the jump host is not drawn as an edge in this scope. */
  jumpLabel: string | null
  attachments: MapAttachment[]
}
export interface MacNodeData {
  kind: 'mac'
  tunnelCount: number
}
export type MapNodeData = ProductNodeData | EnvironmentNodeData | HostNodeData | MacNodeData

/** No position: layout adds that. */
export interface MapNode {
  id: string
  parentId?: string
  data: MapNodeData
}

export interface MembershipEdgeData {
  kind: 'membership'
  primary: boolean
}
export interface JumpEdgeData {
  kind: 'jump'
  viaEnvDefault: boolean
}
export interface TunnelEdgeData {
  kind: 'tunnel'
  tunnelId: string
  tunnelType: TunnelType
  label: string
}
export interface MapEdge {
  id: string
  source: string
  target: string
  data: MembershipEdgeData | JumpEdgeData | TunnelEdgeData
}

export interface MapGraph {
  nodes: MapNode[]
  edges: MapEdge[]
  placementsByHost: Record<string, string[]>
}


interface Group {
  id: string
  env: EnvironmentMeta | null
  primaryProductId: string | null
}

const NO_ATTACHMENTS: MapAttachments = {}

export function buildGraph({
  data,
  tunnels,
  scope,
  attachments = NO_ATTACHMENTS,
}: {
  data: InventoryData
  tunnels: TunnelMeta[]
  scope: MapScope
  attachments?: MapAttachments
}): MapGraph {
  const productById = new Map(data.products.map((p) => [p.id, p]))
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const vaultName = new Map(data.vaults.map((v) => [v.id, v.name]))

  // Scope: which environments and products are drawn.
  const scopedEnvs =
    scope.kind === 'all' ? data.environments
    : scope.kind === 'environment' ? data.environments.filter((e) => e.id === scope.environmentId)
    : data.environments.filter((e) => productIdsOf(e).includes(scope.productId))
  const productIds = new Set(
    scope.kind === 'all' ? data.products.map((p) => p.id)
    : scope.kind === 'product' ? [scope.productId]
    : scopedEnvs.flatMap((e) => productIdsOf(e)),
  )
  const scopedProducts = data.products.filter((p) => productIds.has(p.id)).sort((a, b) => byName(a.name, b.name))
  const productRank = new Map(scopedProducts.map((p, i) => [p.id, i]))

  // Each environment sits once, under its primary product (first by id among the products in scope).
  const groups: Group[] = scopedEnvs.map((env) => {
    const inScope = productIdsOf(env).filter((id) => productRank.has(id))
    const primaryProductId = inScope.length ? [...inScope].sort()[0] : null
    return { id: `e:${env.id}`, env, primaryProductId }
  })
  groups.sort((a, b) => {
    const ra = a.primaryProductId === null ? Infinity : productRank.get(a.primaryProductId)!
    const rb = b.primaryProductId === null ? Infinity : productRank.get(b.primaryProductId)!
    return ra - rb || byName(a.env!.name, b.env!.name)
  })

  const placed = new Set(data.environments.flatMap((e) => e.hosts.map((m) => m.hostId)))
  const looseHosts = scope.kind === 'all' ? data.hosts.filter((h) => !placed.has(h.id)).sort((a, b) => byName(a.label, b.label)) : []
  if (looseHosts.length) groups.push({ id: 'u', env: null, primaryProductId: null })

  const placementCount = new Map<string, number>()
  for (const e of data.environments) for (const m of new Set(e.hosts.map((x) => x.hostId))) placementCount.set(m, (placementCount.get(m) ?? 0) + 1)

  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const placementsByHost: Record<string, string[]> = {}
  const hostNodes: { id: string; data: HostNodeData; host: HostMeta; env: EnvironmentMeta | null }[] = []

  for (const p of scopedProducts) {
    nodes.push({
      id: `p:${p.id}`,
      data: {
        kind: 'product', productId: p.id, name: p.name, color: p.color, icon: p.icon,
        environmentCount: scopedEnvs.filter((e) => productIdsOf(e).includes(p.id)).length,
      },
    })
  }

  for (const g of groups) {
    const members: { host: HostMeta; role: HostRole | null }[] = g.env
      ? g.env.hosts.flatMap((m) => {
          const host = hostById.get(m.hostId)
          return host ? [{ host, role: m.role }] : []
        })
      : looseHosts.map((host) => ({ host, role: null }))
    members.sort((a, b) => compareHosts({ role: a.role, label: a.host.label }, { role: b.role, label: b.host.label }))
    nodes.push({
      id: g.id,
      data: g.env
        ? {
            kind: 'environment', environmentId: g.env.id, name: g.env.name, color: g.env.color, protected: g.env.protected,
            hostCount: members.length,
            productNames: productIdsOf(g.env).flatMap((id) => productById.get(id)?.name ?? []).sort(byName),
          }
        : { kind: 'environment', environmentId: null, name: 'Unassigned', color: UNASSIGNED_COLOR, protected: false, hostCount: members.length, productNames: [] },
    })
    for (const { host, role } of members) {
      const id = `${g.id}/h:${host.id}`
      const data: HostNodeData = {
          kind: 'host', hostId: host.id, environmentId: g.env?.id ?? null, label: host.label, address: host.address, role,
          osIcon: host.osIcon, tags: [...host.tags], vaultNames: host.vaultIds.flatMap((v) => vaultName.get(v) ?? []),
          sharedCount: placementCount.get(host.id) ?? 1, jumpLabel: null,
          // Only an environment placement carries services; the unassigned group has none.
          attachments: g.env ? [...(attachments[host.id]?.[g.env.id] ?? [])] : [],
      }
      nodes.push({ id, parentId: g.id, data })
      hostNodes.push({ id, data, host, env: g.env })
      ;(placementsByHost[host.id] ??= []).push(id)
    }
    if (g.env && g.primaryProductId !== null) {
      for (const productId of productIdsOf(g.env).filter((pid) => productRank.has(pid)).sort()) {
        edges.push({
          id: `m:${productId}>${g.id}`, source: `p:${productId}`, target: g.id,
          data: { kind: 'membership', primary: productId === g.primaryProductId },
        })
      }
    }
  }

  // Jumps: the host's own, else the environment's default.
  for (const { id, data: hostData, host, env } of hostNodes) {
    const jumpId = host.jumpHostId ?? env?.defaultJumpHostId ?? null
    const jump = jumpId ? hostById.get(jumpId) : undefined
    if (!jump || jump.id === host.id) continue
    const own = env ? `e:${env.id}/h:${jump.id}` : null
    const source = own && placementsByHost[jump.id]?.includes(own) ? own : placementsByHost[jump.id]?.[0]
    if (!source) {
      hostData.jumpLabel = jump.label
      continue
    }
    edges.push({ id: `j:${source}>${id}`, source, target: id, data: { kind: 'jump', viaEnvDefault: host.jumpHostId === null } })
  }

  // Tunnels: traffic direction decides which end is the Mac.
  let tunnelCount = 0
  for (const t of tunnels) {
    const placements = placementsByHost[t.hostId]
    if (!placements?.length) continue
    const hostEnd = (t.environmentId && placements.find((id) => id === `e:${t.environmentId}/h:${t.hostId}`)) || placements[0]
    const [source, target] = t.type === 'R' ? [hostEnd, 'mac'] : ['mac', hostEnd]
    edges.push({ id: `t:${t.id}`, source, target, data: { kind: 'tunnel', tunnelId: t.id, tunnelType: t.type, label: t.label } })
    tunnelCount++
  }
  if (tunnelCount) nodes.push({ id: 'mac', data: { kind: 'mac', tunnelCount } })

  return { nodes, edges, placementsByHost }
}
