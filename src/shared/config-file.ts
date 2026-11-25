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
  MAX_PROVIDER,
  PRODUCT_ICONS,
  REGION_CODE,
  REPO_URL,
  TAG,
  UNSAFE_SSH_CHAR,
  hasRepoCredentials,
  isParsableRepoUrl,
  parseEnvDomain,
  type HostRole,
  type OsIcon,
  type ProductIcon,
} from './inventory'
import { LOG_TAIL_MAX, VARIABLE_NAME } from './ops'
import {
  BUILTINS,
  MAX_PARAMS,
  MAX_RUNBOOKS,
  MAX_RUNBOOK_DESCRIPTION,
  MAX_RUNBOOK_NAME,
  MAX_UNTIL_HOURS,
  type BuiltinKind,
  type RunbookParam,
} from './runbooks'
import { MAX_SERVICES, type DbEngine } from './services'
import {
  ENV_NAME as STEP_ENV_NAME,
  MAX_FLOW_STAGES,
  MAX_STEPS_PER_CHECKOUT,
  MAX_STEP_SCRIPT,
  MAX_WHEN_PATHS,
  STEP_ANCHORS,
  WHEN_PATH,
  type Step,
  type StepBody,
  type StepWhen,
} from './steps'
import { BIND_ADDRESS, MAX_BIND_ADDRESS, MAX_TUNNEL_MAX_MINUTES, MAX_TUNNELS, type TunnelType } from './tunnels'
import { IDENTITY_AUTHS, MAX_LABEL, MAX_SECRET_NAME, MAX_USERNAME, MAX_VAULT_NAME, VAULT_COLOR, type IdentityAuth } from './vault'

export const CONFIG_FORMAT = 'credops-config'
/** Files exported before the app was renamed from OpsDeck; read as CONFIG_FORMAT. */
export const LEGACY_CONFIG_FORMAT = 'opsdeck-config'
export const CONFIG_VERSION = 2
export const CONFIG_MAX_BYTES = 5 * 1024 * 1024
export const CONFIG_FILE_NAME = 'credops-config.json'
/** The save dialog's default name: `credops-hosts.json` for a page's part. */
export const configFileName = (segment?: ConfigSegment): string => (segment ? `credops-${segment}.json` : CONFIG_FILE_NAME)

export interface VaultRef {
  vaultName: string
}
/** A secret's name or an ssh key's label, in a vault named by name. */
export interface ItemRef {
  vaultName: string
  itemName: string
}

/** A step's secret: `secret` is a `secretRefs` key, never a secret id or value. */
export interface ConfigStepSecret {
  envName: string
  secret: string
}
export type ConfigStepBody = Omit<StepBody, 'secrets'> & { secrets: ConfigStepSecret[] }
export type ConfigStep = Omit<Step, 'secrets'> & { secrets: ConfigStepSecret[] }
export type ConfigFlowStage = { kind: 'services'; serviceIds: string[] } | { kind: 'step'; serviceId: string; step: ConfigStepBody }
export interface ConfigFlow {
  stages: ConfigFlowStage[]
  onFailure: 'stop-all' | 'continue-other-hosts'
}
export type ConfigRunbookItem = { type: 'step'; step: ConfigStepBody } | { type: 'builtin'; builtin: BuiltinKind; tail?: number; untilHours?: number }
export interface ConfigRunbook {
  id: string
  environmentId: string
  name: string
  description: string
  targetServiceIds: string[]
  items: ConfigRunbookItem[]
  params: RunbookParam[]
  lock: boolean
  notify: boolean
}

