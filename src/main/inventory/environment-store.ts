import { randomUUID } from 'node:crypto'
import {
  HOST_ROLES,
  MAX_NAME,
  type EnvironmentInput,
  type EnvironmentMeta,
  type EnvironmentPatch,
  type HostRole,
} from '../../shared/inventory'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { VaultService } from '../vault/vault-service'
import { checkColor, checkName, checkPort, environmentMeta, hostRow } from './rows'

const exists = (db: Db, table: string, id: string): boolean => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined

/** Environments: defaults, shared product links and host memberships with roles. Every write is audited without values. */
export class EnvironmentStore {
  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
  ) {}

  /** Works while locked. Environments with no product are included (shown as unassigned). */
  list(): EnvironmentMeta[] {
    const rows = this.db.prepare('SELECT id FROM environments ORDER BY name COLLATE NOCASE, id').all() as { id: string }[]
    return rows.map((r) => environmentMeta(this.db, r.id))
  }

  create(input: EnvironmentInput): EnvironmentMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => {
      const name = checkName(input.name, 'environment name', MAX_NAME)
      const color = checkColor(input.color, 'environment')
      const identityId = this.checkIdentity(input.defaultIdentityId)
      const port = input.defaultPort == null ? null : checkPort(input.defaultPort)
      const jumpHostId = this.checkJump(input.defaultJumpHostId)
      const productIds = this.checkProducts(input.productIds ?? [])
      this.checkNamesFree(name, productIds)
      const newId = randomUUID()
      const ts = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO environments(id, name, color, protected, default_identity_id, default_port, default_jump_host_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(newId, name, color, input.protected ? 1 : 0, identityId, port, jumpHostId, ts, ts)
      for (const p of productIds) {
        this.db.prepare('INSERT INTO product_environments(product_id, environment_id) VALUES (?,?)').run(p, newId)
      }
      return newId
    })
    const meta = environmentMeta(this.db, id)
    this.audit.append({
      action: 'environment.create',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: meta.name,
      details: { products: meta.productIds.length },
    })
    return meta
  }

  /** `undefined` keeps a field; `null` clears the three defaults so hosts inherit from the global fallback. */
  update(id: string, patch: EnvironmentPatch): EnvironmentMeta {
    this.vault.assertUnlocked()
    const next = inTransaction(this.db, () => {
      const before = environmentMeta(this.db, id)
      const name = patch.name === undefined ? before.name : checkName(patch.name, 'environment name', MAX_NAME)
      if (name !== before.name) this.checkNamesFree(name, before.productIds, id)
      const color = patch.color === undefined ? before.color : checkColor(patch.color, 'environment')
      const isProtected = patch.protected === undefined ? before.protected : patch.protected === true
      const identityId = patch.defaultIdentityId === undefined ? before.defaultIdentityId : this.checkIdentity(patch.defaultIdentityId)
      const port =
        patch.defaultPort === undefined ? before.defaultPort : patch.defaultPort === null ? null : checkPort(patch.defaultPort)
      const jumpHostId = patch.defaultJumpHostId === undefined ? before.defaultJumpHostId : this.checkJump(patch.defaultJumpHostId)
      const fields = [
        name !== before.name && 'name',
        color !== before.color && 'color',
        isProtected !== before.protected && 'protected',
        identityId !== before.defaultIdentityId && 'defaultIdentityId',
        port !== before.defaultPort && 'defaultPort',
        jumpHostId !== before.defaultJumpHostId && 'defaultJumpHostId',
      ].filter(Boolean)
      if (fields.length === 0) return null
      this.db
        .prepare(
          `UPDATE environments SET name = ?, color = ?, protected = ?, default_identity_id = ?, default_port = ?,
            default_jump_host_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(name, color, isProtected ? 1 : 0, identityId, port, jumpHostId, new Date().toISOString(), id)
      return { name, fields }
    })
    if (next === null) return environmentMeta(this.db, id)
    this.audit.append({
      action: 'environment.update',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: next.name,
      details: { fields: next.fields },
    })
    return environmentMeta(this.db, id)
  }

  /** Removes the environment and its links; hosts and products stay. */
  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = environmentMeta(this.db, id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM environments WHERE id = ?').run(id))
    this.audit.append({
      action: 'environment.delete',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: before.name,
      details: { hosts: before.hosts.length, products: before.productIds.length },
    })
  }

  /** Replaces the environment's product set. */
  setProducts(id: string, productIds: string[]): EnvironmentMeta {
    this.vault.assertUnlocked()
    const before = environmentMeta(this.db, id)
    const wanted = this.checkProducts(productIds)
    const added = wanted.filter((p) => !before.productIds.includes(p)).sort()
    const removed = before.productIds.filter((p) => !wanted.includes(p)).sort()
    if (added.length === 0 && removed.length === 0) return before
    inTransaction(this.db, () => {
      this.checkNamesFree(before.name, added, id)
      for (const p of removed) {
        this.db.prepare('DELETE FROM product_environments WHERE product_id = ? AND environment_id = ?').run(p, id)
      }
      for (const p of added) {
        this.db.prepare('INSERT INTO product_environments(product_id, environment_id) VALUES (?,?)').run(p, id)
      }
      this.db.prepare('UPDATE environments SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    })
    this.audit.append({
      action: 'environment.products',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: before.name,
      details: { added, removed },
    })
    return environmentMeta(this.db, id)
  }

  /** Adds the host or changes its role; the same role again is a no-op. */
  putHost(id: string, hostId: string, role: HostRole): EnvironmentMeta {
    this.vault.assertUnlocked()
    if (!(HOST_ROLES as readonly string[]).includes(role)) throw new Error('host role is not allowed')
    const before = environmentMeta(this.db, id)
    hostRow(this.db, hostId)
    const current = before.hosts.find((h) => h.hostId === hostId)
    if (current?.role === role) return before
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO environment_hosts(environment_id, host_id, role) VALUES (?,?,?)
            ON CONFLICT(environment_id, host_id) DO UPDATE SET role = excluded.role`,
        )
        .run(id, hostId, role)
      this.db.prepare('UPDATE environments SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    })
    this.audit.append({
      action: 'environment.host',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: before.name,
      details: current ? { op: 'role', hostId, role, from: current.role } : { op: 'add', hostId, role },
    })
    return environmentMeta(this.db, id)
  }

  /** Takes the host out; its tunnels in this environment fall back to host-only. */
  removeHost(id: string, hostId: string): EnvironmentMeta {
    this.vault.assertUnlocked()
    const before = environmentMeta(this.db, id)
    if (!before.hosts.some((h) => h.hostId === hostId)) throw new Error('host is not in this environment')
    inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM environment_hosts WHERE environment_id = ? AND host_id = ?').run(id, hostId)
      // The host's tunnels leave the environment with it, as the FK's SET NULL does when it is deleted.
      this.db.prepare('UPDATE tunnels SET environment_id = NULL WHERE host_id = ? AND environment_id = ?').run(hostId, id)
      this.db.prepare('UPDATE environments SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    })
    this.audit.append({
      action: 'environment.host',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: before.name,
      details: { op: 'remove', hostId },
    })
    return environmentMeta(this.db, id)
  }

  private checkIdentity(id: string | null | undefined): string | null {
    if (id == null) return null
    if (!exists(this.db, 'identities', id)) throw new Error('identity not found')
    return id
  }

  private checkJump(id: string | null | undefined): string | null {
    if (id == null) return null
    hostRow(this.db, id)
    return id
  }

  private checkProducts(ids: string[]): string[] {
    const unique = [...new Set(ids)]
    for (const p of unique) if (!exists(this.db, 'products', p)) throw new Error('product not found')
    return unique
  }

  /** An environment name is unique within each product (case-insensitive); other environments may reuse it. */
  private checkNamesFree(name: string, productIds: string[], selfId = ''): void {
    const clash = this.db.prepare(
      `SELECT e.name AS name FROM environments e JOIN product_environments pe ON pe.environment_id = e.id
        WHERE pe.product_id = ? AND e.name = ? COLLATE NOCASE AND e.id <> ?`,
    )
    for (const p of productIds) {
      const hit = clash.get(p, name, selfId) as { name: string } | undefined
      if (hit) {
        const product = (this.db.prepare('SELECT name FROM products WHERE id = ?').get(p) as { name: string }).name
        throw new Error(`product ${product} already has an environment named ${hit.name}`)
      }
    }
  }
}
