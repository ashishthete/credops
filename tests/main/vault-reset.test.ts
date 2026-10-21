import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/connection'
import { SecretStore } from '../../src/main/vault/secret-store'
import type { QuickUnlockDeps } from '../../src/main/vault/vault-service'
import { DEFAULT_VAULT_ID, VAULT_RESET_CONFIRM } from '../../src/shared/vault'
import { parseEnvTemplate } from '../../src/shared/deploy'
import { SETTINGS } from '../../src/shared/settings'
import { makeDeployFixture } from './deploy-helpers'
import { makeInventory, type InventoryFixture, REGION } from './inventory-helpers'
import { auditRows, makeVault } from './vault-helpers'

const PW = 'correct horse'
const SECRET_VALUE = 'hunter2-super-secret'
const ID_PASSWORD = 'identity-pw-9000'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** Fake safeStorage and Touch ID: nothing reaches the real keychain. */
function fakeQuick(): QuickUnlockDeps {
  return {
    keychain: {
      available: () => true,
      encrypt: (plain) => Buffer.from(`kc:${[...plain].reverse().join('')}`, 'utf8'),
      decrypt: (blob) => [...blob.toString('utf8').slice(3)].reverse().join(''),
    },
    touchId: { available: () => true, prompt: async () => undefined },
  }
}

interface Seeded {
  f: InventoryFixture
  hostId: string
  plainHostId: string
  envId: string
  productId: string
  otherVaultId: string
}

/** A tmp-file DB with secrets, keys and identities in two vaults, and inventory that uses them. */
async function seeded(): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-reset-'))
  dirs.push(dir)
  const f = await makeInventory({ db: openDatabase(join(dir, 'opsdeck.db')), quick: fakeQuick() })
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard: f.clipboard ?? { async writeText() {}, async readText() { return '' } } })
  const other = f.vault.createVault({ name: 'Work', color: '#336699' })
  secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'db', kind: 'password', value: SECRET_VALUE })
  secrets.create({ vaultId: other.id, name: 'tok', kind: 'token', value: 'tok-value-1234' })
  const key = f.keys.generate({ vaultId: DEFAULT_VAULT_ID, label: 'deploy key' })
  const keyed = f.identities.create({ vaultId: DEFAULT_VAULT_ID, label: 'ops', username: 'ops', auth: 'key', sshKeyId: key.id })
  const pwId = f.identities.create({
    vaultId: other.id,
    label: 'root',
    username: 'root',
    auth: 'password',
    password: ID_PASSWORD,
  })
  const product = f.products.create({ name: 'Shop', color: '#112233', icon: 'boxes' })
  const env = f.envs.create({ name: 'prod', color: '#445566', defaultIdentityId: pwId.id, productId: product.id })
  const host = f.hosts.create({
    regionId: REGION,
    label: 'web-1',
    address: '10.0.0.1',
    identityId: keyed.id,
    vaultIds: [DEFAULT_VAULT_ID, other.id],
    environments: [{ environmentId: env.id, role: 'app' }],
  })
  const plain = f.hosts.create({ regionId: REGION, label: 'web-2', address: '10.0.0.2' })
  f.tunnels.create({ label: 'pg', hostId: host.id, type: 'L', bindPort: 15432, targetHost: 'localhost', targetPort: 5432 })
  f.vault.setQuickUnlock('touchId')
  f.vault.lock('manual')
  return { f, hostId: host.id, plainHostId: plain.id, envId: env.id, productId: product.id, otherVaultId: other.id }
}

