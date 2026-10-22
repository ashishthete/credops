import {
  IMPORT_ACTIONS,
  TEMPLATE_SECRET_REF,
  type ConfigCounts,
  type ConfigFile,
  type ConfigFlow,
  type ConfigSegment,
  type ConfigStepBody,
  type ImportAction,
  type ImportItem,
  type ImportNeedsSecret,
  type ImportPreview,
  type ImportResult,
  type VaultRef,
} from '../../shared/config-file'
import { SENSITIVE_KEY } from '../../shared/deploy'
import { UNASSIGNED_PRODUCT, stripRepoCredentials } from '../../shared/inventory'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import { DeployError } from '../deploy/access'
import { DeployStore, dbSecretRefs, stepSecretIds } from '../deploy/deploy-store'
import { RunbookStore } from '../deploy/runbook-store'
import { ServiceStore } from '../deploy/service-store'
import { asRunbookSaveInput } from '../ipc/validators'
import { EnvironmentStore } from '../inventory/environment-store'
import { HostStore } from '../inventory/host-store'
import { ProductStore } from '../inventory/product-store'
import type { ReleaseFlow } from '../../shared/deploy'
import type { RunbookInput, RunbookItem } from '../../shared/runbooks'
import type { Step, StepBody, StepSecret } from '../../shared/steps'
import { RegionStore } from '../inventory/region-store'
import { selectSegment } from './segment'
import { TunnelStore } from '../tunnels/tunnel-store'
import { IdentityStore } from '../vault/identity-store'
import type { KeyStore } from '../vault/key-store'
import type { VaultService } from '../vault/vault-service'

export type { ImportAction, ImportItem, ImportPreview, ImportResult } from '../../shared/config-file'

export const CHANGED_MESSAGE = 'The config changed since the preview; open the file again'
export const REGION_MESSAGE = 'Choose a region for the imported hosts'
/** A page import's notes on the objects its page items need. */
export const DEPENDENCY_KEPT = 'already here, not changed'
export const DEPENDENCY_ADDED = 'added as a dependency'

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
    regions: new RegionStore(db, NO_VAULT, NO_AUDIT),
    products: new ProductStore(db, NO_VAULT, NO_AUDIT),
    identities: new IdentityStore(db, NO_VAULT, {} as KeyStore, NO_AUDIT),
    hosts: new HostStore(db, NO_VAULT, NO_AUDIT),
    envs: new EnvironmentStore(db, NO_VAULT, NO_AUDIT),
    tunnels: new TunnelStore({ db, audit: NO_AUDIT, vault: NO_VAULT }),
    deploys: new DeployStore({ db, audit: NO_AUDIT, vault: NO_VAULT, secrets: dbSecretRefs(db) }),
    services: new ServiceStore({ db, audit: NO_AUDIT, vault: NO_VAULT }),
    runbooks: new RunbookStore({ db, audit: NO_AUDIT, vault: NO_VAULT }),
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
 * With `segment`, only the page's part of the file is written: its own kinds as above, and of the objects they
 * need only the ones not here yet.
 */
function run(db: Db, file: ConfigFile, regionId?: string, segment?: ConfigSegment): Plan {
  const part = segment === undefined ? null : selectSegment(file, segment)
  let at = ''
  try {
    const plan = runEach(db, part?.file ?? file, (where) => (at = where), regionId, part?.own)
    return part === null ? plan : { ...plan, ignored: part.ignored }
  } catch (e) {
    // A row the stores refuse: say which one, keeping the error's own type and code.
    if (e instanceof Error && at) e.message = `${at}: ${e.message}`
    throw e
  }
}

/**
 * `regionId`: where a version 1 file's new hosts go. Without it a stand-in region takes them, which only a dry run may keep.
 * `own`: a page import's kinds. An object of another kind is a dependency: added when missing, never changed.
 */
