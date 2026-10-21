import { randomUUID } from 'node:crypto'
import { DeployError } from '../../shared/deploy-error'
import { MAX_RUNBOOKS, validateRunbook, type Runbook, type RunbookInput } from '../../shared/runbooks'
import type { Actor } from '../../shared/deploy'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'

export interface RunbookStoreDeps {
  db: Db
  audit: AuditLog
  vault: { assertUnlocked(): void }
  now?: () => Date
  ids?: () => string
}

interface RunbookRow {
  id: string
  environment_id: string
  name: string
  description: string
  definition: string
  created_at: string
  updated_at: string
}

type Definition = Pick<Runbook, 'targetServiceIds' | 'items' | 'params' | 'lock' | 'notify'>

/**
 * An environment's runbooks. Every write is validated like a step and audited by name and counts only
 * (never a script, a param or a service). `actor` is accepted for the caller's wiring; the audit log stamps its own.
 */
export class RunbookStore {
  /** Set by the wiring: called after every committed mutation, so open pages refetch. */
  onChanged?: (environmentId: string) => void

  private readonly db: Db
  private readonly audit: AuditLog
  private readonly vault: { assertUnlocked(): void }
  private readonly now: () => Date
  private readonly ids: () => string

  constructor(deps: RunbookStoreDeps) {
    this.db = deps.db
    this.audit = deps.audit
    this.vault = deps.vault
    this.now = deps.now ?? (() => new Date())
    this.ids = deps.ids ?? randomUUID
  }

  list(environmentId: string): Runbook[] {
    const rows = this.db.prepare('SELECT * FROM runbooks WHERE environment_id = ? ORDER BY name COLLATE NOCASE, id').all(environmentId) as unknown as RunbookRow[]
    return rows.map(toRunbook)
  }

  get(id: string): Runbook {
    const row = this.db.prepare('SELECT * FROM runbooks WHERE id = ?').get(id) as RunbookRow | undefined
    if (!row) throw new Error('runbook not found')
    return toRunbook(row)
  }

  create(input: RunbookInput, _actor?: Actor): Runbook {
    this.vault.assertUnlocked()
    const v = this.validate(input)
    const id = this.ids()
    inTransaction(this.db, () => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM runbooks').get() as { n: number }).n
      if (n >= MAX_RUNBOOKS) throw new DeployError('VALIDATION', `too many runbooks (${MAX_RUNBOOKS})`)
      this.assertUniqueName(v.environmentId, v.name, null)
      const ts = this.now().toISOString()
      this.db
        .prepare('INSERT INTO runbooks(id, environment_id, name, description, definition, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, v.environmentId, v.name, v.description, definitionOf(v), ts, ts)
    })
    const r = this.get(id)
    this.audit.append({ action: 'runbook.create', outcome: 'success', targetType: 'runbook', targetId: id, targetLabel: r.name, details: counts(r) })
    this.onChanged?.(r.environmentId)
    return r
  }

  /** The environment never changes. */
  update(id: string, input: RunbookInput, _actor?: Actor): Runbook {
    this.vault.assertUnlocked()
    const before = this.get(id)
    const v = this.validate({ ...input, environmentId: before.environmentId })
    inTransaction(this.db, () => {
      this.assertUniqueName(before.environmentId, v.name, id)
      this.db
        .prepare('UPDATE runbooks SET name = ?, description = ?, definition = ?, updated_at = ? WHERE id = ?')
        .run(v.name, v.description, definitionOf(v), this.now().toISOString(), id)
    })
    const r = this.get(id)
    this.audit.append({ action: 'runbook.update', outcome: 'success', targetType: 'runbook', targetId: id, targetLabel: r.name, details: counts(r) })
    this.onChanged?.(r.environmentId)
    return r
  }

  delete(id: string, _actor?: Actor): void {
    this.vault.assertUnlocked()
    const before = this.get(id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM runbooks WHERE id = ?').run(id))
    this.audit.append({ action: 'runbook.delete', outcome: 'success', targetType: 'runbook', targetId: id, targetLabel: before.name, details: counts(before) })
    this.onChanged?.(before.environmentId)
  }

  private validate(input: RunbookInput): RunbookInput {
    const env = typeof input?.environmentId === 'string' ? input.environmentId : ''
    if (!this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(env)) throw new Error('environment not found')
    const services = this.db.prepare("SELECT id, compose_service FROM services WHERE environment_id = ? AND kind = 'service'").all(env) as { id: string; compose_service: string }[]
    const secrets = this.db.prepare('SELECT id FROM secrets').all() as { id: string }[]
    return validateRunbook(input, {
      allowedSecretIds: new Set(secrets.map((s) => s.id)),
      serviceIds: services.map((s) => s.id),
      serviceNames: [...new Set(services.map((s) => s.compose_service))],
    })
  }

  private assertUniqueName(environmentId: string, name: string, selfId: string | null): void {
    const dup = this.db.prepare('SELECT id FROM runbooks WHERE environment_id = ? AND name = ? COLLATE NOCASE').get(environmentId, name) as { id: string } | undefined
    if (dup && dup.id !== selfId) throw new DeployError('VALIDATION', 'a runbook with that name already exists in this environment')
  }
}

const definitionOf = (v: RunbookInput): string =>
  JSON.stringify({ targetServiceIds: v.targetServiceIds, items: v.items, params: v.params, lock: v.lock, notify: v.notify } satisfies Definition)

/** Audit details: counts only. */
const counts = (r: Runbook): Record<string, unknown> => ({ items: r.items.length, params: r.params.length, services: r.targetServiceIds.length })

function toRunbook(r: RunbookRow): Runbook {
  const d = JSON.parse(r.definition) as Definition
  return {
    id: r.id,
    environmentId: r.environment_id,
    name: r.name,
    description: r.description,
    targetServiceIds: d.targetServiceIds,
    items: d.items,
    params: d.params,
    lock: d.lock,
    notify: d.notify,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
