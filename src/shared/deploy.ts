// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import type { OperationMeta } from './runbooks'
import type { Step, StepBody } from './steps'

import type { RegionRef } from './inventory'

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
/** A relative path inside the repo, or COMPOSE_AUTO (empty). */
export const COMPOSE_FILE = /^(?!\/)(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{0,200}$/
/** composeFile '' lets Compose discover its own files (no `-f`): compose.yaml and docker-compose.override.yml, COMPOSE_FILE. */
export const COMPOSE_AUTO = ''
export const VERSION = /^v\d+\.\d+\.\d+$/
export const COMPOSE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
/** A service name inside a compose file: the same rule, so it can never look like an option or carry shell syntax. */
export const COMPOSE_SERVICE = COMPOSE_PROJECT
export const MAX_URL = 2048
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** A name, run id or label the playbook generator accepts as is. */
export const SAFE_IDENT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/
/** Anything outside [A-Za-z0-9._@-] becomes `_`; at most 64 characters. */
export const sanitizeIdent = (s: string): string => s.replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 64)

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
  /** Saved steps; non-empty replaces the hooks (see effectiveSteps). */
  steps: Step[]
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
  steps?: Step[]
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

/** One stage of a release flow: a group of services deployed together, or one step run on a service's checkout. */
export type FlowStage = { kind: 'services'; serviceIds: string[] } | { kind: 'step'; serviceId: string; step: StepBody }
export interface ReleaseFlow {
  stages: FlowStage[]
  onFailure: 'stop-all' | 'continue-other-hosts'
}

/** The services a flow's step stages are bound to: they always deploy, so preflight and start never skip them. */
export function stepBound(flow: ReleaseFlow | null): Set<string> {
  return new Set((flow?.stages ?? []).flatMap((st) => (st.kind === 'step' ? [st.serviceId] : [])))
}

export interface EnvDeploySettings {
  environmentId: string
  versioned: boolean
  autoRollback: boolean
  currentVersion: string | null
  parallelPrepare: boolean
  /** 1-8 hosts prepared at once. */
  prepareCap: number
  /** null: the services deploy in checkout order, as before. */
  flow: ReleaseFlow | null
}
/** `currentVersion` is a manual correction (null clears it); it must match VERSION. */
export type EnvDeploySettingsPatch = Partial<Pick<EnvDeploySettings, 'versioned' | 'autoRollback' | 'currentVersion' | 'parallelPrepare' | 'prepareCap' | 'flow'>>
/** Several edits to one environment saved together: all of them or none (the script-compatible preset and its Undo). */
export interface DeployBatch {
  settings?: EnvDeploySettingsPatch
  deployments: { id: string; patch: DeploymentPatch }[]
}
export interface DeployBatchResult {
  settings: EnvDeploySettings
  /** Every deployment the batch named, as saved. */
  deployments: DeploymentMeta[]
}

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

/**
 * The template with every value parseEnvTemplate reads as a secret reference emptied (`KEY=`);
 * comments, other lines and line endings are kept as they are.
 */
export function stripEnvSecretRefs(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const cr = line.endsWith('\r') ? '\r' : ''
      const raw = cr ? line.slice(0, -1) : line
      const eq = raw.indexOf('=')
      if (raw.trimStart().startsWith('#') || eq <= 0 || !SECRET_REF.test(raw.slice(eq + 1))) return line
      return `${raw.slice(0, eq + 1)}${cr}`
    })
    .join('\n')
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
  | 'restore'
  | 'rb_checkout'
  | 'rb_env'
  | 'rb_build'
  | 'rb_up'
  | 'rb_health'
  | 'rb_tag'
  | 'version'
  | 'finalize_notes'
  | 'finalize_notify'
  | 'finalize_qa'
  | 'custom'
  | 'op'

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
  restore: 'Restore checkout',
  rb_checkout: 'Rollback checkout',
  rb_env: 'Rollback .env',
  rb_build: 'Rollback build',
  rb_up: 'Rollback up',
  rb_health: 'Rollback health',
  rb_tag: 'Rollback tag',
  version: 'Version tag',
  finalize_notes: 'Release notes',
  finalize_notify: 'Notify',
  finalize_qa: 'QA',
  custom: 'Step',
  op: 'Operation',
}

