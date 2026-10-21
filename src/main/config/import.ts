import {
  IMPORT_ACTIONS,
  TEMPLATE_SECRET_REF,
  type ConfigCounts,
  type ConfigFile,
  type ImportAction,
  type ImportItem,
  type ImportNeedsSecret,
  type ImportPreview,
  type ImportResult,
  type VaultRef,
} from '../../shared/config-file'
import { SENSITIVE_KEY } from '../../shared/deploy'
import { stripRepoCredentials } from '../../shared/inventory'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { DeployError } from '../deploy/access'
import { DeployStore, dbSecretRefs } from '../deploy/deploy-store'
import { ServiceStore } from '../deploy/service-store'
import { EnvironmentStore } from '../inventory/environment-store'
import { HostStore } from '../inventory/host-store'
import { ProductStore } from '../inventory/product-store'
import { TunnelStore } from '../tunnels/tunnel-store'
import { IdentityStore } from '../vault/identity-store'
import type { KeyStore } from '../vault/key-store'
import type { VaultService } from '../vault/vault-service'

export type { ImportAction, ImportItem, ImportPreview, ImportResult } from '../../shared/config-file'

export const CHANGED_MESSAGE = 'The config changed since the preview; open the file again'

type Counts = Record<ImportAction, number>
type Kind = keyof ConfigCounts
type Plan = Omit<ImportPreview, 'token'> & { environmentIds: string[] }

// The stores' row rules run on every row (inside the caller's transaction), but none of their per-row side
// effects: their unlock checks, audits and change hooks are left out, so these stand-ins are never reached.
const NO_AUDIT = {
  append() {
    throw new Error('config import writes no per-row audit')
  },
} as unknown as AuditLog
const NO_VAULT = { assertUnlocked() {}, onLock() {}, isCorrupt: () => false, isUnlocked: () => false } as unknown as VaultService

function stores(db: Db) {
  return {
    products: new ProductStore(db, NO_VAULT, NO_AUDIT),
    identities: new IdentityStore(db, NO_VAULT, {} as KeyStore, NO_AUDIT),
    hosts: new HostStore(db, NO_VAULT, NO_AUDIT),
    envs: new EnvironmentStore(db, NO_VAULT, NO_AUDIT),
    tunnels: new TunnelStore({ db, audit: NO_AUDIT, vault: NO_VAULT }),
    deploys: new DeployStore({ db, audit: NO_AUDIT, vault: NO_VAULT, secrets: dbSecretRefs(db) }),
    services: new ServiceStore({ db, audit: NO_AUDIT, vault: NO_VAULT }),
  }
}

const ambiguous = (n: number): string => `ambiguous: ${n} matches`
const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])].sort()
/** The env var name a template line sets, for saying which lines lost their secret. */
const lineKey = (line: string, i: number): string => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? `line ${i + 1}`

/**
 * Writes the file into the DB through the stores and reports what each object did. It always writes: planImport
 * runs it inside a transaction it rolls back, applyImport inside the one it commits, so both see the same result.
 * Matching is by id, then by name within the parent; nothing missing from the file is deleted, unlinked or changed.
 */
function run(db: Db, file: ConfigFile): Plan {
  let at = ''
  try {
    return runEach(db, file, (where) => (at = where))
  } catch (e) {
    // A row the stores refuse: say which one, keeping the error's own type and code.
    if (e instanceof Error && at) e.message = `${at}: ${e.message}`
    throw e
  }
}

