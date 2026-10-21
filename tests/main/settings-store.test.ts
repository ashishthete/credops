import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_VAULT_ID, type SecretKind } from '../../src/shared/vault'
import { auditRows, makeVault } from './vault-helpers'

async function setup() {
  const f = makeVault()
  await f.vault.setup({ password: 'correct horse', touchId: true })
  const clipboard = { text: '', async writeText(t: string) { this.text = t }, async readText() { return this.text } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const store = new SettingsStore({ db: f.db, audit: f.audit, vault: f.vault, secrets, platform: 'darwin' })
  const secret = (kind: SecretKind, name = `s-${kind}`) =>
    secrets.create({ vaultId: DEFAULT_VAULT_ID, name, kind, value: `value-of-${name}-hunter22` })
  return { f, secrets, store, secret }
}

describe('SettingsStore', () => {
  it('returns defaults', async () => {
    const { store } = await setup()
    expect(store.get()).toEqual({
      aiModel: 'claude-opus-5-5',
      aiApiKeySecretId: null,
      sendgridApiKeySecretId: null,
      sendgridFrom: null,
      githubTokenSecretId: null,
      macos: true,
      macosUnscoped: true,
    })
    expect(store.status()).toEqual({ ai: { configured: false, model: 'claude-opus-5-5' }, sendgrid: false, github: false, macosSupported: true })
  })

  it('update persists and audits key names only', async () => {
    const { f, store, secret, secrets } = await setup()
    const key = secret('api_key')
    const seen: unknown[] = []
    store.onChange((s) => seen.push(s.aiModel))
    store.update({ aiModel: 'claude-sonnet-5-5' })
    const after = store.update({ aiApiKeySecretId: key.id, sendgridFrom: 'ops@example.com' })
    expect(after).toMatchObject({ aiModel: 'claude-sonnet-5-5', aiApiKeySecretId: key.id, sendgridFrom: 'ops@example.com' })
    expect(new SettingsStore({ db: f.db, audit: f.audit, vault: f.vault, secrets }).get().aiModel).toBe('claude-sonnet-5-5')
    const events = f.audit.list({ actions: ['settings.update'] }).reverse()
    expect(events.map((e) => e.details)).toEqual([{ fields: ['aiModel'] }, { fields: ['aiApiKeySecretId', 'sendgridFrom'] }])
    expect(auditRows(f.db)).not.toContain('ops@example.com')
    expect(JSON.stringify(events)).not.toContain(key.id)
    expect(seen).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
    // An unchanged patch writes nothing.
    store.update({ aiModel: 'claude-sonnet-5-5' })
    expect(f.audit.list({ actions: ['settings.update'] })).toHaveLength(2)
    expect(store.status().ai.configured).toBe(true)
  })

  it('rejects a secret of the wrong kind', async () => {
    const { store, secret } = await setup()
    const pw = secret('password')
    expect(() => store.update({ aiApiKeySecretId: pw.id })).toThrow('that secret is a password; pick a api_key')
    expect(() => store.update({ githubTokenSecretId: secret('api_key').id })).toThrow('that secret is a api_key; pick a token')
    expect(() => store.update({ sendgridApiKeySecretId: '0190a1b2-c3d4-7e5f-8a6b-1234567890ab' })).toThrow('secret not found')
    expect(store.get().aiApiKeySecretId).toBeNull()
  })

  it('rejects a bad model', async () => {
    const { store } = await setup()
    for (const m of ['gpt-4', 'claude-', 'Claude-opus', `claude-${'a'.repeat(70)}`, 'claude-x y']) {
      expect(() => store.update({ aiModel: m })).toThrow('model must look like claude-…')
    }
    let err: Error | undefined
    try {
      store.update({ sendgridFrom: 'not-an-email-hunter22' })
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toBe('from address must be an email address')
  })

  it('dangling secret reads as not configured', async () => {
    const { store, secrets, secret } = await setup()
    const ai = secret('api_key', 'ai')
    const sg = secret('api_key', 'sg')
    const gh = secret('token')
    store.update({ aiApiKeySecretId: ai.id, sendgridApiKeySecretId: sg.id, sendgridFrom: 'ops@example.com', githubTokenSecretId: gh.id })
    expect(store.status()).toMatchObject({ ai: { configured: true }, sendgrid: true, github: true })
    secrets.delete(ai.id)
    secrets.delete(gh.id)
    expect(store.status()).toMatchObject({ ai: { configured: false }, sendgrid: true, github: false })
    expect(store.get().aiApiKeySecretId).toBeNull()
  })

  it('needs the vault unlocked', async () => {
    const { f, store } = await setup()
    f.vault.lock('manual')
    expect(() => store.update({ macos: false })).toThrow(/locked/i)
    expect(store.get().macos).toBe(true)
  })
})
