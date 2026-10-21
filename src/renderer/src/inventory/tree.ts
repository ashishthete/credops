import type { EnvironmentMeta, HostMeta, HostRole, RegionRef } from '../../../shared/inventory'
import { regionOfHost, regionsOfEnvironment } from './regions'
import type { InventoryData } from './store'

/** 'p:<id>', 'p:<id>/e:<id>', 'p:<id>/e:<id>/h:<id>', 'u', 'u/h:<id>' */
export type NodeKey = string

export interface TreeRow {
  key: NodeKey
  kind: 'product' | 'environment' | 'host' | 'group' | 'hint'
  id: string
  depth: 0 | 1 | 2
  parentKey: NodeKey | null
  label: string
  color: string
  role?: HostRole
  protected?: boolean
  /** Other places this host appears; 0 = not shared. */
  sharedCount: number
  /** Hosts only: "Product · Environment" for every other membership, sorted. */
  alsoIn?: string[]
  /** Hosts only: the host's region, set when its environment spans more than one. */
  region?: RegionRef
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

/** Hosts by role (bastions first, role-less last), then label. */
export const compareHosts = (a: { role: HostRole | null; label: string }, b: { role: HostRole | null; label: string }) =>
  (a.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(a.role)) - (b.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(b.role)) ||
  byName(a.label, b.label)

/** Rows focus and arrow keys can land on; hints are text only. */
export const isFocusable = (r: TreeRow) => r.kind !== 'hint'

/** The visible rows, in order. Products by name; environments by name; hosts by role then label. */
export function buildTree(data: InventoryData, expanded: ReadonlySet<NodeKey>): TreeRow[] {
  const envById = new Map(data.environments.map((e) => [e.id, e]))
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const productName = new Map(data.products.map((p) => [p.id, p.name]))
  const rows: TreeRow[] = []
  const regionRef = (hostId: string): RegionRef | undefined => {
    const r = regionOfHost(data, hostId)
    return r && { id: r.id, code: r.code, displayName: r.displayName }
  }

  // A host shows once under every environment it belongs to (or once if it has none).
  const hostAppearances = (h: HostMeta) => Math.max(1, h.environments.length)

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

  /** Every "Product · Environment" the host sits in, keyed by where that environment shows in the tree. */
  const placementsOf = (h: HostMeta) =>
    h.environments.flatMap((m) => {
      const env = envById.get(m.environmentId)
      return env ? [{ key: environmentKey(env), label: `${productName.get(env.productId) ?? env.productId} · ${env.name}` }] : []
    })

  const push = (row: Omit<TreeRow, 'expandable' | 'expanded'>, canOpen = row.childCount > 0) => {
    const expandable = canOpen
    const open = expandable && expanded.has(row.key)
    rows.push({ ...row, expandable, expanded: open })
    return open
  }

  const addHosts = (envKey: NodeKey, envId: string, depth: 2) => {
    const hosts = hostsOf(envId)
    // Region chips only where they tell hosts apart: an environment spanning more than one region.
    const multiRegion = regionsOfEnvironment(data, envId).length > 1
    for (const { host, role } of hosts) {
      const alsoIn = placementsOf(host).filter((p) => p.key !== envKey).map((p) => p.label).sort(byName)
      push({
        key: `${envKey}/h:${host.id}`, kind: 'host', id: host.id, depth, parentKey: envKey, label: host.label,
        color: envById.get(envId)?.color ?? UNASSIGNED_COLOR, role, sharedCount: hostAppearances(host) - 1, alsoIn,
        region: multiRegion ? regionRef(host.id) : undefined, childCount: 0,
      })
    }
    if (hosts.length === 0) {
      push({ key: `${envKey}/hint`, kind: 'hint', id: envId, depth, parentKey: envKey, label: 'No hosts — drag one here', color: UNASSIGNED_COLOR, sharedCount: 0, childCount: 0 })
    }
  }

  const addEnv = (parentKey: NodeKey, envId: string) => {
    const env = envById.get(envId)!
    const key = `${parentKey}/e:${envId}`
    // An empty environment still opens, to show where hosts can be dropped.
    if (push({
      key, kind: 'environment', id: envId, depth: 1, parentKey, label: env.name, color: env.color,
      protected: env.protected, sharedCount: 0, childCount: hostsOf(envId).length,
    }, true)) addHosts(key, envId, 2)
  }

  for (const p of [...data.products].sort((a, b) => byName(a.name, b.name))) {
    const key = `p:${p.id}`
    const envIds = data.environments.filter((e) => e.productId === p.id).sort((a, b) => byName(a.name, b.name)).map((e) => e.id)
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
        push({ key: `u/h:${h.id}`, kind: 'host', id: h.id, depth: 1, parentKey: 'u', label: h.label, color: UNASSIGNED_COLOR, sharedCount: 0, childCount: 0 })
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

export function selectionFromKey(key: NodeKey): { productId?: string; environmentId?: string; hostId?: string } {
  const out: { productId?: string; environmentId?: string; hostId?: string } = {}
  for (const part of key.split('/')) {
    if (part.startsWith('p:')) out.productId = part.slice(2)
    else if (part.startsWith('e:')) out.environmentId = part.slice(2)
    else if (part.startsWith('h:')) out.hostId = part.slice(2)
  }
  return out
}
