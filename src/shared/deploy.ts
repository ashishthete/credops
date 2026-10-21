// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).

// ---- Limits ----
export const MAX_DEPLOYMENTS = 512
export const MAX_URLS = 8
export const MAX_HOOK = 4000
export const MAX_ENV_TEMPLATE = 32768
export const MAX_COMMITS = 500
export const MAX_LOG_LINE = 4096
export const MAX_EVENTS_PER_RELEASE = 50000
export const EVENT_BATCH_MS = 100
export const MAX_ACTIVE_RELEASES = 4
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000
export const DISK_WARN_KB = 2 * 1024 * 1024
export const CANCEL_GRACE_MS = 10000
export const KILL_GRACE_MS = 5000
export const PREPARE_DIAL_TIMEOUT_MS = 20000
/** Where a release keeps its remote files, under the login user's home. The playbook and the live log tap share it. */
export const RUNS_SUBDIR = '.opsdeck/runs'

// ---- Validation rules (they make generated YAML and shell injection impossible) ----
export const REPO_PATH = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.(?:\/|$))\/[A-Za-z0-9._@+/-]{1,255}(?<!\/)$/
export const BACKUP_DIR = REPO_PATH
export const GIT_REF = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)(?!-)[A-Za-z0-9._/-]{1,200}$/
export const COMPOSE_FILE = /^(?!\/)(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/
export const VERSION = /^v\d+\.\d+\.\d+$/
export const COMPOSE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
/** A service name inside a compose file: the same rule, so it can never look like an option or carry shell syntax. */
export const COMPOSE_SERVICE = COMPOSE_PROJECT
export const MAX_URL = 2048
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Errors cross IPC as messages only, so the renderer matches on this text. */
export const BREAK_LOCK_CONFIRM_MESSAGE = 'Type the host label to confirm'
export const REDEPLOY_CONFIRM_MESSAGE = 'Nothing new to deploy. Confirm to redeploy the current commits'
export const MAX_EVENTS_PAGE = 5000
// Deployment field limits, shared by the store, the IPC validators and the config file reader.
export const MAX_REPO_PATH = 1024
export const MAX_GIT_REF_INPUT = 255
export const MAX_COMPOSE_FILE_INPUT = 255
export const MAX_COMPOSE_NAME = 63
export const MAX_POSITION = 1_000_000
export const HEALTH_STATUS_RANGE = [100, 599] as const
export const HEALTH_TIMEOUT_RANGE = [5, 600] as const
export const STEP_TIMEOUT_RANGE = [10, 3600] as const

/** http(s) only, no credentials, no spaces, braces or control characters: the rule for health and service URLs. */
export function isHttpUrl(url: string): boolean {
  if (url.length === 0 || /[{}\s\u0000-\u001f]/.test(url)) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}
export const MAX_RELEASE_NOTES = 20000

// ---- Basic types ----
export type UseSudo = 'auto' | 'yes' | 'no'
export type DockerMode = 'plain' | 'sudo' | 'sudo-password'
export type HealthFrom = 'host' | 'mac'
export interface HealthUrl {
  url: string
  from: HealthFrom
}

export interface DeploymentMeta {
  id: string
  name: string
  environmentId: string
  hostId: string
  repoUrl: string | null
  composeProject: string | null
  repoPath: string
  defaultBranch: string
  composeFile: string
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
  becomeSecretId: string | null
  managedEnv: boolean
  envTemplate: string | null
  vaultIds: string[]
  createdAt: string
  updatedAt: string
}

/** Defaults: composeFile 'docker-compose.yml', urls [], healthStatus 200, healthTimeoutSec 60, buildTimeoutSec 300, composeTimeoutSec 120, useSudo 'auto'. */
export interface DeploymentInput {
  name: string
  environmentId: string
  hostId: string
  repoPath: string
  defaultBranch: string
  deployTag: string
  repoUrl?: string | null
  composeProject?: string | null
  composeFile?: string
  position?: number
  urls?: HealthUrl[]
  healthStatus?: number
  healthTimeoutSec?: number
  dbBackup?: boolean
  backupDir?: string | null
  preHook?: string | null
  postHook?: string | null
  buildTimeoutSec?: number
  composeTimeoutSec?: number
  useSudo?: UseSudo
  becomeSecretId?: string | null
  managedEnv?: boolean
  envTemplate?: string | null
  vaultIds?: string[]
}
/** Explicit nulls clear nullable fields. */
export type DeploymentPatch = Partial<DeploymentInput>

export interface EnvDeploySettings {
  environmentId: string
  versioned: boolean
  autoRollback: boolean
  currentVersion: string | null
}
/** `currentVersion` is a manual correction (null clears it); it must match VERSION. */
export type EnvDeploySettingsPatch = Partial<Pick<EnvDeploySettings, 'versioned' | 'autoRollback' | 'currentVersion'>>

// ---- Versions ----
export type VersionBump = 'major' | 'minor' | 'patch' | 'none'

export function bumpVersion(current: string | null, bump: VersionBump): string | null {
  if (current !== null && !VERSION.test(current)) throw new Error(`invalid version "${current}"`)
  if (bump === 'none') return current
  const m = current === null ? null : /^v(\d+)\.(\d+)\.(\d+)$/.exec(current)
  let [maj, min, pat] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
  if (bump === 'major') [maj, min, pat] = [maj + 1, 0, 0]
  else if (bump === 'minor') [min, pat] = [min + 1, 0]
  else pat += 1
  return `v${maj}.${min}.${pat}`
}

// ---- Commits ----
export interface CommitInfo {
  sha: string
  subject: string
  author: string
  date: string
  deploymentId: string
}

const REVERT = /^(\[[^\]]*\]\s*)?Revert "(.*)"$/