function runEach(db: Db, file: ConfigFile, setAt: (where: string) => void): Plan {
  const s = stores(db)
  const items: ImportItem[] = []
  const needsSecret: ImportNeedsSecret[] = []
  const counts: Counts = { add: 0, update: 0, unchanged: 0, skip: 0 }
  const item = (kind: Kind, id: string, name: string, action: ImportAction, extra: { reason?: string; fields?: string[] } = {}) => {
    counts[action]++
    items.push({ kind, id, name, action, ...(extra.reason ? { reason: extra.reason } : {}), ...(action === 'update' ? { fields: extra.fields } : {}) })
  }
  const done = (kind: Kind, id: string, name: string, added: boolean, fields: string[]) =>
    item(kind, id, name, added ? 'add' : fields.length > 0 ? 'update' : 'unchanged', { fields })
  const need = (kind: Kind, name: string, field: string, reason?: string) => needsSecret.push({ kind, name, field, ...(reason ? { reason } : {}) })

  const ids = (sql: string, ...params: (string | null)[]): string[] => (db.prepare(sql).all(...params) as { id: string }[]).map((r) => r.id)
  const exists = (table: string, id: string): boolean => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined

  // file id -> local id; null when the object was skipped.
  const map = {
    identities: new Map<string, string | null>(),
    products: new Map<string, string | null>(),
    hosts: new Map<string, string | null>(),
    environments: new Map<string, string | null>(),
    tunnels: new Map<string, string | null>(),
    deployments: new Map<string, string | null>(),
  }
  /** `undefined` when the file's reference is to a skipped object (keep what is here), else the local id or null. */
  const ref = (m: Map<string, string | null>, fileId: string | null): string | null | undefined =>
    fileId === null ? null : (m.get(fileId) ?? undefined)

  const vaultIds = new Map<string, string[]>()
  for (const r of db.prepare('SELECT id, name FROM vaults').all() as { id: string; name: string }[]) {
    vaultIds.set(r.name, [...(vaultIds.get(r.name) ?? []), r.id])
  }
  const vaultOf = (name: string): string | null => {
    const list = vaultIds.get(name) ?? []
    return list.length === 1 ? list[0] : null
  }
  /** The local vault ids; each name that doesn't resolve is listed as needing a secret. */
  const vaults = (kind: Kind, name: string, refs: VaultRef[]): string[] => {
    const out: string[] = []
    for (const v of refs) {
      const id = vaultOf(v.vaultName)
      if (id === null) need(kind, name, 'vaults', `no vault named ${v.vaultName}`)
      else out.push(id)
    }
    return out
  }
  const secret = (refKey: string): { id: string } | { reason?: string } => {
    const r = file.secretRefs[refKey]
    const vid = r ? vaultOf(r.vaultName) : null
    if (vid === null) return {}
    const found = ids('SELECT id FROM secrets WHERE vault_id = ? AND name = ?', vid, r.itemName)
    if (found.length === 1) return { id: found[0] }
    return found.length > 1 ? { reason: ambiguous(found.length) } : {}
  }

  // Which existing environments change, for the typed confirmation of the protected ones.
  const envsBefore = new Map(
    (db.prepare('SELECT id, name, protected FROM environments').all() as { id: string; name: string; protected: number }[]).map((r) => [r.id, r]),
  )
  const touched = new Set<string>()
  const touch = (envId: string | null | undefined) => {
    if (envId) touched.add(envId)
  }
  // Changed, but not by the import writing to the environment: no typed confirmation.
  const reloaded = new Set<string>()
  const touchOnly = (envId: string) => reloaded.add(envId)

  // ---- identities ----
  for (const x of file.identities) {
    setAt(`Identity ${x.label}`)
    const vid = vaultOf(x.vault.vaultName)
    let local: string | null = exists('identities', x.id) ? x.id : null
    if (local === null && vid !== null) {
      const found = ids('SELECT id FROM identities WHERE vault_id = ? AND label = ? COLLATE NOCASE', vid, x.label)
      if (found.length > 1) {
        map.identities.set(x.id, null)
        item('identities', x.id, x.label, 'skip', { reason: ambiguous(found.length) })
        continue
      }
      local = found[0] ?? null
    }
    if (local !== null) {
      // An existing identity keeps its own auth, key and password: only what the file can say for sure changes.
      const next = s.identities.updateInTx(local, { label: x.label, username: x.username })
      map.identities.set(x.id, local)
      done('identities', local, x.label, false, next?.fields ?? [])
      continue
    }
    map.identities.set(x.id, null)
    if (vid === null) {
      item('identities', x.id, x.label, 'skip', { reason: `no vault named ${x.vault.vaultName}` })
      continue
    }
    if (x.auth === 'password') {
      item('identities', x.id, x.label, 'skip', { reason: 'needs a secret: password' })
      need('identities', x.label, 'password')
      continue
    }
    let sshKeyId: string | undefined
    if (x.auth === 'key') {
      const kv = x.key ? vaultOf(x.key.vaultName) : null
      const found = x.key && kv !== null ? ids('SELECT id FROM ssh_keys WHERE vault_id = ? AND label = ?', kv, x.key.itemName) : []
      if (found.length !== 1) {
        const reason = found.length > 1 ? ambiguous(found.length) : undefined
        item('identities', x.id, x.label, 'skip', { reason: reason ?? 'needs a secret: key' })
        need('identities', x.label, 'key', reason)
        continue
      }
      sshKeyId = found[0]
    }
    s.identities.insertInTx({ vaultId: vid, label: x.label, username: x.username, auth: x.auth, sshKeyId }, x.id)
    map.identities.set(x.id, x.id)
    done('identities', x.id, x.label, true, [])
  }

  // ---- products ----
  for (const x of file.products) {
    setAt(`Product ${x.name}`)
    const local = exists('products', x.id) ? x.id : (ids('SELECT id FROM products WHERE name = ?', x.name)[0] ?? null)
    if (local === null) {
      s.products.insertInTx({ name: x.name, color: x.color, icon: x.icon, description: x.description, repoUrl: x.repoUrl }, x.id)
      map.products.set(x.id, x.id)
      done('products', x.id, x.name, true, [])
      continue
    }
    // The file has the URL without its credentials: the local one with them is the same URL.
    const here = (db.prepare('SELECT repo_url FROM products WHERE id = ?').get(local) as { repo_url: string | null }).repo_url
    const repoUrl = here !== null && stripRepoCredentials(here) === x.repoUrl ? undefined : x.repoUrl
    const next = s.products.updateInTx(local, { name: x.name, color: x.color, icon: x.icon, description: x.description, repoUrl })
    map.products.set(x.id, local)
    // Environment pages show their products.
    if (next && next.fields.length > 0) for (const e of ids('SELECT environment_id AS id FROM product_environments WHERE product_id = ?', local)) touchOnly(e)
    done('products', local, x.name, false, next?.fields ?? [])
  }

  // ---- hosts: written without jump hosts first, so a jump host later in the file exists when it is set ----
  const hostRows: { x: ConfigFile['hosts'][number]; local: string; added: boolean; fields: string[] }[] = []
  for (const x of file.hosts) {
    setAt(`Host ${x.label}`)
    const local = exists('hosts', x.id) ? x.id : (ids('SELECT id FROM hosts WHERE label = ?', x.label)[0] ?? null)
    const identityId = ref(map.identities, x.identityId)
    if (identityId === undefined) need('hosts', x.label, 'identityId')
    const vaultIdsHere = vaults('hosts', x.label, x.vaults)
    if (local === null) {
      s.hosts.insertInTx(
        {
          label: x.label,
          address: x.address,
          port: x.port,
          identityId: identityId ?? null,
          jumpHostId: null,
          tags: x.tags,
          osIcon: x.osIcon,
          notes: x.notes,
          keepaliveSec: x.keepaliveSec,
          envVars: x.envVars,
          vaultIds: vaultIdsHere,
        },
        x.id,
      )
      map.hosts.set(x.id, x.id)
      hostRows.push({ x, local: x.id, added: true, fields: [] })
      continue
    }
    // A sensitive value is exported blank: the local value stands for it.
    const localVars = JSON.parse((db.prepare('SELECT env_vars FROM hosts WHERE id = ?').get(local) as { env_vars: string }).env_vars) as Record<string, string>
    const envVars = Object.fromEntries(
      Object.entries(x.envVars).map(([k, v]) => [k, v === '' && SENSITIVE_KEY.test(k) && localVars[k] ? localVars[k] : v]),
    )
    const next = s.hosts.updateInTx(local, {
      label: x.label,
      address: x.address,
      port: x.port,
      identityId,
      tags: x.tags,
      osIcon: x.osIcon,
      notes: x.notes,
      keepaliveSec: x.keepaliveSec,
      envVars,
    })
    const fields = next?.fields ?? []
    if (s.hosts.addVaultsInTx(local, vaultIdsHere).length > 0) fields.push('vaults')
    map.hosts.set(x.id, local)
    hostRows.push({ x, local, added: false, fields })
  }
  for (const h of hostRows) {
    setAt(`Host ${h.x.label}`)
    const jumpHostId = ref(map.hosts, h.x.jumpHostId) ?? null
    if (h.added && jumpHostId === null) continue
    const next = s.hosts.updateInTx(h.local, { jumpHostId })
    if (!h.added && next) h.fields.push(...next.fields)
  }
  for (const h of hostRows) done('hosts', h.local, h.x.label, h.added, h.fields)

  // ---- environments and their links ----
  for (const x of file.environments) {
    setAt(`Environment ${x.name}`)
    let local: string | null = exists('environments', x.id) ? x.id : null
    if (local === null) {
      const found = ids('SELECT id FROM environments WHERE name = ? COLLATE NOCASE', x.name)
      if (found.length > 1) {
        map.environments.set(x.id, null)
        item('environments', x.id, x.name, 'skip', { reason: ambiguous(found.length) })
        continue
      }
      local = found[0] ?? null
    }
    const defaultIdentityId = ref(map.identities, x.defaultIdentityId)
    if (defaultIdentityId === undefined) need('environments', x.name, 'defaultIdentityId')
    const defaultJumpHostId = ref(map.hosts, x.defaultJumpHostId) ?? null
    const productIds = x.productIds.map((p) => map.products.get(p)).filter((p): p is string => typeof p === 'string')
    const added = local === null
    const fields: string[] = []
    if (local === null) {
      local = s.envs.insertInTx(
        {
          name: x.name,
          color: x.color,
          protected: x.protected,
          defaultIdentityId: defaultIdentityId ?? null,
          defaultPort: x.defaultPort,
          defaultJumpHostId,
          domain: x.domain,
          productIds,
        },
        x.id,
      )
    } else {
      const next = s.envs.updateInTx(local, {
        name: x.name,
        color: x.color,
        protected: x.protected,
        defaultIdentityId,
        defaultPort: x.defaultPort,
        defaultJumpHostId,
        domain: x.domain,
      })
      fields.push(...(next?.fields ?? []))
      if (s.envs.addProductsInTx(local, productIds).length > 0) fields.push('productIds')
    }
    fields.push(...s.deploys.updateSettingsInTx(local, { versioned: x.versioned, autoRollback: x.autoRollback }))
    let hostsChanged = false
    for (const m of x.hosts) {
      const hostId = map.hosts.get(m.hostId)
      if (hostId && s.envs.putHostInTx(local, hostId, m.role)) hostsChanged = true
    }
    if (hostsChanged && !added) fields.push('hosts')
    map.environments.set(x.id, local)
    if (added || fields.length > 0) touch(local)
    done('environments', local, x.name, added, fields)
  }

  // ---- tunnels ----
  for (const x of file.tunnels) {
    setAt(`Tunnel ${x.label}`)
    const hostId = map.hosts.get(x.hostId)!
    // undefined: its environment is skipped, so an update keeps the tunnel's own.
    const environmentId = ref(map.environments, x.environmentId)
    let local: string | null = exists('tunnels', x.id) ? x.id : null
    if (local === null) {
      const found = ids('SELECT id FROM tunnels WHERE host_id = ? AND label = ? COLLATE NOCASE', hostId, x.label)
      if (found.length > 1) {
        map.tunnels.set(x.id, null)
        item('tunnels', x.id, x.label, 'skip', { reason: ambiguous(found.length) })
        continue
      }
      local = found[0] ?? null
    }
    const f = {
      label: x.label,
      hostId,
      type: x.type,
      bindAddress: x.bindAddress,
      bindPort: x.bindPort,
      autoStart: x.autoStart,
      autoReconnect: x.autoReconnect,
    }
    if (local === null) {
      s.tunnels.insertInTx(
        { ...f, environmentId: environmentId ?? undefined, targetHost: x.targetHost ?? undefined, targetPort: x.targetPort ?? undefined },
        x.id,
      )
      map.tunnels.set(x.id, x.id)
      touch(environmentId)
      done('tunnels', x.id, x.label, true, [])
      continue
    }
    const before = s.tunnels.get(local).environmentId
    // A running tunnel isn't restarted: the change applies the next time it starts.
    const fields = s.tunnels.updateInTx(local, { ...f, environmentId, targetHost: x.targetHost, targetPort: x.targetPort }) ?? []
    map.tunnels.set(x.id, local)
    if (fields.length > 0) {
      touch(environmentId ?? before)
      touch(before)
    }
    done('tunnels', local, x.label, false, fields)
  }

  // ---- checkouts ----
  for (const x of file.deployments) {
    setAt(`Checkout ${x.name}`)
    const environmentId = map.environments.get(x.environmentId) ?? null
    const hostId = map.hosts.get(x.hostId)!
    if (environmentId === null) {
      map.deployments.set(x.id, null)
      item('deployments', x.id, x.name, 'skip', { reason: 'its environment is skipped' })
      continue
    }
    const byId = db.prepare('SELECT environment_id, host_id FROM deployments WHERE id = ?').get(x.id) as
      | { environment_id: string; host_id: string }
      | undefined
    if (byId && (byId.environment_id !== environmentId || byId.host_id !== hostId)) {
      map.deployments.set(x.id, null)
      item('deployments', x.id, x.name, 'skip', { reason: "can't move to another environment or host" })
      continue
    }
    const local = byId ? x.id : (ids('SELECT id FROM deployments WHERE environment_id = ? AND name = ? COLLATE NOCASE', environmentId, x.name)[0] ?? null)
    const before = local === null ? null : s.deploys.get(local)
    if (before && before.hostId !== hostId) {
      map.deployments.set(x.id, null)
      item('deployments', local!, x.name, 'skip', { reason: "can't move to another environment or host" })
      continue
    }

    // Unresolved secrets leave the field unset on an add and as it is on an update.
    let becomeSecretId: string | null | undefined = null
    if (x.becomeSecret !== null) {
      const found = secret(x.becomeSecret)
      if ('id' in found) becomeSecretId = found.id
      else {
        becomeSecretId = before ? undefined : null
        need('deployments', x.name, 'becomeSecret', found.reason)
      }
    }
    let envTemplate: string | null | undefined = x.envTemplate
    if (x.envTemplate !== null) {
      const lost = new Set<string>()
      envTemplate = x.envTemplate
        .split('\n')
        .map((line, i) =>
          line.replace(TEMPLATE_SECRET_REF, (_m, key: string) => {
            const found = secret(key)
            if ('id' in found) return `\${secret:${found.id}}`
            lost.add(lineKey(line, i))
            return ''
          }),
        )
        .join('\n')
      if (lost.size > 0) {
        need('deployments', x.name, 'envTemplate', [...lost].join(', '))
        if (before) envTemplate = undefined
      }
    }
    const vaultIdsHere = vaults('deployments', x.name, x.vaults)
    const here = before?.repoUrl ?? null
    const f = {
      name: x.name,
      repoUrl: here !== null && stripRepoCredentials(here) === x.repoUrl ? here : x.repoUrl,
      repoPath: x.repoPath,
      defaultBranch: x.defaultBranch,
      composeFile: x.composeFile,
      composeProject: x.composeProject,
      deployTag: x.deployTag,
      position: x.position,
      urls: x.urls,
      healthStatus: x.healthStatus,
      healthTimeoutSec: x.healthTimeoutSec,
      dbBackup: x.dbBackup,
      backupDir: x.backupDir,
      preHook: x.preHook,
      postHook: x.postHook,
      buildTimeoutSec: x.buildTimeoutSec,
      composeTimeoutSec: x.composeTimeoutSec,
      useSudo: x.useSudo,
      managedEnv: x.managedEnv,
    }
    if (before === null) {
      s.deploys.insertInTx(
        { ...f, environmentId, hostId, becomeSecretId: becomeSecretId ?? null, envTemplate: envTemplate ?? null, vaultIds: vaultIdsHere },
        x.id,
      )
      map.deployments.set(x.id, x.id)
      touch(environmentId)
      done('deployments', x.id, x.name, true, [])
      continue
    }
    const fields = s.deploys
      .updateInTx(before.id, { ...f, becomeSecretId, envTemplate, vaultIds: union(before.vaultIds, vaultIdsHere) })
      .map((k) => (k === 'vaultIds' ? 'vaults' : k))
    map.deployments.set(x.id, before.id)
    if (fields.length > 0) touch(environmentId)
    done('deployments', before.id, x.name, false, fields)
  }

  // ---- services ----
  for (const x of file.services) {
    setAt(`Service ${x.name}`)
    const environmentId = map.environments.get(x.environmentId) ?? null
    if (environmentId === null) {
      item('services', x.id, x.name, 'skip', { reason: 'its environment is skipped' })
      continue
    }
    const byId = db.prepare('SELECT environment_id, kind FROM services WHERE id = ?').get(x.id) as { environment_id: string; kind: string } | undefined
    if (byId && byId.environment_id !== environmentId) {
      item('services', x.id, x.name, 'skip', { reason: "can't move to another environment" })
      continue
    }
    const local = byId ? x.id : (ids('SELECT id FROM services WHERE environment_id = ? AND name = ? COLLATE NOCASE', environmentId, x.name)[0] ?? null)
    const before = local === null ? null : s.services.get(local)
    if (before && before.kind !== x.kind) {
      item('services', before.id, x.name, 'skip', { reason: 'is a different kind here' })
      continue
    }
    if (x.kind === 'service') {
      const deploymentId = ref(map.deployments, x.deploymentId)
      const f = { name: x.name, description: x.description, composeService: x.composeService, url: x.url, urlCheckFrom: x.urlCheckFrom }
      if (before === null) {
        s.services.insertInTx({ ...f, kind: 'service', environmentId, deploymentId: deploymentId ?? null }, x.position, x.id)
        touch(environmentId)
        done('services', x.id, x.name, true, [])
        continue
      }
      const fields = s.services.updateInTx(before.id, { ...f, deploymentId })
      if (s.services.setPositionInTx(before.id, x.position)) fields.push('position')
      if (fields.length > 0) touch(environmentId)
      done('services', before.id, x.name, false, fields)
      continue
    }
    const viaHostId = ref(map.hosts, x.viaHostId) ?? null
    const tunnelId = ref(map.tunnels, x.tunnelId)
    const f = { name: x.name, description: x.description, dbEngine: x.dbEngine, dbAddress: x.dbAddress, dbPort: x.dbPort, viaHostId, localPort: x.localPort }
    if (before === null) {
      s.services.insertInTx({ ...f, kind: 'db', environmentId }, x.position, x.id)
      if (tunnelId) s.services.setTunnelInTx(x.id, tunnelId, x.localPort)
      touch(environmentId)
      done('services', x.id, x.name, true, [])
      continue
    }
    const fields = s.services.updateInTx(before.id, f)
    if (s.services.setPositionInTx(before.id, x.position)) fields.push('position')
    const keepTunnel = tunnelId === undefined && before.kind === 'db' ? before.tunnelId : (tunnelId ?? null)
    if (s.services.setTunnelInTx(before.id, keepTunnel, x.localPort)) fields.push('tunnelId')
    if (fields.length > 0) touch(environmentId)
    done('services', before.id, x.name, false, fields)
  }

  const protectedEnvironments = [...touched]
    .map((id) => envsBefore.get(id))
    .filter((e): e is { id: string; name: string; protected: number } => e !== undefined && e.protected === 1)
    .map((e) => e.name)
    .sort()
  return { items, counts, needsSecret, protectedEnvironments, environmentIds: [...new Set([...touched, ...reloaded])].sort() }
}

