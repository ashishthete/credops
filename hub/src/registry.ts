import { createHash } from 'node:crypto'
import { canonicalJson } from '../../src/main/audit/audit-log'
import { inTransaction } from '../../src/main/db/tx'
import { parseKnownHosts } from '../../src/main/ssh/known-hosts'
import {
  BACKUP_DIR,
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  COMPOSE_SERVICE,
  GIT_REF,
  MAX_DEPLOYMENTS,
  MAX_ENV_TEMPLATE,
  MAX_HOOK,
  MAX_URL,
  MAX_URLS,
  parseEnvTemplate,
  REPO_PATH,
  VERSION,
} from '../../src/shared/deploy'
import { hasRepoCredentials, MAX_JUMP_DEPTH, REGION_CODE, REPO_URL } from '../../src/shared/inventory'
import { DeployError } from '../../src/shared/deploy-error'
import { MAX_RUNBOOKS, validateRunbook } from '../../src/shared/runbooks'
import { MAX_SERVICES } from '../../src/shared/services'
import { effectiveSteps, MAX_FLOW_STAGES, MAX_STEPS_PER_CHECKOUT, validateStep, type Step } from '../../src/shared/steps'
import type { FlowStage, ReleaseFlow } from '../../src/shared/deploy'
import {
  MAX_MANIFEST_BYTES,
  type HubActor,
  type HubCatalogEnv,
  type HubEnvManifest,
  type HubGrant,
  type HubIntegrations,
  type HubProductRef,
  type HubPublishResult,
  type HubRegionRef,
  type HubUser,
} from '../../src/shared/hub'
import { decide } from './access/policy'
import type { Directory } from './access/directory'
import type { HubAudit } from './audit'
import { PUBLISHED, type HubDb } from './db'
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

function readProduct(v: unknown, path: string): HubProductRef {
  const o = obj(v, path)
  return { id: uuid(o.id, `${path}/id`), name: str(o.name, `${path}/name`) }
}