export type StepState = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped' | 'cancelled'
/** How one Ansible task ended: `changed` is an ok that changed something on the host. */
export type TaskState = 'ok' | 'changed' | 'skipped' | 'failed'
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
    /**
     * `tagCommit`: the deploy tag's commit on origin, null on a first deploy. `originHead`: `origin/<branch>`'s
     * commit as the host resolved it; null when it is unknown, or when hosts disagree.
     */
    { commits: CommitInfo[]; hiddenPairs: number; truncated: number; firstDeploy: boolean; head: string | null; tagCommit: string | null; originHead?: string | null }
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
   * is not in the list, and then `count` is the list length. A known zero is `since` at origin's head (the
   * list's order is by date, so a first place in it is not one). `skippable` (skipUnchanged, a known zero, nothing
   * hidden or cut, not a first deploy) is what start skips unless forced.
   */
  serviceCommits: Record<string, { since: string | null; count: number; known: boolean; skippable?: boolean }>
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
  /**
   * One Ansible task of a step finished (a step can run several, e.g. one health task per URL). `task` is the
   * task's playbook name; `attempts` is set when the task retried (`until`). Releases from before this event
   * have none, and the view then shows their steps' states.
   */
  | { type: 'task.done'; stepId: string; task: string; hostId: string | null; state: TaskState; rc: number | null; attempts: number | null; durationMs: number }
  /**
   * `task` is the Ansible task the line came from (redacted, as in its `task.done`), set on a task's own output.
   * Streamed lines and lines from releases before it have none; they are only their step's.
   * `term` lines are ansible's console view for the Terminal tab (no step, never in the step logs); releases from
   * before it have none.
   */
  | { type: 'log'; stepId: string | null; hostId: string | null; stream: 'out' | 'err' | 'ansible' | 'term'; line: string; task?: string }
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
  /** Hub only: the release's environment was unpublished; the release is kept as read-only history. */
  unpublished?: boolean
  /** Set when the release is a runbook operation rather than a deploy. */
  operation: OperationMeta | null
  /** 'edited' when the user changed the generated playbook before starting. */
  playbookSource: 'generated' | 'edited'
}

/** An environment's newest release that ran (or is running), with the commits of its first run. */
export interface EnvLastRelease extends ReleaseSummary {
  previousCommit: string | null
  deployedCommit: string | null
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
  steps: { stepId: string; kind: StepKind; state: StepState; startedAt: string | null; finishedAt: string | null; error?: string; label?: string; key?: string }[]
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
  /** The playbook as generated, kept only when the run used an edited one. */
  playbookGenerated: string | null
  /** Hub only: the playbook is left out (null) because it covers deployments this viewer can't see. */
  playbookHidden?: boolean
  runs: DeploymentRunMeta[]
  preflight: PreflightReport | null
  lastSeq: number
  /**
   * The regions of the hosts its checkouts run on, ordered by code: what the confirm step shows. Set by the desktop;
   * a Hub release leaves it out.
   */
  regions?: RegionRef[]
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
  /** sha256 (hex) of the playbook the user reviewed; start refuses when the playbook it would run differs. */
  playbookSha256?: string
  /** The reviewed playbook, edited by the user; main re-validates it and runs it in place of the generated one. */
  editedPlaybook?: string
  /** Services whose unchanged-skip is overridden for this release; the preview and the start must name the same ones. */
  forceServiceIds?: string[]
}
/** The playbook a start would run, for review before Deploy. */
export interface PlaybookPreview {
  playbook: string
  /** Of the playbook and, when any service is skipped, the skipped ids and their commits: a start must skip the same. */
  sha256: string
  /** The services this start leaves out as unchanged since their last deploy (`skippable` and not forced). */
  skippedServiceIds?: string[]
  /** With a release flow: the inventory, whose host vars (`od`, the version among them) the hash covers too. */
  inventory?: string
}
/** Start and its preview refuse a release whose every service would be skipped as unchanged. */
export const NOTHING_SELECTED_MESSAGE = 'Every selected service has no changes; select one to deploy it anyway'
/** A step's secret must be one the environment's env templates or sudo passwords already use (no value is named). */
export const STEP_SECRET_UNUSED_MESSAGE = 'This step uses a secret the environment does not already use'
export const PLAYBOOK_SHA256 = /^[0-9a-f]{64}$/
/** A release from before playbooks were stored (or one that never started). */
export const PLAYBOOK_NOT_STORED_MESSAGE = 'Playbook not stored for this release'
/**
 * What a failed prepare's restore step did with its checkout: put it back on the previous commit, found none (a first
 * deploy), failed, or never ran (the checkout is left where it is).
 */
export type PrepareCheckout = 'restored' | 'first' | 'failed' | 'left'
/** Checkouts other than the failed one still at the new commit; `env` when one of them wrote its managed .env. Null: none. */
export type PrepareOthers = { env: boolean } | null
/**
 * Checkouts that share the failed one's repo on its host, so its restore put them back on the previous commit too;
 * `names` their services, `env` when one of them wrote its managed .env (which the restore leaves). Null: none.
 */
