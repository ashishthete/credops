import { createHash } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import type {
  AuditAction,
  AuditEvent,
  AuditFilter,
  AuditInput,
  AuditOutcome,
  ChainVerification,
} from '../../shared/audit'
import type { Db } from '../db/connection'
import { redact } from '../security/redact'

export const GENESIS_HASH = '0'.repeat(64)

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/** JSON with object keys sorted recursively (arrays keep their order). */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v))
}

const bigintAsString = (_key: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

interface Row {
  id: number
  ts: string
  actor_os_user: string
  actor_machine: string
  action: string
  target_type: string | null
  target_id: string | null
  target_label: string | null
  outcome: string
  details: string
  prev_hash: string
  hash: string
}

function parseDetails(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>
}

function toEvent(r: Row, tolerant = false): AuditEvent {
  let details: Record<string, unknown>
  try {
    details = parseDetails(r.details)
  } catch (err) {
    if (!tolerant) throw err
    details = { _corrupt: r.details }
  }
  return {
    id: r.id,
    ts: r.ts,
    actorOsUser: r.actor_os_user,
    actorMachine: r.actor_machine,
    action: r.action as AuditAction,
    targetType: r.target_type,
    targetId: r.target_id,
    targetLabel: r.target_label,
    outcome: r.outcome as AuditOutcome,
    details,
    prevHash: r.prev_hash,
    hash: r.hash,
  }
}

function computeHash(e: Omit<AuditEvent, 'id' | 'hash'>): string {
  return sha256hex(
    e.prevHash +
      canonicalJson({
        ts: e.ts,
        actorOsUser: e.actorOsUser,
        actorMachine: e.actorMachine,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        targetLabel: e.targetLabel,
        outcome: e.outcome,
        details: e.details,
        prevHash: e.prevHash,
      }),
  )
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')

export interface AuditLogOptions {
  actor?: { osUser: string; machine: string }
  now?: () => Date
  knownSecrets?: () => readonly string[]
}

export class AuditLog {
  private readonly actor: { osUser: string; machine: string }
  private readonly now: () => Date
  private readonly knownSecrets: () => readonly string[]

  constructor(
    private readonly db: Db,
    opts: AuditLogOptions = {},
  ) {
    this.actor = opts.actor ?? { osUser: userInfo().username, machine: hostname() }
    this.now = opts.now ?? ((): Date => new Date())
    this.knownSecrets = opts.knownSecrets ?? ((): readonly string[] => [])
  }

  append(input: AuditInput): AuditEvent {
    // Round-trip so the hashed value is exactly what is stored and re-parsed.
    const detailsJson = JSON.stringify(redact(input.details ?? {}, this.knownSecrets()), bigintAsString)
    const details = JSON.parse(detailsJson) as Record<string, unknown>

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const last = this.db.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').get() as
        | { hash: string }
        | undefined
      const body: Omit<AuditEvent, 'id' | 'hash'> = {
        ts: this.now().toISOString(),
        actorOsUser: this.actor.osUser,
        actorMachine: this.actor.machine,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        outcome: input.outcome,
        details,
        prevHash: last?.hash ?? GENESIS_HASH,
      }
      const hash = computeHash(body)
      const res = this.db
        .prepare(
          `INSERT INTO audit_events(ts, actor_os_user, actor_machine, action, target_type, target_id,
             target_label, outcome, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          body.ts,
          body.actorOsUser,
          body.actorMachine,
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

  list(filter: AuditFilter = {}): AuditEvent[] {
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
    if (filter.actor) {
      where.push('actor_os_user = ?')
      params.push(filter.actor)
    }
    if (filter.targetType) {
      where.push('target_type = ?')
      params.push(filter.targetType)
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
    if (filter.text) {
      const like = `%${escapeLike(filter.text)}%`
      const cols = ['action', 'target_label', 'target_id', 'actor_os_user', 'actor_machine']
      where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
      params.push(...cols.map(() => like))
    }
    const requested = Number.isFinite(filter.limit) ? Math.trunc(filter.limit as number) : DEFAULT_LIMIT
    const limit = Math.min(MAX_LIMIT, Math.max(1, requested))
    const sql = `SELECT * FROM audit_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as Row[]
    return rows.map((r) => toEvent(r, true))
  }

  verifyChain(): ChainVerification {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY id ASC').all() as unknown as Row[]
    let prev = GENESIS_HASH
    for (const r of rows) {
      let parsed: AuditEvent
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
