import { createHash } from 'node:crypto'
import { canonicalJson } from '../../src/main/audit/audit-log'
import { inTransaction } from '../../src/main/db/tx'
import { parseKnownHosts } from '../../src/main/ssh/known-hosts'
import {
  BACKUP_DIR,
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  GIT_REF,
  MAX_APPS,
  MAX_DEPLOYMENTS,
  MAX_ENV_TEMPLATE,
  MAX_HOOK,
  MAX_URL,
  MAX_URLS,
  parseEnvTemplate,
  REPO_PATH,
  VERSION,
} from '../../src/shared/deploy'
import { MAX_JUMP_DEPTH } from '../../src/shared/inventory'
import {
  MAX_MANIFEST_BYTES,
  type HubActor,
  type HubCatalogEnv,
  type HubEnvManifest,
  type HubIntegrations,
  type HubPublishResult,
  type HubUser,
} from '../../src/shared/hub'
import { decide } from './access/policy'
import type { Directory } from './access/directory'
import type { HubAudit } from './audit'
import type { HubDb } from './db'
import type { EnvLocks } from './locks'
import { HubHttpError } from './errors'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ADDRESS = /^(?!-)[A-Za-z0-9._:-]{1,255}$/
const USERNAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/
const MAX_TEXT = 128
const MAX_HOSTS = 512
const MAX_KNOWN_HOST_LINES = 64
const MAX_KNOWN_HOST_LINE = 2048

const bad = (message: string): never => {
  throw new HubHttpError(400, 'bad_request', message)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// Validation messages name the path and the rule, never the value.
function obj(v: unknown, path: string): Obj {
  return isObj(v) ? v : bad(`invalid manifest: ${path} must be an object`)
}
function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) return bad(`invalid manifest: ${path} must be a list`)
  if (v.length > max) return bad(`invalid manifest: ${path} has too many entries`)
  return v
}
function str(v: unknown, path: string, max = MAX_TEXT): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || /[\u0000-\u001f]/.test(v)) {
    return bad(`invalid manifest: ${path} must be 1-${max} characters without control characters`)
  }
  return v
}
function bool(v: unknown, path: string): boolean {
  return typeof v === 'boolean' ? v : bad(`invalid manifest: ${path} must be true or false`)
}
function int(v: unknown, path: string, min: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : bad(`invalid manifest: ${path} must be ${min}-${max}`)
}
function match(v: unknown, path: string, re: RegExp, what: string): string {
  return typeof v === 'string' && re.test(v) ? v : bad(`invalid manifest: ${path} is not ${what}`)
}
function uuid(v: unknown, path: string): string {
  return match(v, path, UUID, 'a valid id')
}
function nullable<T>(v: unknown, f: (x: unknown) => T): T | null {
  return v === null ? null : f(v)
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  return allowed.includes(v as T) ? (v as T) : bad(`invalid manifest: ${path} must be one of ${allowed.join(', ')}`)
}
function strings(v: unknown, path: string, max: number, itemMax: number): string[] {
  return arr(v, path, max).map((s, i) => str(s, `${path}/${i}`, itemMax))
}

function readHop(v: unknown, path: string): HubEnvManifest['hosts'][number]['hops'][number] {
  const o = obj(v, path)
  return {
    hostId: nullable(o.hostId, (x) => uuid(x, `${path}/hostId`)),
    label: str(o.label, `${path}/label`),
    address: match(o.address, `${path}/address`, ADDRESS, 'an address'),
    port: int(o.port, `${path}/port`, 1, 65535),
    username: match(o.username, `${path}/username`, USERNAME, 'a user name'),
  }
}

function readIntegrations(v: unknown): HubIntegrations {
  const o = obj(v, '/integrations')
  const qa = o.qa === null || o.qa === undefined ? null : obj(o.qa, '/integrations/qa')
  return {
    notifyEvents: strings(o.notifyEvents, '/integrations/notifyEvents', 50, 64),
    emailTo: strings(o.emailTo, '/integrations/emailTo', 50, 320),
    emailCc: strings(o.emailCc, '/integrations/emailCc', 50, 320),
    qaOnDeploy: bool(o.qaOnDeploy, '/integrations/qaOnDeploy'),
    qa,
    qaWait: bool(o.qaWait, '/integrations/qaWait'),
  }
}

