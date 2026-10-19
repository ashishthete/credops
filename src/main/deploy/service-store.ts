import { randomUUID } from 'node:crypto'
import type { HealthFrom } from '../../shared/deploy'
import { MAX_DESCRIPTION, MAX_NAME, MAX_URL } from '../../shared/inventory'
import {
  COMPOSE_SERVICE,
  DB_DEFAULT_PORT,
  MAX_SERVICES,
  type AppServiceMeta,
  type DbEngine,
  type DbServiceMeta,
  type ServiceInput,
  type ServiceKind,
  type ServiceMeta,
  type ServicePatch,
} from '../../shared/services'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { checkAddress, checkPort } from '../inventory/rows'

export interface ServiceStoreDeps {
  db: Db
  audit: AuditLog
  vault: { assertUnlocked(): void }
  now?: () => Date
  ids?: () => string
}

interface ServiceRow {
  id: string
  environment_id: string
  name: string
  kind: ServiceKind
  position: number
  description: string
  deployment_id: string | null
  compose_service: string | null
  url: string | null
  url_check_from: HealthFrom | null
  last_deployed_commit: string | null
  last_release_id: string | null
  db_engine: DbEngine | null
  db_address: string | null
  db_port: number | null
  via_host_id: string | null
  local_port: number | null
  tunnel_id: string | null
  created_at: string
  updated_at: string
}

type AppFields = Pick<AppServiceMeta, 'name' | 'description' | 'deploymentId' | 'composeService' | 'url' | 'urlCheckFrom'>
type DbFields = Pick<DbServiceMeta, 'name' | 'description' | 'dbEngine' | 'dbAddress' | 'dbPort' | 'viaHostId' | 'localPort'>

/** The fields a caller may set, per kind; a field of the other kind is refused by name of the rule. */
const APP_FIELDS = ['name', 'description', 'deploymentId', 'composeService', 'url', 'urlCheckFrom'] as const satisfies readonly (keyof AppFields)[]
const DB_FIELDS = ['name', 'description', 'dbEngine', 'dbAddress', 'dbPort', 'viaHostId', 'localPort'] as const satisfies readonly (keyof DbFields)[]
const ENGINES = Object.keys(DB_DEFAULT_PORT) as DbEngine[]

const COMPOSE_MESSAGE = 'compose service must be letters, digits, dashes, dots or underscores'
const URL_MESSAGE = `url must be http(s) and at most ${MAX_URL} characters`
const FIXED_MESSAGE = 'a service cannot change its kind or environment'
const REORDER_MESSAGE = "ids must be exactly the environment's services"

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const has = (o: object, k: string): boolean => (o as Record<string, unknown>)[k] !== undefined

/**
 * Services: what runs from a checkout's compose file (kind `service`) and the databases reached through a tunnel
 * (kind `db`). Every write is audited by name, environment and kind only (never a host, address or URL), appended
 * after COMMIT.
 */
export class ServiceStore {
  /** Set by the wiring: called after every committed mutation, so open pages refetch. */
  onChanged?: (environmentId: string) => void

  private readonly db: Db
  private readonly audit: AuditLog
  private readonly vault: { assertUnlocked(): void }
  private readonly now: () => Date
  private readonly ids: () => string

  constructor(deps: ServiceStoreDeps) {
    this.db = deps.db
    this.audit = deps.audit
    this.vault = deps.vault
    this.now = deps.now ?? (() => new Date())
    this.ids = deps.ids ?? randomUUID
  }

  /** Works while locked. Ordered by environment, then position, then name. */
  list(environmentId?: string): ServiceMeta[] {
    const sql = `SELECT s.* FROM services s JOIN environments e ON e.id = s.environment_id
      ${environmentId === undefined ? '' : 'WHERE s.environment_id = ?'}
      ORDER BY e.name COLLATE NOCASE, s.environment_id, s.position, s.name COLLATE NOCASE, s.id`
    const rows = (environmentId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(environmentId)) as unknown as ServiceRow[]
    return rows.map((r) => this.meta(r))
  }

  get(id: string): ServiceMeta {
    const row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow | undefined
    if (!row) throw new Error('service not found')
    return this.meta(row)
  }

