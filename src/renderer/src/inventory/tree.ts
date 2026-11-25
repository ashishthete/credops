import type { EnvironmentMeta, HostRole, RegionRef } from '../../../shared/inventory'
import type { ServiceKind } from '../../../shared/services'
import { regionOfHost } from './regions'
import type { InventoryData } from './store'

/** 'p:<id>', 'p:<id>/e:<id>', 'p:<id>/e:<id>/s:<id>', 'u', 'u/h:<id>' */
export type NodeKey = string

export interface TreeRow {
  key: NodeKey
  kind: 'product' | 'environment' | 'service' | 'host' | 'group' | 'hint'
  id: string
  depth: 0 | 1 | 2
  parentKey: NodeKey | null
  label: string
  color: string
  role?: HostRole
  /** Services only: its type, and the host it runs on. */
  serviceKind?: ServiceKind
  hostId?: string
  hostLabel?: string
  protected?: boolean
  /** Other places this host appears; 0 = not shared. */
  sharedCount: number
  /** Hosts only: "Product · Environment" for every other membership, sorted. */
  alsoIn?: string[]
  /** A host's region; an environment's when all its hosts share one. */
  region?: RegionRef
  /** Hosts only: the region's chip sits on the environment row instead, since every host there shares it. */
  regionOnParent?: true
  expandable: boolean
  expanded: boolean
  childCount: number
}

/** Where an environment sits in the tree: under its product. */
export const environmentKey = (env: Pick<EnvironmentMeta, 'id' | 'productId'>): NodeKey => `p:${env.productId}/e:${env.id}`

/** Bastions first: they're how you reach the rest. */
export const ROLE_ORDER = ['bastion', 'app', 'db', 'other'] as const satisfies readonly HostRole[]
export const UNASSIGNED_COLOR = '#8a91a3'
export const byName = (a: string, b: string) => a.localeCompare(b)

/** A product's environments in the order the user gave them; a tie falls back to the name. */
export const byPosition = (a: { position: number; name: string }, b: { position: number; name: string }) =>
  a.position - b.position || byName(a.name, b.name)

/** Services by type, in the order you reach them: bastions, then apps, then databases. */
export const SERVICE_ORDER = ['bastion', 'service', 'db'] as const satisfies readonly ServiceKind[]

/** What the tree needs of a service. */
export interface TreeService {
  id: string
  environmentId: string
  hostId: string
  name: string
  kind: ServiceKind
  position: number
}

/** Hosts by role (bastions first, role-less last), then label. */
export const compareHosts = (a: { role: HostRole | null; label: string }, b: { role: HostRole | null; label: string }) =>
  (a.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(a.role)) - (b.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(b.role)) ||
  byName(a.label, b.label)

/** Rows focus and arrow keys can land on; hints are text only. */
export const isFocusable = (r: TreeRow) => r.kind !== 'hint'