/** Plain code-unit comparison: everything that feeds the hash must not depend on the Hub's ICU locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byLabel = (a: { label: string; id: string }, b: { label: string; id: string }): number => cmp(a.label, b.label) || cmp(a.id, b.id)

/** One order for every list, so the same state always hashes and reads back the same. */
function sortManifest(m: HubEnvManifest): HubEnvManifest {
  return {
    ...m,
    hosts: [...m.hosts].sort(byLabel),
    apps: [...m.apps].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)),
    deployments: [...m.deployments].sort((a, b) => a.position - b.position || cmp(a.name, b.name) || cmp(a.id, b.id)),
    requiredSecrets: [...m.requiredSecrets].sort((a, b) => cmp(a.name, b.name) || cmp(a.secretId, b.secretId)),
  }
}

/** Validates the untrusted body and returns a copy with only known fields, in canonical order. */
export function readManifest(input: unknown): HubEnvManifest {
  const m = obj(input, '/')
  const e = obj(m.environment, '/environment')
  const environment: HubEnvManifest['environment'] = {
    id: uuid(e.id, '/environment/id'),
    name: str(e.name, '/environment/name'),
    protected: bool(e.protected, '/environment/protected'),
    versioned: bool(e.versioned, '/environment/versioned'),
    autoRollback: bool(e.autoRollback, '/environment/autoRollback'),
    currentVersion: nullable(e.currentVersion, (x) => match(x, '/environment/currentVersion', VERSION, 'a version')),
  }

  const hostIds = new Set<string>()
  const hosts = arr(m.hosts, '/hosts', MAX_HOSTS).map((raw, i): HubEnvManifest['hosts'][number] => {
    const p = `/hosts/${i}`
    const h = obj(raw, p)
    const base = readHop({ ...h, hostId: null }, p)
    const id = uuid(h.id, `${p}/id`)
    if (hostIds.has(id)) bad(`invalid manifest: ${p}/id is duplicated`)
    hostIds.add(id)
    const hops = arr(h.hops, `${p}/hops`, MAX_JUMP_DEPTH + 1).map((x, j) => readHop(x, `${p}/hops/${j}`))
    const last = hops[hops.length - 1]
    if (!last || last.address !== base.address || last.port !== base.port || last.username !== base.username) {
      bad(`invalid manifest: ${p}/hops must end at the host itself`)
    }
    const knownHosts = [...new Set(arr(h.knownHosts, `${p}/knownHosts`, MAX_KNOWN_HOST_LINES).map((l, j) => str(l, `${p}/knownHosts/${j}`, MAX_KNOWN_HOST_LINE)))].sort()
    knownHosts.forEach((line, j) => {
      const parsed = parseKnownHosts(line)
      if (parsed.length !== 1 || parsed[0].marker !== null) bad(`invalid manifest: ${p}/knownHosts/${j} is not a host key line`)
    })
    return {
      id,
      label: base.label,
      address: base.address,
      port: base.port,
      username: base.username,
      useSudo: oneOf(h.useSudo, `${p}/useSudo`, ['auto', 'yes', 'no']),
      hops,
      knownHosts,
    }
  })

  const appIds = new Set<string>()
  const apps = arr(m.apps, '/apps', MAX_APPS).map((raw, i): HubEnvManifest['apps'][number] => {
    const p = `/apps/${i}`
    const a = obj(raw, p)
    const id = uuid(a.id, `${p}/id`)
    if (appIds.has(id)) bad(`invalid manifest: ${p}/id is duplicated`)
    appIds.add(id)
    return {
      id,
      name: str(a.name, `${p}/name`),
      composeProject: nullable(a.composeProject, (x) => match(x, `${p}/composeProject`, COMPOSE_PROJECT, 'a compose project name')),
      description: typeof a.description === 'string' && a.description.length <= 1000 ? a.description : bad(`invalid manifest: ${p}/description must be text of at most 1000 characters`),
    }
  })

  const depIds = new Set<string>()
  const deployments = arr(m.deployments, '/deployments', MAX_DEPLOYMENTS).map((raw, i): HubEnvManifest['deployments'][number] => {
    const p = `/deployments/${i}`
    const d = obj(raw, p)
    const id = uuid(d.id, `${p}/id`)
    if (depIds.has(id)) bad(`invalid manifest: ${p}/id is duplicated`)
    depIds.add(id)
    if (d.environmentId !== environment.id) bad(`invalid manifest: ${p}/environmentId must be the environment`)
    const hostId = uuid(d.hostId, `${p}/hostId`)
    if (!hostIds.has(hostId)) bad(`invalid manifest: ${p}/hostId is not one of the manifest hosts`)
    const appId = nullable(d.appId, (x) => uuid(x, `${p}/appId`))
    if (appId !== null && !appIds.has(appId)) bad(`invalid manifest: ${p}/appId is not one of the manifest apps`)
    const urls = arr(d.urls, `${p}/urls`, MAX_URLS).map((u, j) => {
      const o = obj(u, `${p}/urls/${j}`)
      const url = str(o.url, `${p}/urls/${j}/url`, MAX_URL)
      let parsed: URL | null = null
      try {
        parsed = new URL(url)
      } catch {
        parsed = null
      }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || /[{}\s]/.test(url)) {
        bad(`invalid manifest: ${p}/urls/${j}/url must be http(s) without credentials`)
      }
      return { url, from: oneOf(o.from, `${p}/urls/${j}/from`, ['host', 'mac'] as const) }
    })
    const hook = (v: unknown, path: string): string | null =>
      nullable(v, (x) => (typeof x === 'string' && x.length <= MAX_HOOK ? x : bad(`invalid manifest: ${path} must be text of at most ${MAX_HOOK} characters`)))
    const envTemplate = nullable(d.envTemplate, (x) =>
      typeof x === 'string' && x.length <= MAX_ENV_TEMPLATE ? x : bad(`invalid manifest: ${p}/envTemplate is too long`),
    )
    if (envTemplate !== null && parseEnvTemplate(envTemplate).errors.length > 0) bad(`invalid manifest: ${p}/envTemplate is not a valid .env template`)
    return {
      id,
      name: str(d.name, `${p}/name`),
      environmentId: environment.id,
      hostId,
      appId,
      repoPath: match(d.repoPath, `${p}/repoPath`, REPO_PATH, 'an absolute path'),
      defaultBranch: match(d.defaultBranch, `${p}/defaultBranch`, GIT_REF, 'a branch name'),
      composeFile: match(d.composeFile, `${p}/composeFile`, COMPOSE_FILE, 'a relative path'),
      deployTag: match(d.deployTag, `${p}/deployTag`, GIT_REF, 'a tag name'),
      position: int(d.position, `${p}/position`, 0, 1_000_000),
      urls,
      healthStatus: int(d.healthStatus, `${p}/healthStatus`, 100, 599),
      healthTimeoutSec: int(d.healthTimeoutSec, `${p}/healthTimeoutSec`, 5, 600),
      dbBackup: bool(d.dbBackup, `${p}/dbBackup`),
      backupDir: nullable(d.backupDir, (x) => match(x, `${p}/backupDir`, BACKUP_DIR, 'an absolute path')),
      preHook: hook(d.preHook, `${p}/preHook`),
      postHook: hook(d.postHook, `${p}/postHook`),
      buildTimeoutSec: int(d.buildTimeoutSec, `${p}/buildTimeoutSec`, 10, 3600),
      composeTimeoutSec: int(d.composeTimeoutSec, `${p}/composeTimeoutSec`, 10, 3600),
      useSudo: oneOf(d.useSudo, `${p}/useSudo`, ['auto', 'yes', 'no']),
      becomeSecretId: nullable(d.becomeSecretId, (x) => uuid(x, `${p}/becomeSecretId`)),
      managedEnv: bool(d.managedEnv, `${p}/managedEnv`),
      envTemplate,
    }
  })

  const secretIds = new Set<string>()
  const requiredSecrets = arr(m.requiredSecrets, '/requiredSecrets', 4096).map((raw, i): HubEnvManifest['requiredSecrets'][number] => {
    const p = `/requiredSecrets/${i}`
    const s = obj(raw, p)
    const secretId = uuid(s.secretId, `${p}/secretId`)
    if (secretIds.has(secretId)) bad(`invalid manifest: ${p}/secretId is duplicated`)
    secretIds.add(secretId)
    return { secretId, name: str(s.name, `${p}/name`), usedBy: [...new Set(strings(s.usedBy, `${p}/usedBy`, MAX_DEPLOYMENTS, MAX_TEXT))].sort() }
  })
  deployments.forEach((d, i) => {
    const refs = [...(d.envTemplate ? parseEnvTemplate(d.envTemplate).secretIds : []), ...(d.becomeSecretId ? [d.becomeSecretId] : [])]
    // The ids are compared case-insensitively by the parser; the Hub keys secrets by the lowercase form.
    if (refs.some((r) => !secretIds.has(r))) bad(`invalid manifest: /deployments/${i} uses a secret that is not in requiredSecrets`)
  })

  const canonical = sortManifest({ environment, hosts, apps, deployments, integrations: readIntegrations(m.integrations), requiredSecrets })
  if (Buffer.byteLength(JSON.stringify(canonical)) > MAX_MANIFEST_BYTES) bad('invalid manifest: it is larger than the limit')
  return canonical
}

