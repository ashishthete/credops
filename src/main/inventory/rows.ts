import {
  ENV_NAME,
  HOST_ADDRESS,
  MAX_ADDRESS,
  MAX_ENV_VALUE,
  MAX_ENV_VARS,
  MAX_KEEPALIVE_SEC,
  MAX_TAG,
  MAX_TAGS,
  TAG,
  UNSAFE_SSH_CHAR,
  parseEnvDomain,
  type EnvironmentMeta,
  type HostMeta,
  type HostRole,
  type OsIcon,
  type ProductIcon,
  type ProductMeta,
  type RegionMeta,
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

/** `null` for empty; otherwise the trimmed value as entered. The message never carries the value. */
export function checkDomain(raw: string | null | undefined): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return null
  const r = parseEnvDomain(s)
  if (!r.ok) throw new Error(r.error)
  return s
}

export function checkPort(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) throw new Error('port must be 1-65535')
  return raw
}

export function checkKeepalive(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_KEEPALIVE_SEC) {
    throw new Error(`keepalive must be 0-${MAX_KEEPALIVE_SEC} seconds`)
  }
  return raw
}

/** Env vars as sorted-key JSON, so equal sets compare equal. Messages name the rule, never a name or value. */
export function checkEnvVars(raw: Record<string, string>): string {
  const entries = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.entries(raw) : null
  if (entries === null) throw new Error('env vars must be an object')
  if (entries.length > MAX_ENV_VARS) throw new Error(`a host can have at most ${MAX_ENV_VARS} env vars`)
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) throw new Error('an env var name is invalid')
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE) {
      throw new Error(`an env var value must be a string of at most ${MAX_ENV_VALUE} characters`)
    }
    if (UNSAFE_SSH_CHAR.test(value)) throw new Error('an env var value has control or format characters')
  }
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
}

interface HostRow {
  id: string
  label: string
  address: string
  region_id: string
  port: number | null
  identity_id: string | null
  jump_host_id: string | null
  tags: string
  os_icon: OsIcon
  notes: string
  keepalive_sec: number | null
  env_vars: string
  created_at: string
  updated_at: string
}

export function hostRow(db: Db, id: string): HostRow {
  const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined
  if (!row) throw new Error('host not found')
  return row
}

/** Rows grouped by `key`, keeping their order. */
function groupBy<T extends Record<K, string>, K extends keyof T>(rows: T[], key: K): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const list = out.get(r[key])
    if (list) list.push(r)
    else out.set(r[key], [r])
  }
  return out
}

export function hostMeta(db: Db, id: string): HostMeta {
  const r = hostRow(db, id)
  const vaults = db.prepare('SELECT vault_id FROM host_vaults WHERE host_id = ? ORDER BY vault_id').all(id) as {
    vault_id: string
  }[]
  const envs = db
    .prepare('SELECT environment_id, role FROM environment_hosts WHERE host_id = ? ORDER BY environment_id')
    .all(id) as { environment_id: string; role: HostRole }[]
  return toHostMeta(r, vaults, envs)
}

/** Every host, sorted by label, in three queries rather than three per host. */
export function hostMetas(db: Db): HostMeta[] {
  const rows = db.prepare('SELECT * FROM hosts ORDER BY label COLLATE NOCASE, id').all() as unknown as HostRow[]
  const vaults = groupBy(
    db.prepare('SELECT host_id, vault_id FROM host_vaults ORDER BY vault_id').all() as { host_id: string; vault_id: string }[],
    'host_id',
  )
  const envs = groupBy(
    db.prepare('SELECT host_id, environment_id, role FROM environment_hosts ORDER BY environment_id').all() as {
      host_id: string
      environment_id: string
      role: HostRole
    }[],
    'host_id',
  )
  return rows.map((r) => toHostMeta(r, vaults.get(r.id) ?? [], envs.get(r.id) ?? []))
}

function toHostMeta(
  r: HostRow,
  vaults: { vault_id: string }[],
  envs: { environment_id: string; role: HostRole }[],
): HostMeta {
  return {
    id: r.id,
    label: r.label,
    address: r.address,
    regionId: r.region_id,
    port: r.port,
    identityId: r.identity_id,
    jumpHostId: r.jump_host_id,
    tags: JSON.parse(r.tags) as string[],
    osIcon: r.os_icon,
    notes: r.notes,
    keepaliveSec: r.keepalive_sec,
    envVars: JSON.parse(r.env_vars) as Record<string, string>,
    vaultIds: vaults.map((x) => x.vault_id),
    environments: envs.map((e) => ({ environmentId: e.environment_id, role: e.role })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface EnvironmentRow {
  id: string
  name: string
  color: string
  protected: number
  default_identity_id: string | null
  default_port: number | null
  default_jump_host_id: string | null
  domain: string | null
  product_id: string
  position: number
  created_at: string
  updated_at: string
}

export function environmentMeta(db: Db, id: string): EnvironmentMeta {
  const r = db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as EnvironmentRow | undefined
  if (!r) throw new Error('environment not found')
  const hosts = db
    .prepare('SELECT host_id, role FROM environment_hosts WHERE environment_id = ? ORDER BY host_id')
    .all(id) as { host_id: string; role: HostRole }[]
  return toEnvironmentMeta(r, hosts)
}

/** Every environment, in its product's order (then by name), in two queries rather than two per environment. */
export function environmentMetas(db: Db): EnvironmentMeta[] {
  const rows = db.prepare('SELECT * FROM environments ORDER BY position, name COLLATE NOCASE, id').all() as unknown as EnvironmentRow[]
  const hosts = groupBy(
    db.prepare('SELECT environment_id, host_id, role FROM environment_hosts ORDER BY host_id').all() as {
      environment_id: string
      host_id: string
      role: HostRole
    }[],
    'environment_id',
  )
  return rows.map((r) => toEnvironmentMeta(r, hosts.get(r.id) ?? []))
}

function toEnvironmentMeta(
  r: EnvironmentRow,
  hosts: { host_id: string; role: HostRole }[],
): EnvironmentMeta {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    protected: r.protected === 1,
    defaultIdentityId: r.default_identity_id,
    defaultPort: r.default_port,
    defaultJumpHostId: r.default_jump_host_id,
    domain: r.domain,
    productId: r.product_id,
    position: r.position,
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
    .prepare('SELECT id FROM environments WHERE product_id = ? ORDER BY position, name COLLATE NOCASE, id')
    .all(id) as { id: string }[]
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    description: r.description,
    repoUrl: r.repo_url,
    environmentIds: envs.map((e) => e.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface RegionRow {
  id: string
  code: string
  provider: string
  display_name: string
  host_count: number
  created_at: string
  updated_at: string
}

const REGION_SELECT = `SELECT r.*, (SELECT COUNT(*) FROM hosts h WHERE h.region_id = r.id) AS host_count FROM regions r`

function toRegionMeta(r: RegionRow): RegionMeta {
  return {
    id: r.id,
    code: r.code,
    provider: r.provider,
    displayName: r.display_name,
    hostCount: r.host_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function regionMeta(db: Db, id: string): RegionMeta {
  const r = db.prepare(`${REGION_SELECT} WHERE r.id = ?`).get(id) as RegionRow | undefined
  if (!r) throw new Error('region not found')
  return toRegionMeta(r)
}

/** Every region, sorted by code. */
export function regionMetas(db: Db): RegionMeta[] {
  return (db.prepare(`${REGION_SELECT} ORDER BY r.code COLLATE NOCASE, r.id`).all() as unknown as RegionRow[]).map(toRegionMeta)
}