export interface ConfigRegion {
  id: string
  code: string
  provider: string
  displayName: string
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
  /** Null only in a version 1 file: the import puts those hosts in the region the user picks. */
  regionId: string | null
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
  /** Absent in files from before playbook ops: a new environment gets 4 true and 3, an existing one keeps its own. */
  parallelPrepare?: boolean
  prepareCap?: number
  /** Written only when the environment has a flow. */
  flow?: ConfigFlow
  /** Null only for a version 1 environment that had no product: the import puts it in Unassigned. */
  productId: string | null
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
  /** Absent in a file from before time limits: the tunnel keeps (or gets) the default. */
  maxMinutes?: number | null
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
  /** Written only when the checkout has saved steps; without them the hooks stand in (effectiveSteps). */
  steps?: ConfigStep[]
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
  /** Absent in files from before services ran on hosts: the checkout's host, else one in the environment. */
  hostId?: string
  deploymentId: string | null
  composeService: string
  url: string | null
  urlCheckFrom: HealthFrom
  skipUnchanged?: boolean
}
export interface ConfigDbService {
  id: string
  environmentId: string
  name: string
  kind: 'db'
  position: number
  description: string
  /** The host the database lives on. Older files only carry `viaHostId`. */
  hostId?: string
  dbEngine: DbEngine
  dbAddress: string
  dbPort: number
  /** Written equal to `hostId` for older readers. */
  viaHostId: string | null
  localPort: number | null
  tunnelId: string | null
}
export interface ConfigBastionService {
  id: string
  environmentId: string
  name: string
  kind: 'bastion'
  position: number
  description: string
  hostId: string
}
export type ConfigService = ConfigAppService | ConfigDbService | ConfigBastionService

export interface ConfigFile {
  format: typeof CONFIG_FORMAT
  version: typeof CONFIG_VERSION
  exportedAt: string
  /** Keys `ref-1`, `ref-2`…, assigned in (vaultName, itemName) order. */
  secretRefs: Record<string, ItemRef>
  regions: ConfigRegion[]
  products: ConfigProduct[]
  identities: ConfigIdentity[]
  hosts: ConfigHost[]
  environments: ConfigEnvironment[]
  tunnels: ConfigTunnel[]
  deployments: ConfigDeployment[]
  services: ConfigService[]
  /** Written only when there are runbooks. */
  runbooks?: ConfigRunbook[]
  /**
   * Set when the file was version 1 (read, never written): each environment's product links as they were, so the
   * import can say what it kept. `productId` holds the one kept, the product whose name sorts first.
   */
  fromV1?: { productIds: Record<string, string[]> }
}

export interface ConfigCounts {
  regions: number
  products: number
  identities: number
  hosts: number
  environments: number
  tunnels: number
  deployments: number
  services: number
  runbooks: number
}

export const countConfig = (file: ConfigFile): ConfigCounts => ({
  regions: file.regions.length,
  products: file.products.length,
  identities: file.identities.length,
  hosts: file.hosts.length,
  environments: file.environments.length,
  tunnels: file.tunnels.length,
  deployments: file.deployments.length,
  services: file.services.length,
  runbooks: file.runbooks?.length ?? 0,
})

/**
 * The pages that import and export their own part of the config. A segment file is a normal config file: the page's
 * own kinds, plus what they refer to (added on import only when missing here).
 */
export const CONFIG_SEGMENTS = ['hosts', 'products', 'tunnels', 'deployments'] as const
export type ConfigSegment = (typeof CONFIG_SEGMENTS)[number]
/** The kinds each page lists or edits. */
export const SEGMENT_KINDS: Record<ConfigSegment, readonly (keyof ConfigCounts)[]> = {
  // RegionsDialog edits regions; the login dialog creates identities.
  hosts: ['regions', 'identities', 'hosts'],
  // The environment view edits services, the release flow and runbooks.
  products: ['products', 'environments', 'services', 'runbooks'],
  tunnels: ['tunnels'],
  deployments: ['deployments'],
}

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

type Optional<T> = Check<T> & { optional: true }
/** A key that may be missing; when present it is checked like any other. */
const optional = <T>(check: Check<T>): Optional<T> => Object.assign((value: unknown, path: string, errs: string[]) => check(value, path, errs), { optional: true as const })

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
        if ((check as Partial<Optional<unknown>>).optional) continue
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
  if (!isParsableRepoUrl(s)) return fail(errs, path, 'must be a valid URL')
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

/** One of several object shapes, picked by the value of `field`. */
const tagged =
  <T>(field: string, shapes: Record<string, Check<T>>): Check<T> =>
  (value, path, errs) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(errs, path, 'must be an object')
    const kind = (value as Record<string, unknown>)[field]
    if (typeof kind !== 'string' || !Object.hasOwn(shapes, kind)) return fail(errs, `${path}.${field}`, 'is not an allowed value')
    return shapes[kind](value, path, errs)
  }

