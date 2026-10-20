import { describe, expect, it } from 'vitest'
import { IntegrationStore } from '../../src/main/settings/integration-store'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_NOTIFY_EVENTS, NOTIFY_EVENTS } from '../../src/shared/settings'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeInventory } from './inventory-helpers'
import { auditRows } from './vault-helpers'

async function setup() {
  const f = await makeInventory()
  const clipboard = { text: '', async writeText(t: string) { this.text = t }, async readText() { return this.text } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const store = new IntegrationStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const env = (name: string) => f.envs.create({ name, color: '#aabbcc' })
  return { f, secrets, store, env }
}

const QA = { repo: 'acme/app', workflow: 'qa.yml', ref: 'main' }

describe('IntegrationStore', () => {
  it('defaults exclude release.started', async () => {
    const { store, env } = await setup()
    const e = env('staging')
    expect(DEFAULT_NOTIFY_EVENTS).toEqual(NOTIFY_EVENTS.filter((k) => k !== 'release.started'))
    expect(store.get(e.id)).toEqual({
      environmentId: e.id,
      notifyEvents: DEFAULT_NOTIFY_EVENTS,
      teamsWebhookSecretId: null,
      emailTo: [],
      emailCc: [],
      qaOnDeploy: false,
      qa: null,
      qaWait: false,
      updatedAt: null,
    })
    expect(() => store.get('0190a1b2-c3d4-7e5f-8a6b-1234567890ab')).toThrow('environment not found')
  })

  it('qaOnDeploy defaults off for prod, uat and uat_eu', async () => {
    const { store, env } = await setup()
    for (const name of ['prod', 'UAT', 'uat_eu', 'staging']) {
      const e = env(name)
      const saved = store.update(e.id, { qa: QA })
      expect([name, saved.qaOnDeploy]).toEqual([name, name === 'staging'])
      expect(store.forEnvironment(e.id).qa).toEqual(QA)
    }
  })

  it('round-trips recipients and QA workflow', async () => {
    const { store, env, secrets } = await setup()
    const e = env('prod')
    const hook = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'teams', kind: 'webhook', value: 'https://hook.example/x' })
    const saved = store.update(e.id, {
      notifyEvents: ['release.failed', 'release.started'],
      teamsWebhookSecretId: hook.id,
      emailTo: [' A@Example.com ', 'b@example.com'],
      emailCc: ['c@example.com'],
      qa: { repo: 'acme/app', workflow: '12345', ref: 'release/1.2' },
      qaOnDeploy: true,
      qaWait: true,
    })
    expect(saved).toMatchObject({
      notifyEvents: ['release.started', 'release.failed'],
      teamsWebhookSecretId: hook.id,
      emailTo: ['A@Example.com', 'b@example.com'],
      emailCc: ['c@example.com'],
      qa: { repo: 'acme/app', workflow: '12345', ref: 'release/1.2' },
      qaOnDeploy: true,
      qaWait: true,
    })
    expect(store.get(e.id)).toEqual(saved)
    expect(store.update(e.id, { qa: null }).qa).toBeNull()
    expect(() => store.update(e.id, { teamsWebhookSecretId: secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'pw', kind: 'password', value: 'x' }).id })).toThrow(
      'that secret is a password; pick a webhook',
    )
  })

  it('rejects bad email without echoing it', async () => {
    const { store, env } = await setup()
    const e = env('prod')
    const cases: [Parameters<IntegrationStore['update']>[1], string][] = [
      [{ emailTo: ['not-an-address-hunter22'] }, 'email address is not valid'],
      [{ emailCc: ['a@b'] }, 'email address is not valid'],
      [{ emailTo: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) }, 'at most 20 recipients'],
      [{ qa: { ...QA, repo: 'acme' } }, 'repo must be owner/name'],
      [{ qa: { ...QA, workflow: '../qa.yml' } }, 'workflow must be a file name like qa.yml or a numeric id'],
      [{ qa: { ...QA, ref: '  ' } }, 'ref is required'],
    ]
    for (const [patch, message] of cases) {
      let err: Error | undefined
      try {
        store.update(e.id, patch)
      } catch (x) {
        err = x as Error
      }
      expect(err?.message).toBe(message)
    }
    expect(store.get(e.id).updatedAt).toBeNull()
  })

  it('rejects unknown event', async () => {
    const { store, env } = await setup()
    const e = env('prod')
    expect(() => store.update(e.id, { notifyEvents: ['release.exploded' as never] })).toThrow('unknown notify event')
  })

  it('audits integration.update with field names and recipient counts only', async () => {
    const { f, store, env } = await setup()
    const e = env('prod')
    store.update(e.id, { emailTo: ['ops@example.com', 'dev@example.com'], qaWait: true })
    store.update(e.id, { emailTo: ['ops@example.com', 'dev@example.com'] })
    const events = f.audit.list({ actions: ['integration.update'] })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      targetType: 'environment',
      targetId: e.id,
      targetLabel: 'prod',
      details: { fields: ['emailTo', 'qaWait'], emailTo: 2, emailCc: 0 },
    })
    expect(auditRows(f.db)).not.toContain('example.com')
  })

  it('needs the vault unlocked and cascades with the environment', async () => {
    const { f, store, env } = await setup()
    const e = env('prod')
    store.update(e.id, { qaWait: true })
    f.envs.delete(e.id)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM environment_integrations').get()).toEqual({ n: 0 })
    const e2 = env('uat')
    f.vault.lock('manual')
    expect(() => store.update(e2.id, { qaWait: true })).toThrow(/locked/i)
    expect(store.get(e2.id).qaWait).toBe(false)
  })
})