/**
 * Hides revert pairs. `commits` is newest first, so the original of a revert is the nearest *older* entry
 * (later in the list) whose subject equals the reverted one. One revert removes at most one original.
 * An unpaired revert is kept.
 */
export function filterReverts(commits: CommitInfo[]): { kept: CommitInfo[]; hiddenPairs: number } {
  const hidden = new Set<number>()
  let pairs = 0
  commits.forEach((c, i) => {
    if (hidden.has(i)) return
    const m = REVERT.exec(c.subject)
    if (!m) return
    const want = `${m[1] ?? ''}${m[2]}`
    for (let j = i + 1; j < commits.length; j++) {
      if (hidden.has(j) || commits[j].subject !== want) continue
      hidden.add(i)
      hidden.add(j)
      pairs++
      break
    }
  })
  return { kept: commits.filter((_, i) => !hidden.has(i)), hiddenPairs: pairs }
}

// ---- Managed .env ----
export type EnvLine =
  | { comment: string }
  | { blank: true }
  | { key: string; value: { kind: 'text'; text: string } | { kind: 'secret'; secretId: string } }

/** Env names that hold a secret: their values never leave as plain text. */
export const SENSITIVE_KEY = /TOKEN|PASSWORD|PASSWD|SECRET|KEY|CREDENTIAL|PRIVATE/i
const SECRET_REF = /^\$\{secret:([^}]*)\}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Error messages carry line numbers and keys only, never values. */
export function parseEnvTemplate(text: string): { lines: EnvLine[]; secretIds: string[]; errors: string[] } {
  const lines: EnvLine[] = []
  const errors: string[] = []
  const secretIds: string[] = []
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, i, all) => {
    const n = i + 1
    if (i === all.length - 1 && raw === '') return // trailing newline
    if (raw.trim() === '') return void lines.push({ blank: true })
    if (raw.trimStart().startsWith('#')) return void lines.push({ comment: raw })
    const eq = raw.indexOf('=')
    const key = eq > 0 ? raw.slice(0, eq) : ''
    if (!ENV_KEY.test(key)) return void errors.push(`line ${n}: not KEY=value`)
    if (seen.has(key)) return void errors.push(`line ${n}: duplicate ${key}`)
    seen.add(key)
    const value = raw.slice(eq + 1)
    const ref = SECRET_REF.exec(value)
    if (ref) {
      if (!UUID_RE.test(ref[1])) return void errors.push(`line ${n}: ${key} has an invalid secret reference`)
      if (!secretIds.includes(ref[1])) secretIds.push(ref[1])
      lines.push({ key, value: { kind: 'secret', secretId: ref[1] } })
      return
    }
    if (value !== '' && SENSITIVE_KEY.test(key)) {
      errors.push(`line ${n}: ${key} looks sensitive; use a vault secret`)
      return
    }
    lines.push({ key, value: { kind: 'text', text: value } })
  })
  return { lines, secretIds, errors }
}

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`

/** Main only. Quotes each value for a POSIX .env; `values` maps secret id to its resolved value. */
export function renderEnvTemplate(lines: EnvLine[], values: Map<string, string>): string {
  let out = ''
  for (const l of lines) {
    if ('blank' in l) out += '\n'
    else if ('comment' in l) out += `${l.comment}\n`
    else {
      const v = l.value.kind === 'text' ? l.value.text : values.get(l.value.secretId)
      if (v === undefined) throw new Error(`missing value for ${l.key}`)
      out += `${l.key}=${shq(v)}\n`
    }
  }
  return out
}

// ---- Steps ----
export type StepKind =
  | 'lock'
  | 'unlock'
  | 'record'
  | 'backup'
  | 'fetch'
  | 'checkout'
  | 'env'
  | 'pre_hook'
  | 'build'
  | 'up'
  | 'health'
  | 'post_hook'
  | 'tag'
  | 'rb_checkout'
  | 'rb_env'
  | 'rb_build'
  | 'rb_up'
  | 'rb_tag'
  | 'version'
  | 'finalize_notes'
  | 'finalize_notify'
  | 'finalize_qa'

export const STEP_LABEL: Record<StepKind, string> = {
  lock: 'Lock',
  unlock: 'Unlock',
  record: 'Record',
  backup: 'Backup DB',
  fetch: 'Fetch',
  checkout: 'Checkout',
  env: 'Write .env',
  pre_hook: 'Pre-hook',
  build: 'Build',
  up: 'Up',
  health: 'Health',
  post_hook: 'Post-hook',
  tag: 'Tag',
  rb_checkout: 'Rollback checkout',
  rb_env: 'Rollback .env',
  rb_build: 'Rollback build',
  rb_up: 'Rollback up',
  rb_tag: 'Rollback tag',
  version: 'Version tag',
  finalize_notes: 'Release notes',
  finalize_notify: 'Notify',
  finalize_qa: 'QA',
}

export type StepState = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped' | 'cancelled'
export type ReleaseStatus =
  | 'preflight'
  | 'ready'
  | 'blocked'
  | 'running'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'cancelled'
  | 'discarded'
export type DeploymentRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'rolled_back'
  | 'rollback_failed'
export type ReleaseKind = 'release' | 'rollback'

export interface Actor {
  osUser: string
  machine: string
  hubUserId?: string
}

// ---- Lock ----
export interface LockHolder {
  releaseId: string
  user: string
  machine: string
  environment: string
  version: string | null
  startedAt: string
}

export function lockHolderText(h: LockHolder, _now: number): string {
  return `${h.user}@${h.machine} is deploying ${h.version ?? 'release'} since ${h.startedAt}`
}

// ---- Preflight ----
export interface PreflightCheck {
  /** tools, docker, repo, clean, branch, compose, deps, disk, lock, tag, version-tag, reachable, auth or ansible */
  id: string
  deploymentId: string | null
  hostId: string
  label: string
  level: 'ok' | 'warn' | 'block'
  message: string
}

export interface PreflightReport {
  releaseId: string
  checks: PreflightCheck[]
  commits: Record<
    string,
    /** `tagCommit`: the deploy tag's commit on origin, null on a first deploy. */
    { commits: CommitInfo[]; hiddenPairs: number; truncated: number; firstDeploy: boolean; head: string | null; tagCommit: string | null }
  >
  dockerModes: Record<string, DockerMode>
  /** Per deployment: the compose file's services (`docker compose config --services`), null when unknown. */
  composeServices: Record<string, string[] | null>
  /**
   * Per deployment: the compose services classed as databases, which a release never restarts.
   * Task 15 owns filling it, from image-based classification in main; the renderer never guesses from names.
   * Absent until then, and the picker shows no database rows.
   */
  composeDatabases?: Record<string, string[] | null>
  /**
   * Per service in the selection: `since` is its last deployed commit, else the deploy tag's commit; `count` is
   * how many commits of its checkout's list (newest first) come before `since`. `known` is false when `since`
   * is not in the list, and then `count` is the list length.
   */
  serviceCommits: Record<string, { since: string | null; count: number; known: boolean }>
  locks: Record<string, { holder: LockHolder; stale: boolean; raw: string } | null>
  commitsTotal: number
  blocked: boolean
}

// ---- Run events (the stream Phase 9 assumes) ----
export interface RunEventBase {
  /** UUIDv7 */
  id: string
  /** = releaseId */
  runId: string
  seq: number
  at: string
}
export type RunEventBody =
  | { type: 'run.started'; kind: ReleaseKind; version: string | null }
  | { type: 'preflight.check'; check: PreflightCheck }
  | { type: 'preflight.done'; report: PreflightReport }
  | { type: 'step.started'; stepId: string; kind: StepKind; name: string; hostId: string | null; deploymentRunId: string | null }
  | { type: 'step.done'; stepId: string; state: 'ok' | 'warn' | 'skipped' | 'cancelled'; durationMs: number; message?: string }
  | { type: 'step.failed'; stepId: string; error: string; durationMs: number }
  | { type: 'log'; stepId: string | null; hostId: string | null; stream: 'out' | 'err' | 'ansible'; line: string }
  | { type: 'log.truncated'; dropped: number }
  | { type: 'lock.busy'; hostId: string; holder: LockHolder; stale: boolean; text: string }
  | { type: 'rollback.started'; deploymentRunIds: string[] }
  | { type: 'rollback.done'; ok: boolean }
  | {
      type: 'deployment.updated'
      deploymentRunId: string
      status: DeploymentRunStatus
      previousCommit?: string
      deployedCommit?: string
      backupFile?: string
    }
  | { type: 'version.bumped'; from: string | null; to: string }
  | { type: 'run.finished'; status: 'succeeded' | 'failed' | 'rolled_back' | 'cancelled'; error?: string }
/** Import as `DeployRunEvent` where Phase 7's ops `RunEvent` is also in scope. */
export type RunEvent = RunEventBase & RunEventBody

// ---- Releases ----
export interface ReleaseOptions {
  backup: boolean
  /** Stored for Phase 9; unused in 8a. */
  notify: boolean
  /** Stored for Phase 9; unused in 8a. */
  qa: boolean
}
export const DEFAULT_RELEASE_OPTIONS: ReleaseOptions = { backup: true, notify: true, qa: false }

export interface ReleaseSummary {
  id: string
  environmentId: string
  environmentName: string
  kind: ReleaseKind
  status: ReleaseStatus
  version: string | null
  previousVersion: string | null
  redeploy: boolean
  rollbackOf: string | null
  triggeredBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  deploymentCount: number
  hostCount: number
  /** The services this release was confirmed for; a rollback release names the services it rolls back. */
  serviceIds: string[]
  /** The run entries: every service the release deploys, including a whole checkout's. */
  serviceCount: number
  error: string | null
}

export interface DeploymentRunMeta {
  id: string
  releaseId: string
  deploymentId: string | null
  deploymentName: string
  hostId: string | null
  hostLabel: string
  position: number
  branch: string
  previousCommit: string | null
  deployedCommit: string | null
  commits: CommitInfo[]
  status: DeploymentRunStatus
  rolledBack: boolean
  backupFile: string | null
  startedAt: string | null
  finishedAt: string | null
  steps: { stepId: string; kind: StepKind; state: StepState; startedAt: string | null; finishedAt: string | null; error?: string }[]
  /** The selected services this run deploys, with their commits. */
  services: RunService[]
  /** True when the run rebuilds the whole checkout (`services` null in the plan). */
  wholeCheckout: boolean
}

export interface ReleaseDetail extends ReleaseSummary {
  options: ReleaseOptions
  releaseNotes: string | null
  /** The generated, secret-free release playbook JSON (redacted again on read). */
  playbook: string | null
  runs: DeploymentRunMeta[]
  preflight: PreflightReport | null
  lastSeq: number
}

/**
 * One service of a run. At preflight `previousCommit` and `previousReleaseId` are its last deployed commit and
 * release (Start refuses when either has moved since) and `deployedCommit` is null.
 */
export interface RunService {
  id: string
  name: string
  composeService: string
  previousCommit: string | null
  previousReleaseId: string | null
  deployedCommit: string | null
}

export interface PreflightRequest {
  environmentId: string
  /** App services to deploy; the checkouts they belong to are the ones planned. */
  serviceIds: string[]
  /** Checkouts with no services, each deployed whole; refused for a checkout that has services. */
  checkoutIds?: string[]
  bump: VersionBump
  options: ReleaseOptions
  releaseNotes?: string
}
/** `typedName` is the environment name (protected environments). `redeploy` confirms a release with zero new commits. */
export interface ReleaseConfirm {
  typedName?: string
  redeploy?: boolean
}
export interface BreakLockConfirm {
  typedLabel: string
}
export interface ReleaseListFilter {
  environmentId?: string
  limit?: number
  before?: string
}

// ---- Tooling ----
/** What `deploy:tooling` reports: the local tools a run needs. */
export interface Tooling {
  ansiblePlaybook: { path: string; version: string } | null
  /** Why ansiblePlaybook is null, or 'ok'. */
  ansibleStatus: 'ok' | 'missing' | 'old' | 'broken'
  sshAgent: string | null
  sshAdd: string | null
  ssh: string | null
  /** Plain-language reasons something is missing or unusable. */
  problems: string[]
}
