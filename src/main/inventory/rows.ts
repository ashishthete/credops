import {
  HOST_ADDRESS,
  MAX_ADDRESS,
  MAX_TAG,
  MAX_TAGS,
  TAG,
  type EnvironmentMeta,
  type HostMeta,
  type HostRole,
  type OsIcon,
  type ProductIcon,
  type ProductMeta,
} from '../../shared/inventory'
import { MAX_LABEL, VAULT_COLOR } from '../../shared/vault'
import type { Db } from '../db/connection'
import { checkHexColor, checkText } from '../util/checks'

/** Trimmed 1..max characters; the message never carries the value. */
export const checkName = checkText

export function checkColor(raw: string, what: string): string {
  return checkHexColor(raw, what, VAULT_COLOR)
}

/** Trimmed, de-duplicated case-insensitively (first spelling wins), each a valid tag. */
export function checkTags(raw: string[]): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_TAGS) throw new Error(`a host can have at most ${MAX_TAGS} tags`)
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const tag = typeof t === 'string' ? t.trim() : ''
    if (tag.length === 0 || tag.length > MAX_TAG || !TAG.test(tag)) throw new Error('a tag is invalid')
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

export function isValidLabel(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0 && raw.trim().length <= MAX_LABEL
}

export function isValidAddress(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_ADDRESS && HOST_ADDRESS.test(raw)
}

export function checkLabel(raw: string): string {
  return checkText(raw, 'host label', MAX_LABEL)
}

export function checkAddress(raw: string): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!isValidAddress(s)) throw new Error('host address is invalid')
  return s
}

export function checkPort(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) throw new Error('port must be 1-65535')
  return raw
}

interface HostRow {
  id: string
  label: string
  address: string
  port: number | null
  identity_id: string | null
  jump_host_id: string | null
  tags: string
  os_icon: OsIcon
  notes: string
  created_at: string
  updated_at: string
}

export function hostRow(db: Db, id: string): HostRow {
  const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined
  if (!row) throw new Error('host not found')
  return row
}

export function hostMeta(db: Db, id: string): HostMeta {
  const r = hostRow(db, id)
  const vaults = db.prepare('SELECT vault_id FROM host_vaults WHERE host_id = ? ORDER BY vault_id').all(id) as {
    vault_id: string
  }[]
  const envs = db
    .prepare('SELECT environment_id, role FROM environment_hosts WHERE host_id = ? ORDER BY environment_id')
    .all(id) as { environment_id: string; role: HostRole }[]
  return {
    id: r.id,
    label: r.label,
    address: r.address,
    port: r.port,
    identityId: r.identity_id,
    jumpHostId: r.jump_host_id,
    tags: JSON.parse(r.tags) as string[],
    osIcon: r.os_icon,
    notes: r.notes,
    vaultIds: vaults.map((x) => x.vault_id),
    environments: envs.map((e) => ({ environmentId: e.environment_id, role: e.role })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function environmentMeta(db: Db, id: string): EnvironmentMeta {
  const r = db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as
    | {
        id: string
        name: string
        color: string
        protected: number
        default_identity_id: string | null
        default_port: number | null
        default_jump_host_id: string | null
        created_at: string
        updated_at: string
      }
    | undefined
  if (!r) throw new Error('environment not found')
  const products = db
    .prepare('SELECT product_id FROM product_environments WHERE environment_id = ? ORDER BY product_id')
    .all(id) as { product_id: string }[]
  const hosts = db
    .prepare('SELECT host_id, role FROM environment_hosts WHERE environment_id = ? ORDER BY host_id')
    .all(id) as { host_id: string; role: HostRole }[]
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    protected: r.protected === 1,
    defaultIdentityId: r.default_identity_id,
    defaultPort: r.default_port,
    defaultJumpHostId: r.default_jump_host_id,
    productIds: products.map((p) => p.product_id),
    hosts: hosts.map((h) => ({ hostId: h.host_id, role: h.role })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function productMeta(db: Db, id: string): ProductMeta {
  const r = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as
    | {
        id: string
        name: string
        color: string
        icon: ProductIcon
        description: string
        repo_url: string | null
        created_at: string
        updated_at: string
      }
    | undefined
  if (!r) throw new Error('product not found')
  const envs = db
    .prepare('SELECT environment_id FROM product_environments WHERE product_id = ? ORDER BY environment_id')
    .all(id) as { environment_id: string }[]
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    description: r.description,
    repoUrl: r.repo_url,
    environmentIds: envs.map((e) => e.environment_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
