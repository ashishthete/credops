import { createHash } from 'node:crypto'
import { canonicalJson, GENESIS_HASH } from '../../src/main/audit/audit-log'
import { redact } from '../../src/main/security/redact'
import type {
  HubActor,
  HubAuditAction,
  HubAuditEvent,
  HubAuditFilter,
  HubRole,
} from '../../src/shared/hub'
import type { HubDb } from './db'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')

interface Row {
  id: number
  ts: string
  actor_oid: string | null
  actor_upn: string | null
  actor_name: string | null
  actor_role: string | null
  via_group: string | null
  action: string
  target_type: string | null
  target_id: string | null
  target_label: string | null
  outcome: string
  details: string
  prev_hash: string
  hash: string
}

export interface HubAuditInput {
  action: HubAuditAction
  outcome: HubAuditEvent['outcome']
  actor: HubActor | null
  viaGroup?: string | null
  targetType?: string | null
  targetId?: string | null
  targetLabel?: string | null
  details?: Record<string, unknown>
}

export type HubChainVerification =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAtId: number; reason: 'hash-mismatch' | 'prev-link-mismatch' }

export interface HubAuditOptions {
  now?: () => Date
  knownSecrets?: () => readonly string[]
}

function toEvent(r: Row, tolerant = false): HubAuditEvent {
  let details: Record<string, unknown>
  try {
    details = JSON.parse(r.details) as Record<string, unknown>
  } catch (err) {
    if (!tolerant) throw err
    // Never return the raw text: it may hold secrets that were never redacted.
    details = { _corrupt: true, bytes: r.details.length }
  }
  return {
    id: r.id,
    ts: r.ts,
    actor:
      r.actor_oid === null
        ? null
        : {
            oid: r.actor_oid,
            upn: r.actor_upn ?? '',
            name: r.actor_name ?? '',
            role: r.actor_role as HubRole | null,
          },
    viaGroup: r.via_group,
    action: r.action as HubAuditAction,
    targetType: r.target_type,
    targetId: r.target_id,
    targetLabel: r.target_label,
    outcome: r.outcome as HubAuditEvent['outcome'],
    details,
    prevHash: r.prev_hash,
    hash: r.hash,
  }
}

function computeHash(e: Omit<HubAuditEvent, 'id' | 'hash'>): string {
  return sha256hex(e.prevHash + canonicalJson(e))
}

export class HubAudit {
  private readonly now: () => Date
  private readonly knownSecrets: () => readonly string[]

  constructor(
    private readonly db: HubDb,
    opts: HubAuditOptions = {},
  ) {
    this.now = opts.now ?? ((): Date => new Date())
    this.knownSecrets = opts.knownSecrets ?? ((): readonly string[] => [])
  }

  append(input: HubAuditInput): HubAuditEvent {
    const secrets = this.knownSecrets()
    const detailsJson = JSON.stringify(redact(input.details ?? {}, secrets), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    const details = JSON.parse(detailsJson) as Record<string, unknown>
    const clean = (v: string | null | undefined): string | null => (v == null ? null : redact(v, secrets))

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const last = this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as
        | { hash: string }
        | undefined
      const a = input.actor
      const body: Omit<HubAuditEvent, 'id' | 'hash'> = {
        ts: this.now().toISOString(),
        actor: a ? { oid: clean(a.oid) ?? '', upn: clean(a.upn) ?? '', name: clean(a.name) ?? '', role: a.role } : null,
        viaGroup: clean(input.viaGroup),
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: clean(input.targetId),
        targetLabel: clean(input.targetLabel),
        outcome: input.outcome,
        details,
        prevHash: last?.hash ?? GENESIS_HASH,
      }
      const hash = computeHash(body)
      const res = this.db
        .prepare(
          `INSERT INTO audit(ts, actor_oid, actor_upn, actor_name, actor_role, via_group, action, target_type,
             target_id, target_label, outcome, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          body.ts,
          body.actor?.oid ?? null,
          body.actor?.upn ?? null,
          body.actor?.name ?? null,
          body.actor?.role ?? null,
          body.viaGroup,
          body.action,
          body.targetType,
          body.targetId,
          body.targetLabel,
          body.outcome,
          detailsJson,
          body.prevHash,
          hash,
        )
      this.db.exec('COMMIT')
      return { id: Number(res.lastInsertRowid), ...body, hash }
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw err
    }
  }

  list(filter: HubAuditFilter = {}): HubAuditEvent[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.actions?.length) {
      where.push(`action IN (${filter.actions.map(() => '?').join(',')})`)
      params.push(...filter.actions)
    }
    if (filter.outcome) {
      where.push('outcome = ?')
      params.push(filter.outcome)
    }
    if (filter.actorOid) {
      where.push('actor_oid = ?')
      params.push(filter.actorOid)
    }
    if (filter.from) {
      where.push('ts >= ?')
      params.push(filter.from)
    }
    if (filter.to) {
      where.push('ts <= ?')
      params.push(filter.to)
    }
    if (filter.beforeId !== undefined) {
      where.push('id < ?')
      params.push(filter.beforeId)
    }
    const requested = Number.isFinite(filter.limit) ? Math.trunc(filter.limit as number) : DEFAULT_LIMIT
    const limit = Math.min(MAX_LIMIT, Math.max(1, requested))
    const sql = `SELECT * FROM audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as Row[]
    return rows.map((r) => toEvent(r, true))
  }

  verify(): HubChainVerification {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id ASC').all() as unknown as Row[]
    let prev = GENESIS_HASH
    for (const r of rows) {
      let parsed: HubAuditEvent
      try {
        parsed = toEvent(r)
      } catch {
        return { ok: false, count: rows.length, brokenAtId: r.id, reason: 'hash-mismatch' }
      }
      const { id, hash, ...body } = parsed
      if (body.prevHash !== prev) {
        return { ok: false, count: rows.length, brokenAtId: id, reason: 'prev-link-mismatch' }
      }
      if (computeHash(body) !== hash) {
        return { ok: false, count: rows.length, brokenAtId: id, reason: 'hash-mismatch' }
      }
      prev = hash
    }
    return { ok: true, count: rows.length }
  }
}
