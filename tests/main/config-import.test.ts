import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyImport, planImport, REGION_MESSAGE } from '../../src/main/config/import'
import { buildConfigExport, serializeConfig } from '../../src/main/config/export'
import { DeployError } from '../../src/main/deploy/access'
import { DeployStore, dbSecretRefs } from '../../src/main/deploy/deploy-store'
import { ServiceStore } from '../../src/main/deploy/service-store'
import { RunbookStore } from '../../src/main/deploy/runbook-store'
import type { Db } from '../../src/main/db/connection'
import { createConfigHandlers } from '../../src/main/ipc/handlers/config'
import { SecretStore } from '../../src/main/vault/secret-store'
import { CONFIG_MAX_BYTES, parseConfigFile, type ConfigFile } from '../../src/shared/config-file'
import type { StepBody } from '../../src/shared/steps'
import { effectiveSteps } from '../../src/shared/steps'
import { DEFAULT_VAULT_ID, VAULT_LOCKED } from '../../src/shared/vault'
import { makeConfigFixture, SECRET_VALUES, type ConfigFixture } from './config-helpers'
import { makeInventory, type InventoryFixture, PRODUCT, REGION } from './inventory-helpers'

const clock = () => new Date('2026-10-20T10:00:00.000Z')
const later = () => new Date('2026-10-21T10:00:00.000Z')
const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
const deps = (t: { db: Db; audit: ConfigFixture['audit']; vault: ConfigFixture['vault'] }) => ({ db: t.db, audit: t.audit, vault: t.vault })
const copy = (file: ConfigFile): ConfigFile => JSON.parse(JSON.stringify(file)) as ConfigFile

const TABLES = [
  'regions',
  'products',
  'identities',
  'hosts',
  'host_vaults',
  'environments',
  'environment_hosts',
  'tunnels',
  'deployments',
  'deployment_vaults',
  'services',
]
/** Every config row, verbatim (timestamps included). */
const snapshot = (db: Db): string => JSON.stringify(TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()))

/** Plans and applies in one go, confirming the given protected names. */
function importFile(t: { db: Db; audit: ConfigFixture['audit']; vault: ConfigFixture['vault'] }, file: ConfigFile, typedNames: string[] = []) {
  const plan = planImport(t.db, file)
  return applyImport(deps(t), file, { typedNames, expected: plan.counts })
}

const hostRow = (db: Db, id: string) => db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as Record<string, unknown>

const itemOf = (plan: ReturnType<typeof planImport>, kind: string, name: string) => plan.items.find((i) => i.kind === kind && i.name === name)!

/** The config fixture without its password identity, exported: every ref in it can resolve elsewhere. */
async function sourceFile(): Promise<{ f: ConfigFixture; file: ConfigFile }> {
  const f = await makeConfigFixture()
  f.identities.delete(f.ids.passwordIdentity)
  return { f, file: buildConfigExport(f.db, clock).file }
}

/** An empty inventory holding only the source's vaults and items by name, under different ids. */
async function makeTarget(
  src: ConfigFixture,
  opts: { team?: boolean; become?: boolean; key?: boolean } = {},
): Promise<InventoryFixture & { teamVaultId: string | null; secrets: SecretStore }> {
  const t = await makeInventory()
  const secrets = new SecretStore(t.db, t.vault, t.audit, { clipboard })
  if (opts.become !== false) secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'sudo-pw', kind: 'password', value: 'other-become' })
  secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'envsecret', kind: 'env', value: 'other-env' })
  let teamVaultId: string | null = null
  if (opts.team !== false) {
    teamVaultId = t.vault.createVault({ name: 'Team', color: '#22aa66' }).id
    secrets.create({ vaultId: teamVaultId, name: 'db-pass', kind: 'env', value: 'other-db' })
    if (opts.key !== false) t.keys.import({ vaultId: teamVaultId, label: 'deploy-key', privateKey: src.privateKey, passphrase: SECRET_VALUES.passphrase })
  }
  return { ...t, teamVaultId, secrets }
}

/** `file` as version 1 wrote it, read back the way the import reads it. */
function asV1(file: ConfigFile, fn: (raw: any) => void = () => {}): ConfigFile {
  const raw = JSON.parse(JSON.stringify(file))
  raw.version = 1
  delete raw.regions
  for (const h of raw.hosts) delete h.regionId
  for (const e of raw.environments) {
    e.productIds = [e.productId]
    delete e.productId
  }
  fn(raw)
  const res = parseConfigFile(JSON.stringify(raw))
  if (!res.ok) throw new Error(res.errors.join('\n'))
  return res.file
}

function otherKey(): string {
  return generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
}