export type PrepareShared = { names: string[]; env: boolean } | null
const othersLeft = (o: PrepareOthers): string => (o ? `; other checkouts are left at the new commit${o.env ? ' with the new .env' : ''}` : '')
const sharedBack = (o: PrepareShared): string => {
  if (!o || o.names.length === 0) return ''
  const one = o.names.length === 1
  return `; ${o.names.join(', ')} ${one ? 'shares' : 'share'} that checkout, so ${one ? 'it is' : 'they are'} back on the previous commit too${o.env ? ' with the new .env' : ''}`
}
/** Built images replace the old ones under their tags at once: the containers keep running, the next compose up starts the new. */
const containers = (built: readonly string[]): string =>
  built.length > 0 ? `running containers are unchanged, but the next compose up of ${built.join(', ')} starts the newly built images` : 'running containers are unchanged'
/**
 * A parallel prepare that failed at or after its checkout, before any service went up. `env`: the failed checkout has
 * a managed .env and this release wrote it; with no managed .env none is mentioned. `built`: services whose build
 * finished in this release.
 */
export const PREPARE_FAILED_MESSAGE = (
  svc: string,
  o: { checkout: PrepareCheckout; env: boolean; others: PrepareOthers; shared?: PrepareShared; built?: readonly string[] },
): string => {
  const envNew = o.env ? ' with the new .env' : ''
  const own: Record<PrepareCheckout, string> = {
    restored: `the checkout is back on the previous commit${o.env ? ' with the previous .env' : ''}`,
    first: `this was its first deploy, so the checkout is left at the new commit${envNew}`,
    failed: `putting the checkout back on the previous commit failed, so it is still on the new commit${envNew}`,
    left: `the checkout is left at the new commit${envNew}`,
  }
  return `Build failed for ${svc}: no service was restarted; ${own[o.checkout]}${sharedBack(o.shared ?? null)}${othersLeft(o.others)}; ${containers(o.built ?? [])}.`
}
/**
 * A parallel prepare that failed before its checkout (the fetch, a step before it), before any service went up. When
 * other checkouts did check out (and were not put back), they are said to be at the new commit.
 */
export const PREPARE_FETCH_FAILED_MESSAGE = (svc: string, others: PrepareOthers, built: readonly string[] = []): string =>
  others
    ? `Fetch failed for ${svc}: no service was restarted; ${svc} is unchanged and still on the old commit${othersLeft(others)}; ${containers(built)}.`
    : `Fetch failed for ${svc}: no service was restarted; servers are unchanged and still on the old commit.`
/** A prepare restore's note when the checkout had no previous commit to go back to. */
export const RESTORE_FIRST_NOTE = 'First deploy: there is no previous commit to go back to'
/** A release with skipped services fails before any change when origin's head is not the one its preflight saw. */
export const ORIGIN_MOVED_MESSAGE = 'origin moved since preview, preview again'
/** Added to a release's error when its deploy-lock release at the end failed. */
export const LOCK_LEFT_MESSAGE = 'The deploy lock could not be removed from the hosts; the next preflight shows it'
export const PLAYBOOK_CHANGED_MESSAGE = 'The playbook changed since you reviewed it. Review it again.'
/** How long a reviewed playbook can be started from (main's `PREVIEW_TTL_MS`). */
export const REVIEW_TTL_MS = 30 * 60_000
/** A review older than that limit: nothing changed, but its start time is too old to reuse. */
export const REVIEW_EXPIRED_MESSAGE = `Your review is more than ${REVIEW_TTL_MS / 60_000} minutes old. Review the playbook again.`
/** A start with an edited playbook whose text no longer passes the checks (the first problem follows). */
export const EDIT_INVALID_MESSAGE = 'The edited playbook does not pass its checks; fix it and review again'
/** The release notes of a rollback (manual or automatic) of a release that ran an edited playbook. */
export const ROLLBACK_GENERATED_NOTE = 'This release ran an edited playbook; the rollback uses the generated one.'
/** A problem `release:validateEdit` found, at a 1-based line of the edited text. */
export interface PlaybookEditError {
  line: number
  message: string
}
/** `sha256` is what a start with this edit must carry as `playbookSha256`; `canonical` is the text it stores and runs. */
export type PlaybookEditResult = { ok: true; canonical: string; sha256: string } | { ok: false; errors: PlaybookEditError[] }
export interface BreakLockConfirm {
  typedLabel: string
}
export interface ReleaseListFilter {
  environmentId?: string
  limit?: number
  before?: string
  operations?: 'only' | 'exclude'
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