export const hashManifest = (m: HubEnvManifest): string => createHash('sha256').update(canonicalJson(m)).digest('hex')

interface EnvRow {
  id: string
  name: string
  protected: number
  versioned: number
  auto_rollback: number
  current_version: string | null
  integrations: string
  manifest_hash: string
  published_by: string
  published_at: string
}
interface HostRow {
  id: string
  label: string
  address: string
  port: number
  username: string
  hops: string
  known_hosts: string
  use_sudo: string
}
interface DepRow {
  id: string
  host_id: string
  app_id: string | null
  name: string
  position: number
  meta: string
}
interface AppRow {
  id: string
  name: string
  meta: string
}

export interface RegistryOptions {
  audit: HubAudit
  directory: Pick<Directory, 'listGroups'>
  locks: Pick<EnvLocks, 'get'>
  now: () => Date
}

export class Registry {
  constructor(
    private readonly db: HubDb,
    private readonly opts: RegistryOptions,
  ) {}

  private assertNoRelease(id: string, name: string): void {
    if (this.opts.locks.get(id)?.kind === 'release') throw new HubHttpError(409, 'conflict', `A release is running on ${name}`)
  }

  private secretIdsPresent(environmentId: string): Set<string> {
    const rows = this.db.prepare('SELECT id FROM hub_secrets WHERE environment_id = ?').all(environmentId) as { id: string }[]
    return new Set(rows.map((r) => r.id))
  }

