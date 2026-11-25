import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConfigExport, exportConfig, serializeConfig } from '../../src/main/config/export'
import { applyImport, DEPENDENCY_ADDED, DEPENDENCY_KEPT, planImport } from '../../src/main/config/import'
import type { Db } from '../../src/main/db/connection'
import { createConfigHandlers } from '../../src/main/ipc/handlers/config'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { SecretStore } from '../../src/main/vault/secret-store'
import { CONFIG_SEGMENTS, parseConfigFile, type ConfigFile, type ConfigSegment } from '../../src/shared/config-file'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeConfigFixture, SECRET_VALUES, type ConfigFixture } from './config-helpers'
import { makeInventory, PRODUCT, REGION } from './inventory-helpers'

const clock = () => new Date('2026-10-20T10:00:00.000Z')
const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
const exportDeps = (f: { db: Db; vault: ConfigFixture['vault']; audit: ConfigFixture['audit'] }) => ({ db: f.db, vault: f.vault, audit: f.audit, now: clock })
const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id).sort()
const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'credops-segment-')), 'credops-config.json')
const tables = ['regions', 'products', 'identities', 'hosts', 'environments', 'environment_hosts', 'tunnels', 'deployments', 'services']
const rows = (db: Db, table: string): string => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all())

/** The config fixture without its password identity: every ref in it can resolve elsewhere. */
async function source(setup: (f: ConfigFixture) => void = () => {}): Promise<{ f: ConfigFixture; file: ConfigFile }> {
  const f = await makeConfigFixture()
  f.identities.delete(f.ids.passwordIdentity)
  setup(f)
  return { f, file: buildConfigExport(f.db, clock).file }
}

/** An inventory holding the source's vaults and items by name, under different ids. */
async function target(src: ConfigFixture) {
  const t = await makeInventory()
  const secrets = new SecretStore(t.db, t.vault, t.audit, { clipboard })
  secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'sudo-pw', kind: 'password', value: 'other-become' })
  secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'envsecret', kind: 'env', value: 'other-env' })
  const teamVaultId = t.vault.createVault({ name: 'Team', color: '#22aa66' }).id
  secrets.create({ vaultId: teamVaultId, name: 'db-pass', kind: 'env', value: 'other-db' })
  t.keys.import({ vaultId: teamVaultId, label: 'deploy-key', privateKey: src.privateKey, passphrase: SECRET_VALUES.passphrase })
  return { ...t, teamVaultId }
}

function importSegment(t: { db: Db; audit: ConfigFixture['audit']; vault: ConfigFixture['vault'] }, file: ConfigFile, segment: ConfigSegment, typedNames: string[] = []) {
  const plan = planImport(t.db, file, segment)
  return { plan, res: applyImport({ db: t.db, audit: t.audit, vault: t.vault }, file, { typedNames, expected: plan.counts, segment }) }
}

/** A third staging host that no tunnel, checkout or service uses. */
function addSpare(f: ConfigFixture): string {
  const spare = f.hosts.create({ regionId: REGION, label: 'spare', address: 'spare.example.com' })
  f.envs.putHost(f.staging.id, spare.id, 'app')
  return spare.id
}

const itemOf = (plan: ReturnType<typeof planImport>, kind: string, name: string) => plan.items.find((i) => i.kind === kind && i.name === name)

