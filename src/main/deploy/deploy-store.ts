import { randomUUID } from 'node:crypto'
import {
  BACKUP_DIR,
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  GIT_REF,
  HEALTH_STATUS_RANGE,
  HEALTH_TIMEOUT_RANGE,
  MAX_DEPLOYMENTS,
  MAX_ENV_TEMPLATE,
  MAX_HOOK,
  MAX_URL,
  MAX_POSITION,
  MAX_URLS,
  REPO_PATH,
  STEP_TIMEOUT_RANGE,
  isHttpUrl,
  VERSION,
  parseEnvTemplate,
  type DeployBatch,
  type DeployBatchResult,
  type DeploymentInput,
  type DeploymentMeta,
  type DeploymentPatch,
  type EnvDeploySettings,
  type EnvDeploySettingsPatch,
  type HealthUrl,
  type UseSudo,
} from '../../shared/deploy'
import { MAX_NAME, REPO_URL, REPO_URL_CREDENTIALS_MSG, hasRepoCredentials, isParsableRepoUrl } from '../../shared/inventory'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { checkText } from '../util/checks'
import type { VaultService } from '../vault/vault-service'

/** Secret lookups the store needs, by reference only (never a value). */
export interface SecretRefs {
  exists(id: string): boolean
  vaultOf(id: string): string | null
}

export function dbSecretRefs(db: Db): SecretRefs {
  return {
    exists: (id) => db.prepare('SELECT 1 FROM secrets WHERE id = ?').get(id) !== undefined,
    vaultOf: (id) => (db.prepare('SELECT vault_id FROM secrets WHERE id = ?').get(id) as { vault_id: string } | undefined)?.vault_id ?? null,
  }
}

export interface DeployStoreDeps {
  db: Db
  audit: AuditLog
  vault: VaultService
  secrets: SecretRefs
  now?: () => Date
  ids?: () => string
}

interface DeploymentRow {
  id: string
  name: string
  environment_id: string
  host_id: string
  repo_url: string | null
  compose_project: string | null
  repo_path: string
  default_branch: string
  compose_file: string
  deploy_tag: string
  position: number
  urls: string
  health_status: number
  health_timeout_sec: number
  db_backup: number
  backup_dir: string | null
  pre_hook: string | null
  post_hook: string | null
  build_timeout_sec: number
  compose_timeout_sec: number
  use_sudo: UseSudo
  become_secret_id: string | null
  managed_env: number
  env_template: string | null
  created_at: string
  updated_at: string
}

type Fields = Omit<DeploymentMeta, 'id' | 'createdAt' | 'updatedAt'>

const FIELDS = [
  'name',
  'repoUrl',
  'composeProject',
  'repoPath',
  'defaultBranch',
  'composeFile',
  'deployTag',
  'position',
  'urls',
  'healthStatus',
  'healthTimeoutSec',
  'dbBackup',
  'backupDir',
  'preHook',
  'postHook',
  'buildTimeoutSec',
  'composeTimeoutSec',
  'useSudo',
  'becomeSecretId',
  'managedEnv',
  'envTemplate',
  'vaultIds',
] as const satisfies readonly (keyof Fields)[]

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const MOVE_MESSAGE = 'a deployment cannot move to another environment or host; recreate it'
const BATCH_ENV_MESSAGE = 'deployment is not in this environment'
const REORDER_MESSAGE = "ids must be exactly the environment's deployments"

/**
 * Deployments (checkouts) and the per-environment deploy settings. Every write is audited by labels and field
 * names only (no paths, URLs, hooks or secret values), appended after COMMIT; secrets are references.
 */
export class DeployStore {
  /** Set by the wiring: called after every committed config mutation, so open pages refetch. */
  onChanged?: (environmentId: string) => void

  private readonly db: Db
  private readonly audit: AuditLog
  private readonly vault: VaultService
  private readonly secrets: SecretRefs
  private readonly now: () => Date
  private readonly ids: () => string