// Steps, flows and runbooks. Shapes, enums and bounds only: the stores' own validators (validateStep, validateRunbook)
// run again on every row at import, because the content rules need the local secrets and services.
const stepWhen = tagged<StepWhen>('kind', {
  always: object({ kind: oneOf(['always'] as const) }) as Check<StepWhen>,
  changed: object({ kind: oneOf(['changed'] as const) }) as Check<StepWhen>,
  paths: object({ kind: oneOf(['paths'] as const), paths: array(str({ min: 1, max: 200, pattern: WHEN_PATH }), MAX_WHEN_PATHS) }) as Check<StepWhen>,
})
const stepBodyFields = {
  id: str({ min: 1, max: 32 }),
  name: str({ min: 1, max: MAX_NAME }),
  run: oneOf(['shell', 'compose-exec'] as const),
  service: nullable(str({ min: 1, max: MAX_COMPOSE_NAME })),
  script: str({ min: 1, max: MAX_STEP_SCRIPT }),
  cwd: nullable(str({ max: MAX_REPO_PATH })),
  sudo: oneOf(['docker', 'yes', 'no'] as const),
  timeoutSec: int(...STEP_TIMEOUT_RANGE),
  onFailure: oneOf(['stop', 'continue'] as const),
  when: stepWhen,
  // `secret` is a `secretRefs` key (checked against the file later).
  secrets: array(object({ envName: str({ max: 64, pattern: STEP_ENV_NAME }), secret: str({ max: 16, pattern: SECRET_REF_KEY }) }), 10),
}
const stepBody = object(stepBodyFields) as Check<ConfigStepBody>
const configStep = object({ ...stepBodyFields, anchor: oneOf(STEP_ANCHORS), alsoOnRollback: bool }) as Check<ConfigStep>
const flowStage = tagged<ConfigFlowStage>('kind', {
  services: object({ kind: oneOf(['services'] as const), serviceIds: array(uuid, MAX_SERVICES) }) as Check<ConfigFlowStage>,
  step: object({ kind: oneOf(['step'] as const), serviceId: uuid, step: stepBody }) as Check<ConfigFlowStage>,
})
const flow = object({ stages: array(flowStage, MAX_FLOW_STAGES), onFailure: oneOf(['stop-all', 'continue-other-hosts'] as const) }) as Check<ConfigFlow>
const runbookItem = tagged<ConfigRunbookItem>('type', {
  step: object({ type: oneOf(['step'] as const), step: stepBody }) as Check<ConfigRunbookItem>,
  builtin: object({
    type: oneOf(['builtin'] as const),
    builtin: oneOf(BUILTINS),
    tail: optional(int(1, LOG_TAIL_MAX)),
    untilHours: optional(int(1, MAX_UNTIL_HOURS)),
  }) as Check<ConfigRunbookItem>,
})
const runbookParam = object({
  name: str({ max: 64, pattern: VARIABLE_NAME }),
  label: str({ min: 1, max: 64 }),
  type: oneOf(['text', 'choice'] as const),
  pattern: oneOf(['identifier', 'number', 'path', 'free'] as const),
  choices: array(str({ min: 1, max: 100 }), 50),
}) as Check<RunbookParam>
const runbook = object({
  id,
  environmentId: uuid,
  name: str({ min: 1, max: MAX_RUNBOOK_NAME }),
  description: str({ max: MAX_RUNBOOK_DESCRIPTION }),
  targetServiceIds: array(uuid, MAX_SERVICES),
  items: array(runbookItem, MAX_STEPS_PER_CHECKOUT),
  params: array(runbookParam, MAX_PARAMS),
  lock: bool,
  notify: bool,
}) as Check<ConfigRunbook>
const region = object({
  id,
  code: str({ min: 1, max: 63, pattern: REGION_CODE }),
  provider: str({ max: MAX_PROVIDER, ok: (s) => !UNSAFE_SSH_CHAR.test(s), rule: 'has control or format characters' }),
  displayName: text(MAX_NAME),
}) as Check<ConfigRegion>

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