describe('config segment export', () => {
  it('a tunnels export holds the tunnels and what they need, and nothing else', async () => {
    const f = await makeConfigFixture()
    const { file, counts } = buildConfigExport(f.db, clock, 'tunnels')
    expect(ids(file.tunnels)).toEqual([f.ids.tunnel])
    // The tunnel's host, its jump host and identity; its environment, that environment's product, default identity and hosts.
    expect(ids(file.hosts)).toEqual([f.host.id, f.ids.bastion].sort())
    expect(ids(file.identities)).toEqual([f.ids.keyIdentity, f.ids.passwordIdentity].sort())
    expect(ids(file.regions)).toEqual([REGION])
    expect(ids(file.environments)).toEqual([f.staging.id])
    expect(ids(file.products)).toEqual([f.ids.product])
    expect(file.deployments).toEqual([])
    expect(file.services).toEqual([])
    expect(file.runbooks).toBeUndefined()
    // No checkout or flow here uses a secret.
    expect(file.secretRefs).toEqual({})
    expect(counts).toEqual({ regions: 1, products: 1, identities: 2, hosts: 2, environments: 1, tunnels: 1, deployments: 0, services: 0, runbooks: 0 })
    // The same format and version as a full export, so Settings reads it too.
    const full = buildConfigExport(f.db, clock).file
    expect(file.format).toBe(full.format)
    expect(file.version).toBe(full.version)
    expect(file.hosts.find((h) => h.id === f.host.id)).toEqual(full.hosts.find((h) => h.id === f.host.id))
  })

  it('a deployments export carries the secret refs its checkouts use', async () => {
    const f = await makeConfigFixture()
    const { file } = buildConfigExport(f.db, clock, 'deployments')
    expect(ids(file.deployments)).toEqual([f.ids.deployment])
    expect(ids(file.environments)).toEqual([f.staging.id])
    expect(file.services).toEqual([])
    expect(file.tunnels).toEqual([])
    expect(Object.values(file.secretRefs).sort((a, b) => (a.itemName < b.itemName ? -1 : 1))).toEqual([
      { vaultName: 'Team', itemName: 'db-pass' },
      { vaultName: 'Default', itemName: 'envsecret' },
      { vaultName: 'Default', itemName: 'sudo-pw' },
    ])
    const text = serializeConfig(file)
    for (const v of Object.values(SECRET_VALUES)) expect(text).not.toContain(v)
  })

  it('a hosts export holds regions, identities and hosts only', async () => {
    const f = await makeConfigFixture()
    const { file } = buildConfigExport(f.db, clock, 'hosts')
    expect(ids(file.hosts)).toEqual([f.host.id, f.ids.bastion].sort())
    expect(ids(file.identities)).toEqual([f.ids.keyIdentity, f.ids.passwordIdentity].sort())
    expect(ids(file.regions)).toEqual([REGION])
    for (const k of ['products', 'environments', 'tunnels', 'deployments', 'services'] as const) expect(file[k]).toEqual([])
    expect(file.secretRefs).toEqual({})
  })

  it('a products export holds the environments, services and the objects they use, with their flows', async () => {
    const f = await makeConfigFixture()
    const { file } = buildConfigExport(f.db, clock, 'products')
    expect(ids(file.products)).toEqual([PRODUCT, f.ids.product].sort())
    expect(ids(file.environments)).toEqual([f.staging.id, f.prod.id].sort())
    // Every service of those environments: the two made here and the hosts' placeholders (staging's bastion, prod's app1).
    const all = (f.db.prepare('SELECT id FROM services').all() as { id: string }[]).map((r) => r.id)
    expect(all).toEqual(expect.arrayContaining([f.ids.appService, f.ids.dbService]))
    expect(all).toHaveLength(4)
    expect(ids(file.services)).toEqual([...all].sort())
    // The app service's checkout and the db service's tunnel come along.
    expect(ids(file.deployments)).toEqual([f.ids.deployment])
    expect(ids(file.tunnels)).toEqual([f.ids.tunnel])
  })

  it('a dependency environment goes without its release flow', async () => {
    const f = await makeConfigFixture()
    f.deploys.updateSettings(f.staging.id, { flow: { onFailure: 'stop-all', stages: [{ kind: 'services', serviceIds: [f.ids.appService] }] } })
    expect(buildConfigExport(f.db, clock, 'products').file.environments.find((e) => e.id === f.staging.id)!.flow).toBeDefined()
    const { file } = buildConfigExport(f.db, clock, 'tunnels')
    expect(file.environments[0].flow).toBeUndefined()
    expect(file.services).toEqual([])
  })

  it('every segment file is a valid config file, an empty one included', async () => {
    const f = await makeConfigFixture()
    for (const segment of CONFIG_SEGMENTS) {
      const parsed = parseConfigFile(serializeConfig(buildConfigExport(f.db, clock, segment).file))
      expect(parsed.ok, segment).toBe(true)
    }
    const empty = await makeInventory()
    const { file, counts } = buildConfigExport(empty.db, clock, 'tunnels')
    expect(counts.tunnels).toBe(0)
    expect(parseConfigFile(serializeConfig(file)).ok).toBe(true)
  })

  it('counts only the left-out values of what the segment holds', async () => {
    const f = await makeConfigFixture()
    f.hosts.update(f.host.id, { envVars: { LANG: 'C.UTF-8', DB_PASSWORD: 'local-db-secret' } })
    // A legacy product row with credentials in its repo URL.
    f.db.prepare('UPDATE products SET repo_url = ? WHERE id = ?').run('https://deployer:tok3n@example.com/shop.git', PRODUCT)
    expect(buildConfigExport(f.db, clock).omitted).toBe(2)
    expect(buildConfigExport(f.db, clock, 'hosts').omitted).toBe(1)
    // Fixture is the prod environment's product: only the products page carries it.
    expect(buildConfigExport(f.db, clock, 'tunnels').omitted).toBe(1)
    expect(buildConfigExport(f.db, clock, 'products').omitted).toBe(2)
  })

  it('writes the file at 0600 and audits counts and the segment only', async () => {
    const f = await makeConfigFixture()
    const path = tmpPath()
    writeFileSync(path, 'old', { mode: 0o644 })
    let asked: ConfigSegment | undefined
    const h = createConfigHandlers({
      ...exportDeps(f),
      openDialog: async () => undefined,
      saveDialog: async (segment) => ((asked = segment), path),
    })
    const res = await h['config:export']('tunnels')
    expect(asked).toBe('tunnels')
    expect(res).toEqual({ path, counts: { regions: 1, products: 1, identities: 2, hosts: 2, environments: 1, tunnels: 1, deployments: 0, services: 0, runbooks: 0 }, omitted: 0 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(parseConfigFile(readFileSync(path, 'utf8')).ok).toBe(true)
    const [e] = f.audit.list({ actions: ['config.export'] })
    expect(e.details).toEqual({ counts: res!.counts, omitted: 0, segment: 'tunnels' })
    const json = JSON.stringify(e)
    for (const leak of [path, f.host.id, f.ids.tunnel, 'app1', 'bastion', 'pg', '10.0.0.7', 'staging', 'Shop']) expect(json).not.toContain(leak)
  })

  it('a dependency environment carries only the host links its page items use', async () => {
    const f = await makeConfigFixture()
    const spare = addSpare(f)
    expect(ids(buildConfigExport(f.db, clock, 'products').file.hosts)).toContain(spare)
    for (const segment of ['tunnels', 'deployments'] as const) {
      const { file } = buildConfigExport(f.db, clock, segment)
      expect(ids(file.hosts), segment).toEqual([f.host.id, f.ids.bastion].sort())
      const links = file.environments.find((e) => e.id === f.staging.id)!.hosts.map((m) => m.hostId)
      expect(links, segment).toContain(f.host.id)
      expect(links, segment).not.toContain(spare)
    }
  })

  it('a failed segment export is audited with its segment', async () => {
    const f = await makeConfigFixture()
    const path = join(mkdtempSync(join(tmpdir(), 'credops-segment-')), 'missing-dir', 'credops-tunnels.json')
    await expect(exportConfig(exportDeps(f), path, 'tunnels')).rejects.toThrow("Couldn't write the config file")
    await expect(exportConfig(exportDeps(f), path)).rejects.toThrow("Couldn't write the config file")
    const entries = f.audit.list({ actions: ['config.export'] })
    expect(entries.map((e) => e.outcome)).toEqual(['failure', 'failure'])
    expect(entries.map((e) => e.details)).toEqual(expect.arrayContaining([{}, { segment: 'tunnels' }]))
  })

  it('a direct export keeps the full file when no segment is given', async () => {
    const f = await makeConfigFixture()
    const path = tmpPath()
    await exportConfig(exportDeps(f), path)
    const [e] = f.audit.list({ actions: ['config.export'] })
    expect(e.details).not.toHaveProperty('segment')
  })
})

describe('config segment import', () => {
  it('adds the missing dependencies of the page items, and says so', async () => {
    const { f, file } = await source()
    const t = await target(f)
    const { plan } = importSegment(t, file, 'tunnels')
    expect(itemOf(plan, 'tunnels', 'pg')).toMatchObject({ action: 'add' })
    expect(itemOf(plan, 'hosts', 'app1')).toMatchObject({ action: 'add', notes: [DEPENDENCY_ADDED] })
    expect(itemOf(plan, 'environments', 'staging')).toMatchObject({ action: 'add', notes: [DEPENDENCY_ADDED] })
    expect(itemOf(plan, 'products', 'Shop')).toMatchObject({ action: 'add', notes: [DEPENDENCY_ADDED] })
    // The region is here already, under the same id.
    expect(itemOf(plan, 'regions', 'test-1')).toMatchObject({ action: 'unchanged', notes: [DEPENDENCY_KEPT] })
    expect(t.tunnels.get(f.ids.tunnel)).toMatchObject({ hostId: f.host.id, environmentId: f.staging.id })
    expect(t.envs.get(f.staging.id).hosts).toContainEqual({ hostId: f.host.id, role: 'app' })
  })

  it('never changes a dependency that is already here', async () => {
    const { f, file } = await source()
    const t = await target(f)
    // app1 and staging are here, both different from the file's.
    const app1 = t.hosts.create({ regionId: REGION, label: 'app1', address: '10.9.9.9', notes: 'mine' })
    const shop = t.products.create({ name: 'Shop', color: '#000000', icon: 'boxes', description: 'local' })
    const staging = t.envs.create({ productId: shop.id, name: 'staging', color: '#ffffff' })
    t.envs.putHost(staging.id, app1.id, 'app')
    const before = Object.fromEntries(['hosts', 'products', 'environments'].map((x) => [x, rows(t.db, x)]))
    const { plan } = importSegment(t, file, 'tunnels')
    for (const [kind, name] of [
      ['hosts', 'app1'],
      ['products', 'Shop'],
      ['environments', 'staging'],
    ]) {
      expect(itemOf(plan, kind, name), name).toMatchObject({ action: 'unchanged', notes: [DEPENDENCY_KEPT] })
      expect(itemOf(plan, kind, name)!.fields).toBeUndefined()
    }
    expect(plan.counts.update).toBe(0)
    // bastion is missing: added, but the existing staging is not linked to it.
    expect(itemOf(plan, 'hosts', 'bastion')).toMatchObject({ action: 'add' })
    expect(rows(t.db, 'products')).toBe(before.products)
    expect(rows(t.db, 'environments')).toBe(before.environments)
    expect(t.db.prepare('SELECT address, notes, jump_host_id FROM hosts WHERE id = ?').get(app1.id)).toEqual({ address: '10.9.9.9', notes: 'mine', jump_host_id: null })
    expect(t.envs.get(staging.id).hosts).toEqual([{ hostId: app1.id, role: 'app' }])
    // The tunnel lands on the local objects.
    expect(t.tunnels.get(f.ids.tunnel)).toMatchObject({ hostId: app1.id, environmentId: staging.id })
  })

  it('updates the page items themselves exactly as the full import does', async () => {
    const f = await makeConfigFixture()
    const file = JSON.parse(JSON.stringify(buildConfigExport(f.db, clock).file)) as ConfigFile
    file.tunnels[0].bindPort = 15433
    file.hosts.find((h) => h.label === 'app1')!.notes = 'changed in the file'
    const { plan } = importSegment(f, file, 'tunnels')
    expect(itemOf(plan, 'tunnels', 'pg')).toMatchObject({ action: 'update', fields: ['bindPort'] })
    expect(itemOf(plan, 'hosts', 'app1')).toMatchObject({ action: 'unchanged', notes: [DEPENDENCY_KEPT] })
    expect(f.tunnels.get(f.ids.tunnel).bindPort).toBe(15433)
    expect(f.db.prepare('SELECT notes FROM hosts WHERE id = ?').get(f.host.id)).toEqual({ notes: 'primary app box' })
  })

  it('ignores the objects that are neither the page kinds nor needed by them, and counts them', async () => {
    const { f, file } = await source()
    const t = await target(f)
    const plan = planImport(t.db, file, 'tunnels')
    // prod, Fixture (prod's product), the checkout and all four services (two of them host placeholders).
    expect(plan.ignored).toBe(7)
    for (const kind of ['deployments', 'services'] as const) expect(plan.items.some((i) => i.kind === kind)).toBe(false)
    expect(itemOf(plan, 'environments', 'prod')).toBeUndefined()
    // A full import says nothing about ignored objects.
    expect(planImport(t.db, file)).not.toHaveProperty('ignored')
  })

  it('a full file imported on a page changes only that page kinds and adds only missing dependencies', async () => {
    const { f, file } = await source()
    const t = await target(f)
    const before = Object.fromEntries(tables.map((x) => [x, rows(t.db, x)]))
    importSegment(t, file, 'deployments')
    expect(ids(t.db.prepare('SELECT id FROM deployments').all() as { id: string }[])).toEqual([f.ids.deployment])
    // No service from the file comes in. The staging it adds as a dependency brings its hosts, and a host is in an
    // environment by running a service there: a placeholder named after the host, outside any checkout.
    expect(before.services).toBe('[]')
    expect(t.db.prepare('SELECT s.name, s.kind, s.deployment_id, s.environment_id, h.label FROM services s JOIN hosts h ON h.id = s.host_id ORDER BY s.name').all()).toEqual([
      { name: 'app1', kind: 'service', deployment_id: null, environment_id: f.staging.id, label: 'app1' },
      { name: 'bastion', kind: 'bastion', deployment_id: null, environment_id: f.staging.id, label: 'bastion' },
    ])
    for (const id of [f.ids.appService, f.ids.dbService]) expect(t.db.prepare('SELECT 1 FROM services WHERE id = ?').get(id)).toBeUndefined()
    expect(rows(t.db, 'tunnels')).toBe(before.tunnels)
    expect(t.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(f.prod.id)).toBeUndefined()
    // Fixture was here already: untouched.
    expect(t.db.prepare('SELECT name FROM products ORDER BY name').all()).toEqual([{ name: 'Fixture' }, { name: 'Shop' }])
    expect(rows(t.db, 'regions')).toBe(before.regions)
  })

  it('a full file imported on a page adds none of the hosts its items do not use', async () => {
    for (const segment of ['tunnels', 'deployments'] as const) {
      let spare = ''
      const { f, file } = await source((src) => (spare = addSpare(src)))
      const t = await target(f)
      const { plan } = importSegment(t, file, segment)
      expect(itemOf(plan, 'hosts', 'spare'), segment).toBeUndefined()
      expect(t.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(spare), segment).toBeUndefined()
      expect(t.envs.get(f.staging.id).hosts.map((m) => m.hostId), segment).toContain(f.host.id)
    }
  })

  it('skips a dependency checkout that is in another environment here, rather than failing the preview', async () => {
    const { f, file } = await source()
    const t = await target(f)
    importSegment(t, file, 'deployments')
    // The checkout here has since moved to another environment; the file's web service uses it in staging.
    const other = t.envs.create({ productId: PRODUCT, name: 'other', color: '#ffffff' })
    t.db.prepare('UPDATE deployments SET environment_id = ? WHERE id = ?').run(other.id, f.ids.deployment)
    const plan = planImport(t.db, file, 'products')
    expect(itemOf(plan, 'deployments', 'api')).toMatchObject({ action: 'skip', reason: "can't move to another environment or host" })
    // As in a full import, the service comes without its checkout.
    expect(itemOf(plan, 'services', 'web')).toMatchObject({ action: 'add' })
  })

  it('a version 1 file on the Tunnels page adds no Unassigned product for an environment already here', async () => {
    const { f, file } = await source()
    const t = await target(f)
    importSegment(t, file, 'tunnels')
    t.db.prepare('DELETE FROM tunnels').run()
    const raw = JSON.parse(serializeConfig(file))
    raw.version = 1
    delete raw.regions
    for (const h of raw.hosts) delete h.regionId
    for (const e of raw.environments) {
      e.productIds = e.id === f.staging.id ? [] : [e.productId]
      delete e.productId
    }
    const parsed = parseConfigFile(JSON.stringify(raw))
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
    const { plan } = importSegment(t, parsed.file, 'tunnels')
    expect(itemOf(plan, 'environments', 'staging')).toMatchObject({ action: 'unchanged', notes: [DEPENDENCY_KEPT] })
    expect(itemOf(plan, 'tunnels', 'pg')).toMatchObject({ action: 'add' })
    expect(t.db.prepare("SELECT 1 FROM products WHERE name = 'Unassigned'").get()).toBeUndefined()
  })

  it('skips a page item whose dependency here cannot take it, with a reason', async () => {
    const { f, file } = await source()
    const t = await target(f)
    // staging is here without app1, and an existing dependency is never changed: the tunnel can't join it.
    const shop = t.products.create({ name: 'Shop', color: '#000000', icon: 'boxes' })
    t.envs.create({ productId: shop.id, name: 'staging', color: '#ffffff' })
    const { plan } = importSegment(t, file, 'tunnels')
    expect(itemOf(plan, 'tunnels', 'pg')).toMatchObject({ action: 'skip', reason: "its host isn't in that environment here" })
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM tunnels').get()).toEqual({ n: 0 })
  })

  it('a segment file imports in Settings like any config file', async () => {
    const { f } = await source()
    const t = await target(f)
    const file = buildConfigExport(f.db, clock, 'tunnels').file
    const plan = planImport(t.db, file)
    applyImport({ db: t.db, audit: t.audit, vault: t.vault }, file, { typedNames: [], expected: plan.counts })
    expect(t.tunnels.get(f.ids.tunnel).hostId).toBe(f.host.id)
    expect(plan.items.every((i) => i.notes === undefined || !i.notes.includes(DEPENDENCY_KEPT))).toBe(true)
  })

  it('opens and applies a page import over IPC, auditing counts and the segment only', async () => {
    const { f, file } = await source()
    const t = await target(f)
    const path = tmpPath()
    writeFileSync(path, serializeConfig(file))
    const h = createConfigHandlers({ ...exportDeps(t), saveDialog: async () => undefined, openDialog: async () => path })
    const preview = await h['config:importOpen']('tunnels')
    if (!preview || 'errors' in preview) throw new Error('expected a preview')
    expect(preview.ignored).toBe(7)
    // The token belongs to the tunnels page.
    await expect(h['config:importApply'](preview.token, { typedNames: [] }, 'hosts')).rejects.toThrow('The preview expired; open the file again')
    const again = await h['config:importOpen']('tunnels')
    if (!again || 'errors' in again) throw new Error('expected a preview')
    const res = await h['config:importApply'](again.token, { typedNames: [] }, 'tunnels')
    expect(res.counts).toEqual(again.counts)
    const [e] = t.audit.list({ actions: ['config.import'] })
    expect(e.details).toEqual({ counts: again.counts, unresolved: res.needsSecret.length, segment: 'tunnels' })
    const json = JSON.stringify(e)
    for (const leak of [path, 'app1', 'bastion', 'pg', 'staging', 'Shop', '10.0.0.7', f.host.id]) expect(json).not.toContain(leak)
  })

  it('the validators accept a known segment and reject any other', () => {
    expect(() => VALIDATORS['config:export'](['hosts'])).not.toThrow()
    expect(() => VALIDATORS['config:export']([])).not.toThrow()
    expect(() => VALIDATORS['config:importOpen'](['tunnels'])).not.toThrow()
    expect(() => VALIDATORS['config:importApply'](['a'.repeat(32), { typedNames: [] }, 'deployments'])).not.toThrow()
    expect(() => VALIDATORS['config:importDiscard'](['a'.repeat(32), 'products'])).not.toThrow()
    for (const bad of ['vaults', 'HOSTS', '', 5, null]) {
      expect(() => VALIDATORS['config:export']([bad])).toThrow()
      expect(() => VALIDATORS['config:importOpen']([bad])).toThrow()
      expect(() => VALIDATORS['config:importApply'](['a'.repeat(32), { typedNames: [] }, bad])).toThrow()
      expect(() => VALIDATORS['config:importDiscard'](['a'.repeat(32), bad])).toThrow()
    }
  })
})
