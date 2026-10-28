import { randomBytes } from 'node:crypto'
import { chmod, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  CONFIG_FORMAT,
  CONFIG_VERSION,
  TEMPLATE_SECRET_REF,
  countConfig,
  type ConfigCounts,
  type ConfigDeployment,
  type ConfigEnvironment,
  type ConfigFile,
  type ConfigFlow,
  type ConfigRunbook,
  type ConfigRunbookItem,
  type ConfigSegment,
  type ConfigStep,
  type ConfigStepBody,
  type ConfigHost,
  type ConfigIdentity,
  type ConfigProduct,
  type ConfigRegion,
  type ConfigService,
  type ConfigTunnel,
  type ItemRef,
  type VaultRef,
} from '../../shared/config-file'
import { REPO_URL, isParsableRepoUrl, stripRepoCredentials } from '../../shared/inventory'
import { blankTemplateLines as blankTemplate, blankUrlParams as blankParams, isExportSecretVar } from '../../shared/config-secrets'
import type { ReleaseFlow } from '../../shared/deploy'
import type { Runbook } from '../../shared/runbooks'
import type { Step, StepBody, StepSecret } from '../../shared/steps'
import type { DbEngine } from '../../shared/services'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import type { VaultService } from '../vault/vault-service'
import { selectSegment } from './segment'

// Only config is read: no secret value, key material or sealed column is ever selected, and release state,
// history, known_hosts, snippets and the vaults themselves (referenced by name) stay out. Secrets kept in plain
// config columns are left out too: sensitive host env var values, repo URL credentials and refs to deleted secrets.

type Row = Record<string, unknown>

const byId = <T extends { id: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const byKey = <T>(xs: T[], key: (x: T) => string): T[] => xs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
const bool = (v: unknown): boolean => v === 1
const str = (v: unknown): string => v as string
const optStr = (v: unknown): string | null => (v === null ? null : (v as string))
const optInt = (v: unknown): number | null => (v === null ? null : Number(v))

/** Link rows grouped by their owner id, each list sorted. */
function groups<T>(rows: Row[], owner: string, item: (r: Row) => T, key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const list = out.get(str(r[owner])) ?? []
    list.push(item(r))
    out.set(str(r[owner]), list)
  }
  for (const list of out.values()) byKey(list, key)
  return out
}

/** Where a left-out value was: `<kind>:<id>`, or `environments:<id>:flow` for one in a release flow. */
type OmittedAt = Map<string, number>

