import { HubHttpError } from '../errors'
import type { HubAudit } from '../audit'
import type { HubDb } from '../db'
import type { HubActor, HubSecretKind, HubSecretMeta } from '../../../src/shared/hub'
import { HUB_INTEGRATION_KINDS, MAX_SECRET_BYTES } from '../../../src/shared/hub'
import { inTransaction } from '../../../src/main/db/tx'
import type { KeyRing } from './keyring'

interface Row {
  id: string
  environment_id: string | null
  name: string
  kind: HubSecretKind
  value_enc: string
  updated_by: string
  updated_at: string
}

export interface SecretSetInput {
  id?: string
  environmentId: string | null
  name: string
  kind: HubSecretKind
  value: string
}

/** Integration kinds are keyed by a fixed name; only Teams hooks are per environment. */
const PER_ENVIRONMENT: ReadonlySet<HubSecretKind> = new Set(['env', 'become', 'teams_webhook'])

const aadOf = (id: string, environmentId: string | null, name: string): string => `hub-secret:v1:${id}:${environmentId ?? '*'}:${name}`

/**
 * Sealed storage for shared secrets. There is no read path for a value except `resolveForRun` and
 * `integration`, which are for the Hub's own runner and notifier.
 */
export class SecretStore {
  /** Values being written right now, so an error raised mid-write can still be redacted. */
  readonly inflight = new Set<string>()

  constructor(
    private readonly db: HubDb,
    private readonly ring: KeyRing,
    private readonly opts: { audit: HubAudit; now: () => Date; ids: () => string },
  ) {}

  set(input: SecretSetInput, actor: HubActor): void {
    const { kind, environmentId } = input
    const integration = HUB_INTEGRATION_KINDS.includes(kind)
    const name = integration ? kind : input.name
    if (PER_ENVIRONMENT.has(kind) && environmentId === null) throw new HubHttpError(400, 'bad_request', `invalid request: ${kind} secrets belong to an environment`)
    if (!PER_ENVIRONMENT.has(kind) && environmentId !== null) throw new HubHttpError(400, 'bad_request', `invalid request: ${kind} is a Hub-wide secret`)
    if (Buffer.byteLength(input.value, 'utf8') > MAX_SECRET_BYTES) throw new HubHttpError(400, 'bad_request', `invalid request: /value is larger than ${MAX_SECRET_BYTES} bytes`)
    if (input.value === '') throw new HubHttpError(400, 'bad_request', 'invalid request: /value is empty')
    this.inflight.add(input.value)
    try {
      const savedId = inTransaction(this.db, () => {
        if (environmentId !== null && !this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) {
          throw new HubHttpError(404, 'not_found', 'That environment is not published to this Hub')
        }
        const scope = environmentId ?? '*'
        const byName = this.db.prepare("SELECT * FROM hub_secrets WHERE IFNULL(environment_id,'*') = ? AND name = ?").get(scope, name) as Row | undefined
        // Integration secrets keep their row (and id) when replaced; env/become ids are the vault's.
        const id = integration ? (byName?.id ?? input.id ?? this.opts.ids()) : (input.id ?? this.opts.ids())
        const byId = this.db.prepare("SELECT * FROM hub_secrets WHERE id = ? AND IFNULL(environment_id,'*') = ?").get(id, scope) as Row | undefined
        if (byId && HUB_INTEGRATION_KINDS.includes(byId.kind) !== integration) {
          throw new HubHttpError(409, 'conflict', 'That secret id is already used by another secret')
        }
        if (byName && byName.id !== id) throw new HubHttpError(409, 'conflict', 'A secret with that name already exists')
        const enc = this.ring.seal(input.value, aadOf(id, environmentId, name))
        const ts = this.opts.now().toISOString()
        this.db
          .prepare(
            `INSERT INTO hub_secrets(id, environment_id, name, kind, value_enc, key_id, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(id, IFNULL(environment_id,'*')) DO UPDATE SET name = excluded.name, kind = excluded.kind,
               value_enc = excluded.value_enc, key_id = excluded.key_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          )
          .run(id, environmentId, name, kind, enc, this.ring.keyId, actor.upn, ts)
        return id
      })
      this.opts.audit.append({
        action: 'secret.set',
        outcome: 'success',
        actor,
        targetType: 'secret',
        targetId: savedId,
        targetLabel: name,
        details: { name, kind, environmentId },
      })
    } finally {
      this.inflight.delete(input.value)
    }
  }

  /** Names and timestamps only. */
  meta(environmentId?: string): HubSecretMeta[] {
    const rows = (
      environmentId === undefined
        ? this.db.prepare('SELECT * FROM hub_secrets ORDER BY name, id').all()
        : this.db.prepare('SELECT * FROM hub_secrets WHERE environment_id = ? OR environment_id IS NULL ORDER BY name, id').all(environmentId)
    ) as unknown as Row[]
    return rows.map((r) => ({ id: r.id, environmentId: r.environment_id, name: r.name, kind: r.kind, updatedBy: r.updated_by, updatedAt: r.updated_at }))
  }

  /** Removes one environment's copy (or the Hub-wide one when `environmentId` is null). */
  delete(id: string, environmentId: string | null, actor: HubActor): void {
    const scope = environmentId ?? '*'
    const r = inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM hub_secrets WHERE id = ? AND IFNULL(environment_id,'*') = ?").get(id, scope) as Row | undefined
      if (!row) throw new HubHttpError(404, 'not_found', 'Not found')
      this.db.prepare("DELETE FROM hub_secrets WHERE id = ? AND IFNULL(environment_id,'*') = ?").run(id, scope)
      return row
    })
    this.opts.audit.append({
      action: 'secret.delete',
      outcome: 'success',
      actor,
      targetType: 'secret',
      targetId: id,
      targetLabel: r.name,
      details: { name: r.name, kind: r.kind, environmentId: r.environment_id },
    })
  }

  private open(r: Row): string {
    try {
      return this.ring.open(r.value_enc, aadOf(r.id, r.environment_id, r.name))
    } catch {
      throw new Error(`secret ${r.id} could not be decrypted`)
    }
  }

  /** For the release adapter only. Unknown ids are omitted; a row that fails to open throws. */
  resolveForRun(environmentId: string, ids: string[]): Map<string, string> {
    const out = new Map<string, string>()
    const get = this.db.prepare('SELECT * FROM hub_secrets WHERE id = ? AND environment_id = ?')
    for (const id of ids) {
      const r = get.get(id, environmentId) as Row | undefined
      if (r) out.set(id, this.open(r))
    }
    return out
  }

  /** For the notifier only: the environment's own value, else the Hub-wide one. */
  integration(environmentId: string | null, kind: HubSecretKind): string | null {
    const r = this.db
      .prepare('SELECT * FROM hub_secrets WHERE kind = ? AND (environment_id = ? OR environment_id IS NULL) ORDER BY environment_id IS NULL LIMIT 1')
      .get(kind, environmentId) as Row | undefined
    return r ? this.open(r) : null
  }
}