describe('config import', () => {
  it('round trip: export, import into an empty DB, export again gives the same file apart from exportedAt', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    const plan = planImport(t.db, file)
    // The fixtures share their region and Fixture product ids: those match as they are.
    expect(plan.counts).toEqual({ add: 10, update: 0, unchanged: 2, skip: 0 })
    expect(plan.needsRegion).toBe(false)
    expect(plan.needsSecret).toEqual([])
    // Adding a protected environment needs no typed name.
    expect(plan.protectedEnvironments).toEqual([])
    const res = applyImport(deps(t), file, { typedNames: [], expected: plan.counts })
    expect(res).toEqual({ counts: plan.counts, needsSecret: [] })

    const again = buildConfigExport(t.db, later).file
    expect(again.exportedAt).toBe(later().toISOString())
    expect({ ...again, exportedAt: '' }).toEqual({ ...file, exportedAt: '' })
    expect(serializeConfig({ ...again, exportedAt: '' })).toBe(serializeConfig({ ...file, exportedAt: '' }))
  })

  it('re-importing the same file is a no-op', async () => {
    const f = await makeConfigFixture()
    // Values the export leaves out stay as they are: a sensitive env var and repo URL credentials.
    f.hosts.update(f.host.id, { envVars: { LANG: 'C.UTF-8', DB_PASSWORD: 'local-db-secret' } })
    // A legacy row: the stores now refuse credentials, so seed it the way an old DB holds it.
    f.db.prepare('UPDATE products SET repo_url = ? WHERE id = ?').run('https://deployer:tok3n@example.com/shop.git', f.ids.product)
    const file = buildConfigExport(f.db, clock).file
    const before = snapshot(f.db)
    const plan = planImport(f.db, file)
    expect(plan.items.every((i) => i.action === 'unchanged')).toBe(true)
    expect(plan.counts).toEqual({ add: 0, update: 0, unchanged: 13, skip: 0 })
    expect(plan.needsSecret).toEqual([])
    expect(plan.protectedEnvironments).toEqual([])

    importFile(f, file)
    expect(snapshot(f.db)).toBe(before)
    const events = f.audit.list({ actions: ['config.import'] })
    expect(events).toHaveLength(1)
    expect(events[0].details).toEqual({ counts: { add: 0, update: 0, unchanged: 13, skip: 0 }, unresolved: 0 })
  })

  it('re-importing keeps every local value the export blanked: env vars, template lines and URL params', async () => {
    const f = await makeConfigFixture()
    const envVars = {
      LANG: 'C.UTF-8',
      DB_PASS: 'local-db-pass',
      DATABASE_URL: 'postgres://u:pw@db.internal/x',
      SENTRY_DSN: 'https://k3y@sentry.example.io/1',
    }
    f.hosts.update(f.host.id, { envVars })
    const template = [
      '# managed',
      `DB_PASSWORD=\${secret:${f.ids.dotenvSecret}}`,
      'APP_ENV=staging',
      'DB_PASS=tmpl-db-pass',
      'DATABASE_URL=postgres://u:pw@db.internal/x',
      'SENTRY_DSN=https://k3y@sentry.example.io/1',
      '# OLD_TOKEN=old-token-value',
      '',
    ].join('\n')
    const urls = [{ url: 'https://staging.example.com/health?api_key=abc&v=1', from: 'mac' as const }]
    f.deploys.update(f.ids.deployment, { envTemplate: template, urls })
    f.services.update(f.ids.appService, { url: 'https://staging.example.com/?token=xyz' })

    const file = buildConfigExport(f.db, clock).file
    // The export did blank them.
    const app1 = file.hosts.find((h) => h.label === 'app1')!
    expect(app1.envVars).toEqual({ LANG: 'C.UTF-8', DB_PASS: '', DATABASE_URL: '', SENTRY_DSN: '' })
    const api = file.deployments.find((d) => d.name === 'api')!
    expect(api.envTemplate).toContain('\nDB_PASS=\nDATABASE_URL=\nSENTRY_DSN=\n# OLD_TOKEN=\n')
    expect(api.urls[0].url).toBe('https://staging.example.com/health?api_key=&v=1')
    expect(file.services.find((s) => s.name === 'web')).toMatchObject({ url: 'https://staging.example.com/?token=' })

    const before = snapshot(f.db)
    const plan = planImport(f.db, file)
    expect(plan.items.filter((i) => i.action !== 'unchanged')).toEqual([])
    expect(plan.needsSecret).toEqual([])
    importFile(f, file)
    expect(snapshot(f.db)).toBe(before)
    expect(JSON.parse(hostRow(f.db, f.host.id).env_vars as string)).toEqual(envVars)
    const d = f.deploys.get(f.ids.deployment)
    expect(d.envTemplate).toBe(template)
    expect(d.urls).toEqual(urls)
    expect(f.services.get(f.ids.appService)).toMatchObject({ url: 'https://staging.example.com/?token=xyz' })
  })

  it('a blanked secret template line the local template has no value for keeps the local template and says so', async () => {
    const f = await makeConfigFixture()
    const local = f.deploys.get(f.ids.deployment).envTemplate!
    f.deploys.update(f.ids.deployment, { envTemplate: `${local}DB_PASS=tmpl-db-pass\n` })
    const file = buildConfigExport(f.db, clock).file
    f.deploys.update(f.ids.deployment, { envTemplate: local })
    const plan = planImport(f.db, file)
    expect(plan.needsSecret).toContainEqual({ kind: 'deployments', name: 'api', field: 'envTemplate', reason: 'DB_PASS; kept the local template' })
    importFile(f, file)
    expect(f.deploys.get(f.ids.deployment).envTemplate).toBe(local)
  })

  it('matches by id, then by name within the parent, and remaps references', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    // By id: a product row with the file's id under another name.
    t.db
      .prepare(`INSERT INTO products(id, name, color, icon, description, repo_url, created_at, updated_at) VALUES (?, 'Old shop', '#3366ff', 'rocket', 'The shop', 'git@example.com:shop.git', 'x', 'x')`)
      .run(f.ids.product)
    // By name: a host labelled like the file's app1, under its own id.
    const app1 = t.hosts.create({ regionId: REGION, label: 'APP1', address: '10.9.9.9' })
    // By name within the product the file's staging maps to; one of the same name in another product doesn't match.
    const staging = t.envs.create({ productId: f.ids.product, name: 'staging', color: '#112233' })
    const elsewhere = t.envs.create({ productId: PRODUCT, name: 'STAGING', color: '#112233' })

    const plan = planImport(t.db, file)
    expect(itemOf(plan, 'products', 'Shop')).toMatchObject({ id: f.ids.product, action: 'update', fields: ['name'] })
    expect(itemOf(plan, 'hosts', 'app1')).toMatchObject({ id: app1.id, action: 'update' })
    expect(itemOf(plan, 'hosts', 'app1').fields).toEqual(expect.arrayContaining(['label', 'address', 'jumpHostId']))
    expect(itemOf(plan, 'environments', 'staging')).toMatchObject({ id: staging.id, action: 'update' })
    expect(itemOf(plan, 'tunnels', 'pg')).toMatchObject({ id: f.ids.tunnel, action: 'add' })
    importFile(t, file)

    expect(t.db.prepare('SELECT name FROM products WHERE id = ?').get(f.ids.product)).toEqual({ name: 'Shop' })
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM hosts').get()).toEqual({ n: 2 })
    expect(t.db.prepare('SELECT address, jump_host_id FROM hosts WHERE id = ?').get(app1.id)).toEqual({ address: '10.0.0.7', jump_host_id: f.ids.bastion })
    // References to the file's app1 and staging now point at the local rows.
    expect(t.tunnels.get(f.ids.tunnel)).toMatchObject({ hostId: app1.id, environmentId: staging.id })
    const d = t.db.prepare('SELECT host_id, environment_id FROM deployments WHERE id = ?').get(f.ids.deployment)
    expect(d).toEqual({ host_id: app1.id, environment_id: staging.id })
    expect(t.db.prepare('SELECT via_host_id, tunnel_id, environment_id FROM services WHERE id = ?').get(f.ids.dbService)).toEqual({
      via_host_id: app1.id,
      tunnel_id: f.ids.tunnel,
      environment_id: staging.id,
    })
    expect(t.envs.get(staging.id).hosts).toEqual(
      expect.arrayContaining([
        { hostId: app1.id, role: 'app' },
        { hostId: f.ids.bastion, role: 'bastion' },
      ]),
    )
    expect(t.envs.get(staging.id).productId).toBe(f.ids.product)
    expect(t.envs.get(elsewhere.id).hosts).toEqual([])
    // The file's own ids for app1 and staging were never used.
    expect(t.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(f.host.id)).toBeUndefined()
    expect(t.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(f.staging.id)).toBeUndefined()
  })

  it('two local identities or tunnels with the same label give skip with ambiguous: 2 matches', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    t.identities.create({ vaultId: t.teamVaultId!, label: 'deployer', username: 'a', auth: 'agent' })
    t.identities.create({ vaultId: t.teamVaultId!, label: 'deployer', username: 'b', auth: 'agent' })
    const app1 = t.hosts.create({ regionId: REGION, label: 'app1', address: '10.0.0.7' })
    t.tunnels.create({ label: 'pg', hostId: app1.id, type: 'D', bindPort: 1080 })
    t.tunnels.create({ label: 'pg', hostId: app1.id, type: 'D', bindPort: 1081 })

    const plan = planImport(t.db, file)
    expect(itemOf(plan, 'identities', 'deployer')).toMatchObject({ action: 'skip', reason: 'ambiguous: 2 matches' })
    expect(itemOf(plan, 'tunnels', 'pg')).toMatchObject({ action: 'skip', reason: 'ambiguous: 2 matches' })
    // What referenced the skipped identity goes without one, and says so.
    expect(plan.needsSecret).toContainEqual({ kind: 'environments', name: 'staging', field: 'defaultIdentityId' })
    importFile(t, file)
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM identities').get()).toEqual({ n: 2 })
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM tunnels').get()).toEqual({ n: 2 })
    // The db service that used the skipped tunnel imports without one.
    expect(t.db.prepare('SELECT tunnel_id FROM services WHERE id = ?').get(f.ids.dbService)).toEqual({ tunnel_id: null })
  })

  it('an ssh key ref matching two keys in the vault is skipped as ambiguous', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    t.keys.import({ vaultId: t.teamVaultId!, label: 'deploy-key', privateKey: otherKey() })

    const plan = planImport(t.db, file)
    expect(itemOf(plan, 'identities', 'deployer')).toMatchObject({ action: 'skip', reason: 'ambiguous: 2 matches' })
    expect(plan.needsSecret).toContainEqual({ kind: 'identities', name: 'deployer', field: 'key', reason: 'ambiguous: 2 matches' })
    importFile(t, file)
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM identities').get()).toEqual({ n: 0 })
  })

  it('never deletes or unlinks anything missing from the file', async () => {
    const f = await makeConfigFixture()
    const file = buildConfigExport(f.db, clock).file
    // Objects and links the file doesn't know.
    const extra = f.hosts.create({ regionId: REGION, label: 'extra', address: '10.0.0.99' })
    const other = f.products.create({ name: 'Other', color: '#111111', icon: 'rocket' })
    f.envs.setProduct(f.prod.id, other.id)
    f.envs.putHost(f.staging.id, extra.id, 'other')
    f.hosts.setVaults(extra.id, [f.teamVaultId])
    f.hosts.setVaults(f.host.id, [DEFAULT_VAULT_ID])
    const t2 = f.tunnels.create({ label: 'extra-tunnel', hostId: extra.id, type: 'D', bindPort: 1090 })
    const d2 = f.deploys.create(f.input({ name: 'worker' }))
    const before = snapshot(f.db)

    const plan = planImport(f.db, file)
    expect(plan.counts.skip).toBe(0)
    // An environment never moves product on import: it stays where it is, and the item says so.
    expect(itemOf(plan, 'environments', 'prod')).toMatchObject({ action: 'unchanged', notes: ['product not changed'] })
    importFile(f, file)
    expect(f.hosts.list().map((h) => h.label).sort()).toEqual(['app1', 'bastion', 'extra'])
    expect(f.products.list().map((p) => p.name).sort()).toEqual(['Fixture', 'Other', 'Shop'])
    expect(f.envs.get(f.prod.id).productId).toBe(other.id)
    expect(f.envs.get(f.staging.id).hosts).toContainEqual({ hostId: extra.id, role: 'other' })
    // Links in the file come back; none is removed.
    expect(f.hosts.list().find((h) => h.id === f.host.id)!.vaultIds.sort()).toEqual([DEFAULT_VAULT_ID, f.teamVaultId].sort())
    expect(f.hosts.list().find((h) => h.id === extra.id)!.vaultIds).toEqual([f.teamVaultId])
    expect(f.tunnels.get(t2.id).label).toBe('extra-tunnel')
    expect(f.deploys.get(d2.id).name).toBe('worker')
    expect(snapshot(f.db)).not.toBe(before)
  })

  it('an unresolved secret ref leaves the field unset and is listed as needs a secret', async () => {
    const { f, file } = await sourceFile()
    // No sudo-pw secret and no Team vault (so no db-pass and no deploy-key) in the target.
    const t = await makeTarget(f, { become: false, team: false })
    const plan = planImport(t.db, file)
    expect(plan.needsSecret).toEqual(
      expect.arrayContaining([
        { kind: 'deployments', name: 'api', field: 'becomeSecret' },
        { kind: 'deployments', name: 'api', field: 'envTemplate', reason: 'DB_PASSWORD, DB_PASSWORD_COPY' },
        { kind: 'deployments', name: 'api', field: 'vaults', reason: 'no vault named Team' },
        { kind: 'hosts', name: 'app1', field: 'vaults', reason: 'no vault named Team' },
      ]),
    )
    expect(itemOf(plan, 'identities', 'deployer')).toMatchObject({ action: 'skip', reason: 'no vault named Team' })
    importFile(t, file)

    const d = t.db.prepare('SELECT become_secret_id, env_template FROM deployments WHERE id = ?').get(f.ids.deployment) as {
      become_secret_id: string | null
      env_template: string
    }
    expect(d.become_secret_id).toBeNull()
    const envSecret = t.db.prepare("SELECT id FROM secrets WHERE name = 'envsecret'").get() as { id: string }
    expect(d.env_template).toBe(['# managed', 'DB_PASSWORD=', 'APP_ENV=staging', `API_TOKEN=\${secret:${envSecret.id}}`, 'DB_PASSWORD_COPY=', ''].join('\n'))
    expect(t.db.prepare('SELECT vault_id FROM deployment_vaults WHERE deployment_id = ?').all(f.ids.deployment)).toEqual([{ vault_id: DEFAULT_VAULT_ID }])
    expect(t.db.prepare('SELECT vault_id FROM host_vaults WHERE host_id = ?').all(f.host.id)).toEqual([{ vault_id: DEFAULT_VAULT_ID }])
  })

  it('a new password identity is skipped and its hosts import with no identity', async () => {
    const f = await makeConfigFixture()
    const file = buildConfigExport(f.db, clock).file
    const t = await makeTarget(f)
    const plan = planImport(t.db, file)
    expect(itemOf(plan, 'identities', 'root-login')).toMatchObject({ action: 'skip', reason: 'needs a secret: password' })
    expect(plan.needsSecret).toEqual(
      expect.arrayContaining([
        { kind: 'identities', name: 'root-login', field: 'password' },
        { kind: 'hosts', name: 'app1', field: 'identityId' },
      ]),
    )
    const res = importFile(t, file)
    expect(res.counts.skip).toBe(1)
    expect(t.db.prepare('SELECT identity_id FROM hosts WHERE id = ?').get(f.host.id)).toEqual({ identity_id: null })
    expect(t.db.prepare("SELECT 1 FROM identities WHERE label = 'root-login'").get()).toBeUndefined()
    expect(t.db.prepare("SELECT 1 FROM identities WHERE label = 'deployer'").get()).toBeDefined()
  })

  it('all or nothing: an invalid checkout late in the file leaves the DB unchanged', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    const bad = copy(file)
    bad.deployments[0].dbBackup = true
    bad.deployments[0].backupDir = null
    const before = snapshot(t.db)
    expect(() => importFile(t, bad)).toThrow(`Checkout ${bad.deployments[0].name}: backup dir is required when DB backup is on`)
    expect(snapshot(t.db)).toBe(before)
    // Applied over a valid preview, the same failure rolls back every row already written.
    const plan = planImport(t.db, file)
    expect(() => applyImport(deps(t), bad, { typedNames: [], expected: plan.counts })).toThrow('backup dir is required')
    expect(snapshot(t.db)).toBe(before)
    expect(t.audit.list({ actions: ['config.import'] })).toEqual([])
  })

  it('updating a protected environment needs its typed name; adding one does not', async () => {
    const f = await makeConfigFixture()
    const file = copy(buildConfigExport(f.db, clock).file)
    file.environments.find((e) => e.name === 'prod')!.color = '#bb0000'
    const plan = planImport(f.db, file)
    expect(plan.protectedEnvironments).toEqual(['prod'])
    expect(itemOf(plan, 'environments', 'prod')).toMatchObject({ action: 'update', fields: ['color'] })

    const err = (() => {
      try {
        applyImport(deps(f), file, { typedNames: ['staging', 'Prod'], expected: plan.counts })
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(DeployError)
    expect(err).toMatchObject({ code: 'CONFIRM_REQUIRED', message: 'Type prod to update this protected environment' })
    expect(f.envs.get(f.prod.id).color).toBe('#aa0000')

    applyImport(deps(f), file, { typedNames: ['prod'], expected: plan.counts })
    expect(f.envs.get(f.prod.id).color).toBe('#bb0000')

    // A checkout added to a protected environment updates it too.
    const withCheckout = copy(file)
    withCheckout.deployments.push({ ...withCheckout.deployments[0], id: '0190a1b2-c3d4-7e5f-8a6b-eeeeeeeeeeee', name: 'prod-api', environmentId: f.prod.id, becomeSecret: null, envTemplate: null, managedEnv: false })
    expect(planImport(f.db, withCheckout).protectedEnvironments).toEqual(['prod'])

    // Adding one: the round trip into an empty DB adds prod with no typed name (checked there too).
    const t = await makeTarget(f)
    const added = planImport(t.db, withCheckout)
    expect(itemOf(added, 'environments', 'prod').action).toBe('add')
    expect(added.protectedEnvironments).toEqual([])
  })

  it('a host behind a protected environment that would reach another machine needs its typed name', async () => {
    const f = await makeConfigFixture()
    const file = copy(buildConfigExport(f.db, clock).file)
    file.hosts.find((h) => h.label === 'app1')!.address = '6.6.6.6'
    const plan = planImport(f.db, file)
    expect(itemOf(plan, 'hosts', 'app1')).toMatchObject({ action: 'update', fields: ['address'] })
    expect(plan.protectedEnvironments).toEqual(['prod'])
    expect(() => applyImport(deps(f), file, { typedNames: [], expected: plan.counts })).toThrow('Type prod to update this protected environment')
    expect(hostRow(f.db, f.host.id).address).not.toBe('6.6.6.6')
    applyImport(deps(f), file, { typedNames: ['prod'], expected: plan.counts })
    expect(hostRow(f.db, f.host.id).address).toBe('6.6.6.6')
  })

  it('a host a protected environment reaches through a db service or checkout needs its typed name', async () => {
    const f = await makeConfigFixture()
    // None of these hosts is linked to prod; prod reaches each through one of its own rows.
    const jump = f.hosts.create({ regionId: REGION, label: 'tunjump', address: '10.5.0.1' })
    const via = f.hosts.create({ regionId: REGION, label: 'tunhost', address: '10.5.0.2', jumpHostId: jump.id })
    f.services.create({ kind: 'db', environmentId: f.prod.id, name: 'prod-db', dbEngine: 'postgres', dbAddress: '10.5.0.9', viaHostId: via.id })
    const build = f.hosts.create({ regionId: REGION, label: 'buildbox', address: '10.5.0.3' })
    f.deploys.create(f.input({ name: 'prod-build', environmentId: f.prod.id, hostId: build.id, deployTag: 'deploy_prod_build' }))
    // The checkout joined prod silently; taking the host out of prod leaves the checkout on it.
    f.envs.removeHost(f.prod.id, build.id)
    const exported = buildConfigExport(f.db, clock).file

    for (const label of ['tunhost', 'tunjump', 'buildbox']) {
      const file = copy(exported)
      file.hosts.find((h) => h.label === label)!.address = '6.6.6.6'
      const plan = planImport(f.db, file)
      expect(itemOf(plan, 'hosts', label)).toMatchObject({ action: 'update', fields: ['address'] })
      expect(plan.protectedEnvironments, label).toContain('prod')
      expect(() => applyImport(deps(f), file, { typedNames: [], expected: plan.counts })).toThrow('Type prod to update this protected environment')
    }
    // A tags-only change reaches nothing.
    const tags = copy(exported)
    tags.hosts.find((h) => h.label === 'tunhost')!.tags = ['db']
    expect(planImport(f.db, tags).protectedEnvironments).toEqual([])
  })

  it('a changed jump host, or a host dropping its jump, guards the protected environments behind it', async () => {
    const f = await makeConfigFixture()
    const exported = buildConfigExport(f.db, clock).file
    // bastion is only in staging, but app1 in prod jumps through it.
    const moved = copy(exported)
    moved.hosts.find((h) => h.label === 'bastion')!.address = 'evil.example.com'
    const plan = planImport(f.db, moved)
    expect(plan.protectedEnvironments).toEqual(['prod'])
    expect(() => applyImport(deps(f), moved, { typedNames: [], expected: plan.counts })).toThrow('Type prod to update this protected environment')

    const direct = copy(exported)
    direct.hosts.find((h) => h.label === 'app1')!.jumpHostId = null
    const plan2 = planImport(f.db, direct)
    expect(itemOf(plan2, 'hosts', 'app1')).toMatchObject({ action: 'update', fields: ['jumpHostId'] })
    expect(plan2.protectedEnvironments).toEqual(['prod'])
    applyImport(deps(f), direct, { typedNames: ['prod'], expected: plan2.counts })
    expect(hostRow(f.db, f.host.id).jump_host_id).toBeNull()
  })

  it('an identity login change guards the protected environments of the hosts using it', async () => {
    const f = await makeConfigFixture()
    const file = copy(buildConfigExport(f.db, clock).file)
    // root-login is app1's identity; app1 is in prod.
    file.identities.find((i) => i.label === 'root-login')!.username = 'admin'
    const plan = planImport(f.db, file)
    expect(itemOf(plan, 'identities', 'root-login')).toMatchObject({ action: 'update', fields: ['username'] })
    expect(plan.protectedEnvironments).toEqual(['prod'])
    expect(() => applyImport(deps(f), file, { typedNames: [], expected: plan.counts })).toThrow('Type prod to update this protected environment')
    applyImport(deps(f), file, { typedNames: ['prod'], expected: plan.counts })
    expect((f.db.prepare('SELECT username FROM identities WHERE id = ?').get(f.ids.passwordIdentity) as { username: string }).username).toBe('admin')

    // A label or tag change reaches nothing: no typed name.
    const harmless = copy(buildConfigExport(f.db, clock).file)
    harmless.hosts.find((h) => h.label === 'app1')!.tags = ['web']
    expect(planImport(f.db, harmless).protectedEnvironments).toEqual([])
  })

  it('a sensitive host env var written into the file is left blank, never imported', async () => {
    const f = await makeConfigFixture()
    const file = copy(buildConfigExport(f.db, clock).file)
    file.hosts.find((h) => h.label === 'app1')!.envVars = { LANG: 'C.UTF-8', DB_PASSWORD: 'hunter2-plain' }
    const plan = planImport(f.db, file)
    expect(plan.needsSecret).toContainEqual({ kind: 'hosts', name: 'app1', field: 'envVars', reason: 'DB_PASSWORD left blank; set it in the host editor' })
    expect(JSON.stringify(plan)).not.toContain('hunter2-plain')
    importFile(f, file, ['prod'])
    expect(JSON.parse(hostRow(f.db, f.host.id).env_vars as string)).toEqual({ LANG: 'C.UTF-8', DB_PASSWORD: '' })
    expect(JSON.stringify(f.db.prepare('SELECT * FROM hosts').all())).not.toContain('hunter2-plain')

    const t = await makeTarget(f)
    importFile(t, file)
    expect(JSON.stringify(t.db.prepare('SELECT * FROM hosts').all())).not.toContain('hunter2-plain')
  })

  it('an unresolved ref on an update keeps the local value and says so', async () => {
    const f = await makeConfigFixture()
    const file = copy(buildConfigExport(f.db, clock).file)
    file.secretRefs = Object.fromEntries(Object.entries(file.secretRefs).map(([k, r]) => [k, { ...r, itemName: `${r.itemName}-gone` }]))
    const plan = planImport(f.db, file)
    expect(plan.needsSecret).toContainEqual({ kind: 'deployments', name: 'api', field: 'becomeSecret', reason: 'kept the local become secret' })
    expect(plan.needsSecret).toContainEqual(
      expect.objectContaining({ kind: 'deployments', name: 'api', field: 'envTemplate', reason: expect.stringMatching(/; kept the local template$/) }),
    )
  })

  it('matches regions by id, then by code; a host keeps its own region and says so', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    const moved = copy(file)
    const eu = '0190a1b2-c3d4-4e5f-8a6b-00000000e001'
    moved.regions.push({ id: eu, code: 'EU-1', provider: 'aws', displayName: 'Europe' })
    moved.hosts.find((h) => h.label === 'bastion')!.regionId = eu
    // A local region with the same code (any case) under its own id.
    const local = t.regions.create({ code: 'eu-1', displayName: 'Europe' })
    const plan = planImport(t.db, moved)
    expect(itemOf(plan, 'regions', 'EU-1')).toMatchObject({ id: local.id, action: 'update', fields: ['provider'] })
    importFile(t, moved)
    expect(t.regions.list().map((r) => [r.code, r.hostCount])).toEqual([
      ['eu-1', 1],
      ['test-1', 1],
    ])
    expect(hostRow(t.db, f.ids.bastion).region_id).toBe(local.id)

    // Re-imported with bastion back in test-1: the host stays in eu-1.
    const back = planImport(t.db, file)
    expect(itemOf(back, 'hosts', 'bastion')).toMatchObject({ action: 'unchanged', notes: ['region not changed'] })
    importFile(t, file)
    expect(hostRow(t.db, f.ids.bastion).region_id).toBe(local.id)
  })

  it('a version 1 file needs a region for its new hosts, and says what became of its product links', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    const extraProduct = '0190a1b2-c3d4-4e5f-8a6b-00000000a001'
    const v1 = asV1(file, (r) => {
      r.products.push({ ...r.products[0], id: extraProduct, name: 'Zebra' })
      r.environments.find((e: { id: string }) => e.id === f.staging.id).productIds.push(extraProduct)
      r.environments.find((e: { id: string }) => e.id === f.prod.id).productIds = []
    })
    const plan = planImport(t.db, v1)
    expect(plan.needsRegion).toBe(true)
    expect(itemOf(plan, 'environments', 'staging').notes).toEqual(['kept Shop, removed Zebra'])
    expect(itemOf(plan, 'environments', 'prod').notes).toEqual(['no product: put in Unassigned'])
    expect(itemOf(plan, 'products', 'Unassigned')).toMatchObject({ action: 'add' })
    // The dry run's stand-in region is never kept, nor listed.
    expect(plan.items.some((i) => i.kind === 'regions')).toBe(false)
    expect(t.regions.list().map((r) => r.code)).toEqual(['test-1'])

    const before = snapshot(t.db)
    expect(() => applyImport(deps(t), v1, { typedNames: [], expected: plan.counts })).toThrow(REGION_MESSAGE)
    expect(snapshot(t.db)).toBe(before)
    const eu = t.regions.create({ code: 'eu-1', displayName: 'Europe' })
    applyImport(deps(t), v1, { typedNames: [], expected: plan.counts, regionId: eu.id })
    expect(t.regions.list().map((r) => [r.code, r.hostCount])).toEqual([
      ['eu-1', 2],
      ['test-1', 0],
    ])
    const unassigned = t.products.list().find((p) => p.name === 'Unassigned')!
    expect(t.envs.get(f.prod.id).productId).toBe(unassigned.id)
    expect(t.envs.get(f.staging.id).productId).toBe(f.ids.product)

    // A second version 1 file reuses that Unassigned, and adds no host so needs no region.
    const again = planImport(t.db, v1)
    expect(again.needsRegion).toBe(false)
    expect(again.counts.add).toBe(0)
  })

  it('the preview refuses to run inside an open transaction', async () => {
    const f = await makeConfigFixture()
    const file = buildConfigExport(f.db, clock).file
    f.db.exec('BEGIN')
    try {
      expect(() => planImport(f.db, file)).toThrow('nested transactions are not supported')
      expect(f.db.isTransaction).toBe(true)
    } finally {
      f.db.exec('ROLLBACK')
    }
  })

  it('apply refuses when the DB changed since the preview', async () => {
    const f = await makeConfigFixture()
    const file = buildConfigExport(f.db, clock).file
    const plan = planImport(f.db, file)
    f.products.update(f.ids.product, { color: '#000000' })
    const before = snapshot(f.db)
    expect(() => applyImport(deps(f), file, { typedNames: [], expected: plan.counts })).toThrow(
      'The config changed since the preview; open the file again',
    )
    expect(snapshot(f.db)).toBe(before)
  })

  it('import refuses while the vault is locked', async () => {
    const f = await makeConfigFixture()
    const file = buildConfigExport(f.db, clock).file
    const plan = planImport(f.db, file)
    f.vault.lock('manual')
    expect(() => applyImport(deps(f), file, { typedNames: [], expected: plan.counts })).toThrow(VAULT_LOCKED)
    let asked = false
    const h = handlers(f, async () => ((asked = true), undefined))
    await expect(h['config:importOpen']()).rejects.toThrow(VAULT_LOCKED)
    expect(asked).toBe(false)
  })
})

