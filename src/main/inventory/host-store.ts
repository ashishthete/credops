import { randomUUID } from 'node:crypto'
import {
  HOST_ROLES,
  MAX_NOTES,
  OS_ICONS,
  type HostInput,
  type HostMeta,
  type HostPatch,
  type Membership,
} from '../../shared/inventory'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { VaultService } from '../vault/vault-service'
import { checkAddress, checkEnvVars, checkKeepalive, checkLabel, checkPort, checkTags, hostMeta, hostMetas, hostRow } from './rows'

const labelOf = (db: Db, id: string): string => hostRow(db, id).label

/**
 * The label path of an explicit jump chain that leads from `jumpHostId` back to `hostId`
 * (`[host, jump, ..., host]`), or null when following `jump_host_id` links never reaches it.
 * Shared by HostStore and the ssh-config importer.
 */
export function findJumpLoop(db: Db, hostId: string, jumpHostId: string): string[] | null {
  const path = [labelOf(db, hostId)]
  const seen = new Set<string>()
  const next = db.prepare('SELECT jump_host_id FROM hosts WHERE id = ?')
  let cur: string | null = jumpHostId
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    path.push(labelOf(db, cur))
    if (cur === hostId) return path
    cur = (next.get(cur) as { jump_host_id: string | null }).jump_host_id
  }
  return null
}

const exists = (db: Db, table: string, id: string): boolean => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined

