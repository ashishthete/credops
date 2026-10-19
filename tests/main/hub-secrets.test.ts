import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { HubPublisher } from '../../src/main/hub/publish'
import { resolveHost } from '../../src/main/inventory/resolve'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import { SecretStore } from '../../src/main/vault/secret-store'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture } from './deploy-helpers'
import { auditRows } from './vault-helpers'

const SUDO_PW = 'sudo-pw-plaintext-9'
const UUID = '11111111-1111-4111-8111-111111111111'

async function setup(opts: { locked?: boolean } = {}) {
  const f = await makeDeployFixture()
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-hsec-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const sudo = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'sudo', kind: 'password', value: SUDO_PW })
  f.deploys.create(f.input({ environmentId: f.prod.id, managedEnv: true, envTemplate: `DB=\${secret:${f.secretId}}\n`, becomeSecretId: sudo.id, vaultIds: [DEFAULT_VAULT_ID] }))
  const put = vi.fn(async (_p: string, _b: unknown) => undefined)
  const get = vi.fn(async (_p: string, _q?: unknown) => ({ secrets: [], missing: { [f.prod.id]: [{ secretId: sudo.id, name: 'sudo' }] } }))
  const vault = opts.locked ? { assertUnlocked: () => { throw new Error('Vault is locked') } } : f.vault
  const pub = new HubPublisher({
    db: f.db,
    envs: f.envs,
    deploys: f.deploys,
    knownHosts,
    secrets,
    values: secrets,
    resolve: (hostId, environmentId) => resolveHost(f.db, hostId, environmentId, { localUser: 'tester' }),
    audit: f.audit,
    vault,
    client: () => ({ put: put as never, get: get as never, del: vi.fn() }),
    hubId: () => 'hub-1',
  })
  return { f, pub, put, get, sudo, secrets }
}

describe('uploadSecrets', () => {
  it('uploads from the local vault without the value crossing IPC', async () => {
    const { f, pub, put, sudo } = await setup()
    const res = await pub.uploadSecrets(f.prod.id)
    // The result carries a count only.
    expect(res).toEqual({ uploaded: 1 })
    expect(JSON.stringify(res)).not.toContain(SUDO_PW)
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toBe(`/api/v1/admin/secrets/${sudo.id}`)
    expect(put.mock.calls[0][1]).toEqual({ environmentId: f.prod.id, name: 'sudo', kind: 'become', value: SUDO_PW })
    const rows = auditRows(f.db)
    expect(rows).toContain('hub.secret.set')
    expect(rows).not.toContain(SUDO_PW)
    const row = f.db.prepare("SELECT target_label, details FROM audit_events WHERE action = 'hub.secret.set'").get() as { target_label: string; details: string }
    expect(JSON.parse(row.details)).toEqual({ name: 'sudo', environmentId: f.prod.id })
  })

  it('selected ids must belong to the environment; explicit ids re-upload', async () => {
    const { f, pub, put, get, secrets } = await setup()
    await expect(pub.uploadSecrets(f.prod.id, [UUID])).rejects.toThrow('A selected secret is not used by this environment')
    const res = await pub.uploadSecrets(f.prod.id, [f.secretId])
    expect(res).toEqual({ uploaded: 1 })
    expect(get).not.toHaveBeenCalled()
    expect(put.mock.calls[0][1]).toMatchObject({ name: secrets.list().find((s) => s.id === f.secretId)?.name, kind: 'env' })
  })

  it('refuses when the vault is locked, with no request and no audit', async () => {
    const { f, pub, put, get } = await setup({ locked: true })
    await expect(pub.uploadSecrets(f.prod.id)).rejects.toThrow('Vault is locked')
    await expect(pub.setIntegrationSecret(null, 'sendgrid_api_key', UUID)).rejects.toThrow('Vault is locked')
    expect(put).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(auditRows(f.db)).not.toContain('hub.secret.set')
  })

  it('a failed upload audits nothing for that secret', async () => {
    const { f, pub, put } = await setup()
    put.mockRejectedValueOnce(new Error('boom'))
    await expect(pub.uploadSecrets(f.prod.id)).rejects.toThrow('boom')
    expect(auditRows(f.db)).not.toContain('hub.secret.set')
  })
})

describe('setIntegrationSecret', () => {
  it('reads the local secret in main and names the integration', async () => {
    const { f, pub, put, sudo } = await setup()
    await pub.setIntegrationSecret(f.prod.id, 'teams_webhook', sudo.id)
    const [path, body] = put.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toMatch(/^\/api\/v1\/admin\/secrets\/[0-9a-f-]{36}$/)
    expect(body).toEqual({ environmentId: f.prod.id, name: 'teams_webhook', kind: 'teams_webhook', value: SUDO_PW })
    const row = f.db.prepare("SELECT details FROM audit_events WHERE action = 'hub.secret.set'").get() as { details: string }
    expect(row.details).not.toContain(SUDO_PW)
    await expect(pub.setIntegrationSecret(null, 'sendgrid_api_key', UUID)).rejects.toThrow('That secret no longer exists')
  })
})

describe('secret IPC validators', () => {
  it('accept ids and kinds only; none takes a value', () => {
    expect(VALIDATORS['hub:secrets']([null])).toEqual([null])
    expect(VALIDATORS['hub:secrets']([UUID])).toEqual([UUID])
    expect(VALIDATORS['hub:uploadSecrets']([UUID, [UUID]])).toEqual([UUID, [UUID]])
    expect(VALIDATORS['hub:setIntegrationSecret']([null, 'github_token', UUID])).toEqual([null, 'github_token', UUID])
    expect(VALIDATORS['hub:deleteSecret']([UUID])).toEqual([UUID])
    expect(VALIDATORS['hub:deployKey']([UUID, true])).toEqual([UUID, true])
    expect(() => VALIDATORS['hub:setIntegrationSecret']([null, 'env', UUID])).toThrow()
    expect(() => VALIDATORS['hub:setIntegrationSecret']([null, 'github_token', 'not-an-id'])).toThrow()
    expect(() => VALIDATORS['hub:uploadSecrets'](['nope'])).toThrow()
    expect(() => VALIDATORS['hub:deployKey']([UUID, 'yes'])).toThrow()
    expect(() => VALIDATORS['hub:deployKey']([UUID])).toThrow()
  })
})
