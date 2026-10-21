// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import {
  BACKUP_DIR,
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  COMPOSE_SERVICE,
  GIT_REF,
  HEALTH_STATUS_RANGE,
  HEALTH_TIMEOUT_RANGE,
  MAX_COMPOSE_FILE_INPUT,
  MAX_COMPOSE_NAME,
  MAX_DEPLOYMENTS,
  MAX_GIT_REF_INPUT,
  MAX_POSITION,
  MAX_REPO_PATH,
  MAX_ENV_TEMPLATE,
  MAX_HOOK,
  MAX_URL as MAX_HEALTH_URL,
  MAX_URLS,
  REPO_PATH,
  STEP_TIMEOUT_RANGE,
  isHttpUrl,
  parseEnvTemplate,
  type HealthFrom,
  type HealthUrl,
  type UseSudo,
} from './deploy'
import {
  ENV_NAME,
  HOST_ADDRESS,
  HOST_ROLES,
  MAX_ADDRESS,
  MAX_DESCRIPTION,
  MAX_ENV_VALUE,
  MAX_ENV_VARS,
  MAX_KEEPALIVE_SEC,
  MAX_LINKS,
  MAX_NAME,
  MAX_NOTES,
  MAX_TAG,
  MAX_TAGS,
  MAX_URL,
  OS_ICONS,
  PRODUCT_ICONS,
  REPO_URL,
  TAG,
  UNSAFE_SSH_CHAR,
  hasRepoCredentials,
  parseEnvDomain,
  type HostRole,
  type OsIcon,
  type ProductIcon,
} from './inventory'
import { MAX_SERVICES, type DbEngine } from './services'
import { BIND_ADDRESS, MAX_BIND_ADDRESS, MAX_TUNNELS, type TunnelType } from './tunnels'
import { IDENTITY_AUTHS, MAX_LABEL, MAX_SECRET_NAME, MAX_USERNAME, MAX_VAULT_NAME, VAULT_COLOR, type IdentityAuth } from './vault'

export const CONFIG_FORMAT = 'opsdeck-config'
export const CONFIG_VERSION = 1
export const CONFIG_MAX_BYTES = 5 * 1024 * 1024
export const CONFIG_FILE_NAME = 'opsdeck-config.json'

export interface VaultRef {
  vaultName: string
}
/** A secret's name or an ssh key's label, in a vault named by name. */
export interface ItemRef {
  vaultName: string
  itemName: string
}

export interface ConfigProduct {
  id: string
  name: string
  color: string
  icon: ProductIcon
  description: string
  repoUrl: string | null
}
export interface ConfigIdentity {
  id: string
  vault: VaultRef
  label: string
  username: string
  auth: IdentityAuth
  key: ItemRef | null
}
export interface ConfigHost {
  id: string
  label: string
  address: string
  port: number | null
  identityId: string | null
  jumpHostId: string | null
  tags: string[]
  osIcon: OsIcon
  notes: string
  keepaliveSec: number | null
  envVars: Record<string, string>
  vaults: VaultRef[]
}
export interface ConfigEnvironment {
  id: string
  name: string
  color: string
  protected: boolean
  defaultIdentityId: string | null
  defaultPort: number | null
  defaultJumpHostId: string | null
  versioned: boolean
  autoRollback: boolean
  domain: string | null
  productIds: string[]
  hosts: { hostId: string; role: HostRole }[]
}
export interface ConfigTunnel {
  id: string
  label: string
  hostId: string
  environmentId: string | null
  type: TunnelType
  bindAddress: string
  bindPort: number
  targetHost: string | null
  targetPort: number | null
  autoStart: boolean
  autoReconnect: boolean
}
export interface ConfigDeployment {
  id: string
  environmentId: string
  hostId: string
  name: string
  repoUrl: string | null
  repoPath: string
  defaultBranch: string
  composeFile: string
  composeProject: string | null
  deployTag: string
  position: number
  urls: HealthUrl[]
  healthStatus: number
  healthTimeoutSec: number
  dbBackup: boolean
  backupDir: string | null
  preHook: string | null
  postHook: string | null
  buildTimeoutSec: number
  composeTimeoutSec: number
  useSudo: UseSudo
  /** A `secretRefs` key. */
  becomeSecret: string | null
  vaults: VaultRef[]
  managedEnv: boolean
  /** Secret references read `${secret:ref-N}`. */
  envTemplate: string | null
}
export interface ConfigAppService {
  id: string
  environmentId: string
  name: string
  kind: 'service'
  position: number
  description: string
  deploymentId: string | null
  composeService: string
  url: string | null
  urlCheckFrom: HealthFrom
}
export interface ConfigDbService {
  id: string
  environmentId: string
  name: string
  kind: 'db'
  position: number
  description: string
  dbEngine: DbEngine
  dbAddress: string
  dbPort: number
  viaHostId: string | null
  localPort: number | null
  tunnelId: string | null
}
export type ConfigService = ConfigAppService | ConfigDbService

