import { chmod, writeFile } from 'node:fs/promises'
import {
  CONFIG_FORMAT,
  CONFIG_VERSION,
  TEMPLATE_SECRET_REF,
  countConfig,
  type ConfigCounts,
  type ConfigDeployment,
  type ConfigEnvironment,
  type ConfigFile,
  type ConfigHost,
  type ConfigIdentity,
  type ConfigProduct,
  type ConfigService,
  type ConfigTunnel,
  type ItemRef,
  type VaultRef,
} from '../../shared/config-file'
import type { DbEngine } from '../../shared/services'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import type { VaultService } from '../vault/vault-service'

// Only config is read: no secret value, key material or sealed column is ever selected, and release state,
// history, known_hosts, snippets and the vaults themselves (referenced by name) stay out.

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

function readConfig(db: Db, now: () => Date): ConfigFile {
  const all = (sql: string): Row[] => db.prepare(sql).all() as Row[]
  const vaultName = new Map(all('SELECT id, name FROM vaults').map((r) => [str(r.id), str(r.name)]))

  // Secret refs: the become secrets and the secrets env templates name, keyed ref-N in (vault name, item name) order.
  const deployRows = all(
    `SELECT id, environment_id, host_id, name, repo_url, repo_path, default_branch, compose_file, compose_project, deploy_tag,
       position, urls, health_status, health_timeout_sec, db_backup, backup_dir, pre_hook, post_hook, build_timeout_sec,
       compose_timeout_sec, use_sudo, become_secret_id, managed_env, env_template FROM deployments`,
  )
  const secretItems = new Map(
    all('SELECT id, vault_id, name FROM secrets').map((r) => [str(r.id), { vaultName: vaultName.get(str(r.vault_id))!, itemName: str(r.name) }]),
  )
  const used = new Set<string>()
  for (const d of deployRows) {
    if (d.become_secret_id !== null) used.add(str(d.become_secret_id))
    for (const m of (optStr(d.env_template) ?? '').matchAll(TEMPLATE_SECRET_REF)) if (secretItems.has(m[1])) used.add(m[1])
  }
  const refItems = byKey(
    [...used].map((id) => ({ id, item: secretItems.get(id)! })),
    (x) => `${x.item.vaultName}\u0000${x.item.itemName}`,
  )
  const refOf = new Map(refItems.map((x, i) => [x.id, `ref-${i + 1}`]))
  const secretRefs: Record<string, ItemRef> = {}
  refItems.forEach((x, i) => (secretRefs[`ref-${i + 1}`] = x.item))

  const vaultRefs = (ids: string[] | undefined): VaultRef[] =>
    byKey(
      (ids ?? []).map((id) => ({ vaultName: vaultName.get(id)! })),
      (v) => v.vaultName,
    )

  const products: ConfigProduct[] = all('SELECT id, name, color, icon, description, repo_url FROM products').map((r) => ({
    id: str(r.id),
    name: str(r.name),
    color: str(r.color),
    icon: r.icon as ConfigProduct['icon'],
    description: str(r.description),
    repoUrl: optStr(r.repo_url),
  }))

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
    'SELECT id, label, address, port, identity_id, jump_host_id, tags, os_icon, notes, keepalive_sec, env_vars FROM hosts',
  ).map((r) => ({
    id: str(r.id),
    label: str(r.label),
    address: str(r.address),
    port: optInt(r.port),
    identityId: optStr(r.identity_id),
    jumpHostId: optStr(r.jump_host_id),
    tags: JSON.parse(str(r.tags)) as string[],
    osIcon: r.os_icon as ConfigHost['osIcon'],
    notes: str(r.notes),
    keepaliveSec: optInt(r.keepalive_sec),
    envVars: JSON.parse(str(r.env_vars)) as Record<string, string>,
    vaults: vaultRefs(hostVaults.get(str(r.id))),
  }))

  const envProducts = groups(all('SELECT product_id, environment_id FROM product_environments'), 'environment_id', (r) => str(r.product_id), (x) => x)
  const envHosts = groups(
    all('SELECT environment_id, host_id, role FROM environment_hosts'),
    'environment_id',
    (r) => ({ hostId: str(r.host_id), role: r.role as ConfigEnvironment['hosts'][number]['role'] }),
    (x) => x.hostId,
  )
  const environments: ConfigEnvironment[] = all(
    `SELECT id, name, color, protected, default_identity_id, default_port, default_jump_host_id, versioned, auto_rollback, domain
     FROM environments`,
  ).map((r) => ({
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
    productIds: envProducts.get(str(r.id)) ?? [],
    hosts: envHosts.get(str(r.id)) ?? [],
  }))

  const tunnels: ConfigTunnel[] = all(
    'SELECT id, label, host_id, environment_id, type, bind_address, bind_port, target_host, target_port, auto_start, auto_reconnect FROM tunnels',
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
  }))

  const deployVaults = groups(all('SELECT deployment_id, vault_id FROM deployment_vaults'), 'deployment_id', (r) => str(r.vault_id), (x) => x)
  // A ref to a secret that no longer exists exports blank: its local id means nothing elsewhere.
  const rewrite = (template: string | null): string | null =>
    template === null ? null : template.replace(TEMPLATE_SECRET_REF, (_m, id: string) => (refOf.has(id) ? `\${secret:${refOf.get(id)}}` : ''))
  const deployments: ConfigDeployment[] = deployRows.map((r) => ({
    id: str(r.id),
    environmentId: str(r.environment_id),
    hostId: str(r.host_id),
    name: str(r.name),
    repoUrl: optStr(r.repo_url),
    repoPath: str(r.repo_path),
    defaultBranch: str(r.default_branch),
    composeFile: str(r.compose_file),
    composeProject: optStr(r.compose_project),
    deployTag: str(r.deploy_tag),
    position: Number(r.position),
    urls: JSON.parse(str(r.urls)) as ConfigDeployment['urls'],
    healthStatus: Number(r.health_status),
    healthTimeoutSec: Number(r.health_timeout_sec),
    dbBackup: bool(r.db_backup),
    backupDir: optStr(r.backup_dir),
    preHook: optStr(r.pre_hook),
    postHook: optStr(r.post_hook),
    buildTimeoutSec: Number(r.build_timeout_sec),
    composeTimeoutSec: Number(r.compose_timeout_sec),
    useSudo: r.use_sudo as ConfigDeployment['useSudo'],
    becomeSecret: r.become_secret_id === null ? null : refOf.get(str(r.become_secret_id))!,
    vaults: vaultRefs(deployVaults.get(str(r.id))),
    managedEnv: bool(r.managed_env),
    envTemplate: rewrite(optStr(r.env_template)),
  }))

  const services: ConfigService[] = all(
    `SELECT id, environment_id, name, kind, position, description, deployment_id, compose_service, url, url_check_from,
       db_engine, db_address, db_port, via_host_id, local_port, tunnel_id FROM services`,
  ).map((r) => {
    const common = { id: str(r.id), environmentId: str(r.environment_id), name: str(r.name) }
    return r.kind === 'service'
      ? {
          ...common,
          kind: 'service' as const,
          position: Number(r.position),
          description: str(r.description),
          deploymentId: optStr(r.deployment_id),
          composeService: str(r.compose_service),
          url: optStr(r.url),
          urlCheckFrom: r.url_check_from as 'mac' | 'host',
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

  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: now().toISOString(),
    secretRefs,
    products: byId(products),
    identities: byId(identities),
    hosts: byId(hosts),
    environments: byId(environments),
    tunnels: byId(tunnels),
    deployments: byId(deployments),
    services: byId(services),
  }
}

/** The whole config, read in one transaction so the parts agree with each other. */
export function buildConfigExport(db: Db, now: () => Date): { file: ConfigFile; counts: ConfigCounts } {
  // A deferred BEGIN: a read snapshot without taking the write lock.
  db.exec('BEGIN')
  try {
    const file = readConfig(db, now)
    return { file, counts: countConfig(file) }
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

/** Writes the export to `path` (0600) and audits counts only: never the path, an address or a name. */
export async function exportConfig(deps: ConfigExportDeps, path: string): Promise<{ counts: ConfigCounts }> {
  deps.vault.assertUnlocked()
  const { file, counts } = buildConfigExport(deps.db, deps.now)
  const text = serializeConfig(file)
  try {
    await writeFile(path, text, { mode: 0o600 })
    // `mode` only applies when the file is created: tighten an existing one too.
    await chmod(path, 0o600)
  } catch {
    deps.audit.append({ action: 'config.export', outcome: 'failure', targetType: 'config', targetLabel: 'config', details: {} })
    throw new Error("Couldn't write the config file")
  }
  deps.audit.append({ action: 'config.export', outcome: 'success', targetType: 'config', targetLabel: 'config', details: { counts } })
  return { counts }
}