const hostFields = {
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
}
const host = object({ ...hostFields, regionId: uuid }) as Check<ConfigHost>

const environmentFields = {
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
  parallelPrepare: optional(bool),
  prepareCap: optional(int(1, 8)),
  flow: optional(flow),
  hosts: array(object({ hostId: uuid, role: oneOf(HOST_ROLES) }), MAX_LINKS),
}
const environment = object({ ...environmentFields, productId: uuid }) as Check<ConfigEnvironment>

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
    maxMinutes: optional(nullable(int(1, MAX_TUNNEL_MAX_MINUTES))),
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
    steps: optional(array(configStep, MAX_STEPS_PER_CHECKOUT)),
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
  hostId: optional(uuid),
  deploymentId: nullableId,
  composeService: str({ max: MAX_COMPOSE_NAME, ok: (s) => s === '' || COMPOSE_SERVICE.test(s) }),
  url: nullable(httpUrl(MAX_URL)),
  urlCheckFrom: oneOf(['mac', 'host'] as const),
  skipUnchanged: optional(bool),
}) as Check<ConfigAppService>
const dbService = object({
  ...serviceCommon,
  kind: oneOf(['db'] as const),
  hostId: optional(uuid),
  dbEngine: oneOf(['postgres', 'mysql', 'mongodb', 'redis', 'other'] as const),
  dbAddress: address,
  dbPort: port,
  viaHostId: nullableId,
  localPort: nullable(port),
  tunnelId: nullableId,
}) as Check<ConfigDbService>
const bastionService = object({
  ...serviceCommon,
  kind: oneOf(['bastion'] as const),
  hostId: uuid,
}) as Check<ConfigBastionService>
const service: Check<ConfigService> = (value, path, errs) => {
  const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined
  if (kind === 'service') return appService(value, path, errs)
  if (kind === 'db') return dbService(value, path, errs)
  if (kind === 'bastion') return bastionService(value, path, errs)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(errs, path, 'must be an object')
  return fail(errs, `${path}.kind`, 'is not an allowed value')
}

// No limit of their own for products, identities, hosts or environments: the 5 MB cap bounds them.
const BIG = Number.MAX_SAFE_INTEGER
const version =
  (n: number): Check<number> =>
  (v, path, errs) =>
    v === n ? n : fail(errs, path, 'is not a supported version')
// Both versions check the keys in file order, so errors come out in that order too.
const exportedAt = str({ max: 64, ok: (s) => !Number.isNaN(Date.parse(s)), rule: 'must be an ISO timestamp' })
const secretRefs = record(SECRET_REF_KEY, itemRef, BIG)
const tail = {
  tunnels: array(tunnel, MAX_TUNNELS),
  deployments: array(deployment, MAX_DEPLOYMENTS),
  services: array(service, MAX_SERVICES),
  runbooks: optional(array(runbook, MAX_RUNBOOKS)),
}
const fileShape = object({
  format: oneOf([CONFIG_FORMAT] as const),
  version: version(CONFIG_VERSION),
  exportedAt,
  secretRefs,
  regions: array(region, BIG),
  products: array(product, BIG),
  identities: array(identity, BIG),
  hosts: array(host, BIG),
  environments: array(environment, BIG),
  ...tail,
}) as Check<ConfigFile>

/** Version 1: no regions, and an environment had any number of products. */
type ConfigFileV1 = Omit<ConfigFile, 'version' | 'regions' | 'hosts' | 'environments' | 'fromV1'> & {
  version: 1
  hosts: Omit<ConfigHost, 'regionId'>[]
  environments: (Omit<ConfigEnvironment, 'productId'> & { productIds: string[] })[]
}
const fileShapeV1 = object({
  format: oneOf([CONFIG_FORMAT] as const),
  version: version(1),
  exportedAt,
  secretRefs,
  products: array(product, BIG),
  identities: array(identity, BIG),
  hosts: array(object(hostFields), BIG),
  environments: array(object({ ...environmentFields, productIds: array(uuid, MAX_LINKS) }), BIG),
  ...tail,
}) as Check<ConfigFileV1>

