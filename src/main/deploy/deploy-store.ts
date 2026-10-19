import { randomUUID } from 'node:crypto'
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
  REPO_PATH,
  VERSION,
  parseEnvTemplate,
  type AppInput,
  type AppMeta,
  type AppPatch,
  type DeploymentInput,
  type DeploymentMeta,
  type DeploymentPatch,
  type EnvDeploySettings,
  type EnvDeploySettingsPatch,
  type HealthUrl,
  type UseSudo,
} from '../../shared/deploy'
import { MAX_NAME } from '../../shared/inventory'
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
  app_id: string | null
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

interface AppRow {
  id: string
  environment_id: string
  host_id: string
  name: string
  compose_project: string | null
  description: string
  created_at: string
  updated_at: string
}

type Fields = Omit<DeploymentMeta, 'id' | 'createdAt' | 'updatedAt'>

const FIELDS = [
  'name',
  'appId',
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
const REORDER_MESSAGE = "ids must be exactly the environment's deployments"

/**
 * Apps, deployments and the per-environment deploy settings. Every write is audited by labels and field
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

  // ---- apps ----

  listApps(environmentId?: string): AppMeta[] {
    const order = 'ORDER BY name COLLATE NOCASE, id'
    const rows = (
      environmentId === undefined
        ? this.db.prepare(`SELECT * FROM apps ${order}`).all()
        : this.db.prepare(`SELECT * FROM apps WHERE environment_id = ? ${order}`).all(environmentId)
    ) as unknown as AppRow[]
    return rows.map(appMeta)
  }

  getApp(id: string): AppMeta {
    const row = this.db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as AppRow | undefined
    if (!row) throw new Error('app not found')
    return appMeta(row)
  }

  createApp(input: AppInput): AppMeta {
    this.vault.assertUnlocked()
    const id = inTransaction(this.db, () => {
      const f = this.validateApp({
        environmentId: input.environmentId,
        hostId: input.hostId,
        name: input.name,
        composeProject: input.composeProject ?? null,
        description: input.description ?? '',
      }, null)
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM apps').get() as { n: number }).n
      if (n >= MAX_APPS) throw new Error(`too many apps (${MAX_APPS})`)
      const id = this.ids()
      const ts = this.now().toISOString()
      this.db
        .prepare('INSERT INTO apps(id, environment_id, host_id, name, compose_project, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, f.environmentId, f.hostId, f.name, f.composeProject, f.description, ts, ts)
      return id
    })
    const app = this.getApp(id)
    this.audit.append({
      action: 'app.create',
      outcome: 'success',
      targetType: 'app',
      targetId: id,
      targetLabel: app.name,
      details: this.labels(app.environmentId, app.hostId),
    })
    this.onChanged?.(app.environmentId)
    return app
  }

  updateApp(id: string, patch: AppPatch): AppMeta {
    this.vault.assertUnlocked()
    const before = this.getApp(id)
    const fields = inTransaction(this.db, () => {
      const f = this.validateApp(
        {
          environmentId: before.environmentId,
          hostId: before.hostId,
          name: patch.name ?? before.name,
          composeProject: patch.composeProject === undefined ? before.composeProject : patch.composeProject,
          description: patch.description ?? before.description,
        },
        id,
      )
      const changed = (['name', 'composeProject', 'description'] as const).filter((k) => f[k] !== before[k])
      if (changed.length === 0) return changed
      this.db
        .prepare('UPDATE apps SET name = ?, compose_project = ?, description = ?, updated_at = ? WHERE id = ?')
        .run(f.name, f.composeProject, f.description, this.now().toISOString(), id)
      return changed
    })
    const after = this.getApp(id)
    if (fields.length === 0) return after
    this.audit.append({ action: 'app.update', outcome: 'success', targetType: 'app', targetId: id, targetLabel: after.name, details: { fields } })
    this.onChanged?.(after.environmentId)
    return after
  }

  deleteApp(id: string): void {
    this.vault.assertUnlocked()
    const before = this.getApp(id)
    inTransaction(this.db, () => this.db.prepare('DELETE FROM apps WHERE id = ?').run(id))
    this.audit.append({
      action: 'app.delete',
      outcome: 'success',
      targetType: 'app',
      targetId: id,
      targetLabel: before.name,
      details: this.labels(before.environmentId, before.hostId),
    })
    this.onChanged?.(before.environmentId)
  }

  private validateApp(f: { environmentId: string; hostId: string; name: string; composeProject: string | null; description: string }, selfId: string | null) {
    const name = checkText(f.name, 'app name', MAX_NAME)
    this.checkMembership(f.environmentId, f.hostId)
    const composeProject = f.composeProject === null ? null : f.composeProject.trim()
    if (composeProject !== null && !COMPOSE_PROJECT.test(composeProject)) {
      throw new Error('compose project must be letters, digits, dashes, dots or underscores')
    }
    if (typeof f.description !== 'string' || f.description.length > 1000) throw new Error('description must be at most 1000 characters')
    const dup = this.db
      .prepare('SELECT id FROM apps WHERE environment_id = ? AND host_id = ? AND name = ? COLLATE NOCASE')
      .get(f.environmentId, f.hostId, name) as { id: string } | undefined
    if (dup && dup.id !== selfId) throw new Error(`an app named "${name}" already exists on that host`)
    return { environmentId: f.environmentId, hostId: f.hostId, name, composeProject, description: f.description }
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
    const id = inTransaction(this.db, () => {
      const f = this.validate(
        {
          name: input.name,
          environmentId: input.environmentId,
          hostId: input.hostId,
          appId: input.appId ?? null,
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
      const id = this.ids()
      const ts = this.now().toISOString()
      this.db
        .prepare(
          `INSERT INTO deployments(id, name, environment_id, host_id, app_id, repo_path, default_branch, compose_file, deploy_tag,
            position, urls, health_status, health_timeout_sec, db_backup, backup_dir, pre_hook, post_hook, build_timeout_sec,
            compose_timeout_sec, use_sudo, become_secret_id, managed_env, env_template, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id, f.name, f.environmentId, f.hostId, f.appId, f.repoPath, f.defaultBranch, f.composeFile, f.deployTag,
          f.position, JSON.stringify(f.urls), f.healthStatus, f.healthTimeoutSec, f.dbBackup ? 1 : 0, f.backupDir, f.preHook,
          f.postHook, f.buildTimeoutSec, f.composeTimeoutSec, f.useSudo, f.becomeSecretId, f.managedEnv ? 1 : 0, f.envTemplate, ts, ts,
        )
      this.setVaults(id, f.vaultIds)
      return id
    })
    const d = this.get(id)
    this.audit.append({
      action: 'deploy.create',
      outcome: 'success',
      targetType: 'deployment',
      targetId: id,
      targetLabel: d.name,
      details: this.labels(d.environmentId, d.hostId),
    })
    this.onChanged?.(d.environmentId)
    return d
  }

  /** `undefined` keeps a field; `null` clears the nullable ones. The environment and host never change. */
  update(id: string, patch: DeploymentPatch): DeploymentMeta {
    this.vault.assertUnlocked()
    const before = this.get(id)
    if (
      (patch.environmentId !== undefined && patch.environmentId !== before.environmentId) ||
      (patch.hostId !== undefined && patch.hostId !== before.hostId)
    ) {
      throw new Error(MOVE_MESSAGE)
    }
    const fields = inTransaction(this.db, () => {
      const pick = <K extends keyof Fields>(k: K): Fields[K] => (patch[k as keyof DeploymentPatch] === undefined ? before[k] : (patch[k as keyof DeploymentPatch] as Fields[K]))
      const merged: Fields = {
        name: pick('name'),
        environmentId: before.environmentId,
        hostId: before.hostId,
        appId: pick('appId'),
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
      const f = this.validate(merged, id)
      const changed = FIELDS.filter((k) => !same(f[k], before[k]))
      if (changed.length === 0) return changed
      this.db
        .prepare(
          `UPDATE deployments SET name = ?, app_id = ?, repo_path = ?, default_branch = ?, compose_file = ?, deploy_tag = ?,
            position = ?, urls = ?, health_status = ?, health_timeout_sec = ?, db_backup = ?, backup_dir = ?, pre_hook = ?,
            post_hook = ?, build_timeout_sec = ?, compose_timeout_sec = ?, use_sudo = ?, become_secret_id = ?, managed_env = ?,
            env_template = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          f.name, f.appId, f.repoPath, f.defaultBranch, f.composeFile, f.deployTag, f.position, JSON.stringify(f.urls),
          f.healthStatus, f.healthTimeoutSec, f.dbBackup ? 1 : 0, f.backupDir, f.preHook, f.postHook, f.buildTimeoutSec,
          f.composeTimeoutSec, f.useSudo, f.becomeSecretId, f.managedEnv ? 1 : 0, f.envTemplate, this.now().toISOString(), id,
        )
      if (changed.includes('vaultIds')) this.setVaults(id, f.vaultIds)
      return changed
    })
    const after = this.get(id)
    if (fields.length === 0) return after
    this.audit.append({ action: 'deploy.update', outcome: 'success', targetType: 'deployment', targetId: id, targetLabel: after.name, details: { fields } })
    this.onChanged?.(after.environmentId)
    return after
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
      details: this.labels(before.environmentId, before.hostId),
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
    const fields = inTransaction(this.db, () => {
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
    })
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
      appId: r.app_id,
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

  private labels(environmentId: string, hostId: string): { environment: string; host: string } {
    const host = (this.db.prepare('SELECT label FROM hosts WHERE id = ?').get(hostId) as { label: string } | undefined)?.label ?? ''
    return { environment: this.envName(environmentId), host }
  }

  private checkMembership(environmentId: string, hostId: string): void {
    if (!this.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(hostId)) throw new Error('host not found')
    if (!this.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) throw new Error('environment not found')
    if (!this.db.prepare('SELECT 1 FROM environment_hosts WHERE environment_id = ? AND host_id = ?').get(environmentId, hostId)) {
      throw new Error("host isn't in that environment")
    }
  }

  /** Checks every rule on a fully merged deployment. Messages name the rule, never the value. */
  private validate(f: Fields, selfId: string | null): Fields {
    const name = checkText(f.name, 'deployment name', MAX_NAME)
    this.checkMembership(f.environmentId, f.hostId)
    if (f.appId !== null) {
      const app = this.db.prepare('SELECT host_id, environment_id FROM apps WHERE id = ?').get(f.appId) as
        | { host_id: string; environment_id: string }
        | undefined
      if (!app || app.host_id !== f.hostId) throw new Error("app isn't on that host")
      if (app.environment_id !== f.environmentId) throw new Error("app isn't in that environment")
    }
    const dup = this.db
      .prepare('SELECT id FROM deployments WHERE environment_id = ? AND name = ? COLLATE NOCASE')
      .get(f.environmentId, name) as { id: string } | undefined
    if (dup && dup.id !== selfId) throw new Error(`a deployment named "${name}" already exists in this environment`)

    const pathMsg = 'must be an absolute path without spaces or shell characters'
    if (typeof f.repoPath !== 'string' || !REPO_PATH.test(f.repoPath)) throw new Error(`repo path ${pathMsg}`)
    if (typeof f.defaultBranch !== 'string' || !GIT_REF.test(f.defaultBranch)) throw new Error("branch isn't a valid git branch name")
    if (typeof f.deployTag !== 'string' || !GIT_REF.test(f.deployTag)) throw new Error("deploy tag isn't a valid git tag name")
    if (typeof f.composeFile !== 'string' || !COMPOSE_FILE.test(f.composeFile)) throw new Error('compose file must be a relative path inside the repo')

    const urls = this.checkUrls(f.urls)
    this.checkInt(f.healthStatus, 100, 599, 'health status')
    this.checkInt(f.healthTimeoutSec, 5, 600, 'health timeout')
    this.checkInt(f.buildTimeoutSec, 10, 3600, 'build timeout')
    this.checkInt(f.composeTimeoutSec, 10, 3600, 'compose timeout')
    this.checkInt(f.position, 0, 1_000_000, 'position')
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
      appId: f.appId,
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
      if (typeof u?.url !== 'string' || u.url.length === 0 || u.url.length > MAX_URL || /[{}\s\u0000-\u001f]/.test(u.url)) throw bad
      if (u.from !== 'host' && u.from !== 'mac') throw new Error(`url ${i + 1} must be checked from host or mac`)
      let parsed: URL
      try {
        parsed = new URL(u.url)
      } catch {
        throw bad
      }
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') throw bad
      return { url: u.url, from: u.from }
    })
  }
}

function appMeta(r: AppRow): AppMeta {
  return {
    id: r.id,
    environmentId: r.environment_id,
    hostId: r.host_id,
    name: r.name,
    composeProject: r.compose_project,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