export interface ConfigFile {
  format: typeof CONFIG_FORMAT
  version: typeof CONFIG_VERSION
  exportedAt: string
  /** Keys `ref-1`, `ref-2`…, assigned in (vaultName, itemName) order. */
  secretRefs: Record<string, ItemRef>
  products: ConfigProduct[]
  identities: ConfigIdentity[]
  hosts: ConfigHost[]
  environments: ConfigEnvironment[]
  tunnels: ConfigTunnel[]
  deployments: ConfigDeployment[]
  services: ConfigService[]
}

export interface ConfigCounts {
  products: number
  identities: number
  hosts: number
  environments: number
  tunnels: number
  deployments: number
  services: number
}

export const countConfig = (file: ConfigFile): ConfigCounts => ({
  products: file.products.length,
  identities: file.identities.length,
  hosts: file.hosts.length,
  environments: file.environments.length,
  tunnels: file.tunnels.length,
  deployments: file.deployments.length,
  services: file.services.length,
})

export const SECRET_REF_KEY = /^ref-[1-9][0-9]{0,5}$/
/** `${secret:<ref>}` anywhere in an env template; group 1 is the ref. */
export const TEMPLATE_SECRET_REF = /\$\{secret:([^}]*)\}/g

// ---- The strict reader ----
// A check returns the value, or BAD after pushing `<JSON path> <rule>` to `errs`. Messages never carry a value.
// The rules are the stores' and the IPC validators' (the shared patterns and limits); none are new here.

const BAD = Symbol('bad')
type Out<T> = T | typeof BAD
type Check<T> = (value: unknown, path: string, errs: string[]) => Out<T>

const MAX_ERRORS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDER_SECRET_ID = '00000000-0000-4000-8000-000000000000'

function fail(errs: string[], path: string, rule: string): typeof BAD {
  errs.push(`${path} ${rule}`)
  return BAD
}

const str =
  (opts: { max: number; min?: number; pattern?: RegExp; ok?: (s: string) => boolean; rule?: string }): Check<string> =>
  (value, path, errs) => {
    if (typeof value !== 'string') return fail(errs, path, 'must be a string')
    if (value.length < (opts.min ?? 0) || value.length > opts.max) {
      return fail(errs, path, opts.min ? `must be ${opts.min}-${opts.max} characters` : `must be at most ${opts.max} characters`)
    }
    if ((opts.pattern && !opts.pattern.test(value)) || (opts.ok && !opts.ok(value))) return fail(errs, path, opts.rule ?? 'has an invalid format')
    return value
  }

/** checkText's rule: trimmed, 1..max characters. */
const text =
  (max: number): Check<string> =>
  (value, path, errs) => {
    if (typeof value !== 'string') return fail(errs, path, 'must be a string')
    const n = value.trim().length
    if (n === 0 || n > max) return fail(errs, path, `must be 1-${max} characters`)
    return value
  }

const int =
  (min: number, max: number): Check<number> =>
  (value, path, errs) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return fail(errs, path, 'must be an integer')
    if (value < min || value > max) return fail(errs, path, `must be ${min}-${max}`)
    return value
  }

const bool: Check<boolean> = (value, path, errs) => (typeof value === 'boolean' ? value : fail(errs, path, 'must be a boolean'))

const oneOf =
  <T extends string>(values: readonly T[]): Check<T> =>
  (value, path, errs) =>
    values.includes(value as T) ? (value as T) : fail(errs, path, 'is not an allowed value')

const uuid: Check<string> = (value, path, errs) => (typeof value === 'string' && UUID.test(value) ? value : fail(errs, path, 'must be a uuid'))

