import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { MAX_LABEL } from '../../shared/vault'
import {
  BIND_ADDRESS,
  DEFAULT_TUNNEL_MAX_MINUTES,
  MAX_TUNNEL_MAX_MINUTES,
  MAX_BIND_ADDRESS,
  MAX_TUNNELS,
  isLoopback,
  type TunnelInput,
  type TunnelMeta,
  type TunnelPatch,
  type TunnelType,
} from '../../shared/tunnels'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { checkAddress, checkPort } from '../inventory/rows'
import { checkText } from '../util/checks'
import type { VaultService } from '../vault/vault-service'

interface TunnelRow {
  id: string
  label: string
  host_id: string
  environment_id: string | null
  type: TunnelType
  bind_address: string
  bind_port: number
  target_host: string | null
  target_port: number | null
  auto_start: number
  auto_reconnect: number
  max_minutes: number | null
  created_at: string
  updated_at: string
}

const meta = (r: TunnelRow): TunnelMeta => ({
  id: r.id,
  label: r.label,
  hostId: r.host_id,
  environmentId: r.environment_id,
  type: r.type,
  bindAddress: r.bind_address,
  bindPort: r.bind_port,
  targetHost: r.target_host,
  targetPort: r.target_port,
  autoStart: r.auto_start === 1,
  autoReconnect: r.auto_reconnect === 1,
  maxMinutes: r.max_minutes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** The fields a tunnel is made of, validated and with defaults applied. */
type Fields = Omit<TunnelMeta, 'id' | 'createdAt' | 'updatedAt'>

const FIELDS = [
  'label',
  'hostId',
  'environmentId',
  'type',
  'bindAddress',
  'bindPort',
  'targetHost',
  'targetPort',
  'autoStart',
  'autoReconnect',
  'maxMinutes',
] as const satisfies readonly (keyof Fields)[]

export interface TunnelStoreDeps {
  db: Db
  audit: AuditLog
  vault: VaultService
  now?: () => Date
  ids?: () => string
}

/** Saved tunnels. Every write is audited without addresses or target hosts; audit is appended after COMMIT. */
export class TunnelStore {
  /** Set by the manager: called after COMMIT (and before the audit row) with the removed id. */
  onRemoved?: (id: string) => void
  /** Set by the manager: called after COMMIT (and before the audit row) when an update changed a field. */
  onChanged?: (before: TunnelMeta, after: TunnelMeta) => void

  private readonly db: Db
  private readonly audit: AuditLog
  private readonly vault: VaultService
  private readonly now: () => Date
  private readonly ids: () => string

  constructor(deps: TunnelStoreDeps) {
    this.db = deps.db
    this.audit = deps.audit
    this.vault = deps.vault
    this.now = deps.now ?? (() => new Date())
    this.ids = deps.ids ?? randomUUID
  }

  /** Works while locked: labels and ports are not secret. */
  list(): TunnelMeta[] {
    const rows = this.db.prepare('SELECT * FROM tunnels ORDER BY label COLLATE NOCASE, id').all() as unknown as TunnelRow[]
    return rows.map(meta)
  }

  listForHost(hostId: string): TunnelMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM tunnels WHERE host_id = ? ORDER BY label COLLATE NOCASE, id')
      .all(hostId) as unknown as TunnelRow[]
    return rows.map(meta)
  }

  get(id: string): TunnelMeta {
    const row = this.db.prepare('SELECT * FROM tunnels WHERE id = ?').get(id) as TunnelRow | undefined
    if (!row) throw new Error('tunnel not found')
    return meta(row)
  }

  /** An existing tunnel with the same host, type, bind address, bind port and target, for de-duplicating on import. */
  findSame(input: TunnelInput): TunnelMeta | null {
    const same = this.list().find(
      (t) =>
        t.hostId === input.hostId &&
        t.type === input.type &&
        t.bindAddress === (input.bindAddress ?? '127.0.0.1') &&
        t.bindPort === input.bindPort &&
        t.targetHost === (input.targetHost ?? null) &&
        t.targetPort === (input.targetPort ?? null),
    )
    return same ?? null
  }

  create(input: TunnelInput): TunnelMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => this.insertInTx(input))
    return this.auditCreated(id)
  }

  /**
   * Validates and writes a tunnel; no transaction and no audit, so a caller (the ssh-config importer)
   * can batch several inside its own `inTransaction` and call `auditCreated` after commit.
   */
  insertInTx(input: TunnelInput, id: string = this.ids()): string {
    const f = this.validate({
      label: input.label,
      hostId: input.hostId,
      environmentId: input.environmentId ?? null,
      type: input.type,
      bindAddress: input.bindAddress ?? '127.0.0.1',
      bindPort: input.bindPort,
      targetHost: input.targetHost ?? null,
      targetPort: input.targetPort ?? null,
      autoStart: input.autoStart ?? false,
      autoReconnect: input.autoReconnect ?? true,
      maxMinutes: input.maxMinutes === undefined ? DEFAULT_TUNNEL_MAX_MINUTES : input.maxMinutes,
    })
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM tunnels').get() as { n: number }).n
    if (count >= MAX_TUNNELS) throw new Error(`too many tunnels (${MAX_TUNNELS})`)
    const ts = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO tunnels(id, label, host_id, environment_id, type, bind_address, bind_port, target_host, target_port,
          auto_start, auto_reconnect, max_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        f.label,
        f.hostId,
        f.environmentId,
        f.type,
        f.bindAddress,
        f.bindPort,
        f.targetHost,
        f.targetPort,
        f.autoStart ? 1 : 0,
        f.autoReconnect ? 1 : 0,
        f.maxMinutes,
        ts,
        ts,
      )
    return id
  }

  /** Appends the `tunnel.create` event for a committed `insertInTx` row and returns its meta. */
  auditCreated(id: string): TunnelMeta {
    const t = this.get(id)
    this.audit.append({
      action: 'tunnel.create',
      outcome: 'success',
      targetType: 'tunnel',
      targetId: id,
      targetLabel: t.label,
      details: { type: t.type, bindPort: t.bindPort, exposed: !isLoopback(t.bindAddress) },
    })
    return t
  }

  /** `undefined` keeps a field; `null` clears environmentId, targetHost and targetPort. */
  update(id: string, patch: TunnelPatch): TunnelMeta {
    this.vault.assertUnlocked()
    const before = this.get(id)
    const changed = inTransaction(this.db, () => this.updateInTx(id, patch))
    const after = this.get(id)
    if (changed === null) return after
    this.onChanged?.(before, after)
    this.audit.append({
      action: 'tunnel.update',
      outcome: 'success',
      targetType: 'tunnel',
      targetId: id,
      targetLabel: after.label,
      details: { fields: changed },
    })
    return after
  }

  /**
   * update() without the transaction, the unlock check, the audit or onChanged (so a running tunnel isn't
   * restarted); null when nothing changed.
   */
  updateInTx(id: string, patch: TunnelPatch): (keyof Fields)[] | null {
    const before = this.get(id)
    const merged: Fields = {
      label: patch.label ?? before.label,
      hostId: patch.hostId ?? before.hostId,
      environmentId: patch.environmentId === undefined ? before.environmentId : patch.environmentId,
      type: patch.type ?? before.type,
      bindAddress: patch.bindAddress ?? before.bindAddress,
      bindPort: patch.bindPort ?? before.bindPort,
      targetHost: patch.targetHost === undefined ? before.targetHost : patch.targetHost,
      targetPort: patch.targetPort === undefined ? before.targetPort : patch.targetPort,
      autoStart: patch.autoStart ?? before.autoStart,
      autoReconnect: patch.autoReconnect ?? before.autoReconnect,
      maxMinutes: patch.maxMinutes === undefined ? before.maxMinutes : patch.maxMinutes,
    }
    const f = this.validate(merged)
    const fields = FIELDS.filter((k) => f[k] !== before[k])
    if (fields.length === 0) return null
    this.db
      .prepare(
        `UPDATE tunnels SET label = ?, host_id = ?, environment_id = ?, type = ?, bind_address = ?, bind_port = ?,
          target_host = ?, target_port = ?, auto_start = ?, auto_reconnect = ?, max_minutes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        f.label,
        f.hostId,
        f.environmentId,
        f.type,
        f.bindAddress,
        f.bindPort,
        f.targetHost,
        f.targetPort,
        f.autoStart ? 1 : 0,
        f.autoReconnect ? 1 : 0,
        f.maxMinutes,
        this.now().toISOString(),
        id,
      )
    return fields
  }

  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = this.get(id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM tunnels WHERE id = ?').run(id))
    this.onRemoved?.(id)
    this.audit.append({
      action: 'tunnel.delete',
      outcome: 'success',
      targetType: 'tunnel',
      targetId: id,
      targetLabel: before.label,
      details: { type: before.type, bindPort: before.bindPort },
    })
  }

  /** Checks every rule on a fully merged tunnel. Messages name the rule, never the value. */
  private validate(f: Fields): Fields {
    const label = checkText(f.label, 'tunnel label', MAX_LABEL)
    if (!this.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(f.hostId)) throw new Error('host not found')
    if (f.environmentId !== null) {
      if (!this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(f.environmentId)) throw new Error('environment not found')
      // The same wording as resolveHost, which enforces this again at dial time.
      if (!this.db.prepare('SELECT 1 FROM environment_hosts WHERE environment_id = ? AND host_id = ?').get(f.environmentId, f.hostId)) {
        throw new Error('host is not in that environment')
      }
    }
    if (f.type !== 'L' && f.type !== 'R' && f.type !== 'D') throw new Error('tunnel type must be L, R or D')
    const bindAddress = typeof f.bindAddress === 'string' ? f.bindAddress.trim() : ''
    const lower = bindAddress.toLowerCase()
    if (
      bindAddress.length === 0 ||
      bindAddress.length > MAX_BIND_ADDRESS ||
      !BIND_ADDRESS.test(bindAddress) ||
      (lower !== 'localhost' && isIP(bindAddress) === 0)
    ) {
      throw new Error('bind address must be an IP address or localhost')
    }
    if (!Number.isInteger(f.bindPort) || f.bindPort < 0 || f.bindPort > 65535) throw new Error('bind port must be 0-65535')
    let targetHost: string | null = null
    let targetPort: number | null = null
    if (f.type === 'D') {
      if (f.targetHost !== null || f.targetPort !== null) throw new Error('a dynamic tunnel has no target')
    } else {
      if (f.targetHost === null) throw new Error('target host is required for L and R tunnels')
      targetHost = checkAddress(f.targetHost)
      targetPort = checkPort(f.targetPort as number)
    }
    if (f.maxMinutes !== null && !(Number.isInteger(f.maxMinutes) && f.maxMinutes >= 1 && f.maxMinutes <= MAX_TUNNEL_MAX_MINUTES)) {
      throw new Error(`time limit must be 1-${MAX_TUNNEL_MAX_MINUTES} minutes`)
    }
    return {
      label,
      hostId: f.hostId,
      environmentId: f.environmentId,
      type: f.type,
      bindAddress: lower === 'localhost' ? 'localhost' : bindAddress,
      bindPort: f.bindPort,
      targetHost,
      targetPort,
      autoStart: f.autoStart === true,
      autoReconnect: f.autoReconnect === true,
      maxMinutes: f.maxMinutes,
    }
  }
}