function readRegion(v: unknown, path: string): HubRegionRef {
  const o = obj(v, path)
  return { code: match(o.code, `${path}/code`, REGION_CODE, 'a region code'), displayName: str(o.displayName, `${path}/displayName`) }
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

/** Runs a shared validator, turning its rule message into a manifest error at `path`. The message names the rule, never a value. */
function rule<T>(path: string, f: () => T): T {
  try {
    return f()
  } catch (err) {
    if (err instanceof DeployError) return bad(`invalid manifest: ${path}: ${err.message}`)
    throw err
  }
}

function readFlow(v: unknown, serviceIds: ReadonlySet<string>, allowedSecretIds: ReadonlySet<string>, serviceNames: readonly string[]): ReleaseFlow | null {
  const path = '/environment/flow'
  if (v === null || v === undefined) return null
  const f = obj(v, path)
  const onFailure = oneOf(f.onFailure, `${path}/onFailure`, ['stop-all', 'continue-other-hosts'] as const)
  const stepIds = new Set<string>()
  const stages = arr(f.stages, `${path}/stages`, MAX_FLOW_STAGES).map((raw, i): FlowStage => {
    const p = `${path}/stages/${i}`
    const st = obj(raw, p)
    if (st.kind === 'services') {
      const ids = arr(st.serviceIds, `${p}/serviceIds`, MAX_SERVICES).map((x, j) => uuid(x, `${p}/serviceIds/${j}`))
      if (ids.length === 0 || ids.some((id) => !serviceIds.has(id))) bad(`invalid manifest: ${p}/serviceIds must name services of the manifest`)
      return { kind: 'services', serviceIds: [...new Set(ids)] }
    }
    if (st.kind !== 'step') return bad(`invalid manifest: ${p}/kind must be one of services, step`)
    const serviceId = uuid(st.serviceId, `${p}/serviceId`)
    if (!serviceIds.has(serviceId)) bad(`invalid manifest: ${p}/serviceId is not one of the manifest services`)
    const step = rule(`${p}/step`, () => validateStep(st.step, { allowedSecretIds, serviceNames, body: true }))
    if (stepIds.has(step.id)) bad(`invalid manifest: ${p}/step/id is duplicated`)
    stepIds.add(step.id)
    return { kind: 'step', serviceId, step }
  })
  if (stages.length === 0) bad(`invalid manifest: ${path}/stages must not be empty`)
  return { stages, onFailure }
}

/** One order for every list, so the same state always hashes and reads back the same. */
function sortManifest(m: HubEnvManifest): HubEnvManifest {
  return {
    ...m,
    hosts: [...m.hosts].sort(byLabel),
    services: [...m.services].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)),
    deployments: [...m.deployments].sort((a, b) => a.position - b.position || cmp(a.name, b.name) || cmp(a.id, b.id)),
    requiredSecrets: [...m.requiredSecrets].sort((a, b) => cmp(a.name, b.name) || cmp(a.secretId, b.secretId)),
    ...(m.runbooks ? { runbooks: [...m.runbooks].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)) } : {}),
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
    ...(e.parallelPrepare === undefined ? {} : { parallelPrepare: bool(e.parallelPrepare, '/environment/parallelPrepare') }),
    ...(e.prepareCap === undefined ? {} : { prepareCap: int(e.prepareCap, '/environment/prepareCap', 1, 8) }),
    // Only when sent: an older desktop's manifest has no product, and hashes exactly as before.
    ...(e.product !== undefined ? { product: readProduct(e.product, '/environment/product') } : {}),
  }
  const schema = m.schema === undefined || m.schema === 1 || m.schema === 2 ? (m.schema ?? 1) : bad('invalid manifest: /schema must be 1 or 2')

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
      ...(h.region !== undefined ? { region: readRegion(h.region, `${p}/region`) } : {}),
    }
  })

  const depIds = new Set<string>()
  const rawSteps = new Map<string, unknown>()
  const deployments = arr(m.deployments, '/deployments', MAX_DEPLOYMENTS).map((raw, i): HubEnvManifest['deployments'][number] => {
    const p = `/deployments/${i}`
    const d = obj(raw, p)
    const id = uuid(d.id, `${p}/id`)
    if (depIds.has(id)) bad(`invalid manifest: ${p}/id is duplicated`)
    depIds.add(id)
    if (d.environmentId !== environment.id) bad(`invalid manifest: ${p}/environmentId must be the environment`)
    const hostId = uuid(d.hostId, `${p}/hostId`)
    if (!hostIds.has(hostId)) bad(`invalid manifest: ${p}/hostId is not one of the manifest hosts`)
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
    // Steps are checked below, once the services and required secrets they refer to are known.
    if (d.steps !== undefined) rawSteps.set(id, arr(d.steps, `${p}/steps`, MAX_STEPS_PER_CHECKOUT))
    return {
      id,
      name: str(d.name, `${p}/name`),
      environmentId: environment.id,
      hostId,
      repoUrl: nullable(d.repoUrl, (x): string => {
        // The messages never carry the URL: it may hold a token.
        const url = typeof x === 'string' && x.length <= MAX_URL && REPO_URL.test(x) ? x : bad(`invalid manifest: ${p}/repoUrl must be an http(s), ssh:// or git@ repository URL`)
        return hasRepoCredentials(url) ? bad(`invalid manifest: ${p}/repoUrl must not contain credentials`) : url
      }),
      composeProject: nullable(d.composeProject, (x) => match(x, `${p}/composeProject`, COMPOSE_PROJECT, 'a compose project name')),
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

  const depHost = new Map(deployments.map((d) => [d.id, d.hostId]))
  const serviceIds = new Set<string>()
  const services = arr(m.services, '/services', MAX_SERVICES).map((raw, i): HubEnvManifest['services'][number] => {
    const p = `/services/${i}`
    const s = obj(raw, p)
    const id = uuid(s.id, `${p}/id`)
    if (serviceIds.has(id)) bad(`invalid manifest: ${p}/id is duplicated`)
    serviceIds.add(id)
    const kind = oneOf(s.kind, `${p}/kind`, ['service', 'db'] as const)
    const deploymentId = nullable(s.deploymentId, (x) => uuid(x, `${p}/deploymentId`))
    const hostId = nullable(s.hostId, (x) => uuid(x, `${p}/hostId`))
    const viaHostId = nullable(s.viaHostId, (x) => uuid(x, `${p}/viaHostId`))
    const composeService = nullable(s.composeService, (x) => match(x, `${p}/composeService`, COMPOSE_SERVICE, 'a compose service name'))
    const name = str(s.name, `${p}/name`)
    const skipUnchanged = s.skipUnchanged === undefined ? undefined : bool(s.skipUnchanged, `${p}/skipUnchanged`)
    if (viaHostId !== null && !hostIds.has(viaHostId)) bad(`invalid manifest: ${p}/viaHostId is not one of the manifest hosts`)
    if (kind === 'db') {
      if (composeService !== null || deploymentId !== null || hostId !== null) bad(`invalid manifest: ${p} is a db and has no compose service, checkout or host`)
      if (skipUnchanged) bad(`invalid manifest: ${p}/skipUnchanged is only for a service`)
      return { id, name, kind, composeService, deploymentId, hostId, viaHostId }
    }
    if (viaHostId !== null) bad(`invalid manifest: ${p}/viaHostId is only for a db`)
    if (deploymentId !== null && !depIds.has(deploymentId)) bad(`invalid manifest: ${p}/deploymentId is not one of the manifest deployments`)
    if (deploymentId === null ? hostId !== null : hostId !== depHost.get(deploymentId)) {
      bad(`invalid manifest: ${p}/hostId must be its checkout's host (and null without a checkout)`)
    }
    return { id, name, kind, composeService, deploymentId, hostId, viaHostId, ...(skipUnchanged === undefined ? {} : { skipUnchanged }) }
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

  // A step may use any required secret of the environment; one outside requiredSecrets is refused.
  const stepSecretIds: ReadonlySet<string> = secretIds
  const namesOf = (deploymentId: string): string[] => services.flatMap((s) => (s.kind === 'service' && s.deploymentId === deploymentId && s.composeService ? [s.composeService] : []))
  const withSteps = deployments.map((d, i): HubEnvManifest['deployments'][number] => {
    const raw = rawSteps.get(d.id)
    const p = `/deployments/${i}/steps`
    const given = (raw as unknown[] | undefined ?? []).map((x, j) => rule(`${p}/${j}`, () => validateStep(x, { allowedSecretIds: stepSecretIds, serviceNames: namesOf(d.id) })))
    if (new Set(given.map((x) => x.id)).size !== given.length) bad(`invalid manifest: ${p} ids must be unique`)
    // A schema-1 publisher has hooks and no steps: they become steps here, so the Hub runs them as the desktop does.
    if (schema === 2 && given.length > 0 && (d.preHook !== null || d.postHook !== null)) bad(`invalid manifest: ${p} cannot be set next to preHook or postHook`)
    const steps: Step[] = schema === 2 ? given : effectiveSteps({ steps: given, preHook: d.preHook, postHook: d.postHook })
    // Steps non-empty means no hooks, as in the app's store: the hooks live on as steps.
    return steps.length > 0 ? { ...d, preHook: null, postHook: null, steps } : d
  })

  const serviceIdSet = new Set(services.map((s) => s.id))
  const appServiceNames = services.flatMap((s) => (s.kind === 'service' && s.composeService ? [s.composeService] : []))
  const flow = e.flow === undefined ? undefined : readFlow(e.flow, serviceIdSet, stepSecretIds, appServiceNames)
  const runbookIds = new Set<string>()
  const runbooks = m.runbooks === undefined ? undefined : arr(m.runbooks, '/runbooks', MAX_RUNBOOKS).map((raw, i): NonNullable<HubEnvManifest['runbooks']>[number] => {
    const p = `/runbooks/${i}`
    const r = obj(raw, p)
    const id = uuid(r.id, `${p}/id`)
    if (runbookIds.has(id)) bad(`invalid manifest: ${p}/id is duplicated`)
    runbookIds.add(id)
    const v = rule(p, () => validateRunbook({ ...r, environmentId: environment.id }, { allowedSecretIds: stepSecretIds, serviceIds: [...serviceIdSet], serviceNames: appServiceNames }))
    const { environmentId: _e, ...rest } = v
    return { id, ...rest }
  })
  if (runbooks) {
    const names = runbooks.map((r) => r.name.toLowerCase())
    if (new Set(names).size !== names.length) bad('invalid manifest: /runbooks names must be unique')
  }
  if (flow !== undefined) environment.flow = flow

  const canonical = sortManifest({
    environment,
    hosts,
    services,
    deployments: withSteps,
    integrations: readIntegrations(m.integrations),
    requiredSecrets,
    ...(runbooks ? { runbooks } : {}),
  })
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
  playbook_ops: string
  manifest_hash: string
  published_by: string
  published_at: string
  product_id: string | null
  product_name: string | null
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
  region_code: string | null
  region_name: string | null
}
interface DepRow {
  id: string
  host_id: string
  name: string
  position: number
  meta: string
}
interface ServiceRow {
  id: string
  name: string
  kind: string
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
        ? this.db.prepare(`SELECT id, integrations FROM environments WHERE ${PUBLISHED} ORDER BY name, id`).all()
        : this.db.prepare(`SELECT id, integrations FROM environments WHERE id = ? AND ${PUBLISHED}`).all(environmentId)
    ) as { id: string; integrations: string }[]
    return rows.flatMap((r) => {
      const present = this.secretIdsPresent(r.id)
      const stored = JSON.parse(r.integrations) as { requiredSecrets: HubEnvManifest['requiredSecrets'] }
      return stored.requiredSecrets.filter((s) => !present.has(s.secretId)).map((s) => ({ environmentId: r.id, secretId: s.secretId, name: s.name }))
    })
  }

  /** The name of a published environment; null when it is unknown or unpublished. */
  nameOf(environmentId: string): string | null {
    return (this.db.prepare(`SELECT name FROM environments WHERE id = ? AND ${PUBLISHED}`).get(environmentId) as { name: string } | undefined)?.name ?? null
  }

  exists(environmentId: string): boolean {
    return this.nameOf(environmentId) !== null
  }

  /** An environment whose release history the Hub keeps: published now, or unpublished (read-only). */
  historyOf(environmentId: string): { name: string; unpublished: boolean } | null {
    const r = this.db.prepare('SELECT name, unpublished_at FROM environments WHERE id = ?').get(environmentId) as { name: string; unpublished_at: string | null } | undefined
    return r ? { name: r.name, unpublished: r.unpublished_at !== null } : null
  }

  /** The grants an unpublished environment had, which still say who may read its history. */
  formerGrants(environmentId: string): HubGrant[] {
    const rows = this.db
      .prepare('SELECT grant_id, group_id, deployment_id, created_at FROM unpublished_grants WHERE environment_id = ? ORDER BY created_at, grant_id')
      .all(environmentId) as { grant_id: string; group_id: string; deployment_id: string | null; created_at: string }[]
    return rows.map((g) => ({
      id: g.grant_id,
      groupId: g.group_id,
      scope: g.deployment_id === null ? { kind: 'environment', environmentId } : { kind: 'deployment', environmentId, deploymentId: g.deployment_id },
      createdAt: g.created_at,
    }))
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
      const existing = this.db.prepare('SELECT name, unpublished_at FROM environments WHERE id = ?').get(env.id) as { name: string; unpublished_at: string | null } | undefined
      if (existing) this.assertNoRelease(env.id, existing.name)
      const dup = this.db.prepare(`SELECT id FROM environments WHERE name = ? COLLATE NOCASE AND id <> ? AND ${PUBLISHED}`).get(env.name, env.id)
      // An unpublished environment gives up its name; one published since may have taken it.
      if (dup && existing?.unpublished_at) {
        throw new HubHttpError(409, 'conflict', `Another published environment now uses the name "${env.name}". Rename one of them to publish this one again.`)
      }
      if (dup) throw new HubHttpError(409, 'conflict', 'An environment with that name is already published')

      this.db
        .prepare(
          `INSERT INTO environments(id, name, protected, versioned, auto_rollback, current_version, integrations, manifest_hash, published_by, published_at,
             playbook_ops, product_id, product_name)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, protected = excluded.protected, versioned = excluded.versioned,
             auto_rollback = excluded.auto_rollback,
             current_version = CASE WHEN EXISTS (SELECT 1 FROM releases WHERE environment_id = environments.id AND version IS NOT NULL AND status IN ('succeeded','rolled_back')) THEN environments.current_version ELSE excluded.current_version END,
             integrations = excluded.integrations,
             manifest_hash = excluded.manifest_hash, published_by = excluded.published_by, published_at = excluded.published_at,
             playbook_ops = excluded.playbook_ops,
             product_id = excluded.product_id, product_name = excluded.product_name, unpublished_at = NULL`,
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
          // Undefined keys drop out of the JSON, so an absent setting reads back as the default.
          JSON.stringify({ flow: env.flow, parallelPrepare: env.parallelPrepare, prepareCap: env.prepareCap, runbooks: manifest.runbooks }),
          env.product?.id ?? null,
          env.product?.name ?? null,
        )
      // A republish: from now on its history follows the grants given again, not the ones it had.
      this.db.prepare('DELETE FROM unpublished_grants WHERE environment_id = ?').run(env.id)

      // Upsert by id, then remove what is gone: ids stay stable for grants and for the history that will hang off them.
      // Hosts may be shared, so each environment upserts its own row for a host.
      const putHost = this.db.prepare(
        `INSERT INTO hosts(id, environment_id, label, address, port, username, hops, known_hosts, use_sudo, region_code, region_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(environment_id, id) DO UPDATE SET label = excluded.label, address = excluded.address,
           port = excluded.port, username = excluded.username, hops = excluded.hops, known_hosts = excluded.known_hosts, use_sudo = excluded.use_sudo,
           region_code = excluded.region_code, region_name = excluded.region_name`,
      )
      for (const h of manifest.hosts) {
        putHost.run(h.id, env.id, h.label, h.address, h.port, h.username, JSON.stringify(h.hops), JSON.stringify(h.knownHosts), h.useSudo, h.region?.code ?? null, h.region?.displayName ?? null)
      }
      const putService = this.db.prepare(
        `INSERT INTO services(id, environment_id, kind, name, meta) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET environment_id = excluded.environment_id, kind = excluded.kind, name = excluded.name, meta = excluded.meta`,
      )
      for (const s of manifest.services) {
        this.guardForeign('services', s.id, env.id)
        putService.run(s.id, env.id, s.kind, s.name, JSON.stringify({ composeService: s.composeService, deploymentId: s.deploymentId, hostId: s.hostId, viaHostId: s.viaHostId, skipUnchanged: s.skipUnchanged }))
      }
      const putDep = this.db.prepare(
        `INSERT INTO deployments(id, environment_id, host_id, name, position, meta) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET environment_id = excluded.environment_id, host_id = excluded.host_id,
           name = excluded.name, position = excluded.position, meta = excluded.meta`,
      )
      for (const d of manifest.deployments) {
        this.guardForeign('deployments', d.id, env.id)
        const { id, name, hostId, position, environmentId: _e, ...meta } = d
        putDep.run(id, env.id, hostId, name, position, JSON.stringify(meta))
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
      const serviceIds = manifest.services.map((s) => s.id)
      this.db.prepare(`DELETE FROM services WHERE environment_id = ? AND id NOT IN (${keep(serviceIds)})`).run(env.id, ...serviceIds)

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

  /** A service or deployment id that belongs to another environment is never taken over. Hosts are per environment and may be shared. */
  private guardForeign(table: 'services' | 'deployments', id: string, environmentId: string): void {
    const r = this.db.prepare(`SELECT environment_id FROM ${table} WHERE id = ?`).get(id) as { environment_id: string } | undefined
    if (r && r.environment_id !== environmentId) throw new HubHttpError(409, 'conflict', 'An id in the manifest belongs to another environment')
  }

  /**
   * Removes the environment's inventory, secrets, deploy key, freeze and grants, and keeps its row (marked
   * unpublished) so its releases, runs and events stay as read-only history. The grants it had move to
   * unpublished_grants, so the people who could view it still can. A republish of the same id lifts the mark.
   */
  unpublish(id: string, actor: HubActor): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT name FROM environments WHERE id = ? AND ${PUBLISHED}`).get(id) as { name: string } | undefined
      if (!row) throw new HubHttpError(404, 'not_found', 'Environment not found')
      this.assertNoRelease(id, row.name)
      const counts = {
        hosts: (this.db.prepare('SELECT COUNT(*) AS n FROM hosts WHERE environment_id = ?').get(id) as { n: number }).n,
        deployments: (this.db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE environment_id = ?').get(id) as { n: number }).n,
      }
      const hash = (this.db.prepare('SELECT manifest_hash FROM environments WHERE id = ?').get(id) as { manifest_hash: string }).manifest_hash
      const keptReleases = (this.db.prepare('SELECT COUNT(*) AS n FROM releases WHERE environment_id = ?').get(id) as { n: number }).n
      this.db
        .prepare(
          `INSERT OR REPLACE INTO unpublished_grants(grant_id, group_id, environment_id, deployment_id, created_at)
           SELECT id, group_id, environment_id, deployment_id, created_at FROM grants WHERE environment_id = ?`,
        )
        .run(id)
      this.db.prepare('DELETE FROM grants WHERE environment_id = ?').run(id)
      for (const t of ['deployments', 'services', 'hosts', 'hub_secrets', 'env_deploy_keys', 'env_locks']) {
        this.db.prepare(`DELETE FROM ${t} WHERE environment_id = ?`).run(id)
      }
      this.db.prepare('UPDATE environments SET unpublished_at = ? WHERE id = ?').run(this.opts.now().toISOString(), id)
      this.opts.audit.append({
        action: 'env.unpublish',
        outcome: 'success',
        actor,
        targetType: 'environment',
        targetId: id,
        targetLabel: row.name,
        details: { name: row.name, ...counts, manifestHash: hash, keptReleases },
      })
    })
    this.changed()
  }

  private envRow(id: string): EnvRow {
    const r = this.db.prepare(`SELECT * FROM environments WHERE id = ? AND ${PUBLISHED}`).get(id) as unknown as EnvRow | undefined
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
        ...(h.region_code !== null && h.region_name !== null ? { region: { code: h.region_code, displayName: h.region_name } } : {}),
      }),
    )
    const services = (this.db.prepare('SELECT * FROM services WHERE environment_id = ? ORDER BY name COLLATE NOCASE, id').all(r.id) as unknown as ServiceRow[]).map(
      (s): HubEnvManifest['services'][number] => ({ id: s.id, name: s.name, kind: s.kind as 'service' | 'db', ...(JSON.parse(s.meta) as Omit<HubEnvManifest['services'][number], 'id' | 'name' | 'kind'>) }),
    )
    const deployments = (this.db.prepare('SELECT * FROM deployments WHERE environment_id = ? ORDER BY position, name COLLATE NOCASE, id').all(r.id) as unknown as DepRow[]).map(
      (d) =>
        ({ id: d.id, name: d.name, environmentId: r.id, hostId: d.host_id, repoUrl: null, composeProject: null, position: d.position, ...JSON.parse(d.meta) }) as HubEnvManifest['deployments'][number],
    )
    const ops = JSON.parse(r.playbook_ops) as { flow?: ReleaseFlow | null; parallelPrepare?: boolean; prepareCap?: number; runbooks?: HubEnvManifest['runbooks'] }
    return sortManifest({
      environment: {
        id: r.id,
        name: r.name,
        protected: r.protected === 1,
        versioned: r.versioned === 1,
        autoRollback: r.auto_rollback === 1,
        currentVersion: r.current_version,
        ...(ops.parallelPrepare === undefined ? {} : { parallelPrepare: ops.parallelPrepare }),
        ...(ops.prepareCap === undefined ? {} : { prepareCap: ops.prepareCap }),
        ...(ops.flow === undefined ? {} : { flow: ops.flow }),
        ...(r.product_id !== null && r.product_name !== null ? { product: { id: r.product_id, name: r.product_name } } : {}),
      },
      hosts,
      services,
      deployments,
      integrations: stored.integrations,
      requiredSecrets: stored.requiredSecrets,
      ...(ops.runbooks ? { runbooks: ops.runbooks } : {}),
    })
  }

  /** The full manifest, addresses and host keys included: admins only. */
  get(id: string): HubEnvManifest {
    return this.manifestOf(this.envRow(id))
  }

  private entry(r: EnvRow, m: HubEnvManifest, view: { hosts: HubEnvManifest['hosts']; services: HubEnvManifest['services']; deployments: HubEnvManifest['deployments'] }): HubCatalogEnv {
    const present = this.secretIdsPresent(r.id)
    return {
      environment: m.environment,
      hosts: view.hosts.map((h) => ({ id: h.id, label: h.label, ...(h.region ? { region: h.region } : {}) })),
      services: view.services,
      deployments: view.deployments,
      missingSecrets: m.requiredSecrets.filter((s) => !present.has(s.secretId)).length,
      deployKey: this.deployKey(r.id),
      lock: this.opts.locks.get(r.id),
      publishedAt: r.published_at,
      publishedBy: r.published_by,
    }
  }

  private rows(): EnvRow[] {
    return this.db.prepare(`SELECT * FROM environments WHERE ${PUBLISHED} ORDER BY name COLLATE NOCASE, id`).all() as unknown as EnvRow[]
  }

  /** Every environment in catalog form (no addresses): for the admin list. */
  list(): HubCatalogEnv[] {
    return this.rows().map((r) => {
      const m = this.manifestOf(r)
      return this.entry(r, m, m)
    })
  }

  /** What `user` may see: environments they can view, with only the deployments (and their hosts and services) they can view. */
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
      const depIds = new Set(visible.map((d) => d.id))
      // A service is visible when its checkout is; db services and services without a checkout need every checkout of the environment. Via-hosts are not in hostIds, so a partial viewer never gets them.
      out.push(this.entry(r, m, { hosts: m.hosts.filter((h) => hostIds.has(h.id)), services: m.services.filter((s) => s.deploymentId !== null && depIds.has(s.deploymentId)), deployments: visible }))
    }
    return out
  }
}