  constructor(deps: DeployStoreDeps) {
    this.db = deps.db
    this.audit = deps.audit
    this.vault = deps.vault
    this.secrets = deps.secrets
    this.now = deps.now ?? (() => new Date())
    this.ids = deps.ids ?? randomUUID
  }

  // ---- deployments ----

  /** Works while locked: names and flags are not secret. Ordered by position, then name. */
  list(environmentId?: string): DeploymentMeta[] {
    const order = 'ORDER BY position, name COLLATE NOCASE, id'
    const rows = (
      environmentId === undefined
        ? this.db.prepare(`SELECT * FROM deployments ${order}`).all()
        : this.db.prepare(`SELECT * FROM deployments WHERE environment_id = ? ${order}`).all(environmentId)
    ) as unknown as DeploymentRow[]
    const vaults = this.vaultMap()
    return rows.map((r) => this.meta(r, vaults.get(r.id) ?? []))
  }

  get(id: string): DeploymentMeta {
    const row = this.db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as DeploymentRow | undefined
    if (!row) throw new Error('deployment not found')
    return this.meta(row, this.vaultMap(id).get(id) ?? [])
  }

  create(input: DeploymentInput): DeploymentMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => this.insertInTx(input))
    const d = this.get(id)
    this.audit.append({
      action: 'deploy.create',
      outcome: 'success',
      targetType: 'deployment',
      targetId: id,
      targetLabel: d.name,
      details: this.labels(d.environmentId),
    })
    this.onChanged?.(d.environmentId)
    return d
  }

  /**
   * Validates and writes a deployment, adding its host to the environment when needed; no transaction, no audit
   * and no `onChanged`, so a caller (copy to another environment) can batch several inside its own `inTransaction`.
   */
  insertInTx(input: DeploymentInput, id: string = this.ids()): string {
    const f = this.validate(
      {
        name: input.name,
        environmentId: input.environmentId,
        hostId: input.hostId,
        repoUrl: input.repoUrl ?? null,
        composeProject: input.composeProject ?? null,
        repoPath: input.repoPath,
        defaultBranch: input.defaultBranch,
        composeFile: input.composeFile ?? 'docker-compose.yml',
        deployTag: input.deployTag,
        position: input.position ?? this.nextPosition(input.environmentId),
        urls: input.urls ?? [],
        healthStatus: input.healthStatus ?? 200,
        healthTimeoutSec: input.healthTimeoutSec ?? 60,
        dbBackup: input.dbBackup ?? false,
        backupDir: input.backupDir ?? null,
        preHook: input.preHook ?? null,
        postHook: input.postHook ?? null,
        buildTimeoutSec: input.buildTimeoutSec ?? 300,
        composeTimeoutSec: input.composeTimeoutSec ?? 120,
        useSudo: input.useSudo ?? 'auto',
        becomeSecretId: input.becomeSecretId ?? null,
        managedEnv: input.managedEnv ?? false,
        envTemplate: input.envTemplate ?? null,
        vaultIds: input.vaultIds ?? [],
      },
      null,
    )
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM deployments').get() as { n: number }).n
    if (n >= MAX_DEPLOYMENTS) throw new Error(`too many deployments (${MAX_DEPLOYMENTS})`)
    const ts = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO deployments(id, name, environment_id, host_id, repo_url, compose_project, repo_path, default_branch, compose_file, deploy_tag,
          position, urls, health_status, health_timeout_sec, db_backup, backup_dir, pre_hook, post_hook, build_timeout_sec,
          compose_timeout_sec, use_sudo, become_secret_id, managed_env, env_template, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, f.name, f.environmentId, f.hostId, f.repoUrl, f.composeProject, f.repoPath, f.defaultBranch, f.composeFile, f.deployTag,
        f.position, JSON.stringify(f.urls), f.healthStatus, f.healthTimeoutSec, f.dbBackup ? 1 : 0, f.backupDir, f.preHook,
        f.postHook, f.buildTimeoutSec, f.composeTimeoutSec, f.useSudo, f.becomeSecretId, f.managedEnv ? 1 : 0, f.envTemplate, ts, ts,
      )
    this.setVaults(id, f.vaultIds)
    return id
  }

  /** `undefined` keeps a field; `null` clears the nullable ones. The environment and host never change. */
  update(id: string, patch: DeploymentPatch): DeploymentMeta {
    this.vault.assertUnlocked()
    const fields = inTransaction(this.db, () => this.updateInTx(id, patch))
    const after = this.get(id)
    if (fields.length === 0) return after
    this.audit.append({ action: 'deploy.update', outcome: 'success', targetType: 'deployment', targetId: id, targetLabel: after.name, details: { fields } })
    this.onChanged?.(after.environmentId)
    return after
  }

  /** update() without the transaction, the unlock check, the audit or `onChanged`; the changed field names. */
  updateInTx(id: string, patch: DeploymentPatch): (keyof Fields)[] {
    const before = this.get(id)
    if (
      (patch.environmentId !== undefined && patch.environmentId !== before.environmentId) ||
      (patch.hostId !== undefined && patch.hostId !== before.hostId)
    ) {
      throw new Error(MOVE_MESSAGE)
    }
    const pick = <K extends keyof Fields>(k: K): Fields[K] => (patch[k as keyof DeploymentPatch] === undefined ? before[k] : (patch[k as keyof DeploymentPatch] as Fields[K]))
    const merged: Fields = {
      name: pick('name'),
      environmentId: before.environmentId,
      hostId: before.hostId,
      repoUrl: pick('repoUrl'),
      composeProject: pick('composeProject'),
      repoPath: pick('repoPath'),
      defaultBranch: pick('defaultBranch'),
      composeFile: pick('composeFile'),
      deployTag: pick('deployTag'),
      position: pick('position'),
      urls: pick('urls'),
      healthStatus: pick('healthStatus'),
      healthTimeoutSec: pick('healthTimeoutSec'),
      dbBackup: pick('dbBackup'),
      backupDir: pick('backupDir'),
      preHook: pick('preHook'),
      postHook: pick('postHook'),
      buildTimeoutSec: pick('buildTimeoutSec'),
      composeTimeoutSec: pick('composeTimeoutSec'),
      useSudo: pick('useSudo'),
      becomeSecretId: pick('becomeSecretId'),
      managedEnv: pick('managedEnv'),
      envTemplate: pick('envTemplate'),
      vaultIds: pick('vaultIds'),
    }
    const f = this.validate(merged, id, before.repoUrl)
    const changed = FIELDS.filter((k) => !same(f[k], before[k]))
    if (changed.length === 0) return changed
    this.db
      .prepare(
        `UPDATE deployments SET name = ?, repo_url = ?, compose_project = ?, repo_path = ?, default_branch = ?, compose_file = ?, deploy_tag = ?,
          position = ?, urls = ?, health_status = ?, health_timeout_sec = ?, db_backup = ?, backup_dir = ?, pre_hook = ?,
          post_hook = ?, build_timeout_sec = ?, compose_timeout_sec = ?, use_sudo = ?, become_secret_id = ?, managed_env = ?,
          env_template = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        f.name, f.repoUrl, f.composeProject, f.repoPath, f.defaultBranch, f.composeFile, f.deployTag, f.position, JSON.stringify(f.urls),
        f.healthStatus, f.healthTimeoutSec, f.dbBackup ? 1 : 0, f.backupDir, f.preHook, f.postHook, f.buildTimeoutSec,
        f.composeTimeoutSec, f.useSudo, f.becomeSecretId, f.managedEnv ? 1 : 0, f.envTemplate, this.now().toISOString(), id,
      )
    if (changed.includes('vaultIds')) this.setVaults(id, f.vaultIds)
    return changed
  }

  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = this.get(id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM deployments WHERE id = ?').run(id))
    this.audit.append({
      action: 'deploy.delete',
      outcome: 'success',
      targetType: 'deployment',
      targetId: id,
      targetLabel: before.name,
      details: this.labels(before.environmentId),
    })
    this.onChanged?.(before.environmentId)
  }

  /** Renumbers `position` 0..n-1 in the given order. `ids` must be exactly the environment's deployments. */
  reorder(environmentId: string, ids: string[]): void {
    this.vault.assertUnlocked()
    const moved = inTransaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) throw new Error('environment not found')
      const have = this.db.prepare('SELECT id, position FROM deployments WHERE environment_id = ?').all(environmentId) as { id: string; position: number }[]
      const known = new Set(have.map((r) => r.id))
      if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((i) => known.has(i))) {
        throw new Error(REORDER_MESSAGE)
      }
      const pos = new Map(have.map((r) => [r.id, r.position]))
      if (ids.every((i, n) => pos.get(i) === n)) return false
      const upd = this.db.prepare('UPDATE deployments SET position = ?, updated_at = ? WHERE id = ?')
      const ts = this.now().toISOString()
      ids.forEach((i, n) => upd.run(n, ts, i))
      return true
    })
    if (!moved) return
    this.audit.append({
      action: 'deploy.update',
      outcome: 'success',
      targetType: 'environment',
      targetId: environmentId,
      targetLabel: this.envName(environmentId),
      details: { fields: ['position'] },
    })
    this.onChanged?.(environmentId)
  }

  // ---- settings ----

  settings(environmentId: string): EnvDeploySettings {
    const row = this.db
      .prepare('SELECT versioned, auto_rollback, current_version FROM environments WHERE id = ?')
      .get(environmentId) as { versioned: number; auto_rollback: number; current_version: string | null } | undefined
    if (!row) throw new Error('environment not found')
    return { environmentId, versioned: row.versioned === 1, autoRollback: row.auto_rollback === 1, currentVersion: row.current_version }
  }

  updateSettings(environmentId: string, patch: EnvDeploySettingsPatch): EnvDeploySettings {
    this.vault.assertUnlocked()
    if (patch.currentVersion !== undefined && patch.currentVersion !== null && !VERSION.test(patch.currentVersion)) {
      throw new Error('version must look like v1.2.3')
    }
    const fields = inTransaction(this.db, () => this.updateSettingsInTx(environmentId, patch))
    if (fields.length === 0) return this.settings(environmentId)
    this.audit.append({
      action: 'deploy.settings',
      outcome: 'success',
      targetType: 'environment',
      targetId: environmentId,
      targetLabel: this.envName(environmentId),
      details: { fields },
    })
    this.onChanged?.(environmentId)
    return this.settings(environmentId)
  }

  /** updateSettings() without the transaction, the unlock check, the audit or `onChanged`; the changed field names. */
  updateSettingsInTx(environmentId: string, patch: EnvDeploySettingsPatch): ('versioned' | 'autoRollback' | 'currentVersion')[] {
    const before = this.settings(environmentId)
    const next = {
      versioned: patch.versioned ?? before.versioned,
      autoRollback: patch.autoRollback ?? before.autoRollback,
      currentVersion: patch.currentVersion === undefined ? before.currentVersion : patch.currentVersion,
    }
    const changed = (['versioned', 'autoRollback', 'currentVersion'] as const).filter((k) => next[k] !== before[k])
    if (changed.length === 0) return changed
    this.db
      .prepare('UPDATE environments SET versioned = ?, auto_rollback = ?, current_version = ?, updated_at = ? WHERE id = ?')
      .run(next.versioned ? 1 : 0, next.autoRollback ? 1 : 0, next.currentVersion, this.now().toISOString(), environmentId)
    return changed
  }

  /** Settings and deployment patches of one environment in one transaction: a failing patch saves nothing. One `onChanged`. */
  applyBatch(environmentId: string, batch: DeployBatch): DeployBatchResult {
    this.vault.assertUnlocked()
    if (batch.settings?.currentVersion !== undefined && batch.settings.currentVersion !== null && !VERSION.test(batch.settings.currentVersion)) {
      throw new Error('version must look like v1.2.3')
    }
    const { settings, deployments } = inTransaction(this.db, () => {
      const settings = this.updateSettingsInTx(environmentId, batch.settings ?? {})
      const deployments = batch.deployments.map(({ id, patch }) => {
        if (this.get(id).environmentId !== environmentId) throw new Error(BATCH_ENV_MESSAGE)
        return { id, fields: this.updateInTx(id, patch) }
      })
      return { settings, deployments }
    })
    if (settings.length) {
      this.audit.append({
        action: 'deploy.settings',
        outcome: 'success',
        targetType: 'environment',
        targetId: environmentId,
        targetLabel: this.envName(environmentId),
        details: { fields: settings },
      })
    }
    const changed = deployments.filter((d) => d.fields.length)
    for (const { id, fields } of changed) {
      this.audit.append({ action: 'deploy.update', outcome: 'success', targetType: 'deployment', targetId: id, targetLabel: this.get(id).name, details: { fields } })
    }
    if (settings.length || changed.length) this.onChanged?.(environmentId)
    return { settings: this.settings(environmentId), deployments: batch.deployments.map(({ id }) => this.get(id)) }
  }

  /** Always null: the compose file lives on the host. Exists so Phase 9's AI context compiles. */
  composeSnippet(_id: string): null {
    return null
  }

  // ---- internals ----

  /** deployment id -> sorted vault ids, in one query (all deployments, or just `only`). */
  private vaultMap(only?: string): Map<string, string[]> {
    const rows = (
      only === undefined
        ? this.db.prepare('SELECT deployment_id, vault_id FROM deployment_vaults ORDER BY vault_id').all()
        : this.db.prepare('SELECT deployment_id, vault_id FROM deployment_vaults WHERE deployment_id = ? ORDER BY vault_id').all(only)
    ) as { deployment_id: string; vault_id: string }[]
    const out = new Map<string, string[]>()
    for (const r of rows) out.set(r.deployment_id, [...(out.get(r.deployment_id) ?? []), r.vault_id])
    return out
  }

  private meta(r: DeploymentRow, vaultIds: string[]): DeploymentMeta {
    return {
      id: r.id,
      name: r.name,
      environmentId: r.environment_id,
      hostId: r.host_id,
      repoUrl: r.repo_url,
      composeProject: r.compose_project,
      repoPath: r.repo_path,
      defaultBranch: r.default_branch,
      composeFile: r.compose_file,
      deployTag: r.deploy_tag,
      position: r.position,
      urls: JSON.parse(r.urls) as HealthUrl[],
      healthStatus: r.health_status,
      healthTimeoutSec: r.health_timeout_sec,
      dbBackup: r.db_backup === 1,
      backupDir: r.backup_dir,
      preHook: r.pre_hook,
      postHook: r.post_hook,
      buildTimeoutSec: r.build_timeout_sec,
      composeTimeoutSec: r.compose_timeout_sec,
      useSudo: r.use_sudo,
      becomeSecretId: r.become_secret_id,
      managedEnv: r.managed_env === 1,
      envTemplate: r.env_template,
      vaultIds,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  private setVaults(id: string, vaultIds: string[]): void {
    this.db.prepare('DELETE FROM deployment_vaults WHERE deployment_id = ?').run(id)
    const ins = this.db.prepare('INSERT INTO deployment_vaults(deployment_id, vault_id) VALUES (?, ?)')
    for (const v of vaultIds) ins.run(id, v)
  }

  private nextPosition(environmentId: string): number {
    const row = this.db.prepare('SELECT MAX(position) AS p FROM deployments WHERE environment_id = ?').get(environmentId) as { p: number | null }
    return row.p === null ? 0 : row.p + 1
  }

  private envName(environmentId: string): string {
    return (this.db.prepare('SELECT name FROM environments WHERE id = ?').get(environmentId) as { name: string } | undefined)?.name ?? ''
  }

  /** Audit details name the environment only: host ids and labels never reach the audit log. */
  private labels(environmentId: string): { environment: string } {
    return { environment: this.envName(environmentId) }
  }

  /** A checkout's host joins its environment as an `app` host when it isn't a member yet; a member keeps its role. */
  private ensureMembership(environmentId: string, hostId: string): void {
    if (!this.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(hostId)) throw new Error('host not found')
    if (!this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) throw new Error('environment not found')
    this.db.prepare("INSERT OR IGNORE INTO environment_hosts(environment_id, host_id, role) VALUES (?, ?, 'app')").run(environmentId, hostId)
  }

  /**
   * Checks every rule on a fully merged deployment. Messages name the rule, never the value. Runs inside the write
   * transaction: it adds the host to the environment, which a later failing rule rolls back.
   */
  private validate(f: Fields, selfId: string | null, unchangedRepoUrl: string | null = null): Fields {
    const name = checkText(f.name, 'deployment name', MAX_NAME)
    this.ensureMembership(f.environmentId, f.hostId)
    const dup = this.db
      .prepare('SELECT id FROM deployments WHERE environment_id = ? AND name = ? COLLATE NOCASE')
      .get(f.environmentId, name) as { id: string } | undefined
    if (dup && dup.id !== selfId) throw new Error(`a deployment named "${name}" already exists in this environment`)

    const pathMsg = 'must be an absolute path without spaces or shell characters'
    if (typeof f.repoPath !== 'string' || !REPO_PATH.test(f.repoPath)) throw new Error(`repo path ${pathMsg}`)
    if (typeof f.defaultBranch !== 'string' || !GIT_REF.test(f.defaultBranch)) throw new Error("branch isn't a valid git branch name")
    if (typeof f.deployTag !== 'string' || !GIT_REF.test(f.deployTag)) throw new Error("deploy tag isn't a valid git tag name")
    if (typeof f.composeFile !== 'string' || !COMPOSE_FILE.test(f.composeFile)) throw new Error('compose file must be a relative path inside the repo')
    // A stored value the caller leaves alone is not re-checked: a row saved before the rules stays editable.
    const keepRepoUrl = unchangedRepoUrl !== null && f.repoUrl === unchangedRepoUrl
    if (!keepRepoUrl && typeof f.repoUrl === 'string' && REPO_URL.test(f.repoUrl.trim()) && hasRepoCredentials(f.repoUrl.trim())) {
      throw new Error(REPO_URL_CREDENTIALS_MSG)
    }
    const repoUrl = keepRepoUrl
      ? f.repoUrl
      : this.checkBlankable(
          f.repoUrl,
          'repository URL must be an http(s), ssh:// or git@ URL without spaces',
          (u) => u.length <= MAX_URL && REPO_URL.test(u) && isParsableRepoUrl(u),
        )
    const composeProject = this.checkBlankable(
      f.composeProject,
      'compose project must be letters, digits, dashes, dots or underscores',
      (p) => COMPOSE_PROJECT.test(p),
    )

    const urls = this.checkUrls(f.urls)
    this.checkInt(f.healthStatus, ...HEALTH_STATUS_RANGE, 'health status')
    this.checkInt(f.healthTimeoutSec, ...HEALTH_TIMEOUT_RANGE, 'health timeout')
    this.checkInt(f.buildTimeoutSec, ...STEP_TIMEOUT_RANGE, 'build timeout')
    this.checkInt(f.composeTimeoutSec, ...STEP_TIMEOUT_RANGE, 'compose timeout')
    this.checkInt(f.position, 0, MAX_POSITION, 'position')
    if (f.useSudo !== 'auto' && f.useSudo !== 'yes' && f.useSudo !== 'no') throw new Error('use sudo must be auto, yes or no')

    const dbBackup = f.dbBackup === true
    const backupDir = f.backupDir === null || f.backupDir === undefined ? null : f.backupDir
    if (dbBackup && backupDir === null) throw new Error('backup dir is required when DB backup is on')
    if (backupDir !== null && !BACKUP_DIR.test(backupDir)) throw new Error(`backup dir ${pathMsg}`)

    const preHook = this.checkHook(f.preHook)
    const postHook = this.checkHook(f.postHook)

    if (f.becomeSecretId !== null && !this.secrets.exists(f.becomeSecretId)) throw new Error('become secret not found')

    const vaultIds = [...new Set(f.vaultIds)].sort()
    for (const v of vaultIds) if (!this.db.prepare('SELECT 1 FROM vaults WHERE id = ?').get(v)) throw new Error('vault not found')

    const managedEnv = f.managedEnv === true
    let envTemplate = f.envTemplate
    if (envTemplate !== null) {
      if (typeof envTemplate !== 'string' || envTemplate.length > MAX_ENV_TEMPLATE) throw new Error(`env template is too long (${MAX_ENV_TEMPLATE})`)
      if (envTemplate.trim() === '') envTemplate = null
    }
    if (managedEnv && envTemplate === null) throw new Error('env template is required when the managed .env is on')
    if (envTemplate !== null) {
      const parsed = parseEnvTemplate(envTemplate)
      if (parsed.errors.length > 0) throw new Error(parsed.errors.join('; '))
      parsed.secretIds.forEach((sid, i) => {
        const vid = this.secrets.vaultOf(sid)
        if (vid === null || !vaultIds.includes(vid)) throw new Error(`secret ${i + 1} in the env template isn't in this deployment's vaults`)
      })
    }

    return {
      name,
      environmentId: f.environmentId,
      hostId: f.hostId,
      repoUrl,
      composeProject,
      repoPath: f.repoPath,
      defaultBranch: f.defaultBranch,
      composeFile: f.composeFile,
      deployTag: f.deployTag,
      position: f.position,
      urls,
      healthStatus: f.healthStatus,
      healthTimeoutSec: f.healthTimeoutSec,
      dbBackup,
      backupDir,
      preHook,
      postHook,
      buildTimeoutSec: f.buildTimeoutSec,
      composeTimeoutSec: f.composeTimeoutSec,
      useSudo: f.useSudo,
      becomeSecretId: f.becomeSecretId,
      managedEnv,
      envTemplate,
      vaultIds,
    }
  }

  /** A blank string clears the field. `rule` names the rule, never the value. */
  private checkBlankable(raw: string | null, rule: string, ok: (v: string) => boolean): string | null {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string' || (raw.trim() !== '' && !ok(raw))) throw new Error(rule)
    return raw.trim() === '' ? null : raw
  }

  private checkInt(n: number, min: number, max: number, what: string): void {
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be ${min}-${max}`)
  }

  private checkHook(h: string | null): string | null {
    if (h === null || h === undefined) return null
    if (typeof h !== 'string' || h.length > MAX_HOOK) throw new Error(`hook is too long (${MAX_HOOK})`)
    return h.trim() === '' ? null : h
  }

  private checkUrls(urls: HealthUrl[]): HealthUrl[] {
    if (!Array.isArray(urls)) throw new Error('urls must be a list')
    if (urls.length > MAX_URLS) throw new Error(`too many urls (${MAX_URLS})`)
    return urls.map((u, i) => {
      const bad = new Error(`url ${i + 1} must be http(s) without credentials`)
      if (typeof u?.url !== 'string' || u.url.length > MAX_URL || !isHttpUrl(u.url)) throw bad
      if (u.from !== 'host' && u.from !== 'mac') throw new Error(`url ${i + 1} must be checked from host or mac`)
      return { url: u.url, from: u.from }
    })
  }
}