/** Hosts: connection facts plus vault links and environment memberships. Every write is audited without values. */
export class HostStore {
  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
  ) {}

  /** Works while locked: labels and addresses are not secret. */
  list(): HostMeta[] {
    return hostMetas(this.db)
  }

  create(input: HostInput, opts: { auditDetails?: Record<string, unknown> } = {}): HostMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => this.insertInTx(input))
    return this.auditCreated(id, opts.auditDetails)
  }

  /** Appends the `host.create` event for a committed `insertInTx` row and returns its meta. */
  auditCreated(id: string, auditDetails?: Record<string, unknown>): HostMeta {
    const meta = hostMeta(this.db, id)
    this.audit.append({
      action: 'host.create',
      outcome: 'success',
      targetType: 'host',
      targetId: id,
      targetLabel: meta.label,
      details: { vaults: meta.vaultIds.length, environments: meta.environments.length, ...auditDetails },
    })
    return meta
  }

  /**
   * Validates and writes a host with its links; no transaction and no audit, so a caller (the ssh
   * importer) can batch several inside its own `inTransaction` and append the audit rows after commit.
   */
  insertInTx(input: HostInput, id: string = randomUUID()): string {
    const label = this.uniqueLabel(checkLabel(input.label))
    const address = checkAddress(input.address)
    const regionId = this.checkRegion(input.regionId)
    const port = input.port == null ? null : checkPort(input.port)
    const identityId = this.checkIdentity(input.identityId)
    const jumpHostId = input.jumpHostId == null ? null : this.checkJump(input.jumpHostId)
    const tags = checkTags(input.tags ?? [])
    const osIcon = this.checkIcon(input.osIcon ?? 'linux')
    const notes = this.checkNotes(input.notes ?? '')
    const keepaliveSec = input.keepaliveSec == null ? null : checkKeepalive(input.keepaliveSec)
    const envVars = checkEnvVars(input.envVars ?? {})
    const vaultIds = this.checkVaults(input.vaultIds ?? [])
    const memberships = this.checkMemberships(input.environments ?? [])
    const ts = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO hosts(id, label, address, region_id, port, identity_id, jump_host_id, tags, os_icon, notes, keepalive_sec, env_vars,
          created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, label, address, regionId, port, identityId, jumpHostId, JSON.stringify(tags), osIcon, notes, keepaliveSec, envVars, ts, ts)
    for (const vaultId of vaultIds) {
      this.db.prepare('INSERT INTO host_vaults(host_id, vault_id) VALUES (?,?)').run(id, vaultId)
    }
    for (const m of memberships) {
      this.db
        .prepare('INSERT INTO environment_hosts(environment_id, host_id, role) VALUES (?,?,?)')
        .run(m.environmentId, id, m.role)
    }
    return id
  }

  /** `undefined` keeps a field; `null` clears port, identityId and jumpHostId so they inherit. */
  update(id: string, patch: HostPatch): HostMeta {
    this.vault.assertUnlocked()
    const next = inTransaction(this.db, () => this.updateInTx(id, patch))
    if (next === null) return hostMeta(this.db, id)
    this.audit.append({
      action: 'host.update',
      outcome: 'success',
      targetType: 'host',
      targetId: id,
      targetLabel: next.label,
      details: { fields: next.fields },
    })
    return hostMeta(this.db, id)
  }

  /** update() without the transaction, the unlock check or the audit; null when nothing changed. */
  updateInTx(id: string, patch: HostPatch): { label: string; fields: string[] } | null {
    const before = hostRow(this.db, id)
    const label = patch.label === undefined ? before.label : this.uniqueLabel(checkLabel(patch.label), id)
    const address = patch.address === undefined ? before.address : checkAddress(patch.address)
    const regionId = patch.regionId === undefined ? before.region_id : this.checkRegion(patch.regionId)
    const port = patch.port === undefined ? before.port : patch.port === null ? null : checkPort(patch.port)
    const identityId = patch.identityId === undefined ? before.identity_id : this.checkIdentity(patch.identityId)
    const jumpHostId =
      patch.jumpHostId === undefined ? before.jump_host_id : patch.jumpHostId === null ? null : this.checkJump(patch.jumpHostId, id)
    const tags = patch.tags === undefined ? (JSON.parse(before.tags) as string[]) : checkTags(patch.tags)
    const osIcon = patch.osIcon === undefined ? before.os_icon : this.checkIcon(patch.osIcon)
    const notes = patch.notes === undefined ? before.notes : this.checkNotes(patch.notes)
    const keepaliveSec =
      patch.keepaliveSec === undefined
        ? before.keepalive_sec
        : patch.keepaliveSec === null
          ? null
          : checkKeepalive(patch.keepaliveSec)
    const envVars = patch.envVars === undefined ? before.env_vars : checkEnvVars(patch.envVars)
    const tagsJson = JSON.stringify(tags)
    const fields = [
      label !== before.label && 'label',
      address !== before.address && 'address',
      regionId !== before.region_id && 'regionId',
      port !== before.port && 'port',
      identityId !== before.identity_id && 'identityId',
      jumpHostId !== before.jump_host_id && 'jumpHostId',
      tagsJson !== before.tags && 'tags',
      osIcon !== before.os_icon && 'osIcon',
      notes !== before.notes && 'notes',
      keepaliveSec !== before.keepalive_sec && 'keepaliveSec',
      envVars !== before.env_vars && 'envVars',
    ].filter((f): f is string => typeof f === 'string')
    if (fields.length === 0) return null
    this.db
      .prepare(
        `UPDATE hosts SET label = ?, address = ?, region_id = ?, port = ?, identity_id = ?, jump_host_id = ?, tags = ?,
          os_icon = ?, notes = ?, keepalive_sec = ?, env_vars = ?, updated_at = ? WHERE id = ?`,
      )
      .run(label, address, regionId, port, identityId, jumpHostId, tagsJson, osIcon, notes, keepaliveSec, envVars, new Date().toISOString(), id)
    return { label, fields }
  }

  /** Links the vaults the host doesn't have yet (never unlinks); no transaction and no audit. Returns the added ids. */
  addVaultsInTx(id: string, vaultIds: string[]): string[] {
    const before = hostMeta(this.db, id)
    const added = this.checkVaults(vaultIds).filter((v) => !before.vaultIds.includes(v))
    if (added.length === 0) return []
    for (const v of added) this.db.prepare('INSERT INTO host_vaults(host_id, vault_id) VALUES (?,?)').run(id, v)
    this.db.prepare('UPDATE hosts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    return added
  }

  /** Throws what `delete` would refuse with, so a caller can tear down what depends on the host first. */
  assertDeletable(id: string): void {
    this.vault.assertUnlocked()
    hostMeta(this.db, id)
    this.assertNotJumpHost(id)
  }

  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = hostMeta(this.db, id)
    inTransaction(this.db, () => {
      this.assertNotJumpHost(id)
      this.db.prepare('DELETE FROM hosts WHERE id = ?').run(id)
    })
    this.audit.append({
      action: 'host.delete',
      outcome: 'success',
      targetType: 'host',
      targetId: id,
      targetLabel: before.label,
      details: { environments: before.environments.length },
    })
  }

  private assertNotJumpHost(id: string): void {
    const user =
      (this.db.prepare('SELECT label FROM hosts WHERE jump_host_id = ? ORDER BY label COLLATE NOCASE LIMIT 1').get(id) as
        | { label: string }
        | undefined)?.label ??
      (this.db
        .prepare('SELECT name FROM environments WHERE default_jump_host_id = ? ORDER BY name COLLATE NOCASE LIMIT 1')
        .get(id) as { name: string } | undefined)?.name
    if (user !== undefined) throw new Error(`host is the jump host for ${user}`)
  }

  /** Replaces the host's vault set. */
  setVaults(id: string, vaultIds: string[]): HostMeta {
    this.vault.assertUnlocked()
    const before = hostMeta(this.db, id)
    const wanted = this.checkVaults(vaultIds)
    const added = wanted.filter((v) => !before.vaultIds.includes(v)).sort()
    const removed = before.vaultIds.filter((v) => !wanted.includes(v)).sort()
    if (added.length === 0 && removed.length === 0) return before
    inTransaction(this.db, () => {
      for (const v of removed) this.db.prepare('DELETE FROM host_vaults WHERE host_id = ? AND vault_id = ?').run(id, v)
      for (const v of added) this.db.prepare('INSERT INTO host_vaults(host_id, vault_id) VALUES (?,?)').run(id, v)
      this.db.prepare('UPDATE hosts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    })
    this.audit.append({
      action: 'host.vaults',
      outcome: 'success',
      targetType: 'host',
      targetId: id,
      targetLabel: before.label,
      details: { added, removed },
    })
    return hostMeta(this.db, id)
  }

  private uniqueLabel(label: string, selfId = ''): string {
    // The column is COLLATE NOCASE, so = compares case-insensitively.
    if (this.db.prepare('SELECT 1 FROM hosts WHERE label = ? AND id <> ?').get(label, selfId)) {
      throw new Error('a host with that label already exists')
    }
    return label
  }

  private checkRegion(id: string | null | undefined): string {
    if (typeof id !== 'string' || id === '') throw new Error('a host needs a region')
    if (!exists(this.db, 'regions', id)) throw new Error('region not found')
    return id
  }

  private checkIdentity(id: string | null | undefined): string | null {
    if (id == null) return null
    if (!exists(this.db, 'identities', id)) throw new Error('identity not found')
    return id
  }

  /** `selfId` is the host being updated; a new host can't be part of a loop yet. */
  private checkJump(jumpHostId: string, selfId?: string): string {
    if (jumpHostId === selfId) throw new Error("a host can't be its own jump host")
    if (!exists(this.db, 'hosts', jumpHostId)) throw new Error('jump host not found')
    if (selfId !== undefined) {
      const loop = findJumpLoop(this.db, selfId, jumpHostId)
      if (loop) throw new Error(`jump host loop: ${loop.join(' → ')}`)
    }
    return jumpHostId
  }

  private checkIcon(icon: string): HostMeta['osIcon'] {
    if (!(OS_ICONS as readonly string[]).includes(icon)) throw new Error('os icon is not allowed')
    return icon as HostMeta['osIcon']
  }

  private checkNotes(notes: string): string {
    if (typeof notes !== 'string' || notes.length > MAX_NOTES) throw new Error(`notes must be at most ${MAX_NOTES} characters`)
    return notes
  }

  private checkVaults(ids: string[]): string[] {
    const unique = [...new Set(ids)]
    for (const v of unique) if (!exists(this.db, 'vaults', v)) throw new Error('vault not found')
    return unique
  }

  private checkMemberships(list: Membership[]): Membership[] {
    const seen = new Set<string>()
    for (const m of list) {
      if (!(HOST_ROLES as readonly string[]).includes(m.role)) throw new Error('host role is not allowed')
      if (!exists(this.db, 'environments', m.environmentId)) throw new Error('environment not found')
      if (seen.has(m.environmentId)) throw new Error('a host can join an environment only once')
      seen.add(m.environmentId)
    }
    return list
  }
}