const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (value, path, errs) =>
    value === null ? null : check(value, path, errs)

const array =
  <T>(check: Check<T>, max: number): Check<T[]> =>
  (value, path, errs) => {
    if (!Array.isArray(value)) return fail(errs, path, 'must be an array')
    if (value.length > max) return fail(errs, path, `must have at most ${max} items`)
    const out = value.map((item, i) => check(item, `${path}[${i}]`, errs))
    return out.includes(BAD as never) ? BAD : (out as T[])
  }

type Shape = Record<string, Check<unknown>>
type Infer<S extends Shape> = { [K in keyof S]: Exclude<ReturnType<S[K]>, typeof BAD> }

/** Every key is required and no other key is allowed. `refine` runs cross-field rules once every field passed. */
const object =
  <S extends Shape, T = Infer<S>>(shape: S, refine?: (out: Infer<S>, path: string, errs: string[]) => boolean): Check<T> =>
  (value, path, errs) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(errs, path, 'must be an object')
    const input = value as Record<string, unknown>
    let ok = true
    for (const key of Object.keys(input)) if (!Object.hasOwn(shape, key)) ok = fail(errs, `${path}.${key}`, 'is not an allowed key') !== BAD
    const out: Record<string, unknown> = {}
    for (const [key, check] of Object.entries(shape)) {
      if (!Object.hasOwn(input, key)) {
        ok = fail(errs, `${path}.${key}`, 'is required') !== BAD
        continue
      }
      const v = check(input[key], `${path}.${key}`, errs)
      if (v === BAD) ok = false
      else out[key] = v
    }
    if (!ok) return BAD
    return refine && !refine(out as Infer<S>, path, errs) ? BAD : (out as T)
  }

/** A string-keyed map into a null-prototype object; a bad key is reported without echoing it. */
const record =
  <T>(keyPattern: RegExp, check: Check<T>, max: number): Check<Record<string, T>> =>
  (value, path, errs) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(errs, path, 'must be an object')
    const keys = Object.keys(value)
    if (keys.length > max) return fail(errs, path, `must have at most ${max} keys`)
    const out = Object.create(null) as Record<string, T>
    let ok = true
    for (const key of keys) {
      if (!keyPattern.test(key) || key in Object.prototype) {
        ok = fail(errs, path, 'has an invalid key') !== BAD
        continue
      }
      const v = check((value as Record<string, unknown>)[key], `${path}.${key}`, errs)
      if (v === BAD) ok = false
      else out[key] = v
    }
    return ok ? { ...out } : BAD
  }

// Field rules, from the shared patterns and limits.
const id = uuid
const nullableId = nullable(uuid)
const port = int(1, 65535)
const address = str({ min: 1, max: MAX_ADDRESS, pattern: HOST_ADDRESS })
const color = str({ max: 7, pattern: VAULT_COLOR })
const repoUrl: Check<string | null> = nullable((value, path, errs) => {
  const s = str({ max: MAX_URL, pattern: REPO_URL })(value, path, errs)
  if (s === BAD) return BAD
  return hasRepoCredentials(s) ? fail(errs, path, 'must not carry credentials') : s
})
const vaultRef = object({ vaultName: text(MAX_VAULT_NAME) })
const itemRef = object({ vaultName: text(MAX_VAULT_NAME), itemName: text(Math.max(MAX_LABEL, MAX_SECRET_NAME)) })
const vaultRefs = array(vaultRef, MAX_LINKS)

const httpUrl = (max: number) => str({ max, ok: isHttpUrl, rule: 'must be an http(s) URL without credentials' })

const envVars = record(
  ENV_NAME,
  str({ max: MAX_ENV_VALUE, ok: (s) => !UNSAFE_SSH_CHAR.test(s), rule: 'has control or format characters' }),
  MAX_ENV_VARS,
)

const envTemplate: Check<string | null> = nullable((value, path, errs) => {
  const s = str({ max: MAX_ENV_TEMPLATE })(value, path, errs)
  if (s === BAD) return BAD
  // Refs are checked against secretRefs later; here only the template rules, with each ref as a placeholder id.
  const parsed = parseEnvTemplate(s.replace(TEMPLATE_SECRET_REF, (m, ref: string) => (SECRET_REF_KEY.test(ref) ? `\${secret:${PLACEHOLDER_SECRET_ID}}` : m)))
  if (parsed.errors.length === 0) return s
  for (const e of parsed.errors) fail(errs, path, e)
  return BAD
})