function readConfig(db: Db, now: () => Date): { file: ConfigFile; omitted: OmittedAt } {
  const all = (sql: string): Row[] => db.prepare(sql).all() as Row[]
  // Values left out of the file, counted for the user by the object they belong to: never which ones.
  const omitted: OmittedAt = new Map()
  let at = ''
  const omit = (): void => void omitted.set(at, (omitted.get(at) ?? 0) + 1)
  const repoUrl = (v: unknown): string | null => {
    const url = optStr(v)
    if (url === null) return null
    // A legacy row the rules would now refuse could still hold a token in a shape the strip can't read: leave it out.
    if (!REPO_URL.test(url) || !isParsableRepoUrl(url)) {
      omit()
      return null
    }
    const clean = stripRepoCredentials(url)
    if (clean !== url) omit()
    return blankUrlParams(clean)
  }
  /** Blanks the value of every query parameter whose name looks secret; each one counts. */
  const blankUrlParams = (url: string): string => blankParams(url, omit)
  const envVars = (v: unknown): Record<string, string> => {
    const vars = JSON.parse(str(v)) as Record<string, string>
    for (const [k, value] of Object.entries(vars)) {
      if (!isExportSecretVar(k, value)) continue
      vars[k] = ''
      omit()
    }
    return vars
  }
  const vaultName = new Map(all('SELECT id, name FROM vaults').map((r) => [str(r.id), str(r.name)]))

  // Secret refs: the become secrets and the secrets env templates name, keyed ref-N in (vault name, item name) order.
  const deployRows = all(
    `SELECT id, environment_id, host_id, name, repo_url, repo_path, default_branch, compose_file, compose_project, deploy_tag,
       position, urls, health_status, health_timeout_sec, db_backup, backup_dir, pre_hook, post_hook, steps, build_timeout_sec,
       compose_timeout_sec, use_sudo, become_secret_id, managed_env, env_template FROM deployments`,
  )
  const secretItems = new Map(
    all('SELECT id, vault_id, name FROM secrets').map((r) => [str(r.id), { vaultName: vaultName.get(str(r.vault_id))!, itemName: str(r.name) }]),
  )
  const used = new Set<string>()
  const stepsOf = (v: unknown): Step[] => JSON.parse(optStr(v) ?? '[]') as Step[]
  const deploySteps = new Map(deployRows.map((r) => [str(r.id), stepsOf(r.steps)]))
  const flowRows = all('SELECT id, release_flow FROM environments WHERE release_flow IS NOT NULL')
  const runbookRows = all('SELECT id, environment_id, name, description, definition FROM runbooks')
  const runbookDefs = runbookRows.map((r) => JSON.parse(str(r.definition)) as Pick<Runbook, 'targetServiceIds' | 'items' | 'params' | 'lock' | 'notify'>)
  const flowSteps = (flow: ReleaseFlow): StepBody[] => flow.stages.flatMap((st) => (st.kind === 'step' ? [st.step] : []))
  const useSecrets = (steps: StepBody[]): void => {
    for (const st of steps) for (const sec of st.secrets) if (secretItems.has(sec.secretId)) used.add(sec.secretId)
  }
  for (const d of deployRows) {
    if (d.become_secret_id !== null) used.add(str(d.become_secret_id))
    for (const m of (optStr(d.env_template) ?? '').matchAll(TEMPLATE_SECRET_REF)) if (secretItems.has(m[1])) used.add(m[1])
    useSecrets(deploySteps.get(str(d.id))!)
  }
  for (const r of flowRows) useSecrets(flowSteps(JSON.parse(str(r.release_flow)) as ReleaseFlow))
  for (const d of runbookDefs) useSecrets(d.items.flatMap((i) => (i.type === 'step' ? [i.step] : [])))
  const refItems = byKey(
    [...used].map((id) => ({ id, item: secretItems.get(id)! })),
    (x) => `${x.item.vaultName}\u0000${x.item.itemName}`,
  )
  const refOf = new Map(refItems.map((x, i) => [x.id, `ref-${i + 1}`]))
  const secretRefs: Record<string, ItemRef> = {}
  refItems.forEach((x, i) => (secretRefs[`ref-${i + 1}`] = x.item))

  /** A step's secrets as ref keys; a secret that no longer exists is left out (its local id means nothing elsewhere). */
  const refSecrets = (secrets: StepSecret[]): ConfigStepBody['secrets'] =>
    secrets.flatMap((sec) => {
      const key = refOf.get(sec.secretId)
      if (key === undefined) {
        omit()
        return []
      }
      return [{ envName: sec.envName, secret: key }]
    })
  const configBody = (st: StepBody): ConfigStepBody => ({ ...st, secrets: refSecrets(st.secrets) })
  const configStep = (st: Step): ConfigStep => ({ ...st, secrets: refSecrets(st.secrets) })
  const configFlow = (flow: ReleaseFlow): ConfigFlow => ({
    stages: flow.stages.map((st) => (st.kind === 'services' ? st : { ...st, step: configBody(st.step) })),
    onFailure: flow.onFailure,
  })

  const vaultRefs = (ids: string[] | undefined): VaultRef[] =>
    byKey(
      (ids ?? []).map((id) => ({ vaultName: vaultName.get(id)! })),
      (v) => v.vaultName,
    )

  const regions: ConfigRegion[] = all('SELECT id, code, provider, display_name FROM regions').map((r) => ({
    id: str(r.id),
    code: str(r.code),
    provider: str(r.provider),
    displayName: str(r.display_name),
  }))

  const products: ConfigProduct[] = all('SELECT id, name, color, icon, description, repo_url FROM products').map((r) => {
    at = `products:${str(r.id)}`
    return {
      id: str(r.id),
      name: str(r.name),
      color: str(r.color),
      icon: r.icon as ConfigProduct['icon'],
      description: str(r.description),
      repoUrl: repoUrl(r.repo_url),
    }
  })

  const keyItem = new Map(all('SELECT id, vault_id, label FROM ssh_keys').map((r) => [str(r.id), { vaultName: vaultName.get(str(r.vault_id))!, itemName: str(r.label) }]))
  const identities: ConfigIdentity[] = all('SELECT id, vault_id, label, username, auth, ssh_key_id FROM identities').map((r) => ({
    id: str(r.id),
    vault: { vaultName: vaultName.get(str(r.vault_id))! },
    label: str(r.label),
    username: str(r.username),
    auth: r.auth as ConfigIdentity['auth'],
    key: r.ssh_key_id === null ? null : (keyItem.get(str(r.ssh_key_id)) ?? null),
  }))

  const hostVaults = groups(all('SELECT host_id, vault_id FROM host_vaults'), 'host_id', (r) => str(r.vault_id), (x) => x)
  const hosts: ConfigHost[] = all(
    'SELECT id, label, address, region_id, port, identity_id, jump_host_id, tags, os_icon, notes, keepalive_sec, env_vars FROM hosts',
  ).map((r) => {
    at = `hosts:${str(r.id)}`
    return {
      id: str(r.id),
      label: str(r.label),
      address: str(r.address),
      regionId: str(r.region_id),
      port: optInt(r.port),
      identityId: optStr(r.identity_id),
      jumpHostId: optStr(r.jump_host_id),
      tags: JSON.parse(str(r.tags)) as string[],
      osIcon: r.os_icon as ConfigHost['osIcon'],
      notes: str(r.notes),
      keepaliveSec: optInt(r.keepalive_sec),
      envVars: envVars(r.env_vars),
      vaults: vaultRefs(hostVaults.get(str(r.id))),
    }
  })

  const envHosts = groups(
    all('SELECT environment_id, host_id, role FROM environment_hosts'),
    'environment_id',
    (r) => ({ hostId: str(r.host_id), role: r.role as ConfigEnvironment['hosts'][number]['role'] }),
    (x) => x.hostId,
  )
  const environments: ConfigEnvironment[] = all(
    `SELECT id, name, color, protected, default_identity_id, default_port, default_jump_host_id, versioned, auto_rollback, domain,
       product_id, parallel_prepare, prepare_cap, release_flow FROM environments`,
  ).map((r) => {
    at = `environments:${str(r.id)}:flow`
    return {
      id: str(r.id),
      name: str(r.name),
      color: str(r.color),
      protected: bool(r.protected),
      defaultIdentityId: optStr(r.default_identity_id),
      defaultPort: optInt(r.default_port),
      defaultJumpHostId: optStr(r.default_jump_host_id),
      versioned: bool(r.versioned),
      autoRollback: bool(r.auto_rollback),
      domain: optStr(r.domain),
      parallelPrepare: bool(r.parallel_prepare),
      prepareCap: Number(r.prepare_cap),
      ...(r.release_flow === null ? {} : { flow: configFlow(JSON.parse(str(r.release_flow)) as ReleaseFlow) }),
      productId: str(r.product_id),
      hosts: envHosts.get(str(r.id)) ?? [],
    }
  })

  const tunnels: ConfigTunnel[] = all(
    'SELECT id, label, host_id, environment_id, type, bind_address, bind_port, target_host, target_port, auto_start, auto_reconnect, max_minutes FROM tunnels',
  ).map((r) => ({
    id: str(r.id),
    label: str(r.label),
    hostId: str(r.host_id),
    environmentId: optStr(r.environment_id),
    type: r.type as ConfigTunnel['type'],
    bindAddress: str(r.bind_address),
    bindPort: Number(r.bind_port),
    targetHost: optStr(r.target_host),
    targetPort: optInt(r.target_port),
    autoStart: bool(r.auto_start),
    autoReconnect: bool(r.auto_reconnect),
    maxMinutes: optInt(r.max_minutes),
  }))

  const deployVaults = groups(all('SELECT deployment_id, vault_id FROM deployment_vaults'), 'deployment_id', (r) => str(r.vault_id), (x) => x)
  // A ref to a secret that no longer exists exports blank: its local id means nothing elsewhere.
  // Template lines with a secret-looking name or a credentialed URL value (and no ${secret:} ref) export as `KEY=`.
  const blankTemplateLines = (template: string): string => blankTemplate(template, omit)
  const rewrite = (template: string | null): string | null =>
    template === null
      ? null
      : blankTemplateLines(template).replace(TEMPLATE_SECRET_REF, (_m, id: string) => {
          if (refOf.has(id)) return `\${secret:${refOf.get(id)}}`
          omit()
          return ''
        })
  const deployments: ConfigDeployment[] = deployRows.map((r) => {
    at = `deployments:${str(r.id)}`
    return {
      id: str(r.id),
      environmentId: str(r.environment_id),
      hostId: str(r.host_id),
      name: str(r.name),
      repoUrl: repoUrl(r.repo_url),
      repoPath: str(r.repo_path),
      defaultBranch: str(r.default_branch),
      composeFile: str(r.compose_file),
      composeProject: optStr(r.compose_project),
      deployTag: str(r.deploy_tag),
      position: Number(r.position),
      urls: (JSON.parse(str(r.urls)) as ConfigDeployment['urls']).map((u) => ({ ...u, url: blankUrlParams(u.url) })),
      healthStatus: Number(r.health_status),
      healthTimeoutSec: Number(r.health_timeout_sec),
      dbBackup: bool(r.db_backup),
      backupDir: optStr(r.backup_dir),
      preHook: optStr(r.pre_hook),
      postHook: optStr(r.post_hook),
      ...(deploySteps.get(str(r.id))!.length === 0 ? {} : { steps: deploySteps.get(str(r.id))!.map(configStep) }),
      buildTimeoutSec: Number(r.build_timeout_sec),
      composeTimeoutSec: Number(r.compose_timeout_sec),
      useSudo: r.use_sudo as ConfigDeployment['useSudo'],
      becomeSecret: r.become_secret_id === null ? null : refOf.get(str(r.become_secret_id))!,
      vaults: vaultRefs(deployVaults.get(str(r.id))),
      managedEnv: bool(r.managed_env),
      envTemplate: rewrite(optStr(r.env_template)),
    }
  })

  const services: ConfigService[] = all(
    `SELECT id, environment_id, name, kind, position, description, deployment_id, compose_service, url, url_check_from,
       db_engine, db_address, db_port, via_host_id, local_port, tunnel_id, skip_unchanged FROM services`,
  ).map((r) => {
    at = `services:${str(r.id)}`
    const common = { id: str(r.id), environmentId: str(r.environment_id), name: str(r.name) }
    return r.kind === 'service'
      ? {
          ...common,
          kind: 'service' as const,
          position: Number(r.position),
          description: str(r.description),
          deploymentId: optStr(r.deployment_id),
          composeService: str(r.compose_service),
          url: r.url === null ? null : blankUrlParams(str(r.url)),
          urlCheckFrom: r.url_check_from as 'mac' | 'host',
          skipUnchanged: bool(r.skip_unchanged),
        }
      : {
          ...common,
          kind: 'db' as const,
          position: Number(r.position),
          description: str(r.description),
          dbEngine: r.db_engine as DbEngine,
          dbAddress: str(r.db_address),
          dbPort: Number(r.db_port),
          viaHostId: optStr(r.via_host_id),
          localPort: optInt(r.local_port),
          tunnelId: optStr(r.tunnel_id),
        }
  })

  const runbooks: ConfigRunbook[] = runbookRows.map((r, i) => {
    at = `runbooks:${str(r.id)}`
    return {
      id: str(r.id),
      environmentId: str(r.environment_id),
      name: str(r.name),
      description: str(r.description),
      targetServiceIds: [...runbookDefs[i].targetServiceIds].sort(),
      items: runbookDefs[i].items.map((it): ConfigRunbookItem => (it.type === 'step' ? { type: 'step', step: configBody(it.step) } : it)),
      params: runbookDefs[i].params,
      lock: runbookDefs[i].lock,
      notify: runbookDefs[i].notify,
    }
  })

  const file: ConfigFile = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: now().toISOString(),
    secretRefs,
    regions: byId(regions),
    products: byId(products),
    identities: byId(identities),
    hosts: byId(hosts),
    environments: byId(environments),
    tunnels: byId(tunnels),
    deployments: byId(deployments),
    services: byId(services),
    ...(runbooks.length === 0 ? {} : { runbooks: byId(runbooks) }),
  }
  return { file, omitted }
}