/** Reads a version 1 file as version 2: hosts without a region, and each environment in the product whose name sorts first. */
function upgradeV1(v1: ConfigFileV1): ConfigFile {
  // Lowercased name then id, compared as the upgrade's SQL does.
  const key = new Map(v1.products.map((p) => [p.id, `${p.name.toLowerCase()}\u0000${p.id}`]))
  const first = (ids: string[]): string | null => [...ids].sort((a, b) => ((key.get(a) ?? a) < (key.get(b) ?? b) ? -1 : 1))[0] ?? null
  const { version: _, hosts, environments, ...rest } = v1
  return {
    ...rest,
    version: CONFIG_VERSION,
    regions: [],
    hosts: hosts.map((h) => ({ ...h, regionId: null })),
    environments: environments.map(({ productIds, ...e }) => ({ ...e, productId: first(productIds) })),
    fromV1: { productIds: Object.fromEntries(environments.map((e) => [e.id, e.productIds])) },
  }
}

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
  const regions = ids(file.regions, 'regions')
  const products = ids(file.products, 'products')
  const identities = ids(file.identities, 'identities')
  const hosts = ids(file.hosts, 'hosts')
  const envs = ids(file.environments, 'environments')
  const tunnels = ids(file.tunnels, 'tunnels')
  const deployments = ids(file.deployments, 'deployments')
  const services = ids(file.services, 'services')
  const runbooks = file.runbooks ?? []
  ids(runbooks, 'runbooks')
  const refs = new Set(Object.keys(file.secretRefs))
  const ref = (set: Set<string>, what: string, value: string | null, path: string): void => {
    if (value !== null && !set.has(value)) fail(errs, path, `is not ${what} in this file`)
  }
  const appServices = new Map<string, Set<string>>()
  for (const s of file.services) if (s.kind === 'service') appServices.set(s.environmentId, (appServices.get(s.environmentId) ?? new Set()).add(s.id))
  const appServicesOf = (envId: string): Set<string> => appServices.get(envId) ?? new Set()
  const runbookNames = new Set<string>()
  const checkFlowReferences = (e: ConfigEnvironment, p: string): void => {
    e.flow?.stages.forEach((st, j) => {
      if (st.kind === 'services') st.serviceIds.forEach((sid, k) => ref(appServicesOf(e.id), 'an app service of its environment', sid, `${p}.flow.stages[${j}].serviceIds[${k}]`))
      else {
        ref(appServicesOf(e.id), 'an app service of its environment', st.serviceId, `${p}.flow.stages[${j}].serviceId`)
        st.step.secrets.forEach((sec, k) => ref(refs, 'a secret ref', sec.secret, `${p}.flow.stages[${j}].step.secrets[${k}].secret`))
      }
    })
  }

  file.hosts.forEach((h, i) => {
    const p = `$.hosts[${i}]`
    ref(regions, 'a region', h.regionId, `${p}.regionId`)
    ref(identities, 'an identity', h.identityId, `${p}.identityId`)
    if (h.jumpHostId === h.id) fail(errs, `${p}.jumpHostId`, "can't be the host itself")
    else ref(hosts, 'a host', h.jumpHostId, `${p}.jumpHostId`)
  })
  file.environments.forEach((e, i) => {
    const p = `$.environments[${i}]`
    ref(identities, 'an identity', e.defaultIdentityId, `${p}.defaultIdentityId`)
    ref(hosts, 'a host', e.defaultJumpHostId, `${p}.defaultJumpHostId`)
    if (file.fromV1) file.fromV1.productIds[e.id]?.forEach((pid, j) => ref(products, 'a product', pid, `${p}.productIds[${j}]`))
    else ref(products, 'a product', e.productId, `${p}.productId`)
    e.hosts.forEach((m, j) => ref(hosts, 'a host', m.hostId, `${p}.hosts[${j}].hostId`))
    checkFlowReferences(e, p)
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
    d.steps?.forEach((st, j) => st.secrets.forEach((sec, k) => ref(refs, 'a secret ref', sec.secret, `${p}.steps[${j}].secrets[${k}].secret`)))
    if (d.envTemplate !== null && [...d.envTemplate.matchAll(TEMPLATE_SECRET_REF)].some((m) => !refs.has(m[1]))) {
      fail(errs, `${p}.envTemplate`, 'refers to a secret ref not in this file')
    }
  })
  runbooks.forEach((r, i) => {
    const p = `$.runbooks[${i}]`
    ref(envs, 'an environment', r.environmentId, `${p}.environmentId`)
    r.targetServiceIds.forEach((sid, j) => ref(appServicesOf(r.environmentId), 'an app service of its environment', sid, `${p}.targetServiceIds[${j}]`))
    r.items.forEach((it, j) => {
      if (it.type === 'step') it.step.secrets.forEach((sec, k) => ref(refs, 'a secret ref', sec.secret, `${p}.items[${j}].step.secrets[${k}].secret`))
    })
    const key = `${r.environmentId}\u0000${r.name.trim().toLowerCase()}`
    if (runbookNames.has(key)) fail(errs, `${p}.name`, 'is a duplicate name in its environment')
    runbookNames.add(key)
  })
  file.services.forEach((s, i) => {
    const p = `$.services[${i}]`
    ref(envs, 'an environment', s.environmentId, `${p}.environmentId`)
    if (s.hostId !== undefined) ref(hosts, 'a host', s.hostId, `${p}.hostId`)
    if (s.kind === 'service') {
      ref(deployments, 'a checkout', s.deploymentId, `${p}.deploymentId`)
      if (s.deploymentId !== null && s.composeService === '') fail(errs, `${p}.composeService`, 'is required with a checkout')
    } else if (s.kind === 'db') {
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
  if (typeof raw === 'object' && raw !== null && (raw as { format?: unknown }).format === LEGACY_CONFIG_FORMAT) {
    raw = { ...(raw as object), format: CONFIG_FORMAT }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw as { format?: unknown }).format !== CONFIG_FORMAT) {
    return { ok: false, errors: ["This isn't a CredOps config file"] }
  }
  const version = (raw as { version?: unknown }).version
  if (typeof version === 'number' && version > CONFIG_VERSION) return { ok: false, errors: ['This file is from a newer CredOps'] }

  const errs: string[] = []
  let file: ConfigFile | typeof BAD
  if (version === 1) {
    const v1 = fileShapeV1(raw, '$', errs)
    file = v1 === BAD ? BAD : upgradeV1(v1)
  } else {
    file = fileShape(raw, '$', errs)
  }
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
  /** What the import left alone or mapped, e.g. "region not changed", "kept Leaf, removed Globe". */
  notes?: string[]
}

/** A field the import leaves unset because the secret (or the object holding one) isn't here; `reason` says why when it isn't plain. */
export interface ImportNeedsSecret {
  kind: keyof ConfigCounts
  name: string
  field: string
  reason?: string
}

/** A step the import adds, or changes in what it runs or which secrets it reads: a checkout's, a runbook's or a release flow's. */
export interface ImportStepChange {
  kind: 'deployments' | 'runbooks' | 'environments'
  /** The checkout, runbook or environment's name. */
  owner: string
  step: string
  action: 'add' | 'update'
  script: string
  /** An update that changes the script: the script here now. */
  before?: string
  /** The secrets the step reads, as `vault / item`; `gained` when the step here doesn't read it already. */
  secrets: { envName: string; secret: string; gained: boolean }[]
}

export interface ImportPreview {
  token: string
  items: ImportItem[]
  counts: Record<ImportAction, number>
  needsSecret: ImportNeedsSecret[]
  steps: ImportStepChange[]
  /** Existing protected environments the import changes: each name must be typed to confirm. */
  protectedEnvironments: string[]
  /** A version 1 file adds hosts: the apply needs the region to put them in. */
  needsRegion: boolean
  /** A page import only: how many objects in the file are neither the page's kinds nor needed by them. */
  ignored?: number
}

export interface ImportResult {
  counts: Record<ImportAction, number>
  needsSecret: ImportNeedsSecret[]
}