const product = object({
  id,
  name: text(MAX_NAME),
  color,
  icon: oneOf(PRODUCT_ICONS),
  description: str({ max: MAX_DESCRIPTION }),
  repoUrl,
}) as Check<ConfigProduct>

const identity = object(
  {
    id,
    vault: vaultRef,
    label: text(MAX_LABEL),
    username: text(MAX_USERNAME),
    auth: oneOf(IDENTITY_AUTHS),
    key: nullable(itemRef),
  },
  (o, path, errs) => (o.auth === 'key' && o.key === null ? fail(errs, `${path}.key`, 'is required for key auth') !== BAD : true),
) as Check<ConfigIdentity>

const host = object({
  id,
  label: text(MAX_LABEL),
  address,
  port: nullable(port),
  identityId: nullableId,
  jumpHostId: nullableId,
  tags: array(str({ min: 1, max: MAX_TAG, pattern: TAG }), MAX_TAGS),
  osIcon: oneOf(OS_ICONS),
  notes: str({ max: MAX_NOTES }),
  keepaliveSec: nullable(int(0, MAX_KEEPALIVE_SEC)),
  envVars,
  vaults: vaultRefs,
}) as Check<ConfigHost>

const environment = object({
  id,
  name: text(MAX_NAME),
  color,
  protected: bool,
  defaultIdentityId: nullableId,
  defaultPort: nullable(port),
  defaultJumpHostId: nullableId,
  versioned: bool,
  autoRollback: bool,
  domain: nullable(str({ max: MAX_URL, ok: (s) => parseEnvDomain(s).ok, rule: 'must be a domain or http(s) URL' })),
  productIds: array(uuid, MAX_LINKS),
  hosts: array(object({ hostId: uuid, role: oneOf(HOST_ROLES) }), MAX_LINKS),
}) as Check<ConfigEnvironment>

const tunnel = object(
  {
    id,
    label: text(MAX_LABEL),
    hostId: uuid,
    environmentId: nullableId,
    type: oneOf(['L', 'R', 'D'] as const),
    bindAddress: str({ min: 1, max: MAX_BIND_ADDRESS, pattern: BIND_ADDRESS }),
    bindPort: int(0, 65535),
    targetHost: nullable(address),
    targetPort: nullable(port),
    autoStart: bool,
    autoReconnect: bool,
  },
  (o, path, errs) =>
    (o.type === 'D') === (o.targetHost === null && o.targetPort === null) && (o.targetHost === null) === (o.targetPort === null)
      ? true
      : fail(errs, `${path}.targetHost`, 'must be set exactly for L and R tunnels') !== BAD,
) as Check<ConfigTunnel>

const deployment = object(
  {
    id,
    environmentId: uuid,
    hostId: uuid,
    name: text(MAX_NAME),
    repoUrl,
    repoPath: str({ max: MAX_REPO_PATH, pattern: REPO_PATH }),
    defaultBranch: str({ max: MAX_GIT_REF_INPUT, pattern: GIT_REF }),
    composeFile: str({ max: MAX_COMPOSE_FILE_INPUT, pattern: COMPOSE_FILE }),
    composeProject: nullable(str({ max: MAX_COMPOSE_NAME, pattern: COMPOSE_PROJECT })),
    deployTag: str({ max: MAX_GIT_REF_INPUT, pattern: GIT_REF }),
    position: int(0, MAX_POSITION),
    urls: array(object({ url: httpUrl(MAX_HEALTH_URL), from: oneOf(['host', 'mac'] as const) }), MAX_URLS),
    healthStatus: int(...HEALTH_STATUS_RANGE),
    healthTimeoutSec: int(...HEALTH_TIMEOUT_RANGE),
    dbBackup: bool,
    backupDir: nullable(str({ max: MAX_REPO_PATH, pattern: BACKUP_DIR })),
    preHook: nullable(str({ max: MAX_HOOK })),
    postHook: nullable(str({ max: MAX_HOOK })),
    buildTimeoutSec: int(...STEP_TIMEOUT_RANGE),
    composeTimeoutSec: int(...STEP_TIMEOUT_RANGE),
    useSudo: oneOf(['auto', 'yes', 'no'] as const),
    becomeSecret: nullable(str({ max: 16, pattern: SECRET_REF_KEY })),
    vaults: vaultRefs,
    managedEnv: bool,
    envTemplate,
  },
  (o, path, errs) => {
    let ok = true
    if (o.dbBackup && o.backupDir === null) ok = fail(errs, `${path}.backupDir`, 'is required when dbBackup is on') !== BAD
    if (o.managedEnv && o.envTemplate === null) ok = fail(errs, `${path}.envTemplate`, 'is required when managedEnv is on') !== BAD
    return ok
  },
) as Check<ConfigDeployment>