/**
 * The whole config, or with `segment` a page's part of it, read in one transaction so the parts agree with each
 * other. `omitted` counts the secret values left out (sensitive env var values, repo URL credentials, refs to
 * deleted secrets) of what the file holds.
 */
export function buildConfigExport(db: Db, now: () => Date, segment?: ConfigSegment): { file: ConfigFile; counts: ConfigCounts; omitted: number } {
  // A deferred BEGIN: a read snapshot without taking the write lock.
  db.exec('BEGIN')
  try {
    const read = readConfig(db, now)
    if (segment === undefined) {
      const file = read.file
      return { file, counts: countConfig(file), omitted: [...read.omitted.values()].reduce((a, b) => a + b, 0) }
    }
    const { file, own, kept } = selectSegment(read.file, segment)
    let omitted = 0
    for (const [at, n] of read.omitted) {
      const [kind, id, flow] = at.split(':') as [keyof ConfigCounts, string, string | undefined]
      // A dependency environment goes without its flow, and what was left out of it.
      if (kept[kind].has(id) && (flow === undefined || own.has('environments'))) omitted += n
    }
    return { file, counts: countConfig(file), omitted }
  } finally {
    db.exec('COMMIT')
  }
}

export const serializeConfig = (file: ConfigFile): string => JSON.stringify(file, null, 2) + '\n'