/** The visible rows, in order. Products by name; environments by name; services by type, then their own order. */
export function buildTree(data: InventoryData, expanded: ReadonlySet<NodeKey>, services: readonly TreeService[] = []): TreeRow[] {
  const envById = new Map(data.environments.map((e) => [e.id, e]))
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const rows: TreeRow[] = []
  const regionRef = (hostId: string): RegionRef | undefined => {
    const r = regionOfHost(data, hostId)
    return r && { id: r.id, code: r.code, displayName: r.displayName }
  }

  const hostsOf = (envId: string) => {
    const env = envById.get(envId)
    if (!env) return []
    return env.hosts
      .flatMap((m) => {
        const h = hostById.get(m.hostId)
        return h ? [{ host: h, role: m.role }] : []
      })
      .sort((a, b) => compareHosts({ role: a.role, label: a.host.label }, { role: b.role, label: b.host.label }))
  }

  const push = (row: Omit<TreeRow, 'expandable' | 'expanded'>, canOpen = row.childCount > 0) => {
    const expandable = canOpen
    const open = expandable && expanded.has(row.key)
    rows.push({ ...row, expandable, expanded: open })
    return open
  }

  /** The region every host of the environment is in; undefined when they differ, some have none, or there are none. */
  const sharedRegion = (envId: string): RegionRef | undefined => {
    const refs = hostsOf(envId).map(({ host }) => regionRef(host.id))
    const first = refs[0]
    return first && refs.every((r) => r?.id === first.id) ? first : undefined
  }

  const servicesOf = (envId: string) =>
    services
      .filter((x) => x.environmentId === envId)
      .sort((a, b) => SERVICE_ORDER.indexOf(a.kind) - SERVICE_ORDER.indexOf(b.kind) || a.position - b.position || byName(a.name, b.name))

  const addServices = (envKey: NodeKey, envId: string, depth: 2) => {
    const list = servicesOf(envId)
    const onParent = sharedRegion(envId) ? { regionOnParent: true as const } : {}
    for (const svc of list) {
      const host = hostById.get(svc.hostId)
      push({
        key: `${envKey}/s:${svc.id}`, kind: 'service', id: svc.id, depth, parentKey: envKey, label: svc.name,
        color: envById.get(envId)?.color ?? UNASSIGNED_COLOR, serviceKind: svc.kind, hostId: svc.hostId, hostLabel: host?.label,
        region: host ? regionRef(host.id) : undefined, ...onParent, sharedCount: 0, childCount: 0,
      })
    }
    if (list.length === 0) {
      push({ key: `${envKey}/hint`, kind: 'hint', id: envId, depth, parentKey: envKey, label: 'No services — drag a host here', color: UNASSIGNED_COLOR, sharedCount: 0, childCount: 0 })
    }
  }

  const addEnv = (parentKey: NodeKey, envId: string) => {
    const env = envById.get(envId)!
    const key = `${parentKey}/e:${envId}`
    // An empty environment still opens, to show where hosts can be dropped.
    if (push({
      key, kind: 'environment', id: envId, depth: 1, parentKey, label: env.name, color: env.color,
      protected: env.protected, region: sharedRegion(envId), sharedCount: 0, childCount: servicesOf(envId).length,
    }, true)) addServices(key, envId, 2)
  }

  for (const p of [...data.products].sort((a, b) => byName(a.name, b.name))) {
    const key = `p:${p.id}`
    const envIds = data.environments.filter((e) => e.productId === p.id).sort(byPosition).map((e) => e.id)
    if (push({ key, kind: 'product', id: p.id, depth: 0, parentKey: null, label: p.name, color: p.color, sharedCount: 0, childCount: envIds.length })) {
      envIds.forEach((id) => addEnv(key, id))
    }
  }

  // Every environment has a product; only hosts can be in none.
  const looseHosts = data.hosts.filter((h) => h.environments.length === 0).sort((a, b) => byName(a.label, b.label))
  if (looseHosts.length) {
    const open = push({
      key: 'u', kind: 'group', id: 'u', depth: 0, parentKey: null, label: 'Unassigned hosts', color: UNASSIGNED_COLOR,
      sharedCount: 0, childCount: looseHosts.length,
    })
    if (open) {
      for (const h of looseHosts) {
        push({ key: `u/h:${h.id}`, kind: 'host', id: h.id, depth: 1, parentKey: 'u', label: h.label, color: UNASSIGNED_COLOR, region: regionRef(h.id), sharedCount: 0, childCount: 0 })
      }
    }
  }
  return rows
}

/** Tree keyboard model: where focus goes, and which node (if any) to expand or collapse. */
export function moveFocus(
  rows: TreeRow[],
  key: NodeKey,
  keyName: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
): { focus: NodeKey; toggle?: NodeKey } {
  rows = rows.filter(isFocusable)
  const i = rows.findIndex((r) => r.key === key)
  if (i === -1 || rows.length === 0) return { focus: key }
  const row = rows[i]
  switch (keyName) {
    case 'ArrowUp':
      return { focus: rows[Math.max(0, i - 1)].key }
    case 'ArrowDown':
      return { focus: rows[Math.min(rows.length - 1, i + 1)].key }
    case 'Home':
      return { focus: rows[0].key }
    case 'End':
      return { focus: rows[rows.length - 1].key }
    case 'ArrowRight':
      if (row.expandable && !row.expanded) return { focus: key, toggle: key }
      return { focus: row.expanded && rows[i + 1]?.parentKey === key ? rows[i + 1].key : key }
    case 'ArrowLeft':
      if (row.expanded) return { focus: key, toggle: key }
      return { focus: row.parentKey ?? key }
  }
}

export function selectionFromKey(key: NodeKey): { productId?: string; environmentId?: string; serviceId?: string; hostId?: string } {
  const out: { productId?: string; environmentId?: string; serviceId?: string; hostId?: string } = {}
  for (const part of key.split('/')) {
    if (part.startsWith('p:')) out.productId = part.slice(2)
    else if (part.startsWith('e:')) out.environmentId = part.slice(2)
    else if (part.startsWith('s:')) out.serviceId = part.slice(2)
    else if (part.startsWith('h:')) out.hostId = part.slice(2)
  }
  return out
}
