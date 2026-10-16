import type { EnvironmentMeta, HostMeta, HostRole } from '../../../shared/inventory'
import type { InventoryData } from './store'

/** 'p:<id>', 'p:<id>/e:<id>', 'p:<id>/e:<id>/h:<id>', 'u', 'u/e:<id>', 'u/e:<id>/h:<id>', 'u/h:<id>' */
export type NodeKey = string

export interface TreeRow {
  key: NodeKey
  kind: 'product' | 'environment' | 'host' | 'group'
  id: string
  depth: 0 | 1 | 2
  parentKey: NodeKey | null
  label: string
  color: string
  role?: HostRole
  protected?: boolean
  /** Other places this environment or host appears; 0 = not shared. */
  sharedCount: number
  expandable: boolean
  expanded: boolean
  childCount: number
}

/** Where an environment sits in the tree: under `preferProduct` if it's one of its products, else its first by id. */
export function environmentKey(env: EnvironmentMeta, preferProduct?: string): NodeKey {
  if (env.productIds.length === 0) return `u/e:${env.id}`
  const productId = preferProduct && env.productIds.includes(preferProduct) ? preferProduct : [...env.productIds].sort()[0]
  return `p:${productId}/e:${env.id}`
}

const ROLE_ORDER: HostRole[] = ['bastion', 'app', 'db', 'other']
const UNASSIGNED_COLOR = '#8a91a3'
const byName = (a: string, b: string) => a.localeCompare(b)

/** The visible rows, in order. Products by name; environments by name; hosts by role then label. */
export function buildTree(data: InventoryData, expanded: ReadonlySet<NodeKey>): TreeRow[] {
  const envById = new Map(data.environments.map((e) => [e.id, e]))
  const hostById = new Map(data.hosts.map((h) => [h.id, h]))
  const rows: TreeRow[] = []

  // A host shows once under every placement of every environment it belongs to (or once if it has none).
  const placements = (envId: string) => Math.max(1, envById.get(envId)?.productIds.length ?? 1)
  const hostAppearances = (h: HostMeta) =>
    h.environments.length ? h.environments.reduce((n, m) => n + placements(m.environmentId), 0) : 1

  const hostsOf = (envId: string) => {
    const env = envById.get(envId)
    if (!env) return []
    return env.hosts
      .flatMap((m) => {
        const h = hostById.get(m.hostId)
        return h ? [{ host: h, role: m.role }] : []
      })
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || byName(a.host.label, b.host.label))
  }

  const push = (row: Omit<TreeRow, 'expandable' | 'expanded'>) => {
    const expandable = row.childCount > 0
    const open = expandable && expanded.has(row.key)
    rows.push({ ...row, expandable, expanded: open })
    return open
  }

  const addHosts = (envKey: NodeKey, envId: string, depth: 2) => {
    for (const { host, role } of hostsOf(envId)) {
      push({
        key: `${envKey}/h:${host.id}`, kind: 'host', id: host.id, depth, parentKey: envKey, label: host.label,
        color: envById.get(envId)?.color ?? UNASSIGNED_COLOR, role, sharedCount: hostAppearances(host) - 1, childCount: 0,
      })
    }
  }

  const addEnv = (parentKey: NodeKey, envId: string) => {
    const env = envById.get(envId)!
    const key = `${parentKey}/e:${envId}`
    if (push({
      key, kind: 'environment', id: envId, depth: 1, parentKey, label: env.name, color: env.color,
      protected: env.protected, sharedCount: placements(envId) - 1, childCount: hostsOf(envId).length,
    })) addHosts(key, envId, 2)
  }

  for (const p of [...data.products].sort((a, b) => byName(a.name, b.name))) {
    const key = `p:${p.id}`
    const envIds = data.environments.filter((e) => e.productIds.includes(p.id)).sort((a, b) => byName(a.name, b.name)).map((e) => e.id)
    if (push({ key, kind: 'product', id: p.id, depth: 0, parentKey: null, label: p.name, color: p.color, sharedCount: 0, childCount: envIds.length })) {
      envIds.forEach((id) => addEnv(key, id))
    }
  }

  const looseEnvs = data.environments.filter((e) => e.productIds.length === 0).sort((a, b) => byName(a.name, b.name))
  const looseHosts = data.hosts.filter((h) => h.environments.length === 0).sort((a, b) => byName(a.label, b.label))
  if (looseEnvs.length + looseHosts.length) {
    const open = push({
      key: 'u', kind: 'group', id: 'u', depth: 0, parentKey: null, label: 'Unassigned', color: UNASSIGNED_COLOR,
      sharedCount: 0, childCount: looseEnvs.length + looseHosts.length,
    })
    if (open) {
      looseEnvs.forEach((e) => addEnv('u', e.id))
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