const serviceCommon = {
  id,
  environmentId: uuid,
  name: text(MAX_NAME),
  position: int(0, MAX_POSITION),
  description: str({ max: MAX_DESCRIPTION }),
}
const appService = object({
  ...serviceCommon,
  kind: oneOf(['service'] as const),
  deploymentId: nullableId,
  composeService: str({ min: 1, max: MAX_COMPOSE_NAME, pattern: COMPOSE_SERVICE }),
  url: nullable(httpUrl(MAX_URL)),
  urlCheckFrom: oneOf(['mac', 'host'] as const),
}) as Check<ConfigAppService>
const dbService = object({
  ...serviceCommon,
  kind: oneOf(['db'] as const),
  dbEngine: oneOf(['postgres', 'mysql', 'mongodb', 'redis', 'other'] as const),
  dbAddress: address,
  dbPort: port,
  viaHostId: nullableId,
  localPort: nullable(port),
  tunnelId: nullableId,
}) as Check<ConfigDbService>
const service: Check<ConfigService> = (value, path, errs) => {
  const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined
  if (kind === 'service') return appService(value, path, errs)
  if (kind === 'db') return dbService(value, path, errs)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(errs, path, 'must be an object')
  return fail(errs, `${path}.kind`, 'is not an allowed value')
}

// No limit of their own for products, identities, hosts or environments: the 5 MB cap bounds them.
const BIG = Number.MAX_SAFE_INTEGER
const fileShape = object({
  format: oneOf([CONFIG_FORMAT] as const),
  version: (v: unknown, path: string, errs: string[]) => (v === CONFIG_VERSION ? CONFIG_VERSION : fail(errs, path, 'is not a supported version')),
  exportedAt: str({ max: 64, ok: (s) => !Number.isNaN(Date.parse(s)), rule: 'must be an ISO timestamp' }),
  secretRefs: record(SECRET_REF_KEY, itemRef, BIG),
  products: array(product, BIG),
  identities: array(identity, BIG),
  hosts: array(host, BIG),
  environments: array(environment, BIG),
  tunnels: array(tunnel, MAX_TUNNELS),
  deployments: array(deployment, MAX_DEPLOYMENTS),
  services: array(service, MAX_SERVICES),
}) as Check<ConfigFile>