function runEach(db: Db, file: ConfigFile, setAt: (where: string) => void, regionId?: string, own?: ReadonlySet<Kind>): Plan {
  const s = stores(db)
  const items: ImportItem[] = []
  const needsSecret: ImportNeedsSecret[] = []
  const counts: Counts = { add: 0, update: 0, unchanged: 0, skip: 0 }
  const item = (kind: Kind, id: string, name: string, action: ImportAction, extra: { reason?: string; fields?: string[]; notes?: string[] } = {}) => {
    counts[action]++
    items.push({
      kind,
      id,
      name,
      action,
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(action === 'update' ? { fields: extra.fields } : {}),
      ...(extra.notes?.length ? { notes: extra.notes } : {}),
    })
  }
  const done = (kind: Kind, id: string, name: string, added: boolean, fields: string[], notes?: string[]) =>
    item(kind, id, name, added ? 'add' : fields.length > 0 ? 'update' : 'unchanged', { fields, notes })
  const need = (kind: Kind, name: string, field: string, reason?: string) => needsSecret.push({ kind, name, field, ...(reason ? { reason } : {}) })
  const isDependency = (kind: Kind): boolean => own !== undefined && !own.has(kind)
  /** A dependency already here: used as it is. */
  const kept = (kind: Kind, local: string, name: string): void => item(kind, local, name, 'unchanged', { notes: [DEPENDENCY_KEPT] })
  const addedNotes = (kind: Kind, notes: string[] = []): string[] => (isDependency(kind) ? [DEPENDENCY_ADDED, ...notes] : notes)
  // The existing environments kept as dependencies: their hosts aren't changed either.
  const keptEnvs = new Set<string>()
  const inEnv = (environmentId: string, hostId: string): boolean =>
    db.prepare('SELECT 1 FROM environment_hosts WHERE environment_id = ? AND host_id = ?').get(environmentId, hostId) !== undefined
  const NOT_IN_ENV = "its host isn't in that environment here"

  const ids = (sql: string, ...params: (string | null)[]): string[] => (db.prepare(sql).all(...params) as { id: string }[]).map((r) => r.id)
  const exists = (table: string, id: string): boolean => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined

  // file id -> local id; null when the object was skipped.
  const map = {
    regions: new Map<string, string | null>(),
    identities: new Map<string, string | null>(),
    products: new Map<string, string | null>(),
    hosts: new Map<string, string | null>(),
    environments: new Map<string, string | null>(),
    tunnels: new Map<string, string | null>(),
    deployments: new Map<string, string | null>(),
    services: new Map<string, string | null>(),
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

  /**
   * A step's secrets as local ids. A secret that isn't here, or isn't in the vaults the step may use, is left out and
   * its `<step>.<ENV_NAME>` is added to `lost`; the stores check the rest.
   */
  const stepSecrets = (secrets: { envName: string; secret: string }[], allowed: ReadonlySet<string>, stepId: string, lost: string[]): StepSecret[] => {
    const out: StepSecret[] = []
    for (const sec of secrets) {
      const found = secret(sec.secret)
      if ('id' in found && allowed.has(found.id)) out.push({ envName: sec.envName, secretId: found.id })
      else lost.push(`${stepId}.${sec.envName}`)
    }
    return out
  }
  const stepBody = (st: ConfigStepBody, allowed: ReadonlySet<string>, lost: string[]): StepBody => ({ ...st, secrets: stepSecrets(st.secrets, allowed, st.id, lost) })

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
  /**
   * The environments that depend on a host: those it is linked to, whose default jump it is, whose services reach
   * through it, or whose checkouts or tunnels run on it; and, through `jump_host_id`, those of every host that jumps
   * through it.
   */
  const protectedDependents = (hostId: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>()
    if (seen.has(hostId)) return out
    seen.add(hostId)
    for (const sql of [
      'SELECT environment_id AS id FROM environment_hosts WHERE host_id = ?',
      'SELECT id FROM environments WHERE default_jump_host_id = ?',
      'SELECT environment_id AS id FROM services WHERE via_host_id = ?',
      'SELECT environment_id AS id FROM deployments WHERE host_id = ?',
      'SELECT environment_id AS id FROM tunnels WHERE host_id = ? AND environment_id IS NOT NULL',
    ]) {
      for (const e of ids(sql, hostId)) out.add(e)
    }
    for (const h of ids('SELECT id FROM hosts WHERE jump_host_id = ?', hostId)) for (const e of protectedDependents(h, seen)) out.add(e)
    return out
  }
  /** A host now reaches another machine or logs in as someone else: every environment that depends on it needs confirming. */
  const guardHost = (hostId: string) => {
    for (const e of protectedDependents(hostId)) touch(e)
  }
  const guardIdentity = (identityId: string) => {
    for (const h of ids('SELECT id FROM hosts WHERE identity_id = ?', identityId)) guardHost(h)
    for (const e of ids('SELECT id FROM environments WHERE default_identity_id = ?', identityId)) touch(e)
  }
  const HOST_REACH = ['address', 'port', 'identityId', 'jumpHostId']
  const IDENTITY_REACH = ['username', 'auth', 'sshKeyId']
  const reaches = (fields: string[], which: string[]) => fields.some((f) => which.includes(f))

  // ---- regions: matched by id, then by code ----
  for (const x of file.regions) {
    setAt(`Region ${x.code}`)
    const local = exists('regions', x.id) ? x.id : (ids('SELECT id FROM regions WHERE code = ?', x.code)[0] ?? null)
    if (local === null) {
      s.regions.insertInTx({ code: x.code, provider: x.provider, displayName: x.displayName }, x.id)
      map.regions.set(x.id, x.id)
      done('regions', x.id, x.code, true, [], addedNotes('regions'))
      continue
    }
    map.regions.set(x.id, local)
    if (isDependency('regions')) {
      kept('regions', local, x.code)
      continue
    }
    const next = s.regions.updateInTx(local, { code: x.code, provider: x.provider, displayName: x.displayName })
    done('regions', local, x.code, false, next?.fields ?? [])
  }
  let needsRegion = false
  let standIn: string | null = null
  /** The region a version 1 file's new host goes in. */
  const v1Region = (): string => {
    needsRegion = true
    if (regionId !== undefined) return regionId
    standIn ??= s.regions.insertInTx({ code: `import-${Date.now().toString(36)}`, displayName: 'Import' })
    return standIn
  }

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
    if (local !== null && isDependency('identities')) {
      map.identities.set(x.id, local)
      kept('identities', local, x.label)
      continue
    }
    if (local !== null) {
      // An existing identity keeps its own auth, key and password: only what the file can say for sure changes.
      const next = s.identities.updateInTx(local, { label: x.label, username: x.username })
      if (next && reaches(next.fields, IDENTITY_REACH)) guardIdentity(local)
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
    done('identities', x.id, x.label, true, [], addedNotes('identities'))
  }

  // ---- products ----
  for (const x of file.products) {
    setAt(`Product ${x.name}`)
    const local = exists('products', x.id) ? x.id : (ids('SELECT id FROM products WHERE name = ?', x.name)[0] ?? null)
    if (local === null) {
      s.products.insertInTx({ name: x.name, color: x.color, icon: x.icon, description: x.description, repoUrl: x.repoUrl }, x.id)
      map.products.set(x.id, x.id)
      done('products', x.id, x.name, true, [], addedNotes('products'))
      continue
    }
    if (isDependency('products')) {
      map.products.set(x.id, local)
      kept('products', local, x.name)
      continue
    }
    // The file has the URL without its credentials: the local one with them is the same URL.
    const here = (db.prepare('SELECT repo_url FROM products WHERE id = ?').get(local) as { repo_url: string | null }).repo_url
    const repoUrl = here !== null && stripRepoCredentials(here) === x.repoUrl ? undefined : x.repoUrl
    const next = s.products.updateInTx(local, { name: x.name, color: x.color, icon: x.icon, description: x.description, repoUrl })
    map.products.set(x.id, local)
    // Environment pages show their products.
    if (next && next.fields.length > 0) for (const e of ids('SELECT id FROM environments WHERE product_id = ?', local)) touchOnly(e)
    done('products', local, x.name, false, next?.fields ?? [])
  }

  // ---- hosts: written without jump hosts first, so a jump host later in the file exists when it is set ----
  const hostRows: { x: ConfigFile['hosts'][number]; local: string; added: boolean; fields: string[]; notes: string[]; kept?: true }[] = []
  for (const x of file.hosts) {
    setAt(`Host ${x.label}`)
    const local = exists('hosts', x.id) ? x.id : (ids('SELECT id FROM hosts WHERE label = ?', x.label)[0] ?? null)
    if (local !== null && isDependency('hosts')) {
      map.hosts.set(x.id, local)
      hostRows.push({ x, local, added: false, fields: [], notes: [], kept: true })
      continue
    }
    const identityId = ref(map.identities, x.identityId)
    if (identityId === undefined) need('hosts', x.label, 'identityId')
    const vaultIdsHere = vaults('hosts', x.label, x.vaults)
    // A sensitive value is exported blank, and one written into the file by hand is never imported: the local value
    // stands for it, or it stays blank. The value itself is never repeated.
    const localVars =
      local === null
        ? {}
        : (JSON.parse((db.prepare('SELECT env_vars FROM hosts WHERE id = ?').get(local) as { env_vars: string }).env_vars) as Record<string, string>)
    const envVars = Object.fromEntries(
      Object.entries(x.envVars).map(([k, v]) => {
        if (!SENSITIVE_KEY.test(k)) return [k, v]
        if (v !== '') need('hosts', x.label, 'envVars', `${k} left blank; set it in the host editor`)
        return [k, localVars[k] ?? '']
      }),
    )
    if (local === null) {
      s.hosts.insertInTx(
        {
          label: x.label,
          address: x.address,
          regionId: x.regionId === null ? v1Region() : map.regions.get(x.regionId)!,
          port: x.port,
          identityId: identityId ?? null,
          jumpHostId: null,
          tags: x.tags,
          osIcon: x.osIcon,
          notes: x.notes,
          keepaliveSec: x.keepaliveSec,
          envVars,
          vaultIds: vaultIdsHere,
        },
        x.id,
      )
      map.hosts.set(x.id, x.id)
      hostRows.push({ x, local: x.id, added: true, fields: [], notes: addedNotes('hosts') })
      continue
    }
    // An existing host stays in its own region: moving it is the user's call.
    const here = (db.prepare('SELECT region_id FROM hosts WHERE id = ?').get(local) as { region_id: string }).region_id
    const notes = x.regionId !== null && map.regions.get(x.regionId) !== here ? ['region not changed'] : []
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
    if (reaches(fields, HOST_REACH)) guardHost(local)
    if (s.hosts.addVaultsInTx(local, vaultIdsHere).length > 0) fields.push('vaults')
    map.hosts.set(x.id, local)
    hostRows.push({ x, local, added: false, fields, notes })
  }
  for (const h of hostRows) {
    if (h.kept) continue
    setAt(`Host ${h.x.label}`)
    const jumpHostId = ref(map.hosts, h.x.jumpHostId) ?? null
    if (h.added && jumpHostId === null) continue
    const next = s.hosts.updateInTx(h.local, { jumpHostId })
    if (!h.added && next) {
      h.fields.push(...next.fields)
      guardHost(h.local)
    }
  }
  for (const h of hostRows) {
    if (h.kept) kept('hosts', h.local, h.x.label)
    else done('hosts', h.local, h.x.label, h.added, h.fields, h.notes)
  }

  // Parts that name services or secrets of other rows are written after those exist (see "checkouts' steps" below).
  const flows: { x: ConfigFile['environments'][number]; local: string; added: boolean; item: number }[] = []
  const stepRows: { x: ConfigFile['deployments'][number]; local: string; environmentId: string; added: boolean; item: number }[] = []
  /** Adds fields found after an item was recorded: an unchanged item becomes an update. */
  const amend = (index: number, fields: string[]): void => {
    const it = items[index]
    if (fields.length === 0 || it.action === 'add') return
    if (it.action === 'unchanged') {
      counts.unchanged--
      counts.update++
      it.action = 'update'
    }
    it.fields = [...new Set([...(it.fields ?? []), ...fields])]
  }

  let unassigned: string | null = null
  /** A version 1 environment with no product goes in Unassigned: the one here, or a new one. */
  const unassignedProduct = (): string => {
    if (unassigned !== null) return unassigned
    unassigned = ids('SELECT id FROM products WHERE name = ?', UNASSIGNED_PRODUCT.name)[0] ?? null
    if (unassigned === null) {
      unassigned = s.products.insertInTx({ ...UNASSIGNED_PRODUCT, description: '', repoUrl: null })
      done('products', unassigned, UNASSIGNED_PRODUCT.name, true, [])
    }
    return unassigned
  }
  const fileProduct = new Map(file.products.map((p) => [p.id, p.name]))
  /** What a version 1 environment's product links became. */
  const v1Notes = (envId: string, kept: string | null): string[] => {
    const was = file.fromV1?.productIds[envId]
    if (!was) return []
    if (kept === null) return ['no product: put in Unassigned']
    const removed = was.filter((p) => p !== kept).map((p) => fileProduct.get(p)!)
    return removed.length > 0 ? [`kept ${fileProduct.get(kept)!}, removed ${removed.join(', ')}`] : []
  }

  // ---- environments and their links: matched by id, then by name within the product ----
  for (const x of file.environments) {
    setAt(`Environment ${x.name}`)
    let local: string | null = exists('environments', x.id) ? x.id : null
    if (local === null) {
      // No product: matched in the Unassigned here, if there is one. Making it waits until it's needed.
      const matchIn = x.productId === null ? (unassigned ?? ids('SELECT id FROM products WHERE name = ?', UNASSIGNED_PRODUCT.name)[0]) : map.products.get(x.productId)!
      if (matchIn !== undefined) local = ids('SELECT id FROM environments WHERE product_id = ? AND name = ? COLLATE NOCASE', matchIn, x.name)[0] ?? null
    }
    if (local !== null && isDependency('environments')) {
      map.environments.set(x.id, local)
      keptEnvs.add(local)
      kept('environments', local, x.name)
      continue
    }
    const productId = x.productId === null ? unassignedProduct() : map.products.get(x.productId)!
    const defaultIdentityId = ref(map.identities, x.defaultIdentityId)
    if (defaultIdentityId === undefined) need('environments', x.name, 'defaultIdentityId')
    const defaultJumpHostId = ref(map.hosts, x.defaultJumpHostId) ?? null
    const added = local === null
    const fields: string[] = []
    // An existing environment stays in its own product: moving it is the user's call (and may be refused for the Hub).
    const notes =
      local === null
        ? v1Notes(x.id, x.productId)
        : (db.prepare('SELECT product_id FROM environments WHERE id = ?').get(local) as { product_id: string }).product_id !== productId
          ? ['product not changed']
          : []
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
          productId,
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
    }
    // Absent in an older file: a new environment gets the column defaults, an existing one keeps its own.
    fields.push(...s.deploys.updateSettingsInTx(local, { versioned: x.versioned, autoRollback: x.autoRollback, parallelPrepare: x.parallelPrepare, prepareCap: x.prepareCap }))
    let hostsChanged = false
    for (const m of x.hosts) {
      const hostId = map.hosts.get(m.hostId)
      if (hostId && s.envs.putHostInTx(local, hostId, m.role)) hostsChanged = true
    }
    if (hostsChanged && !added) fields.push('hosts')
    map.environments.set(x.id, local)
    if (added || fields.length > 0) touch(local)
    done('environments', local, x.name, added, fields, added ? addedNotes('environments', notes) : notes)
    if (x.flow !== undefined) flows.push({ x, local, added, item: items.length - 1 })
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
    if (local !== null && isDependency('tunnels')) {
      map.tunnels.set(x.id, local)
      kept('tunnels', local, x.label)
      continue
    }
    // A tunnel's host must be in its environment, and a kept environment doesn't get it.
    if (environmentId && keptEnvs.has(environmentId) && !inEnv(environmentId, hostId)) {
      map.tunnels.set(x.id, null)
      item('tunnels', local ?? x.id, x.label, 'skip', { reason: NOT_IN_ENV })
      continue
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
      done('tunnels', x.id, x.label, true, [], addedNotes('tunnels'))
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
    if (isDependency('deployments')) {
      // One in another environment here can't serve this one's services: skipped below, as the full import does.
      const here = byId ? (byId.environment_id === environmentId ? x.id : undefined) : ids('SELECT id FROM deployments WHERE environment_id = ? AND name = ? COLLATE NOCASE', environmentId, x.name)[0]
      if (here !== undefined) {
        map.deployments.set(x.id, here)
        kept('deployments', here, x.name)
        continue
      }
    }
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
        const reason = [found.reason, before && 'kept the local become secret'].filter(Boolean).join('; ')
        need('deployments', x.name, 'becomeSecret', reason || undefined)
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
        need('deployments', x.name, 'envTemplate', [...lost].join(', ') + (before ? '; kept the local template' : ''))
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
    // A new checkout puts its host in its environment, and a kept environment doesn't get it.
    if (before === null && keptEnvs.has(environmentId) && !inEnv(environmentId, hostId)) {
      map.deployments.set(x.id, null)
      item('deployments', x.id, x.name, 'skip', { reason: NOT_IN_ENV })
      continue
    }
    if (before === null) {
      s.deploys.insertInTx(
        { ...f, environmentId, hostId, becomeSecretId: becomeSecretId ?? null, envTemplate: envTemplate ?? null, vaultIds: vaultIdsHere },
        x.id,
      )
      map.deployments.set(x.id, x.id)
      touch(environmentId)
      done('deployments', x.id, x.name, true, [], addedNotes('deployments'))
      if (x.steps !== undefined) stepRows.push({ x, local: x.id, environmentId, added: true, item: items.length - 1 })
      continue
    }
    const fields = s.deploys
      .updateInTx(before.id, { ...f, becomeSecretId, envTemplate, vaultIds: union(before.vaultIds, vaultIdsHere) })
      .map((k) => (k === 'vaultIds' ? 'vaults' : k))
    map.deployments.set(x.id, before.id)
    if (fields.length > 0) touch(environmentId)
    done('deployments', before.id, x.name, false, fields)
    if (x.steps !== undefined) stepRows.push({ x, local: before.id, environmentId, added: false, item: items.length - 1 })
  }

  // ---- services ----
  for (const x of file.services) {
    setAt(`Service ${x.name}`)
    const environmentId = map.environments.get(x.environmentId) ?? null
    if (environmentId === null) {
      map.services.set(x.id, null)
      item('services', x.id, x.name, 'skip', { reason: 'its environment is skipped' })
      continue
    }
    const byId = db.prepare('SELECT environment_id, kind FROM services WHERE id = ?').get(x.id) as { environment_id: string; kind: string } | undefined
    if (byId && byId.environment_id !== environmentId) {
      map.services.set(x.id, null)
      item('services', x.id, x.name, 'skip', { reason: "can't move to another environment" })
      continue
    }
    const local = byId ? x.id : (ids('SELECT id FROM services WHERE environment_id = ? AND name = ? COLLATE NOCASE', environmentId, x.name)[0] ?? null)
    const before = local === null ? null : s.services.get(local)
    if (before && before.kind !== x.kind) {
      map.services.set(x.id, null)
      item('services', before.id, x.name, 'skip', { reason: 'is a different kind here' })
      continue
    }
    if (x.kind === 'service') {
      const deploymentId = ref(map.deployments, x.deploymentId)
      const f = {
        name: x.name,
        description: x.description,
        composeService: x.composeService,
        url: x.url,
        urlCheckFrom: x.urlCheckFrom,
        skipUnchanged: x.skipUnchanged,
      }
      if (before === null) {
        s.services.insertInTx({ ...f, kind: 'service', environmentId, deploymentId: deploymentId ?? null }, x.position, x.id)
        map.services.set(x.id, x.id)
        touch(environmentId)
        done('services', x.id, x.name, true, [])
        continue
      }
      map.services.set(x.id, before.id)
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
      map.services.set(x.id, x.id)
      if (tunnelId) s.services.setTunnelInTx(x.id, tunnelId, x.localPort)
      touch(environmentId)
      done('services', x.id, x.name, true, [])
      continue
    }
    map.services.set(x.id, before.id)
    const fields = s.services.updateInTx(before.id, f)
    if (s.services.setPositionInTx(before.id, x.position)) fields.push('position')
    const keepTunnel = tunnelId === undefined && before.kind === 'db' ? before.tunnelId : (tunnelId ?? null)
    if (s.services.setTunnelInTx(before.id, keepTunnel, x.localPort)) fields.push('tunnelId')
    if (fields.length > 0) touch(environmentId)
    done('services', before.id, x.name, false, fields)
  }

  // ---- checkouts' steps ----
  // After the services: a compose-exec step names a service of its checkout, and a step's secrets come from its vaults.
  for (const r of stepRows) {
    setAt(`Checkout ${r.x.name}`)
    const allowed = stepSecretIds(db, r.environmentId, r.local)
    const lost: string[] = []
    const steps = r.x.steps!.map((st): Step => ({ ...st, secrets: stepSecrets(st.secrets, allowed, st.id, lost) }))
    if (lost.length > 0) {
      need('deployments', r.x.name, 'steps', lost.join(', ') + (r.added ? '' : '; kept the local steps'))
      if (!r.added) continue
    }
    const fields = s.deploys.updateInTx(r.local, { steps })
    if (fields.length > 0) touch(r.environmentId)
    amend(r.item, fields)
  }

  // ---- release flows ----
  const fileServiceName = new Map(file.services.map((x) => [x.id, x.name]))
  const serviceCheckout = db.prepare('SELECT deployment_id FROM services WHERE id = ?')
  for (const r of flows) {
    setAt(`Environment ${r.x.name}`)
    const flow = r.x.flow as ConfigFlow
    const fileIds = flow.stages.flatMap((st) => (st.kind === 'services' ? st.serviceIds : [st.serviceId]))
    const skipped = fileIds.find((id) => !map.services.get(id))
    if (skipped !== undefined) {
      items[r.item].reason = `Flow not imported: it uses ${fileServiceName.get(skipped) ?? 'a service'}, which was skipped`
      continue
    }
    const lost: string[] = []
    const local: ReleaseFlow = {
      onFailure: flow.onFailure,
      stages: flow.stages.map((st) => {
        if (st.kind === 'services') return { kind: 'services' as const, serviceIds: st.serviceIds.map((id) => map.services.get(id)!) }
        const serviceId = map.services.get(st.serviceId)!
        // The same scope checkFlow applies: the secrets of the service's own checkout.
        const checkout = (serviceCheckout.get(serviceId) as { deployment_id: string | null } | undefined)?.deployment_id ?? null
        return { kind: 'step' as const, serviceId, step: stepBody(st.step, stepSecretIds(db, r.local, checkout), lost) }
      }),
    }
    if (lost.length > 0) {
      need('environments', r.x.name, 'flow', lost.join(', ') + (r.added ? '' : '; kept the local flow'))
      if (!r.added) continue
    }
    const fields = s.deploys.updateSettingsInTx(r.local, { flow: local })
    if (fields.length > 0) touch(r.local)
    amend(r.item, fields)
  }

  // ---- runbooks ----
  for (const x of file.runbooks ?? []) {
    setAt(`Runbook ${x.name}`)
    const environmentId = map.environments.get(x.environmentId) ?? null
    if (environmentId === null) {
      item('runbooks', x.id, x.name, 'skip', { reason: 'its environment is skipped' })
      continue
    }
    const byId = db.prepare('SELECT environment_id FROM runbooks WHERE id = ?').get(x.id) as { environment_id: string } | undefined
    if (byId && byId.environment_id !== environmentId) {
      item('runbooks', x.id, x.name, 'skip', { reason: "can't move to another environment" })
      continue
    }
    const local = byId ? x.id : (ids('SELECT id FROM runbooks WHERE environment_id = ? AND name = ? COLLATE NOCASE', environmentId, x.name)[0] ?? null)
    const targets = x.targetServiceIds.map((t) => map.services.get(t) ?? null)
    if (targets.includes(null)) {
      item('runbooks', local ?? x.id, x.name, 'skip', { reason: 'a service it runs on is skipped' })
      continue
    }
    const allowed = stepSecretIds(db, environmentId)
    const lost: string[] = []
    const runbookItems = x.items.map((it): RunbookItem => (it.type === 'step' ? { type: 'step', step: stepBody(it.step, allowed, lost) } : it))
    const lostNote = lost.join(', ') + (local === null ? '' : '; kept the local runbook')
    if (lost.length > 0 && local !== null) {
      need('runbooks', x.name, 'items', lostNote)
      done('runbooks', local, x.name, false, [])
      continue
    }
    // The IPC shape check first (the same one a runbook saved in the app passes), then the store's content rules.
    // A hand-edited file can fail it: skip that runbook, like any other object kind, rather than abort the import.
    let input: RunbookInput
    try {
      input = asRunbookSaveInput(
        { environmentId, name: x.name, description: x.description, targetServiceIds: targets, items: runbookItems, params: x.params, lock: x.lock, notify: x.notify },
        'runbook',
      ) as RunbookInput
    } catch (e) {
      item('runbooks', local ?? x.id, x.name, 'skip', { reason: `runbook ${x.name} is malformed: ${e instanceof Error ? e.message : String(e)}` })
      continue
    }
    // Only now, so a skipped runbook is one plan row and not also a needs-secret entry.
    if (lost.length > 0) need('runbooks', x.name, 'items', lostNote)
    if (local === null) {
      s.runbooks.insertInTx(input, x.id)
      touch(environmentId)
      done('runbooks', x.id, x.name, true, [])
      continue
    }
    const changed = s.runbooks.updateInTx(local, input, true)
    if (changed) touch(environmentId)
    done('runbooks', local, x.name, false, changed ? ['runbook'] : [])
  }

  const protectedEnvironments = [...touched]
    .map((id) => envsBefore.get(id))
    .filter((e): e is { id: string; name: string; protected: number } => e !== undefined && e.protected === 1)
    .map((e) => e.name)
    .sort()
  return { items, counts, needsSecret, protectedEnvironments, needsRegion, environmentIds: [...new Set([...touched, ...reloaded])].sort() }
}

/** What importing `file` would do, without changing anything: the writes run in a transaction that is rolled back. */
export function planImport(db: Db, file: ConfigFile, segment?: ConfigSegment): Omit<ImportPreview, 'token'> {
  const { environmentIds: _, ...plan } = dryRun(db, file, segment)
  return plan
}

function dryRun(db: Db, file: ConfigFile, segment?: ConfigSegment): Plan {
  if (db.isTransaction) throw new Error('nested transactions are not supported')
  // BEGIN IMMEDIATE: nothing else can write between the plan's reads and its writes.
  db.exec('BEGIN IMMEDIATE')
  try {
    return run(db, file, undefined, segment)
  } finally {
    // SQLite may already have rolled back after an I/O or full-disk error: don't hide that error behind a second one.
    if (db.isTransaction) db.exec('ROLLBACK')
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
 * every existing protected environment it changes must be named in `typedNames`, and a version 1 file that adds
 * hosts needs `regionId`. One `config.import` audit with
 * counts only (and a page import's segment), after COMMIT, then `onChanged` with the environments it changed.
 * Running tunnels aren't restarted.
 */
export function applyImport(
  deps: ImportDeps,
  file: ConfigFile,
  opts: { typedNames: string[]; expected: ImportPreview['counts']; regionId?: string; segment?: ConfigSegment },
): ImportResult {
  deps.vault.assertUnlocked()
  const plan = inTransaction(deps.db, () => {
    const p = run(deps.db, file, opts.regionId, opts.segment)
    if (p.needsRegion && opts.regionId === undefined) throw new Error(REGION_MESSAGE)
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
    details: { counts: plan.counts, unresolved: plan.needsSecret.length, ...(opts.segment ? { segment: opts.segment } : {}) },
  })
  deps.onChanged?.(plan.environmentIds)
  return { counts: plan.counts, needsSecret: plan.needsSecret }
}
