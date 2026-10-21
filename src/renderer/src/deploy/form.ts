import {
  BACKUP_DIR,
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  GIT_REF,
  MAX_ENV_TEMPLATE,
  MAX_HOOK,
  MAX_URL,
  MAX_URLS,
  REPO_PATH,
  parseEnvTemplate,
  type DeploymentInput,
  type DeploymentMeta,
  type HealthUrl,
  type UseSudo,
} from '../../../shared/deploy'
import { MAX_NAME, REPO_URL, REPO_URL_CREDENTIALS_MSG, hasRepoCredentials } from '../../../shared/inventory'
import { DEFAULT_VAULT_ID } from '../../../shared/vault'

export interface DeploymentForm {
  name: string
  hostId: string
  repoUrl: string
  composeProject: string
  repoPath: string
  defaultBranch: string
  composeFile: string
  deployTag: string
  urls: HealthUrl[]
  healthStatus: string
  healthTimeoutSec: string
  dbBackup: boolean
  backupDir: string
  buildTimeoutSec: string
  composeTimeoutSec: string
  useSudo: UseSudo
  becomeSecretId: string
  preHook: string
  postHook: string
  managedEnv: boolean
  envTemplate: string
  vaultIds: string[]
}

export type FormField = keyof DeploymentForm

export function blankForm(hostId = ''): DeploymentForm {
  return {
    name: '',
    hostId,
    repoUrl: '',
    composeProject: '',
    repoPath: '',
    defaultBranch: 'main',
    composeFile: 'docker-compose.yml',
    deployTag: '',
    urls: [],
    healthStatus: '200',
    healthTimeoutSec: '60',
    dbBackup: false,
    backupDir: '',
    buildTimeoutSec: '300',
    composeTimeoutSec: '120',
    useSudo: 'auto',
    becomeSecretId: '',
    preHook: '',
    postHook: '',
    managedEnv: false,
    envTemplate: '',
    vaultIds: [DEFAULT_VAULT_ID],
  }
}

export function formFrom(d: DeploymentMeta): DeploymentForm {
  return {
    name: d.name,
    hostId: d.hostId,
    repoUrl: d.repoUrl ?? '',
    composeProject: d.composeProject ?? '',
    repoPath: d.repoPath,
    defaultBranch: d.defaultBranch,
    composeFile: d.composeFile,
    deployTag: d.deployTag,
    urls: d.urls.map((u) => ({ ...u })),
    healthStatus: String(d.healthStatus),
    healthTimeoutSec: String(d.healthTimeoutSec),
    dbBackup: d.dbBackup,
    backupDir: d.backupDir ?? '',
    buildTimeoutSec: String(d.buildTimeoutSec),
    composeTimeoutSec: String(d.composeTimeoutSec),
    useSudo: d.useSudo,
    becomeSecretId: d.becomeSecretId ?? '',
    preHook: d.preHook ?? '',
    postHook: d.postHook ?? '',
    managedEnv: d.managedEnv,
    envTemplate: d.envTemplate ?? '',
    vaultIds: [...d.vaultIds],
  }
}

const REF_RULE = 'letters, digits and . _ / - only, with no "..", "//" or leading "-"'

const whole = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN)

function rangeError(label: string, text: string, min: number, max: number, unit = ''): string | undefined {
  const n = whole(text)
  return n >= min && n <= max ? undefined : `${label} must be a whole number from ${min} to ${max}${unit}`
}

export function urlError(u: HealthUrl): string | undefined {
  const text = u.url.trim()
  if (!text) return 'Enter a URL'
  if (text.length > MAX_URL) return `A URL can be at most ${MAX_URL} characters`
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'A health URL must start with http:// or https://'
  } catch {
    return 'A health URL must start with http:// or https://'
  }
  return undefined
}