  /** The checkout's services in position order. */
  forCheckout(deploymentId: string): AppServiceMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM services WHERE deployment_id = ? AND kind = 'service' ORDER BY position, name COLLATE NOCASE, id")
      .all(deploymentId) as unknown as ServiceRow[]
    return rows.map((r) => this.meta(r) as AppServiceMeta)
  }

  create(input: ServiceInput): ServiceMeta {
    this.vault.assertUnlocked()
    const kind = input.kind
    if (kind !== 'service' && kind !== 'db') throw new Error('kind must be service or db')
    this.refuseForeign(kind, input)
    const id = inTransaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(input.environmentId)) throw new Error('environment not found')
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM services').get() as { n: number }).n
      if (n >= MAX_SERVICES) throw new Error(`too many services (${MAX_SERVICES})`)
      const id = this.ids()
      const ts = this.now().toISOString()
      const position = this.nextPosition(input.environmentId)
      if (input.kind === 'service') {
        const name = this.checkName(input.name, input.environmentId, null)
        const f = this.validateApp(
          {
            name,
            description: input.description ?? '',
            deploymentId: input.deploymentId,
            composeService: input.composeService ?? (COMPOSE_SERVICE.test(name) ? name : ''),
            url: input.url ?? null,
            urlCheckFrom: input.urlCheckFrom ?? 'mac',
          },
          input.environmentId,
          null,
        )
        this.db
          .prepare(
            `INSERT INTO services(id, environment_id, name, kind, position, description, deployment_id, compose_service, url,
              url_check_from, created_at, updated_at) VALUES (?,?,?,'service',?,?,?,?,?,?,?,?)`,
          )
          .run(id, input.environmentId, f.name, position, f.description, f.deploymentId, f.composeService, f.url, f.urlCheckFrom, ts, ts)
      } else {
        const name = this.checkName(input.name, input.environmentId, null)
        const engine = this.checkEngine(input.dbEngine)
        const f = this.validateDb({
          name,
          description: input.description ?? '',
          dbEngine: engine,
          dbAddress: input.dbAddress,
          dbPort: input.dbPort ?? (DB_DEFAULT_PORT[engine] as number),
          viaHostId: input.viaHostId ?? null,
          localPort: input.localPort ?? null,
        })
        this.db
          .prepare(
            `INSERT INTO services(id, environment_id, name, kind, position, description, db_engine, db_address, db_port,
              via_host_id, local_port, created_at, updated_at) VALUES (?,?,?,'db',?,?,?,?,?,?,?,?,?)`,
          )
          .run(id, input.environmentId, f.name, position, f.description, f.dbEngine, f.dbAddress, f.dbPort, f.viaHostId, f.localPort, ts, ts)
      }
      return id
    })
    const s = this.get(id)
    this.audit.append({
      action: 'service.create',
      outcome: 'success',
      targetType: 'service',
      targetId: id,
      targetLabel: s.name,
      details: this.labels(s),
    })
    this.onChanged?.(s.environmentId)
    return s
  }

  /** `undefined` keeps a field; `null` clears the nullable ones. The kind and environment never change. */
  update(id: string, patch: ServicePatch): ServiceMeta {
    this.vault.assertUnlocked()
    const before = this.get(id)
    const raw = patch as Record<string, unknown>
    if ((has(raw, 'kind') && raw.kind !== before.kind) || (has(raw, 'environmentId') && raw.environmentId !== before.environmentId)) {
      throw new Error(FIXED_MESSAGE)
    }
    this.refuseForeign(before.kind, raw)
    const fields = inTransaction(this.db, () => {
      const pick = <T extends ServiceMeta, K extends keyof T>(b: T, k: K): T[K] => (has(raw, k as string) ? (raw[k as string] as T[K]) : b[k])
      const name = has(raw, 'name') ? this.checkName(raw.name as string, before.environmentId, id) : before.name
      let changed: string[]
      if (before.kind === 'service') {
        const f = this.validateApp(
          {
            name,
            description: pick(before, 'description'),
            deploymentId: pick(before, 'deploymentId'),
            composeService: pick(before, 'composeService'),
            url: pick(before, 'url'),
            urlCheckFrom: pick(before, 'urlCheckFrom'),
          },
          before.environmentId,
          id,
        )
        changed = APP_FIELDS.filter((k) => !same(f[k], before[k]))
        if (changed.length === 0) return changed
        this.db
          .prepare('UPDATE services SET name = ?, description = ?, deployment_id = ?, compose_service = ?, url = ?, url_check_from = ?, updated_at = ? WHERE id = ?')
          .run(f.name, f.description, f.deploymentId, f.composeService, f.url, f.urlCheckFrom, this.now().toISOString(), id)
      } else {
        const f = this.validateDb({
          name,
          description: pick(before, 'description'),
          dbEngine: this.checkEngine(pick(before, 'dbEngine')),
          dbAddress: pick(before, 'dbAddress'),
          dbPort: pick(before, 'dbPort'),
          viaHostId: pick(before, 'viaHostId'),
          localPort: pick(before, 'localPort'),
        })
        changed = DB_FIELDS.filter((k) => !same(f[k], before[k]))
        if (changed.length === 0) return changed
        this.db
          .prepare('UPDATE services SET name = ?, description = ?, db_engine = ?, db_address = ?, db_port = ?, via_host_id = ?, local_port = ?, updated_at = ? WHERE id = ?')
          .run(f.name, f.description, f.dbEngine, f.dbAddress, f.dbPort, f.viaHostId, f.localPort, this.now().toISOString(), id)
      }
      return changed
    })
    const after = this.get(id)
    if (fields.length === 0) return after
    this.audit.append({
      action: 'service.update',
      outcome: 'success',
      targetType: 'service',
      targetId: id,
      targetLabel: after.name,
      details: { ...this.labels(after), fields },
    })
    this.onChanged?.(after.environmentId)
    return after
  }

  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = this.get(id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM services WHERE id = ?').run(id))
    this.audit.append({
      action: 'service.delete',
      outcome: 'success',
      targetType: 'service',
      targetId: id,
      targetLabel: before.name,
      details: this.labels(before),
    })
    this.onChanged?.(before.environmentId)
  }

  /** Renumbers `position` 0..n-1 in the given order. `ids` must be exactly the environment's services. */
  reorder(environmentId: string, ids: string[]): void {
    this.vault.assertUnlocked()
    const moved = inTransaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) throw new Error('environment not found')
      const have = this.db.prepare('SELECT id, position FROM services WHERE environment_id = ?').all(environmentId) as { id: string; position: number }[]
      const known = new Set(have.map((r) => r.id))
      if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((i) => known.has(i))) {
        throw new Error(REORDER_MESSAGE)
      }
      const pos = new Map(have.map((r) => [r.id, r.position]))
      if (ids.every((i, n) => pos.get(i) === n)) return false
      const upd = this.db.prepare('UPDATE services SET position = ?, updated_at = ? WHERE id = ?')
      const ts = this.now().toISOString()
      ids.forEach((i, n) => upd.run(n, ts, i))
      return true
    })
    if (!moved) return
    const environment = this.envName(environmentId)
    this.audit.append({
      action: 'service.update',
      outcome: 'success',
      targetType: 'environment',
      targetId: environmentId,
      targetLabel: environment,
      details: { environment, fields: ['position'] },
    })
    this.onChanged?.(environmentId)
  }

  /** Links a db service to the tunnel that backs it. Not audited: the tunnel's own create is. */
  setTunnel(id: string, tunnelId: string | null, localPort: number | null): DbServiceMeta {
    this.vault.assertUnlocked()
    const before = this.get(id)
    if (before.kind !== 'db') throw new Error('that field does not apply to a service service')
    inTransaction(this.db, () => {
      if (tunnelId !== null && !this.db.prepare('SELECT 1 FROM tunnels WHERE id = ?').get(tunnelId)) throw new Error('tunnel not found')
      const port = localPort === null ? null : checkPort(localPort)
      this.db.prepare('UPDATE services SET tunnel_id = ?, local_port = ?, updated_at = ? WHERE id = ?').run(tunnelId, port, this.now().toISOString(), id)
    })
    this.onChanged?.(before.environmentId)
    return this.get(id) as DbServiceMeta
  }

  /** Release bookkeeping: what each service last shipped. Not audited (the release is); db services are skipped. */
  recordDeployed(entries: { serviceId: string; commit: string | null; releaseId: string | null }[]): void {
    if (entries.length === 0) return
    const envs = inTransaction(this.db, () => {
      const upd = this.db.prepare(
        "UPDATE services SET last_deployed_commit = ?, last_release_id = ?, updated_at = ? WHERE id = ? AND kind = 'service' RETURNING environment_id",
      )
      const ts = this.now().toISOString()
      const out = new Set<string>()
      for (const e of entries) {
        const row = upd.get(e.commit, e.releaseId, ts, e.serviceId) as { environment_id: string } | undefined
        if (row) out.add(row.environment_id)
      }
      return out
    })
    for (const env of envs) this.onChanged?.(env)
  }

  // ---- internals ----

  private meta(r: ServiceRow): ServiceMeta {
    const base = {
      id: r.id,
      environmentId: r.environment_id,
      name: r.name,
      position: r.position,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
    if (r.kind === 'service') {
      return {
        ...base,
        kind: 'service',
        deploymentId: r.deployment_id,
        composeService: r.compose_service as string,
        url: r.url,
        urlCheckFrom: r.url_check_from as HealthFrom,
        lastDeployedCommit: r.last_deployed_commit,
        lastReleaseId: r.last_release_id,
      }
    }
    return {
      ...base,
      kind: 'db',
      dbEngine: r.db_engine as DbEngine,
      dbAddress: r.db_address as string,
      dbPort: r.db_port as number,
      viaHostId: r.via_host_id,
      localPort: r.local_port,
      tunnelId: r.tunnel_id,
    }
  }

  private nextPosition(environmentId: string): number {
    const row = this.db.prepare('SELECT MAX(position) AS p FROM services WHERE environment_id = ?').get(environmentId) as { p: number | null }
    return row.p === null ? 0 : row.p + 1
  }

  private envName(environmentId: string): string {
    return (this.db.prepare('SELECT name FROM environments WHERE id = ?').get(environmentId) as { name: string } | undefined)?.name ?? ''
  }

  /** Audit details name the environment and kind only: host ids and labels never reach the audit log. */
  private labels(s: ServiceMeta): { environment: string; kind: ServiceKind } {
    return { environment: this.envName(s.environmentId), kind: s.kind }
  }

  private refuseForeign(kind: ServiceKind, raw: object): void {
    const foreign: readonly string[] = kind === 'service' ? DB_FIELDS : APP_FIELDS
    const own: readonly string[] = kind === 'service' ? APP_FIELDS : DB_FIELDS
    for (const k of foreign) if (!own.includes(k) && has(raw, k)) throw new Error(`that field does not apply to a ${kind} service`)
  }

  private checkName(raw: string, environmentId: string, selfId: string | null): string {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name === '') throw new Error('service name is required')
    if (name.length > MAX_NAME) throw new Error(`service name must be at most ${MAX_NAME} characters`)
    const dup = this.db
      .prepare('SELECT id FROM services WHERE environment_id = ? AND name = ? COLLATE NOCASE')
      .get(environmentId, name) as { id: string } | undefined
    if (dup && dup.id !== selfId) throw new Error(`a service named ${name} already exists in this environment`)
    return name
  }

  private checkDescription(raw: string): string {
    if (typeof raw !== 'string' || raw.length > MAX_DESCRIPTION) throw new Error(`description must be at most ${MAX_DESCRIPTION} characters`)
    return raw.trim()
  }

  private checkEngine(raw: DbEngine): DbEngine {
    if (!ENGINES.includes(raw)) throw new Error('db engine must be postgres, mysql, mongodb, redis or other')
    return raw
  }

  /** Checks every rule on a fully merged kind `service`. Messages name the rule, never the value. */
  private validateApp(f: AppFields, environmentId: string, selfId: string | null): AppFields {
    const description = this.checkDescription(f.description)
    if (typeof f.composeService !== 'string' || !COMPOSE_SERVICE.test(f.composeService)) throw new Error(COMPOSE_MESSAGE)
    if (f.deploymentId !== null) {
      const checkout = this.db.prepare('SELECT name, environment_id FROM deployments WHERE id = ?').get(f.deploymentId) as
        | { name: string; environment_id: string }
        | undefined
      if (!checkout) throw new Error('checkout not found')
      if (checkout.environment_id !== environmentId) throw new Error('the checkout belongs to another environment')
      const dup = this.db
        .prepare('SELECT id FROM services WHERE deployment_id = ? AND compose_service = ?')
        .get(f.deploymentId, f.composeService) as { id: string } | undefined
      if (dup && dup.id !== selfId) throw new Error(`${checkout.name} already has a service for compose service ${f.composeService}`)
    }
    if (f.urlCheckFrom !== 'mac' && f.urlCheckFrom !== 'host') throw new Error('url check must run from mac or host')
    return { ...f, description, url: this.checkUrl(f.url) }
  }

  /** Checks every rule on a fully merged kind `db`. */
  private validateDb(f: DbFields): DbFields {
    const description = this.checkDescription(f.description)
    const dbAddress = checkAddress(f.dbAddress)
    const dbPort = checkPort(f.dbPort)
    if (f.viaHostId !== null && !this.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(f.viaHostId)) throw new Error('host not found')
    const localPort = f.localPort === null ? null : checkPort(f.localPort)
    return { ...f, description, dbAddress, dbPort, localPort }
  }

  /** Blank clears it. http(s) only, no credentials, no spaces or braces. */
  private checkUrl(raw: string | null): string | null {
    if (raw === null) return null
    if (typeof raw !== 'string') throw new Error(URL_MESSAGE)
    const url = raw.trim()
    if (url === '') return null
    if (url.length > MAX_URL || /[{}\s\u0000-\u001f]/.test(url)) throw new Error(URL_MESSAGE)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(URL_MESSAGE)
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') throw new Error(URL_MESSAGE)
    return url
  }
}