function handlers(f: ConfigFixture, openDialog: () => Promise<string | undefined>, over: { readFile?: (path: string) => Promise<string>; now?: () => Date; onImported?: (environmentIds: string[]) => void } = {}) {
  return createConfigHandlers({
    db: f.db,
    vault: f.vault,
    audit: f.audit,
    now: over.now ?? clock,
    saveDialog: async () => undefined,
    openDialog,
    ...(over.readFile ? { readFile: over.readFile } : {}),
    ...(over.onImported ? { onImported: over.onImported } : {}),
  })
}

/** The keys a version 1 file has in place of the version 2 ones. */
const v1Shape = (file: ConfigFile) => ({
  version: 1,
  regions: undefined,
  hosts: file.hosts.map(({ regionId: _, ...h }) => h),
  environments: file.environments.map(({ productId, ...e }) => ({ ...e, productIds: [productId] })),
})

const writeTmp = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'credops-import-')), 'credops-config.json')
  writeFileSync(path, text)
  return path
}

describe('config import over IPC', () => {
  it('opens a preview under a token, applies it once and audits counts only', async () => {
    const f = await makeConfigFixture()
    const file = copy(buildConfigExport(f.db, clock).file)
    file.products.find((p) => p.name === 'Shop')!.description = 'A new description'
    const path = writeTmp(serializeConfig(file))
    const changed: string[][] = []
    const h = handlers(f, async () => path, { onImported: (ids) => changed.push(ids) })

    const preview = await h['config:importOpen']()
    if (!preview || 'errors' in preview) throw new Error('expected a preview')
    expect(preview.token).toMatch(/^[0-9a-f]{32}$/)
    expect(preview.counts).toEqual({ add: 0, update: 1, unchanged: 12, skip: 0 })
    expect(preview.needsRegion).toBe(false)
    expect(JSON.stringify(preview)).not.toContain(path)

    const res = await h['config:importApply'](preview.token, { typedNames: [] })
    expect(res.counts).toEqual(preview.counts)
    expect(f.products.list().find((p) => p.name === 'Shop')!.description).toBe('A new description')
    // The product is linked to staging only: its page reloads.
    expect(changed).toEqual([[f.staging.id]])

    const [e] = f.audit.list({ actions: ['config.import'] })
    expect(e).toMatchObject({ outcome: 'success', targetType: 'config', targetLabel: 'config' })
    expect(e.details).toEqual({ counts: preview.counts, unresolved: 0 })
    const row = JSON.stringify(e)
    for (const s of [path, 'Shop', 'app1', 'staging', f.ids.product, f.host.id]) expect(row).not.toContain(s)

    // The token was spent.
    await expect(h['config:importApply'](preview.token, { typedNames: [] })).rejects.toThrow('The preview expired; open the file again')
  })

  it('config.import audit has counts only', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f, { become: false })
    const last = Math.max(0, ...t.audit.list({}).map((x) => x.id))
    importFile(t, file)
    const [e] = t.audit.list({ actions: ['config.import'] })
    expect(e.details).toEqual({ counts: { add: 10, update: 0, unchanged: 2, skip: 0 }, unresolved: 1 })
    expect(e.targetId ?? null).toBeNull()
    // No per-row audits: the import's one event is all it wrote.
    expect(t.audit.list({}).filter((x) => x.id > last).map((x) => x.action)).toEqual(['config.import'])
  })

  it('passes the chosen region through for a version 1 file', async () => {
    const { f, file } = await sourceFile()
    const t = await makeTarget(f)
    const path = writeTmp(JSON.stringify({ ...JSON.parse(serializeConfig(file)), ...v1Shape(file) }))
    const h = handlers(t as unknown as ConfigFixture, async () => path)
    const preview = await h['config:importOpen']()
    if (!preview || 'errors' in preview) throw new Error(`expected a preview: ${JSON.stringify(preview)}`)
    expect(preview.needsRegion).toBe(true)
    await expect(h['config:importApply'](preview.token, { typedNames: [] })).rejects.toThrow(REGION_MESSAGE)
    const again = await h['config:importOpen']()
    if (!again || 'errors' in again) throw new Error('expected a preview')
    await h['config:importApply'](again.token, { typedNames: [], regionId: REGION })
    expect(hostRow(t.db, f.host.id).region_id).toBe(REGION)
  })

  it('a cancelled dialog returns null and holds nothing', async () => {
    const f = await makeConfigFixture()
    const h = handlers(f, async () => undefined)
    expect(await h['config:importOpen']()).toBeNull()
  })

  it('a file over 5 MB is refused before it is read', async () => {
    const f = await makeConfigFixture()
    const path = writeTmp('')
    truncateSync(path, CONFIG_MAX_BYTES + 1)
    const readFile = vi.fn(async () => '{}')
    const h = handlers(f, async () => path, { readFile })
    expect(await h['config:importOpen']()).toEqual({ errors: ['The file is larger than 5 MB'] })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('an unknown format or a newer version is refused', async () => {
    const f = await makeConfigFixture()
    const file = buildConfigExport(f.db, clock).file
    const wrong = handlers(f, async () => writeTmp(JSON.stringify({ ...file, format: 'something-else' })))
    expect(await wrong['config:importOpen']()).toEqual({ errors: ["This isn't a CredOps config file"] })
    const newer = handlers(f, async () => writeTmp(JSON.stringify({ ...file, version: 3 })))
    expect(await newer['config:importOpen']()).toEqual({ errors: ['This file is from a newer CredOps'] })
    const notJson = handlers(f, async () => writeTmp('{ not json'))
    expect(await notJson['config:importOpen']()).toEqual({ errors: ["The file isn't valid JSON"] })
  })

  it('discard drops the token, a new open replaces it, and it expires after 10 minutes', async () => {
    const f = await makeConfigFixture()
    const path = writeTmp(serializeConfig(buildConfigExport(f.db, clock).file))
    let now = clock().getTime()
    const h = handlers(f, async () => path, { now: () => new Date(now) })
    const open = async () => {
      const p = await h['config:importOpen']()
      if (!p || 'errors' in p) throw new Error('expected a preview')
      return p
    }
    const a = await open()
    await h['config:importDiscard'](a.token)
    await expect(h['config:importApply'](a.token, { typedNames: [] })).rejects.toThrow('The preview expired; open the file again')

    const b = await open()
    const c = await open()
    await expect(h['config:importApply'](b.token, { typedNames: [] })).rejects.toThrow('The preview expired; open the file again')
    now += 10 * 60_000 + 1
    await expect(h['config:importApply'](c.token, { typedNames: [] })).rejects.toThrow('The preview expired; open the file again')
  })
})