/** Messages name the rule that failed, never the value that failed it. */
export function checkForm(f: DeploymentForm): { errors: Partial<Record<FormField, string>>; urlErrors: (string | undefined)[]; envLines: string[] } {
  const errors: Partial<Record<FormField, string>> = {}
  const name = f.name.trim()
  if (!name) errors.name = 'Give the deployment a name'
  else if (name.length > MAX_NAME) errors.name = `A name can be at most ${MAX_NAME} characters`
  if (!f.hostId) errors.hostId = 'Pick the host it runs on'
  if (!REPO_PATH.test(f.repoPath)) errors.repoPath = 'Use an absolute path (letters, digits and . _ @ + / -), with no ".." or "//"'
  if (!GIT_REF.test(f.defaultBranch)) errors.defaultBranch = `A branch name uses ${REF_RULE}`
  if (!GIT_REF.test(f.deployTag)) errors.deployTag = `A tag name uses ${REF_RULE}`
  if (!COMPOSE_FILE.test(f.composeFile)) errors.composeFile = 'Use a relative path (letters, digits and . _ / -), with no ".."'
  const repoUrl = f.repoUrl.trim()
  if (repoUrl && (repoUrl.length > MAX_URL || !REPO_URL.test(repoUrl))) errors.repoUrl = 'Use an http(s), ssh:// or git@ URL, with no spaces'
  else if (repoUrl && hasRepoCredentials(repoUrl)) errors.repoUrl = REPO_URL_CREDENTIALS_MSG
  const project = f.composeProject.trim()
  if (project && !COMPOSE_PROJECT.test(project)) errors.composeProject = 'A compose project uses letters, digits and . _ -, and starts with a letter or digit'
  if (f.dbBackup && !BACKUP_DIR.test(f.backupDir)) errors.backupDir = 'Use an absolute path for backups (letters, digits and . _ @ + / -), with no ".." or "//"'
  const status = rangeError('The status', f.healthStatus, 100, 599)
  if (status) errors.healthStatus = status
  const health = rangeError('The timeout', f.healthTimeoutSec, 5, 600, ' seconds')
  if (health) errors.healthTimeoutSec = health
  const build = rangeError('The build timeout', f.buildTimeoutSec, 10, 3600, ' seconds')
  if (build) errors.buildTimeoutSec = build
  const compose = rangeError('The compose timeout', f.composeTimeoutSec, 10, 3600, ' seconds')
  if (compose) errors.composeTimeoutSec = compose
  if (f.urls.length > MAX_URLS) errors.urls = `At most ${MAX_URLS} health URLs`
  if (f.preHook.length > MAX_HOOK) errors.preHook = `A hook can be at most ${MAX_HOOK} characters`
  if (f.postHook.length > MAX_HOOK) errors.postHook = `A hook can be at most ${MAX_HOOK} characters`
  const urlErrors = f.urls.map(urlError)
  let envLines: string[] = []
  if (f.managedEnv) {
    if (f.envTemplate.length > MAX_ENV_TEMPLATE) errors.envTemplate = `The template can be at most ${MAX_ENV_TEMPLATE} characters`
    else {
      envLines = parseEnvTemplate(f.envTemplate).errors
      if (envLines.length) errors.envTemplate = envLines[0]
    }
  }
  return { errors, urlErrors, envLines }
}

export function isValid(f: DeploymentForm): boolean {
  const { errors, urlErrors } = checkForm(f)
  return Object.keys(errors).length === 0 && urlErrors.every((e) => !e)
}

/** The wire shape for a create. */
export function toInput(f: DeploymentForm, environmentId: string, position?: number): DeploymentInput {
  const hook = (t: string) => (t.trim() ? t : null)
  return {
    name: f.name.trim(),
    environmentId,
    hostId: f.hostId,
    repoUrl: f.repoUrl.trim() || null,
    composeProject: f.composeProject.trim() || null,
    repoPath: f.repoPath,
    defaultBranch: f.defaultBranch,
    deployTag: f.deployTag,
    composeFile: f.composeFile,
    ...(position !== undefined ? { position } : {}),
    urls: f.urls.map((u) => ({ url: u.url.trim(), from: u.from })),
    healthStatus: whole(f.healthStatus),
    healthTimeoutSec: whole(f.healthTimeoutSec),
    dbBackup: f.dbBackup,
    backupDir: f.dbBackup ? f.backupDir : null,
    preHook: hook(f.preHook),
    postHook: hook(f.postHook),
    buildTimeoutSec: whole(f.buildTimeoutSec),
    composeTimeoutSec: whole(f.composeTimeoutSec),
    useSudo: f.useSudo,
    becomeSecretId: f.useSudo === 'no' ? null : f.becomeSecretId || null,
    managedEnv: f.managedEnv,
    envTemplate: f.managedEnv ? f.envTemplate : null,
    vaultIds: f.vaultIds,
  }
}

/** Only the fields that differ from the saved deployment. */
export function toPatch(f: DeploymentForm, original: DeploymentMeta): Partial<DeploymentInput> {
  const next = toInput(f, original.environmentId)
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) {
    if (k === 'environmentId') continue
    if (JSON.stringify(v) !== JSON.stringify(original[k as keyof DeploymentMeta])) patch[k] = v
  }
  return patch as Partial<DeploymentInput>
}

/** A name for a secret as an env key: `Stripe key` becomes `STRIPE_KEY`. */
export function envKeyFor(name: string): string {
  const k = name.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[A-Z_]/.test(k) ? k : `_${k}`
}