  private deployKey(environmentId: string): { fingerprint: string } | null {
    const r = this.db.prepare('SELECT fingerprint FROM env_deploy_keys WHERE environment_id = ?').get(environmentId) as { fingerprint: string } | undefined
    return r ? { fingerprint: r.fingerprint } : null
  }

  /** What each published environment still needs: its `requiredSecrets` that have no Hub secret yet. */
  required(environmentId?: string): { environmentId: string; secretId: string; name: string }[] {
    const rows = (
      environmentId === undefined
        ? this.db.prepare('SELECT id, integrations FROM environments ORDER BY name, id').all()
        : this.db.prepare('SELECT id, integrations FROM environments WHERE id = ?').all(environmentId)
    ) as { id: string; integrations: string }[]
    return rows.flatMap((r) => {
      const present = this.secretIdsPresent(r.id)
      const stored = JSON.parse(r.integrations) as { requiredSecrets: HubEnvManifest['requiredSecrets'] }
      return stored.requiredSecrets.filter((s) => !present.has(s.secretId)).map((s) => ({ environmentId: r.id, secretId: s.secretId, name: s.name }))
    })
  }

  nameOf(environmentId: string): string | null {
    return (this.db.prepare('SELECT name FROM environments WHERE id = ?').get(environmentId) as { name: string } | undefined)?.name ?? null
  }