/** Duplicate ids and references to ids (or secret refs) that the file doesn't define. */
function checkReferences(file: ConfigFile, errs: string[]): void {
  const ids = <T extends { id: string }>(list: T[], name: string): Set<string> => {
    const seen = new Set<string>()
    list.forEach((x, i) => {
      if (seen.has(x.id)) fail(errs, `$.${name}[${i}].id`, 'is a duplicate id')
      seen.add(x.id)
    })
    return seen
  }
  const products = ids(file.products, 'products')
  const identities = ids(file.identities, 'identities')
  const hosts = ids(file.hosts, 'hosts')
  const envs = ids(file.environments, 'environments')
  const tunnels = ids(file.tunnels, 'tunnels')
  const deployments = ids(file.deployments, 'deployments')
  ids(file.services, 'services')
  const refs = new Set(Object.keys(file.secretRefs))
  const ref = (set: Set<string>, what: string, value: string | null, path: string): void => {
    if (value !== null && !set.has(value)) fail(errs, path, `is not ${what} in this file`)
  }

  file.hosts.forEach((h, i) => {
    const p = `$.hosts[${i}]`
    ref(identities, 'an identity', h.identityId, `${p}.identityId`)
    if (h.jumpHostId === h.id) fail(errs, `${p}.jumpHostId`, "can't be the host itself")
    else ref(hosts, 'a host', h.jumpHostId, `${p}.jumpHostId`)
  })
  file.environments.forEach((e, i) => {
    const p = `$.environments[${i}]`
    ref(identities, 'an identity', e.defaultIdentityId, `${p}.defaultIdentityId`)
    ref(hosts, 'a host', e.defaultJumpHostId, `${p}.defaultJumpHostId`)
    e.productIds.forEach((pid, j) => ref(products, 'a product', pid, `${p}.productIds[${j}]`))
    e.hosts.forEach((m, j) => ref(hosts, 'a host', m.hostId, `${p}.hosts[${j}].hostId`))
  })
  file.tunnels.forEach((t, i) => {
    ref(hosts, 'a host', t.hostId, `$.tunnels[${i}].hostId`)
    ref(envs, 'an environment', t.environmentId, `$.tunnels[${i}].environmentId`)
  })
  file.deployments.forEach((d, i) => {
    const p = `$.deployments[${i}]`
    ref(envs, 'an environment', d.environmentId, `${p}.environmentId`)
    ref(hosts, 'a host', d.hostId, `${p}.hostId`)
    ref(refs, 'a secret ref', d.becomeSecret, `${p}.becomeSecret`)
    if (d.envTemplate !== null && [...d.envTemplate.matchAll(TEMPLATE_SECRET_REF)].some((m) => !refs.has(m[1]))) {
      fail(errs, `${p}.envTemplate`, 'refers to a secret ref not in this file')
    }
  })
  file.services.forEach((s, i) => {
    const p = `$.services[${i}]`
    ref(envs, 'an environment', s.environmentId, `${p}.environmentId`)
    if (s.kind === 'service') {
      ref(deployments, 'a checkout', s.deploymentId, `${p}.deploymentId`)
    } else {
      ref(hosts, 'a host', s.viaHostId, `${p}.viaHostId`)
      ref(tunnels, 'a tunnel', s.tunnelId, `${p}.tunnelId`)
    }
  })
}

/** Strict: unknown keys at any level, wrong types and dangling ids are errors. Messages carry a JSON path, never a value. */
export function parseConfigFile(text: string): { ok: true; file: ConfigFile } | { ok: false; errors: string[] } {
  if (new TextEncoder().encode(text).length > CONFIG_MAX_BYTES) return { ok: false, errors: ['The file is larger than 5 MB'] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // JSON.parse messages quote the text around the error: never pass them on.
    return { ok: false, errors: ["The file isn't valid JSON"] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw as { format?: unknown }).format !== CONFIG_FORMAT) {
    return { ok: false, errors: ["This isn't an OpsDeck config file"] }
  }
  const version = (raw as { version?: unknown }).version
  if (typeof version === 'number' && version > CONFIG_VERSION) return { ok: false, errors: ['This file is from a newer OpsDeck'] }

  const errs: string[] = []
  const file = fileShape(raw, '$', errs)
  if (file !== BAD) checkReferences(file, errs)
  if (file === BAD || errs.length > 0) {
    const errors = errs.length > MAX_ERRORS ? [...errs.slice(0, MAX_ERRORS), `and ${errs.length - MAX_ERRORS} more problems`] : errs
    return { ok: false, errors }
  }
  return { ok: true, file }
}

// ---- Import ----

export type ImportAction = 'add' | 'update' | 'unchanged' | 'skip'
export const IMPORT_ACTIONS: readonly ImportAction[] = ['add', 'update', 'unchanged', 'skip']

/** One object in the file and what the import does with it; `id` is the local id it lands on (the file's for an add). */
export interface ImportItem {
  kind: keyof ConfigCounts
  id: string
  name: string
  action: ImportAction
  reason?: string
  /** For an update: the fields that differ. */
  fields?: string[]
}

/** A field the import leaves unset because the secret (or the object holding one) isn't here; `reason` says why when it isn't plain. */
export interface ImportNeedsSecret {
  kind: keyof ConfigCounts
  name: string
  field: string
  reason?: string
}

export interface ImportPreview {
  token: string
  items: ImportItem[]
  counts: Record<ImportAction, number>
  needsSecret: ImportNeedsSecret[]
  /** Existing protected environments the import changes: each name must be typed to confirm. */
  protectedEnvironments: string[]
}

export interface ImportResult {
  counts: Record<ImportAction, number>
  needsSecret: ImportNeedsSecret[]
}
