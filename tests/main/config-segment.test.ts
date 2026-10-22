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
const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'opsdeck-segment-')), 'opsdeck-config.json')
const tables = ['regions', 'products', 'identities', 'hosts', 'environments', 'environment_hosts', 'tunnels', 'deployments', 'services']
const rows = (db: Db, table: string): string => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all())

/** The config fixture without its password identity: every ref in it can resolve elsewhere. */
async function source(): Promise<{ f: ConfigFixture; file: ConfigFile }> {
  const f = await makeConfigFixture()
  f.identities.delete(f.ids.passwordIdentity)
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
    expect(ids(file.services)).toEqual([f.ids.appService, f.ids.dbService].sort())
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
    // prod, Fixture (prod's product), the checkout and both services.
    expect(plan.ignored).toBe(5)
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
    expect(rows(t.db, 'services')).toBe(before.services)
    expect(rows(t.db, 'tunnels')).toBe(before.tunnels)
    expect(t.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(f.prod.id)).toBeUndefined()
    // Fixture was here already: untouched.
    expect(t.db.prepare('SELECT name FROM products ORDER BY name').all()).toEqual([{ name: 'Fixture' }, { name: 'Shop' }])
    expect(rows(t.db, 'regions')).toBe(before.regions)
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
    expect(preview.ignored).toBe(5)
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
