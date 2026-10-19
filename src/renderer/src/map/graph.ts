import type { EnvironmentMeta, HostMeta, HostRole, OsIcon, ProductIcon } from '../../../shared/inventory'
import type { TunnelMeta, TunnelType } from '../../../shared/tunnels'
import type { InventoryData } from '../inventory/store'
import { environmentKey, ROLE_ORDER } from '../inventory/tree'

export type MapScope = { kind: 'all' } | { kind: 'product'; productId: string } | { kind: 'environment'; environmentId: string }

export const scopeKey = (scope: MapScope): string =>
  scope.kind === 'all' ? 'all' : scope.kind === 'product' ? `p:${scope.productId}` : `e:${scope.environmentId}`

/** `env` wins over `product`; an unknown id falls through, and the last resort is `all`. */
export function parseScope(params: URLSearchParams, data: InventoryData): MapScope {
  const environmentId = params.get('env')
  if (environmentId && data.environments.some((e) => e.id === environmentId)) return { kind: 'environment', environmentId }
  const productId = params.get('product')
  if (productId && data.products.some((p) => p.id === productId)) return { kind: 'product', productId }
  return { kind: 'all' }
}

/** Phase 8 adds 'app' | 'deployment'. */
export type MapNodeKind = 'product' | 'environment' | 'host' | 'mac'

/** The Phase 8 seam: things attached to a host (apps, deployments). Always empty for now. */
export interface MapAttachment {
  id: string
  kind: string
  label: string
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

const UNASSIGNED_COLOR = '#8a91a3'
const byText = (a: string, b: string) => a.localeCompare(b)

interface Group {
  id: string
  env: EnvironmentMeta | null
  primaryProductId: string | null
}

export function buildGraph({ data, tunnels, scope }: { data: InventoryData; tunnels: TunnelMeta[]; scope: MapScope }): MapGraph {
  const productById = new Map(data.products.map((p) => [p.id, p]))
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const vaultName = new Map(data.vaults.map((v) => [v.id, v.name]))

  // Scope: which environments and products are drawn.
  const scopedEnvs =
    scope.kind === 'all' ? data.environments
    : scope.kind === 'environment' ? data.environments.filter((e) => e.id === scope.environmentId)
    : data.environments.filter((e) => e.productIds.includes(scope.productId))
  const productIds = new Set(
    scope.kind === 'all' ? data.products.map((p) => p.id)
    : scope.kind === 'product' ? [scope.productId]
    : scopedEnvs.flatMap((e) => e.productIds),
  )
  const scopedProducts = data.products.filter((p) => productIds.has(p.id)).sort((a, b) => byText(a.name, b.name))
  const productRank = new Map(scopedProducts.map((p, i) => [p.id, i]))

  // Each environment sits once, under its primary product (first by id among the products in scope).
  const groups: Group[] = scopedEnvs.map((env) => {
    const inScope = env.productIds.filter((id) => productRank.has(id))
    const primaryProductId = inScope.length ? environmentKey({ ...env, productIds: inScope }).split('/')[0].slice(2) : null
    return { id: `e:${env.id}`, env, primaryProductId }
  })
  groups.sort((a, b) => {
    const ra = a.primaryProductId === null ? Infinity : productRank.get(a.primaryProductId)!
    const rb = b.primaryProductId === null ? Infinity : productRank.get(b.primaryProductId)!
    return ra - rb || byText(a.env!.name, b.env!.name)
  })

  const placed = new Set(data.environments.flatMap((e) => e.hosts.map((m) => m.hostId)))
  const looseHosts = scope.kind === 'all' ? data.hosts.filter((h) => !placed.has(h.id)).sort((a, b) => byText(a.label, b.label)) : []
  if (looseHosts.length) groups.push({ id: 'u', env: null, primaryProductId: null })

  const sharedCount = (h: HostMeta) => Math.max(1, data.environments.filter((e) => e.hosts.some((m) => m.hostId === h.id)).length)

  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const placementsByHost: Record<string, string[]> = {}
  const hostNodes: { node: MapNode; host: HostMeta; env: EnvironmentMeta | null }[] = []

  for (const p of scopedProducts) {
    nodes.push({
      id: `p:${p.id}`,
      data: {
        kind: 'product', productId: p.id, name: p.name, color: p.color, icon: p.icon,
        environmentCount: scopedEnvs.filter((e) => e.productIds.includes(p.id)).length,
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
    members.sort((a, b) => {
      const ra = a.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(a.role)
      const rb = b.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(b.role)
      return ra - rb || byText(a.host.label, b.host.label)
    })
    nodes.push({
      id: g.id,
      data: g.env
        ? {
            kind: 'environment', environmentId: g.env.id, name: g.env.name, color: g.env.color, protected: g.env.protected,
            hostCount: members.length,
            productNames: g.env.productIds.flatMap((id) => productById.get(id)?.name ?? []).sort(byText),
          }
        : { kind: 'environment', environmentId: null, name: 'Unassigned', color: UNASSIGNED_COLOR, protected: false, hostCount: members.length, productNames: [] },
    })
    for (const { host, role } of members) {
      const id = `${g.id}/h:${host.id}`
      const node: MapNode = {
        id,
        parentId: g.id,
        data: {
          kind: 'host', hostId: host.id, environmentId: g.env?.id ?? null, label: host.label, address: host.address, role,
          osIcon: host.osIcon, tags: [...host.tags], vaultNames: host.vaultIds.flatMap((v) => vaultName.get(v) ?? []),
          sharedCount: sharedCount(host), jumpLabel: null, attachments: [],
        },
      }
      nodes.push(node)
      hostNodes.push({ node, host, env: g.env })
      ;(placementsByHost[host.id] ??= []).push(id)
    }
    if (g.env && g.primaryProductId !== null) {
      for (const productId of g.env.productIds.filter((pid) => productRank.has(pid)).sort()) {
        edges.push({
          id: `m:${productId}>${g.id}`, source: `p:${productId}`, target: g.id,
          data: { kind: 'membership', primary: productId === g.primaryProductId },
        })
      }
    }
  }

  // Jumps: the host's own, else the environment's default.
  for (const { node, host, env } of hostNodes) {
    const jumpId = host.jumpHostId ?? env?.defaultJumpHostId ?? null
    const jump = jumpId ? hostById.get(jumpId) : undefined
    if (!jump || jump.id === host.id) continue
    const own = env ? `e:${env.id}/h:${jump.id}` : null
    const source = own && placementsByHost[jump.id]?.includes(own) ? own : placementsByHost[jump.id]?.[0]
    if (!source) {
      ;(node.data as HostNodeData).jumpLabel = jump.label
      continue
    }
    edges.push({ id: `j:${source}>${node.id}`, source, target: node.id, data: { kind: 'jump', viaEnvDefault: host.jumpHostId === null } })
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