export interface ConfigExportDeps {
  db: Db
  vault: Pick<VaultService, 'assertUnlocked'>
  audit: Pick<AuditLog, 'append'>
  now: () => Date
}

/**
 * Writes the export to `path` (0600) and audits counts only: never the path, an address or a name. The file is
 * written to a temp file beside it and renamed over it, so a failure never leaves a partial or widened file.
 */
export async function exportConfig(deps: ConfigExportDeps, path: string, segment?: ConfigSegment): Promise<{ counts: ConfigCounts; omitted: number }> {
  deps.vault.assertUnlocked()
  const failed = (message: string): Error => {
    deps.audit.append({ action: 'config.export', outcome: 'failure', targetType: 'config', targetLabel: 'config', details: segment ? { segment } : {} })
    return new Error(message)
  }
  let built: ReturnType<typeof buildConfigExport>
  try {
    built = buildConfigExport(deps.db, deps.now, segment)
  } catch {
    // A parser or SQLite message could quote stored text: none of it crosses IPC.
    throw failed("Couldn't read the config")
  }
  const { file, counts, omitted } = built
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  // Cleanup only touches a temp file this call created: an EEXIST means the name belongs to someone else.
  let created = false
  try {
    try {
      await writeFile(temp, serializeConfig(file), { mode: 0o600, flag: 'wx' })
    } catch (err) {
      // A partial write leaves a file of ours behind; a name collision does not.
      created = (err as NodeJS.ErrnoException).code !== 'EEXIST'
      throw err
    }
    created = true
    // `mode` is masked by the umask: make sure of it before the file takes the target's name.
    await chmod(temp, 0o600)
    await rename(temp, path)
  } catch {
    if (created) await rm(temp, { force: true }).catch(() => undefined)
    throw failed("Couldn't write the config file")
  }
  deps.audit.append({ action: 'config.export', outcome: 'success', targetType: 'config', targetLabel: 'config', details: { counts, omitted, ...(segment ? { segment } : {}) } })
  return { counts, omitted }
}