const count = (f: InventoryFixture, table: string): number =>
  Number((f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)

/** What a failed or refused reset must leave exactly as it was. */
const vaultMaterial = (f: InventoryFixture) => ({
  secrets: count(f, 'secrets'),
  keys: count(f, 'ssh_keys'),
  identities: count(f, 'identities'),
  wrapped: f.db.prepare('SELECT id, wrapped_key, kdf_params FROM vaults ORDER BY id').all(),
  state: f.db.prepare('SELECT quick_unlock, quick_unlock_blob FROM vault_state WHERE id = 1').get(),
  hostIdentities: f.db.prepare('SELECT id, identity_id FROM hosts ORDER BY id').all(),
})

const resetRows = (f: InventoryFixture) =>
  f.audit
    .list({ limit: 1000 })
    .filter((e) => e.action === 'vault.reset')
    .map((e) => ({ outcome: e.outcome, details: e.details }))

describe('VaultService.reset', () => {
  it('clears every deploy and integration reference to a secret, so none dangles', async () => {
    const f = await makeDeployFixture()
    const ref = `\${secret:${f.secretId}}`
    const template = `# api, was A=${ref}\nTOKEN=${ref}\r\nDB_PASSWORD=${ref}\nPORT=8080\nNOTE=keep \${secret:x} inline\n`
    const withRefs = f.deploys.create(
      f.input({ becomeSecretId: f.secretId, managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: template }),
    )
    const plain = f.deploys.create(f.input({ name: 'web', managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: 'PORT=80\n' }))
    // Looks like a reference only in a comment and inside a value: not one, so the .env stays managed.
    const literal = `# OLD=${ref}\nNOTE=a \${secret:x} b\n`
    const lookalike = f.deploys.create(f.input({ name: 'lit', managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: literal }))
    const created = new Date(f.now.t).toISOString()
    f.db
      .prepare('INSERT INTO environment_integrations(environment_id, teams_webhook_secret_id, updated_at) VALUES (?, ?, ?)')
      .run(f.staging.id, f.secretId, created)
    const put = f.db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)')
    for (const key of [SETTINGS.aiApiKeySecretId, SETTINGS.sendgridApiKeySecretId, SETTINGS.githubTokenSecretId])
      put.run(key, JSON.stringify(f.secretId), created)
    put.run(SETTINGS.sendgridFrom, JSON.stringify('ops@example.com'), created)
    f.vault.lock('manual')
    f.now.t += 60_000
    const resetAt = new Date(f.now.t).toISOString()

    await f.vault.reset(VAULT_RESET_CONFIRM)

    const row = (id: string) =>
      f.db.prepare('SELECT become_secret_id, managed_env, env_template, updated_at FROM deployments WHERE id = ?').get(id) as {
        become_secret_id: string | null
        managed_env: number
        env_template: string
        updated_at: string
      }
    // updated_at moved: the explicit clears ran, not just the FKs' ON DELETE SET NULL.
    const stripped = `# api, was A=${ref}\nTOKEN=\r\nDB_PASSWORD=\nPORT=8080\nNOTE=keep \${secret:x} inline\n`
    expect(row(withRefs.id)).toEqual({ become_secret_id: null, managed_env: 0, env_template: stripped, updated_at: resetAt })
    // Still a valid template, so the deployment can be edited and saved as it is.
    expect(parseEnvTemplate(stripped)).toMatchObject({ secretIds: [], errors: [] })
    // Templates with no secret reference keep their managed .env, untouched.
    expect(row(plain.id)).toMatchObject({ managed_env: 1, env_template: 'PORT=80\n' })
    expect(row(lookalike.id)).toMatchObject({ managed_env: 1, env_template: literal })
    expect(row(plain.id).updated_at).not.toBe(resetAt)
    expect(row(lookalike.id).updated_at).not.toBe(resetAt)
    // Vault links stay, as a host's do: the vaults outlive a reset.
    expect(count(f, 'deployment_vaults')).toBe(3)
    expect(f.db.prepare('SELECT teams_webhook_secret_id, updated_at FROM environment_integrations').all()).toEqual([
      { teams_webhook_secret_id: null, updated_at: resetAt },
    ])
    expect(f.db.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([{ key: SETTINGS.sendgridFrom }])
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(resetRows(f)[0].details).toMatchObject({ deployRefs: 2, managedEnvOff: 1, integrationRefs: 4 })
    const dump = JSON.stringify(['deployments', 'environment_integrations', 'settings'].map((t) => f.db.prepare(`SELECT * FROM ${t}`).all()))
    expect(dump).not.toContain('sekret-value-1')
  })

  it('while locked erases every secret, keeps the inventory and clears its references', async () => {
    const { f, hostId, plainHostId, envId, productId, otherVaultId } = await seeded()
    const { quick_unlock_blob: blob } = f.db.prepare('SELECT quick_unlock_blob FROM vault_state WHERE id = 1').get() as {
      quick_unlock_blob: string | null
    }
    expect(blob).toBeTruthy()
    const status = await f.vault.reset(VAULT_RESET_CONFIRM)
    expect(status).toMatchObject({ setUp: false, unlocked: false, quickUnlock: 'off', retryAfterMs: 0 })

    for (const table of ['secrets', 'ssh_keys', 'identities']) expect(count(f, table)).toBe(0)
    const vaults = f.db.prepare('SELECT id, wrapped_key, kdf_params FROM vaults ORDER BY name').all() as {
      id: string
      wrapped_key: string | null
      kdf_params: string | null
    }[]
    expect(vaults.map((v) => v.id).sort()).toEqual([DEFAULT_VAULT_ID, otherVaultId].sort())
    for (const v of vaults) expect(v).toMatchObject({ wrapped_key: null, kdf_params: null })

    // Inventory kept, vault references cleared.
    const host = f.hosts.list().find((h) => h.id === hostId)!
    expect(host).toMatchObject({ label: 'web-1', address: '10.0.0.1', identityId: null })
    expect([...host.vaultIds].sort()).toEqual([DEFAULT_VAULT_ID, otherVaultId].sort())
    expect(f.hosts.list().find((h) => h.id === plainHostId)?.label).toBe('web-2')
    expect(f.envs.list().find((e) => e.id === envId)).toMatchObject({ name: 'prod', defaultIdentityId: null, productId })
    expect(f.products.list().find((p) => p.id === productId)?.name).toBe('Shop')
    expect(count(f, 'environment_hosts')).toBe(1)
    expect(count(f, 'tunnels')).toBe(1)
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])

    // No ciphertext or secret left anywhere in the DB.
    const dump = JSON.stringify(
      ['vaults', 'hosts', 'environments', 'vault_state'].map((t) => f.db.prepare(`SELECT * FROM ${t}`).all()),
    )
    expect(dump).not.toContain(SECRET_VALUE)
    expect(dump).not.toContain(blob)
  })

  it('leaves the vaults not set up, and a new setup works', async () => {
    const { f, otherVaultId } = await seeded()
    await f.vault.reset(VAULT_RESET_CONFIRM)
    expect(f.vault.status().setUp).toBe(false)
    await expect(f.vault.unlock(PW)).rejects.toThrow(/not set up/)
    expect(await f.vault.setup('a brand new password')).toMatchObject({ setUp: true, unlocked: true, corruptVaultIds: [] })
    // Every kept vault is keyed again and usable.
    for (const id of [DEFAULT_VAULT_ID, otherVaultId]) {
      expect(f.vault.open(id, 'a', f.vault.seal(id, 'a', 'v'))).toBe('v')
    }
    f.vault.lock('manual')
    expect(await f.vault.unlock('a brand new password')).toEqual({ ok: true })
  })

  it('refuses a wrong confirmation and changes nothing', async () => {
    const { f } = await seeded()
    for (const bad of ['reset', 'RESET ', '', 'yes']) {
      await expect(f.vault.reset(bad)).rejects.toThrow(/type RESET/)
    }
    expect(count(f, 'secrets')).toBe(2)
    expect(f.vault.status()).toMatchObject({ setUp: true, quickUnlock: 'touchId' })
    expect(resetRows(f)).toEqual([])
  })

  it('refuses while unlocked', async () => {
    const { f } = await seeded()
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    await expect(f.vault.reset(VAULT_RESET_CONFIRM)).rejects.toThrow(/unlocked/)
    expect(f.vault.isUnlocked()).toBe(true)
    expect(count(f, 'secrets')).toBe(2)
    expect(f.vault.status().setUp).toBe(true)
    expect(resetRows(f)).toEqual([])
  })

  it('rolls back everything when a statement inside the transaction fails', async () => {
    const { f } = await seeded()
    const before = vaultMaterial(f)
    expect(before.wrapped.every((v) => (v as { wrapped_key: unknown }).wrapped_key !== null)).toBe(true)
    // Fails the unkeying, after the deletes have run.
    f.db.exec("CREATE TRIGGER fail_unkey BEFORE UPDATE OF wrapped_key ON vaults BEGIN SELECT RAISE(ABORT, 'disk on fire'); END")
    await expect(f.vault.reset(VAULT_RESET_CONFIRM)).rejects.toThrow('disk on fire')
    expect(vaultMaterial(f)).toEqual(before)
    expect(f.vault.status()).toMatchObject({ setUp: true, quickUnlock: 'touchId' })
    expect(resetRows(f)).toEqual([])
    f.db.exec('DROP TRIGGER fail_unkey')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
  })

  it('a failed audit append rolls the erase back with it', async () => {
    const { f } = await seeded()
    const before = vaultMaterial(f)
    f.db.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'vault.reset' BEGIN SELECT RAISE(ABORT, 'audit full'); END",
    )
    await expect(f.vault.reset(VAULT_RESET_CONFIRM)).rejects.toThrow('audit full')
    expect(vaultMaterial(f)).toEqual(before)
    expect(f.vault.status().setUp).toBe(true)
    expect(f.audit.verifyChain().ok).toBe(true)
  })

  it('queues behind an unlock in flight, then refuses as unlocked and erases nothing', async () => {
    const { f } = await seeded()
    const before = vaultMaterial(f)
    const unlocking = f.vault.unlock(PW)
    const resetting = f.vault.reset(VAULT_RESET_CONFIRM)
    await expect(resetting).rejects.toThrow(/unlocked/)
    expect(await unlocking).toEqual({ ok: true })
    expect(f.vault.isUnlocked()).toBe(true)
    expect(vaultMaterial(f)).toEqual(before)
    expect(resetRows(f)).toEqual([])
  })

  it('on a never-set-up install does nothing and audits nothing', async () => {
    const { vault, audit } = makeVault()
    const status = await vault.reset(VAULT_RESET_CONFIRM)
    expect(status).toMatchObject({ setUp: false, unlocked: false })
    expect(audit.list({ actions: ['vault.reset'] })).toEqual([])
  })

  it('audits counts only, and keeps the audit log', async () => {
    const { f } = await seeded()
    const before = count(f, 'audit_events')
    await f.vault.reset(VAULT_RESET_CONFIRM)
    // 2 vaults; 2 secrets + 1 key + 2 identities.
    expect(resetRows(f)).toEqual([{ outcome: 'success', details: { vaults: 2, items: 5, deployRefs: 0, managedEnvOff: 0, integrationRefs: 0 } }])
    expect(count(f, 'audit_events')).toBe(before + 1)
    expect(f.audit.verifyChain().ok).toBe(true)
    const rows = auditRows(f.db)
    expect(rows).not.toContain(SECRET_VALUE)
    expect(rows).not.toContain(ID_PASSWORD)
  })

  it('clears the quick-unlock blob and resets the backoff', async () => {
    const { f } = await seeded()
    for (let i = 0; i < 4; i++) await f.vault.unlock('wrong password!')
    expect(f.vault.status().retryAfterMs).toBeGreaterThan(0)
    const before = f.db.prepare('SELECT quick_unlock_blob FROM vault_state WHERE id = 1').get() as {
      quick_unlock_blob: string | null
    }
    expect(before.quick_unlock_blob).not.toBeNull()

    await f.vault.reset(VAULT_RESET_CONFIRM)
    expect(f.db.prepare('SELECT quick_unlock, quick_unlock_blob, failed_attempts, last_failed_at FROM vault_state').get()).toEqual({
      quick_unlock: 'off',
      quick_unlock_blob: null,
      failed_attempts: 0,
      last_failed_at: null,
    })
    expect(f.vault.status()).toMatchObject({ quickUnlock: 'off', retryAfterMs: 0 })
    expect(await f.vault.unlockQuick().catch((e: Error) => e.message)).toMatch(/not set up/)
  })
})
