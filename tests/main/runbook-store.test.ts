import { describe, expect, it } from 'vitest'
import { RunbookStore } from '../../src/main/deploy/runbook-store'
import type { RunbookInput } from '../../src/shared/runbooks'
import { makeDeployFixture } from './deploy-helpers'
import { auditRows } from './vault-helpers'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'

const ACTOR = { osUser: 'ana', machine: 'mbp' }

async function setup() {
  const f = await makeDeployFixture()
  const checkout = f.deploys.create(f.input({ name: 'webapp' }))
  const svc = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'web', deploymentId: checkout.id })
  const store = new RunbookStore({ db: f.db, audit: f.audit, vault: f.vault })
  const input = (over: Partial<RunbookInput> = {}): RunbookInput => ({
    environmentId: f.staging.id,
    name: 'Restart web',
    description: 'bounce it',
    targetServiceIds: [svc.id],
    items: [
      { type: 'builtin', builtin: 'restart' },
      {
        type: 'step',
        step: {
          id: 'c_1', name: 'warm', run: 'shell', service: null, script: 'echo TOPSECRETSCRIPT', cwd: null, sudo: 'docker', timeoutSec: 60,
          onFailure: 'stop', when: { kind: 'always' }, secrets: [],
        },
      },
    ],
    params: [{ name: 'count', label: 'Count', type: 'text', pattern: 'number', choices: [] }],
    lock: true,
    notify: false,
    ...over,
  })
  return { ...f, store, svc, input }
}

describe('RunbookStore', () => {
  it('round-trips create, get, list, update and delete', async () => {
    const f = await setup()
    const r = f.store.create(f.input(), ACTOR)
    expect(f.store.get(r.id)).toEqual(r)
    expect(f.store.list(f.staging.id)).toEqual([r])
    expect(f.store.list(f.prod.id)).toEqual([])
    const u = f.store.update(r.id, f.input({ name: 'Restart all', params: [] }), ACTOR)
    expect(u).toMatchObject({ id: r.id, name: 'Restart all', params: [], environmentId: f.staging.id, createdAt: r.createdAt })
    f.store.delete(r.id, ACTOR)
    expect(f.store.list(f.staging.id)).toEqual([])
    expect(() => f.store.get(r.id)).toThrow('runbook not found')
  })

  it('forces the lock on a runbook that changes things', async () => {
    const f = await setup()
    expect(f.store.create(f.input({ lock: false }), ACTOR).lock).toBe(true)
  })

  it('keeps names unique per environment, ignoring case', async () => {
    const f = await setup()
    f.store.create(f.input(), ACTOR)
    expect(() => f.store.create(f.input({ name: 'restart WEB' }), ACTOR)).toThrow(/already exists/)
    const other = f.store.create(f.input({ name: 'Other' }), ACTOR)
    expect(() => f.store.update(other.id, f.input({ name: 'Restart web' }), ACTOR)).toThrow(/already exists/)
    expect(f.store.update(other.id, f.input({ name: 'Other' }), ACTOR).name).toBe('Other')
  })

  it('refuses an unknown environment or a service from another environment', async () => {
    const f = await setup()
    expect(() => f.store.create(f.input({ environmentId: '00000000-0000-4000-8000-000000000000' }), ACTOR)).toThrow('environment not found')
    expect(() => f.store.create(f.input({ environmentId: f.prod.id }), ACTOR)).toThrow(/not in this environment/)
  })

  it('audits names and counts only, and notifies', async () => {
    const f = await setup()
    const changed: string[] = []
    f.store.onChanged = (e) => changed.push(e)
    const r = f.store.create(f.input(), ACTOR)
    f.store.update(r.id, f.input(), ACTOR)
    f.store.delete(r.id, ACTOR)
    const events = f.audit.list({ actions: ['runbook.create', 'runbook.update', 'runbook.delete'] })
    expect(events.map((e) => e.action).sort()).toEqual(['runbook.create', 'runbook.delete', 'runbook.update'])
    for (const e of events) {
      expect(e).toMatchObject({ targetType: 'runbook', targetId: r.id, targetLabel: 'Restart web', details: { items: 2, params: 1, services: 1 } })
    }
    expect(auditRows(f.db)).not.toContain('TOPSECRETSCRIPT')
    expect(changed).toEqual([f.staging.id, f.staging.id, f.staging.id])
  })

  it('cascades with its environment', async () => {
    const f = await setup()
    f.store.create(f.input(), ACTOR)
    f.db.exec('PRAGMA foreign_keys = ON')
    f.db.prepare('DELETE FROM environments WHERE id = ?').run(f.staging.id)
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM runbooks').get() as { n: number }).n).toBe(0)
  })

  it('limits step secrets to the vaults of the environment\'s checkouts', async () => {
    const f = await setup()
    const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
    const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
    const foreign = f.vault.createVault({ name: 'ProdOnly', color: '#112233' })
    const prodSecret = secrets.create({ vaultId: foreign.id, name: 'prodtoken', kind: 'env', value: 'prod-value-1' })
    const dep = (over: object) => ({ name: 'x', environmentId: f.staging.id, hostId: f.host.id, repoPath: '/srv/a', defaultBranch: 'main', deployTag: 'deploy_staging', ...over })
    f.deploys.create(dep({ name: 'prodapp', environmentId: f.prod.id, vaultIds: [foreign.id] }))
    f.deploys.create(dep({ name: 'stagingvault', vaultIds: [DEFAULT_VAULT_ID] }))
    const withSecret = (secretId: string) =>
      f.input({
        items: [{ type: 'step', step: { id: 'c_1', name: 'x', run: 'shell', service: null, script: 'echo', cwd: null, sudo: 'docker', timeoutSec: 60, onFailure: 'stop', when: { kind: 'always' }, secrets: [{ envName: 'TOKEN', secretId }] } }],
      })
    expect(() => f.store.create(withSecret(prodSecret.id), ACTOR)).toThrow(/secret/)
    expect(f.store.create(withSecret(f.secretId), ACTOR).items).toHaveLength(1)
  })
})