/** What importing `file` would do, without changing anything: the writes run in a transaction that is rolled back. */
export function planImport(db: Db, file: ConfigFile): Omit<ImportPreview, 'token'> {
  const { environmentIds: _, ...plan } = dryRun(db, file)
  return plan
}

function dryRun(db: Db, file: ConfigFile): Plan {
  // BEGIN IMMEDIATE: nothing else can write between the plan's reads and its writes.
  db.exec('BEGIN IMMEDIATE')
  try {
    return run(db, file)
  } finally {
    db.exec('ROLLBACK')
  }
}

export interface ImportDeps {
  db: Db
  audit: Pick<AuditLog, 'append'>
  vault: { assertUnlocked(): void }
  onChanged?: (environmentIds: string[]) => void
}

/**
 * Applies `file` all or nothing: the plan is recomputed inside the transaction and must match the preview's counts,
 * and every existing protected environment it changes must be named in `typedNames`. One `config.import` audit with
 * counts only, after COMMIT, then `onChanged` with the environments it changed. Running tunnels aren't restarted.
 */
export function applyImport(deps: ImportDeps, file: ConfigFile, opts: { typedNames: string[]; expected: ImportPreview['counts'] }): ImportResult {
  deps.vault.assertUnlocked()
  const plan = inTransaction(deps.db, () => {
    const p = run(deps.db, file)
    if (IMPORT_ACTIONS.some((a) => p.counts[a] !== opts.expected[a])) throw new Error(CHANGED_MESSAGE)
    const missing = p.protectedEnvironments.find((name) => !opts.typedNames.includes(name))
    if (missing !== undefined) throw new DeployError('CONFIRM_REQUIRED', `Type ${missing} to update this protected environment`)
    return p
  })
  deps.audit.append({
    action: 'config.import',
    outcome: 'success',
    targetType: 'config',
    targetLabel: 'config',
    // `unresolved`, not `needsSecret`: the audit redacts any detail whose key names a secret.
    details: { counts: plan.counts, unresolved: plan.needsSecret.length },
  })
  deps.onChanged?.(plan.environmentIds)
  return { counts: plan.counts, needsSecret: plan.needsSecret }
}