  exists(environmentId: string): boolean {
    return this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId) !== undefined
  }

  private readonly listeners = new Set<() => void>()

  /** Told after a committed publish or unpublish, so live clients refresh their catalog. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // Listeners are advisory; the change is already committed.
      }
    }
  }

  publish(input: unknown, actor: HubActor): HubPublishResult {
    const manifest = readManifest(input)
    const env = manifest.environment
    const hash = hashManifest(manifest)
    const now = this.opts.now().toISOString()
    const result = inTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT name FROM environments WHERE id = ?').get(env.id) as { name: string } | undefined
      if (existing) this.assertNoRelease(env.id, existing.name)
      const dup = this.db.prepare('SELECT id FROM environments WHERE name = ? COLLATE NOCASE AND id <> ?').get(env.name, env.id)
      if (dup) throw new HubHttpError(409, 'conflict', 'An environment with that name is already published')

      this.db
        .prepare(
          `INSERT INTO environments(id, name, protected, versioned, auto_rollback, current_version, integrations, manifest_hash, published_by, published_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, protected = excluded.protected, versioned = excluded.versioned,
             auto_rollback = excluded.auto_rollback, current_version = excluded.current_version, integrations = excluded.integrations,
             manifest_hash = excluded.manifest_hash, published_by = excluded.published_by, published_at = excluded.published_at`,
        )
        .run(
          env.id,
          env.name,
          env.protected ? 1 : 0,
          env.versioned ? 1 : 0,
          env.autoRollback ? 1 : 0,
          env.currentVersion,
          // requiredSecrets rides in this JSON because migration 2 has no column for it.
          JSON.stringify({ integrations: manifest.integrations, requiredSecrets: manifest.requiredSecrets }),
          hash,
          actor.upn,
          now,
        )

      // Upsert by id, then remove what is gone: ids stay stable for grants and for the history that will hang off them.
      const putHost = this.db.prepare(
        `INSERT INTO hosts(id, environment_id, label, address, port, username, hops, known_hosts, use_sudo) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET environment_id = excluded.environment_id, label = excluded.label, address = excluded.address,
           port = excluded.port, username = excluded.username, hops = excluded.hops, known_hosts = excluded.known_hosts, use_sudo = excluded.use_sudo`,
      )
      for (const h of manifest.hosts) {
        this.guardForeign('hosts', h.id, env.id)
        putHost.run(h.id, env.id, h.label, h.address, h.port, h.username, JSON.stringify(h.hops), JSON.stringify(h.knownHosts), h.useSudo)
      }
      const putApp = this.db.prepare(
        `INSERT INTO apps(id, environment_id, name, meta) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET environment_id = excluded.environment_id, name = excluded.name, meta = excluded.meta`,
      )
      for (const a of manifest.apps) {
        this.guardForeign('apps', a.id, env.id)
        putApp.run(a.id, env.id, a.name, JSON.stringify({ composeProject: a.composeProject, description: a.description }))
      }
      const putDep = this.db.prepare(
        `INSERT INTO deployments(id, environment_id, host_id, app_id, name, position, meta) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET environment_id = excluded.environment_id, host_id = excluded.host_id, app_id = excluded.app_id,
           name = excluded.name, position = excluded.position, meta = excluded.meta`,
      )
      for (const d of manifest.deployments) {
        this.guardForeign('deployments', d.id, env.id)
        const { id, name, hostId, appId, position, environmentId: _e, ...meta } = d
        putDep.run(id, env.id, hostId, appId, name, position, JSON.stringify(meta))
      }

      const keep = (ids: string[]): string => (ids.length ? ids.map(() => '?').join(',') : "''")
      const depIds = manifest.deployments.map((d) => d.id)
      const gone = this.db
        .prepare(`SELECT id FROM deployments WHERE environment_id = ? AND id NOT IN (${keep(depIds)})`)
        .all(env.id, ...depIds) as { id: string }[]
      for (const g of gone) this.db.prepare('DELETE FROM grants WHERE deployment_id = ?').run(g.id)
      this.db.prepare(`DELETE FROM deployments WHERE environment_id = ? AND id NOT IN (${keep(depIds)})`).run(env.id, ...depIds)
      const hostIds = manifest.hosts.map((h) => h.id)
      this.db.prepare(`DELETE FROM hosts WHERE environment_id = ? AND id NOT IN (${keep(hostIds)})`).run(env.id, ...hostIds)
      const appIds = manifest.apps.map((a) => a.id)
      this.db.prepare(`DELETE FROM apps WHERE environment_id = ? AND id NOT IN (${keep(appIds)})`).run(env.id, ...appIds)

      this.opts.audit.append({
        action: 'env.publish',
        outcome: 'success',
        actor,
        targetType: 'environment',
        targetId: env.id,
        targetLabel: env.name,
        details: { name: env.name, hosts: manifest.hosts.length, deployments: manifest.deployments.length, manifestHash: hash },
      })
      const present = this.secretIdsPresent(env.id)
      return { manifestHash: hash, missingSecrets: manifest.requiredSecrets.map((s) => s.secretId).filter((id) => !present.has(id)) }
    })
    this.changed()
    return result
  }

  /** A host, app or deployment id that belongs to another environment is never taken over. */
  private guardForeign(table: 'hosts' | 'apps' | 'deployments', id: string, environmentId: string): void {
    const r = this.db.prepare(`SELECT environment_id FROM ${table} WHERE id = ?`).get(id) as { environment_id: string } | undefined
    if (r && r.environment_id !== environmentId) throw new HubHttpError(409, 'conflict', 'An id in the manifest belongs to another environment')
  }

  unpublish(id: string, actor: HubActor): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare('SELECT name FROM environments WHERE id = ?').get(id) as { name: string } | undefined
      if (!row) throw new HubHttpError(404, 'not_found', 'Environment not found')
      this.assertNoRelease(id, row.name)
      const counts = {
        hosts: (this.db.prepare('SELECT COUNT(*) AS n FROM hosts WHERE environment_id = ?').get(id) as { n: number }).n,
        deployments: (this.db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE environment_id = ?').get(id) as { n: number }).n,
      }
      const hash = (this.db.prepare('SELECT manifest_hash FROM environments WHERE id = ?').get(id) as { manifest_hash: string }).manifest_hash
      this.db.prepare('DELETE FROM grants WHERE environment_id = ?').run(id)
      this.db.prepare('DELETE FROM environments WHERE id = ?').run(id)
      this.opts.audit.append({
        action: 'env.unpublish',
        outcome: 'success',
        actor,
        targetType: 'environment',
        targetId: id,
        targetLabel: row.name,
        details: { name: row.name, ...counts, manifestHash: hash },
      })
    })
    this.changed()
  }

  private envRow(id: string): EnvRow {
    const r = this.db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as unknown as EnvRow | undefined
    if (!r) throw new HubHttpError(404, 'not_found', 'Environment not found')
    return r
  }

  private manifestOf(r: EnvRow): HubEnvManifest {
    const stored = JSON.parse(r.integrations) as { integrations: HubIntegrations; requiredSecrets: HubEnvManifest['requiredSecrets'] }
    const hosts = (this.db.prepare('SELECT * FROM hosts WHERE environment_id = ? ORDER BY label COLLATE NOCASE, id').all(r.id) as unknown as HostRow[]).map(
      (h): HubEnvManifest['hosts'][number] => ({
        id: h.id,
        label: h.label,
        address: h.address,
        port: h.port,
        username: h.username,
        useSudo: h.use_sudo as HubEnvManifest['hosts'][number]['useSudo'],
        hops: JSON.parse(h.hops),
        knownHosts: JSON.parse(h.known_hosts),
      }),
    )
    const apps = (this.db.prepare('SELECT * FROM apps WHERE environment_id = ? ORDER BY name COLLATE NOCASE, id').all(r.id) as unknown as AppRow[]).map(
      (a): HubEnvManifest['apps'][number] => ({ id: a.id, name: a.name, ...(JSON.parse(a.meta) as { composeProject: string | null; description: string }) }),
    )
    const deployments = (this.db.prepare('SELECT * FROM deployments WHERE environment_id = ? ORDER BY position, name COLLATE NOCASE, id').all(r.id) as unknown as DepRow[]).map(
      (d) =>
        ({ id: d.id, name: d.name, environmentId: r.id, hostId: d.host_id, appId: d.app_id, position: d.position, ...JSON.parse(d.meta) }) as HubEnvManifest['deployments'][number],
    )
    return sortManifest({
      environment: {
        id: r.id,
        name: r.name,
        protected: r.protected === 1,
        versioned: r.versioned === 1,
        autoRollback: r.auto_rollback === 1,
        currentVersion: r.current_version,
      },
      hosts,
      apps,
      deployments,
      integrations: stored.integrations,
      requiredSecrets: stored.requiredSecrets,
    })
  }

  /** The full manifest, addresses and host keys included: admins only. */
  get(id: string): HubEnvManifest {
    return this.manifestOf(this.envRow(id))
  }

  private entry(r: EnvRow, m: HubEnvManifest, view: { hosts: HubEnvManifest['hosts']; apps: HubEnvManifest['apps']; deployments: HubEnvManifest['deployments'] }): HubCatalogEnv {
    const present = this.secretIdsPresent(r.id)
    return {
      environment: m.environment,
      hosts: view.hosts.map((h) => ({ id: h.id, label: h.label })),
      apps: view.apps,
      deployments: view.deployments,
      missingSecrets: m.requiredSecrets.filter((s) => !present.has(s.secretId)).length,
      deployKey: this.deployKey(r.id),
      lock: this.opts.locks.get(r.id),
      publishedAt: r.published_at,
      publishedBy: r.published_by,
    }
  }

  private rows(): EnvRow[] {
    return this.db.prepare('SELECT * FROM environments ORDER BY name COLLATE NOCASE, id').all() as unknown as EnvRow[]
  }

  /** Every environment in catalog form (no addresses): for the admin list. */
  list(): HubCatalogEnv[] {
    return this.rows().map((r) => {
      const m = this.manifestOf(r)
      return this.entry(r, m, m)
    })
  }

  /** What `user` may see: environments they can view, with only the deployments (and their hosts and apps) they can view. */
  catalogFor(user: HubUser): HubCatalogEnv[] {
    const groups = this.opts.directory.listGroups()
    const out: HubCatalogEnv[] = []
    for (const r of this.rows()) {
      if (!decide(user, groups, 'deploy.view', { environmentId: r.id }).allowed) continue
      const m = this.manifestOf(r)
      const visible = m.deployments.filter((d) => decide(user, groups, 'deploy.view', { environmentId: r.id, deploymentIds: [d.id] }).allowed)
      if (visible.length === m.deployments.length) {
        out.push(this.entry(r, m, m))
        continue
      }
      const hostIds = new Set(visible.map((d) => d.hostId))
      const appIds = new Set(visible.flatMap((d) => (d.appId ? [d.appId] : [])))
      out.push(this.entry(r, m, { hosts: m.hosts.filter((h) => hostIds.has(h.id)), apps: m.apps.filter((a) => appIds.has(a.id)), deployments: visible }))
    }
    return out
  }
}
