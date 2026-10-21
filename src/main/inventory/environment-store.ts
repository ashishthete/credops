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
import { checkColor, checkDomain, checkName, checkPort, environmentMeta, environmentMetas, hostRow } from './rows'

const exists = (db: Db, table: string, id: string): boolean => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined

/** Environments: defaults, their one product and host memberships with roles. Every write is audited without values. */
export class EnvironmentStore {
  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
  ) {}

  /** Works while locked. */
  list(): EnvironmentMeta[] {
    return environmentMetas(this.db)
  }

  /** One environment. Works while locked. */
  get(id: string): EnvironmentMeta {
    return environmentMeta(this.db, id)
  }

  create(input: EnvironmentInput): EnvironmentMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => this.insertInTx(input))
    const meta = environmentMeta(this.db, id)
    this.audit.append({
      action: 'environment.create',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: meta.name,
      details: { productId: meta.productId },
    })
    return meta
  }

  /** `undefined` keeps a field; `null` clears the three defaults so hosts inherit from the global fallback. */
  update(id: string, patch: EnvironmentPatch): EnvironmentMeta {
    this.vault.assertUnlocked()
    const next = inTransaction(this.db, () => this.updateInTx(id, patch))
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

  /** create() without the transaction, the unlock check or the audit: for a caller's own transaction (config import). */
  insertInTx(input: EnvironmentInput, id: string = randomUUID()): string {
    const name = checkName(input.name, 'environment name', MAX_NAME)
    const color = checkColor(input.color, 'environment')
    const identityId = this.checkIdentity(input.defaultIdentityId)
    const port = input.defaultPort == null ? null : checkPort(input.defaultPort)
    const jumpHostId = this.checkJump(input.defaultJumpHostId)
    const domain = checkDomain(input.domain)
    const productId = this.checkProduct(input.productId)
    this.checkNameFree(name, productId)
    const ts = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO environments(id, name, color, protected, default_identity_id, default_port, default_jump_host_id, domain,
          product_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, name, color, input.protected ? 1 : 0, identityId, port, jumpHostId, domain, productId, ts, ts)
    return id
  }

  /** update() without the transaction, the unlock check or the audit; null when nothing changed. */
  updateInTx(id: string, patch: EnvironmentPatch): { name: string; fields: string[] } | null {
    const before = environmentMeta(this.db, id)
    const name = patch.name === undefined ? before.name : checkName(patch.name, 'environment name', MAX_NAME)
    if (name !== before.name) this.checkNameFree(name, before.productId, id)
    const color = patch.color === undefined ? before.color : checkColor(patch.color, 'environment')
    const isProtected = patch.protected === undefined ? before.protected : patch.protected === true
    const identityId = patch.defaultIdentityId === undefined ? before.defaultIdentityId : this.checkIdentity(patch.defaultIdentityId)
    const port =
      patch.defaultPort === undefined ? before.defaultPort : patch.defaultPort === null ? null : checkPort(patch.defaultPort)
    const jumpHostId = patch.defaultJumpHostId === undefined ? before.defaultJumpHostId : this.checkJump(patch.defaultJumpHostId)
    const domain = patch.domain === undefined ? before.domain : checkDomain(patch.domain)
    const fields = [
      name !== before.name && 'name',
      color !== before.color && 'color',
      isProtected !== before.protected && 'protected',
      identityId !== before.defaultIdentityId && 'defaultIdentityId',
      port !== before.defaultPort && 'defaultPort',
      jumpHostId !== before.defaultJumpHostId && 'defaultJumpHostId',
      domain !== before.domain && 'domain',
    ].filter((f): f is string => typeof f === 'string')
    if (fields.length === 0) return null
    this.db
      .prepare(
        `UPDATE environments SET name = ?, color = ?, protected = ?, default_identity_id = ?, default_port = ?,
          default_jump_host_id = ?, domain = ?, updated_at = ? WHERE id = ?`,
      )
      .run(name, color, isProtected ? 1 : 0, identityId, port, jumpHostId, domain, new Date().toISOString(), id)
    return { name, fields }
  }

  /** putHost() without the transaction, the unlock check or the audit; false when the host already has that role. */
  putHostInTx(id: string, hostId: string, role: HostRole): boolean {
    if (!(HOST_ROLES as readonly string[]).includes(role)) throw new Error('host role is not allowed')
    const before = environmentMeta(this.db, id)
    hostRow(this.db, hostId)
    if (before.hosts.find((h) => h.hostId === hostId)?.role === role) return false
    this.db
      .prepare(
        `INSERT INTO environment_hosts(environment_id, host_id, role) VALUES (?,?,?)
          ON CONFLICT(environment_id, host_id) DO UPDATE SET role = excluded.role`,
      )
      .run(id, hostId, role)
    this.db.prepare('UPDATE environments SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    return true
  }

  /** Removes the environment and its links; hosts and its product stay. */
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
      details: { hosts: before.hosts.length, productId: before.productId },
    })
  }

  /**
   * Moves the environment to another product. Refused while it is published to the Hub: there is no manifest-change
   * tracking to carry the move, so the user unpublishes, moves and publishes again.
   */
  setProduct(id: string, productId: string): EnvironmentMeta {
    this.vault.assertUnlocked()
    const before = environmentMeta(this.db, id)
    const to = this.checkProduct(productId)
    if (to === before.productId) return before
    inTransaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM hub_env_links WHERE environment_id = ?').get(id)) {
        throw new Error('this environment is published to the Hub: unpublish it, move it, then publish it again')
      }
      this.checkNameFree(before.name, to, id)
      this.db.prepare('UPDATE environments SET product_id = ?, updated_at = ? WHERE id = ?').run(to, new Date().toISOString(), id)
    })
    this.audit.append({
      action: 'environment.product',
      outcome: 'success',
      targetType: 'environment',
      targetId: id,
      targetLabel: before.name,
      details: { from: before.productId, to },
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

  private checkProduct(id: string | undefined): string {
    if (typeof id !== 'string' || id === '') throw new Error('an environment needs a product')
    if (!exists(this.db, 'products', id)) throw new Error('product not found')
    return id
  }

  /** An environment name is unique within its product (case-insensitive); other products may reuse it. */
  private checkNameFree(name: string, productId: string, selfId = ''): void {
    const hit = this.db
      .prepare('SELECT name FROM environments WHERE product_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
      .get(productId, name, selfId) as { name: string } | undefined
    if (hit) {
      const product = (this.db.prepare('SELECT name FROM products WHERE id = ?').get(productId) as { name: string }).name
      throw new Error(`product ${product} already has an environment named ${hit.name}`)
    }
  }
}