// ---- playbook ops: steps, flow, runbooks and prepare settings ----

const stepBody = (over: Partial<StepBody> = {}): StepBody => ({
  id: 'migrate',
  name: 'migrate',
  run: 'shell',
  service: null,
  script: 'echo migrate',
  cwd: null,
  sudo: 'docker',
  timeoutSec: 600,
  onFailure: 'stop',
  when: { kind: 'always' },
  secrets: [],
  ...over,
})

/** The config fixture with saved steps (one holding a secret), a flow, a runbook and non-default prepare settings. */
async function playbookSource(): Promise<{ f: ConfigFixture; file: ConfigFile; secretValue: string }> {
  const f = await makeConfigFixture()
  f.identities.delete(f.ids.passwordIdentity)
  f.deploys.update(f.ids.deployment, {
    steps: [
      { ...stepBody({ secrets: [{ envName: 'DB_PASS', secretId: f.ids.dotenvSecret }] }), anchor: 'before_build', alsoOnRollback: false },
      { ...stepBody({ id: 'exec', name: 'exec', run: 'compose-exec', service: 'web', script: 'ls' }), anchor: 'after_up', alsoOnRollback: true },
    ],
  })
  f.services.update(f.ids.appService, { skipUnchanged: true })
  f.deploys.updateSettings(f.staging.id, {
    parallelPrepare: false,
    prepareCap: 5,
    flow: {
      onFailure: 'continue-other-hosts',
      stages: [
        { kind: 'step', serviceId: f.ids.appService, step: stepBody({ id: 'warm', name: 'warm', secrets: [{ envName: 'TOKEN', secretId: f.ids.dotenvSecret }] }) },
        { kind: 'services', serviceIds: [f.ids.appService] },
      ],
    },
  })
  const runbooks = new RunbookStore({ db: f.db, audit: f.audit, vault: f.vault })
  runbooks.create({
    environmentId: f.staging.id,
    name: 'Reindex',
    description: 'rebuild the index',
    targetServiceIds: [f.ids.appService],
    items: [
      { type: 'step', step: stepBody({ id: 'reindex', name: 'reindex', secrets: [{ envName: 'DB_PASS', secretId: f.ids.dotenvSecret }] }) },
      { type: 'builtin', builtin: 'logs', tail: 50 },
    ],
    params: [{ name: 'shard', label: 'Shard', type: 'text', pattern: 'number', choices: [] }],
    lock: true,
    notify: true,
  })
  return { f, file: buildConfigExport(f.db, clock).file, secretValue: SECRET_VALUES.dotenv }
}

/** The target's deploy and service stores, for reading back what an import wrote. */
const readers = (t: InventoryFixture) => ({
  deploys: new DeployStore({ db: t.db, audit: t.audit, vault: t.vault, secrets: dbSecretRefs(t.db) }),
  services: new ServiceStore({ db: t.db, audit: t.audit, vault: t.vault }),
})

describe('config import of playbook ops settings', () => {
  it('round-trips steps, flow, parallelPrepare, prepareCap, skipUnchanged and runbooks', async () => {
    const { f, file } = await playbookSource()
    expect(file.deployments[0].steps).toHaveLength(2)
    expect(file.environments.find((e) => e.id === f.staging.id)).toMatchObject({ parallelPrepare: false, prepareCap: 5 })
    expect(file.runbooks).toHaveLength(1)
    // Step secrets are refs into secretRefs, never ids.
    expect(file.deployments[0].steps![0].secrets).toEqual([{ envName: 'DB_PASS', secret: expect.stringMatching(/^ref-\d+$/) }])
    expect(parseConfigFile(serializeConfig(file))).toEqual({ ok: true, file })

    const t = await makeTarget(f)
    const r = readers(t)
    const plan = planImport(t.db, file)
    expect(plan.needsSecret).toEqual([])
    // The target already has the fixture's region and product.
    expect(plan.counts).toEqual({ add: 11, update: 0, unchanged: 2, skip: 0 })
    importFile(t, file)

    const again = buildConfigExport(t.db, later).file
    expect({ ...again, exportedAt: '' }).toEqual({ ...file, exportedAt: '' })
    // The secret resolved to the target's own item, not the source's id.
    const local = r.deploys.get(f.ids.deployment).steps[0].secrets[0].secretId
    expect(local).not.toBe(f.ids.dotenvSecret)
    expect(t.db.prepare('SELECT name FROM secrets WHERE id = ?').get(local)).toEqual({ name: 'db-pass' })
    expect(r.deploys.settings(f.staging.id)).toMatchObject({ parallelPrepare: false, prepareCap: 5 })
    // Importing it again changes nothing.
    const second = planImport(t.db, file)
    expect(second.counts).toEqual({ add: 0, update: 0, unchanged: 13, skip: 0 })
  })

  it('an old file with only preHook/postHook imports as migrated steps pre-hook/post-hook', async () => {
    const { f, file } = await sourceFile()
    expect(file.deployments[0].steps).toBeUndefined()
    expect(file.deployments[0].preHook).toBe('echo pre')
    const t = await makeTarget(f)
    const r = readers(t)
    importFile(t, file)
    const d = r.deploys.get(f.ids.deployment)
    expect(d.steps).toEqual([])
    expect(effectiveSteps(d).map((s) => s.id)).toEqual(['pre-hook'])
    expect(effectiveSteps(d)).toEqual(effectiveSteps({ steps: [], preHook: 'echo pre', postHook: null }))
  })

  it('a file without parallelPrepare imports with parallelPrepare true and prepareCap 3', async () => {
    const { f, file } = await sourceFile()
    const old = copy(file)
    for (const e of old.environments) {
      delete e.parallelPrepare
      delete e.prepareCap
    }
    const t = await makeTarget(f)
    const r = readers(t)
    importFile(t, old)
    expect(r.deploys.settings(f.staging.id)).toMatchObject({ parallelPrepare: true, prepareCap: 3, flow: null })
    expect(r.services.get(f.ids.appService)).toMatchObject({ skipUnchanged: false })
  })

  it('step secrets are exported as secret refs only, never values', async () => {
    const { f, file } = await playbookSource()
    const text = serializeConfig(file)
    for (const value of Object.values(SECRET_VALUES)) {
      expect(text).not.toContain(value)
      expect(text).not.toContain(Buffer.from(value).toString('base64'))
    }
    expect(text).not.toContain(f.ids.dotenvSecret)
    expect(Object.values(file.secretRefs)).toContainEqual({ vaultName: 'Team', itemName: 'db-pass' })
  })

  it('import rejects an invalid step (bad anchor, timeout 5, 21 steps) with a validation error naming the deployment', async () => {
    const { f, file } = await playbookSource()
    const t = await makeTarget(f)
    const bad = (edit: (steps: NonNullable<ConfigFile['deployments'][number]['steps']>) => void): ConfigFile => {
      const c = copy(file)
      edit(c.deployments[0].steps!)
      return c
    }
    const cases = [
      bad((steps) => ((steps[0] as { anchor: string }).anchor = 'whenever')),
      bad((steps) => (steps[0].timeoutSec = 5)),
      bad((steps) => {
        while (steps.length < 21) steps.push({ ...steps[0], id: `s${steps.length}` })
      }),
    ]
    for (const c of cases) {
      // The strict reader refuses it, and so do the stores if it gets past (a hand-built file object).
      expect(parseConfigFile(JSON.stringify(c)).ok).toBe(false)
      expect(() => planImport(t.db, c)).toThrow(/^Checkout api: /)
    }
    // A step that names no service of its checkout passes the reader but not the store.
    const noService = bad((steps) => {
      steps[1].service = 'nope'
    })
    expect(parseConfigFile(JSON.stringify(noService)).ok).toBe(true)
    expect(() => planImport(t.db, noService)).toThrow(/^Checkout api: .*service/)
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM deployments').get()).toEqual({ n: 0 })
  })

  it('the reader refuses hostile steps, flows and runbooks', async () => {
    const { file } = await playbookSource()
    const refused = (edit: (c: ConfigFile) => void): string[] => {
      const c = copy(file)
      edit(c)
      const r = parseConfigFile(JSON.stringify(c))
      return r.ok ? [] : r.errors
    }
    expect(refused((c) => ((c.deployments[0].steps![0] as Record<string, unknown>).extra = 1))).not.toEqual([])
    expect(refused((c) => (c.deployments[0].steps![0].secrets[0].secret = 'ref-99'))).toEqual(['$.deployments[0].steps[0].secrets[0].secret is not a secret ref in this file'])
    expect(refused((c) => (c.deployments[0].steps![0].secrets[0].secret = '../../etc'))).not.toEqual([])
    expect(refused((c) => ((c.environments.find((e) => e.flow)!.flow!.stages[1] as { serviceIds: string[] }).serviceIds = ['0190a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa']))).not.toEqual([])
    expect(refused((c) => (c.runbooks![0].targetServiceIds = ['0190a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa']))).not.toEqual([])
    expect(refused((c) => c.runbooks!.push({ ...c.runbooks![0], id: '0190a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa' }))).toEqual(['$.runbooks[1].name is a duplicate name in its environment'])
    expect(refused((c) => (c.runbooks![0].params[0].name = 'constructor'))).not.toEqual([])
    expect(refused((c) => ((c as unknown as { runbooks: unknown }).runbooks = 'x'))).not.toEqual([])
  })

  it('a step secret the target lacks is left out and reported; an existing checkout keeps its own steps', async () => {
    const { f, file } = await playbookSource()
    const t = await makeTarget(f, { team: false })
    const r = readers(t)
    // Without the Team vault the secret cannot resolve: the vault link is reported as well.
    const plan = planImport(t.db, file)
    expect(plan.needsSecret.map((n) => `${n.kind}.${n.field}`)).toEqual(expect.arrayContaining(['deployments.steps', 'environments.flow', 'runbooks.items']))
    importFile(t, file)
    expect(r.deploys.get(f.ids.deployment).steps[0].secrets).toEqual([])
    // Again, over the checkout that now exists: its steps stay as they are.
    r.deploys.update(f.ids.deployment, { steps: [{ ...stepBody({ id: 'mine', name: 'mine' }), anchor: 'after_up', alsoOnRollback: false }] })
    const again = planImport(t.db, file)
    expect(again.needsSecret.find((n) => n.field === 'steps')?.reason).toContain('kept the local steps')
    importFile(t, file)
    expect(r.deploys.get(f.ids.deployment).steps.map((s) => s.id)).toEqual(['mine'])
  })

  it('a changed step shows as an update of the checkout, and a changed runbook of the runbook', async () => {
    const { f, file } = await playbookSource()
    const t = await makeTarget(f)
    importFile(t, file)
    const edited = copy(file)
    edited.deployments[0].steps![1].script = 'ls -la'
    edited.runbooks![0].description = 'changed'
    const plan = planImport(t.db, edited)
    expect(itemOf(plan, 'deployments', 'api')).toMatchObject({ action: 'update', fields: ['steps'] })
    expect(itemOf(plan, 'runbooks', 'Reindex')).toMatchObject({ action: 'update' })
    expect(plan.counts).toMatchObject({ update: 2, unchanged: 11 })
  })

  it('a flow that uses a skipped service is not imported, with a reason, and the rest of the import goes on', async () => {
    const { f, file } = await playbookSource()
    const t = await makeTarget(f)
    const r = readers(t)
    importFile(t, file)
    const before = r.deploys.settings(f.staging.id).flow
    // Here the same id lives in another environment, so the file's app service is skipped.
    const edited = copy(file)
    t.db.prepare('UPDATE services SET environment_id = ? WHERE id = ?').run(f.prod.id, f.ids.appService)
    edited.environments.find((e) => e.id === f.staging.id)!.flow!.stages.push({ kind: 'services', serviceIds: [f.ids.appService] })
    const plan = planImport(t.db, edited)
    expect(itemOf(plan, 'environments', 'staging').reason).toBe('Flow not imported: it uses web, which was skipped')
    importFile(t, edited)
    expect(r.deploys.settings(f.staging.id).flow).toEqual(before)
  })

  it('a re-import of an unchanged runbook shows no update even when the stored targets are in another order', async () => {
    const { f, file } = await playbookSource()
    const second = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'worker', deploymentId: f.ids.deployment, composeService: 'worker' })
    const runbooks = new RunbookStore({ db: f.db, audit: f.audit, vault: f.vault })
    const id = file.runbooks![0].id
    const [rb] = runbooks.list(f.staging.id)
    runbooks.update(id, { ...rb, targetServiceIds: [second.id, f.ids.appService] })
    const now = buildConfigExport(f.db, clock).file
    const again = copy(now)
    for (const order of [[second.id, f.ids.appService], [f.ids.appService, second.id]]) {
      again.runbooks![0].targetServiceIds = order
      expect(itemOf(planImport(f.db, again), 'runbooks', 'Reindex').action).toBe('unchanged')
    }
  })

  it('skips a malformed runbook with a reason and imports the rest', async () => {
    const { f, file } = await playbookSource()
    const edited = copy(file)
    const bad = { ...structuredClone(edited.runbooks![0]), id: '0190a1b2-c3d4-7e5f-8a6b-bbbbbbbbbbbb', name: 'Broken' }
    // Past the reader (a hand-built object): a param pattern the app's own save refuses.
    ;(bad.params[0] as { pattern: string }).pattern = 'bogus'
    edited.runbooks!.push(bad)
    const t = await makeTarget(f)
    const plan = planImport(t.db, edited)
    expect(itemOf(plan, 'runbooks', 'Broken')).toMatchObject({ action: 'skip', reason: expect.stringContaining('Broken') })
    expect(itemOf(plan, 'runbooks', 'Reindex').action).toBe('add')
    importFile(t, edited)
    const names = new RunbookStore({ db: t.db, audit: t.audit, vault: t.vault }).list(f.staging.id).map((r) => r.name)
    expect(names).toEqual(['Reindex'])
  })

  it('a malformed runbook with a lost secret step is one skip row and no needs-secret entry', async () => {
    const { f, file } = await playbookSource()
    const edited = copy(file)
    const bad = { ...structuredClone(edited.runbooks![0]), id: '0190a1b2-c3d4-7e5f-8a6b-cccccccccccc', name: 'Broken' }
    ;(bad.params[0] as { pattern: string }).pattern = 'bogus'
    edited.runbooks!.push(bad)
    // A target without the secret: the step's secret is lost.
    const t = await makeTarget(f)
    t.db.prepare('DELETE FROM secrets').run()
    const plan = planImport(t.db, edited)
    expect(plan.items.filter((i) => i.kind === 'runbooks' && i.name === 'Broken')).toHaveLength(1)
    expect(plan.needsSecret.filter((n) => n.kind === 'runbooks' && n.name === 'Broken')).toEqual([])
  })

  it('a flow or runbook that points at a service of another environment is refused', async () => {
    const { f, file } = await playbookSource()
    const other = f.services.create({ kind: 'service', environmentId: f.prod.id, name: 'prod-web', deploymentId: null, composeService: 'web' })
    const flowEdit = copy(file)
    flowEdit.services.push({ ...(flowEdit.services.find((x) => x.id === f.ids.appService)!), id: other.id, environmentId: f.prod.id, name: 'prod-web', deploymentId: null } as ConfigFile['services'][number])
    ;(flowEdit.environments.find((e) => e.id === f.staging.id)!.flow!.stages[1] as { serviceIds: string[] }).serviceIds = [other.id]
    expect(parseConfigFile(JSON.stringify(flowEdit)).ok).toBe(false)
    const rbEdit = copy(file)
    rbEdit.services = flowEdit.services
    rbEdit.runbooks![0].targetServiceIds = [other.id]
    expect(parseConfigFile(JSON.stringify(rbEdit)).ok).toBe(false)
    // Past the reader (a hand-built object), the stores refuse them.
    const t = await makeTarget(f)
    expect(() => planImport(t.db, flowEdit)).toThrow()
    expect(() => planImport(t.db, rbEdit)).toThrow()
  })
})
