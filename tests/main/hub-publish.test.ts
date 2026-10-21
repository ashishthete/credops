import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { EnvironmentIntegrations } from '../../src/shared/settings'
import { HUB_TOO_OLD_MESSAGE, HubPublisher, buildManifest, toHubIntegrations } from '../../src/main/hub/publish'
import { resolveHost } from '../../src/main/inventory/resolve'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import type { HubEnvManifest } from '../../src/shared/hub'
import { RunbookStore } from '../../src/main/deploy/runbook-store'
import type { Step } from '../../src/shared/steps'
import { hubReadManifest } from './hub-fixture'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture, type DeployFixture } from './deploy-helpers'
import { auditRows } from './vault-helpers'
import { generateKey } from './ssh-server'

const SUDO_PW = 'sudo-pw-plaintext-9'

function pubKey(): { type: string; b64: string } {
  const parsed = generateKey('ed25519').public
  return { type: parsed.type, b64: parsed.getPublicSSH().toString('base64') }
}

async function setup() {
  const f: DeployFixture = await makeDeployFixture()
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-pub-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  const bastion = f.hosts.create({ label: 'bastion', address: '203.0.113.9', port: 2222 })
  f.hosts.update(f.host.id, { jumpHostId: bastion.id })
  f.envs.putHost(f.prod.id, bastion.id, 'bastion')
  const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const sudo = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'sudo', kind: 'password', value: SUDO_PW })
  f.deploys.create(
    f.input({ environmentId: f.prod.id, managedEnv: true, envTemplate: `DB=\${secret:${f.secretId}}\n`, becomeSecretId: sudo.id, vaultIds: [DEFAULT_VAULT_ID] }),
  )
  const trust = (address: string, port: number): void => {
    const k = pubKey()
    knownHosts.trust(address, port, k.type, k.b64)
  }
  const deps = {
    db: f.db,
    envs: f.envs,
    deploys: f.deploys,
    services: f.services,
    knownHosts,
    secrets,
    resolve: (hostId: string, environmentId: string) => resolveHost(f.db, hostId, environmentId, { localUser: 'tester' }),
  }
  return { f, deps, trust, secrets, sudo }
}

describe('buildManifest', () => {
  it('builds a manifest with hops and pinned host keys', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    const m = await buildManifest(f.prod.id, deps)
    expect(m.environment).toMatchObject({ id: f.prod.id, name: 'prod', protected: true })
    expect(m.hosts).toHaveLength(1)
    const h = m.hosts[0]
    expect(h).toMatchObject({ id: f.host.id, label: 'app1', address: '10.0.0.7', port: 22, username: 'tester' })
    expect(h.hops.map((x) => [x.label, x.address, x.port])).toEqual([
      ['bastion', '203.0.113.9', 2222],
      ['app1', '10.0.0.7', 22],
    ])
    expect(h.hops[h.hops.length - 1].hostId).toBe(f.host.id)
    expect(h.knownHosts).toHaveLength(2)
    expect(h.knownHosts.some((l) => l.startsWith('[203.0.113.9]:2222 ssh-ed25519 '))).toBe(true)
    expect(h.knownHosts.some((l) => l.startsWith('10.0.0.7 ssh-ed25519 '))).toBe(true)
    expect(m.deployments).toHaveLength(1)
    expect(m.requiredSecrets.map((s) => s.name).sort()).toEqual(['envsecret', 'sudo'])
  })

  it('refuses a hop with no pinned key', async () => {
    const { f, deps, trust } = await setup()
    trust('10.0.0.7', 22)
    await expect(buildManifest(f.prod.id, deps)).rejects.toThrow('Connect to bastion once from OpsDeck so its host key is pinned, then publish')
  })

  it('refuses a host with a password identity', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    const id = f.identities.create({ vaultId: DEFAULT_VAULT_ID, label: 'pw', username: 'ops', auth: 'password', password: 'x' })
    f.hosts.update(f.host.id, { identityId: id.id })
    await expect(buildManifest(f.prod.id, deps)).rejects.toThrow('Deploys need key or agent auth; "app1" uses a password')
  })

  it('carries services: checkout host for a service, via-host for a db', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    const dep = f.deploys.list(f.prod.id)[0]
    const web = f.services.create({ kind: 'service', environmentId: f.prod.id, name: 'web', deploymentId: dep.id, composeService: 'web' })
    const loose = f.services.create({ kind: 'service', environmentId: f.prod.id, name: 'loose', deploymentId: null })
    const db = f.services.create({ kind: 'db', environmentId: f.prod.id, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9', viaHostId: f.host.id })
    const m = await buildManifest(f.prod.id, deps)
    const byName = Object.fromEntries(m.services.map((s) => [s.name, s]))
    expect(byName.web).toEqual({ id: web.id, name: 'web', kind: 'service', composeService: 'web', deploymentId: dep.id, hostId: f.host.id, viaHostId: null })
    expect(byName.loose).toMatchObject({ id: loose.id, deploymentId: null, hostId: null })
    expect(byName['main-db']).toEqual({ id: db.id, name: 'main-db', kind: 'db', composeService: null, deploymentId: null, hostId: null, viaHostId: f.host.id })
    expect(m.deployments[0]).toHaveProperty('composeProject')
    expect(m.deployments[0]).toHaveProperty('repoUrl')
  })

  it('publishes a db via-host that runs no checkout', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    trust('10.0.0.50', 22)
    const via = f.hosts.create({ label: 'jump2', address: '10.0.0.50', port: 22 })
    f.envs.putHost(f.prod.id, via.id, 'db')
    f.services.create({ kind: 'db', environmentId: f.prod.id, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9', viaHostId: via.id })
    const m = await buildManifest(f.prod.id, deps)
    expect(m.hosts.map((h) => h.id)).toContain(via.id)
    expect(m.services[0].viaHostId).toBe(via.id)
  })

  it('a repository URL with credentials is never published or echoed', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    const dep = f.deploys.list(f.prod.id)[0]
    const url = 'https://ghp_secrettoken123@github.com/acme/web.git'
    f.db.prepare('UPDATE deployments SET repo_url = ? WHERE id = ?').run(url, dep.id)
    const err = await buildManifest(f.prod.id, deps).then(
      () => null,
      (e: Error) => e,
    )
    expect(err?.message).toContain(`"${dep.name}"`)
    expect(err?.message).not.toContain('ghp_secrettoken123')
    expect(err?.message).not.toContain('github.com')
    const put = vi.fn(async () => ({ manifestHash: 'x', missingSecrets: [] }))
    const pub = new HubPublisher({ ...deps, audit: f.audit, vault: f.vault, client: () => ({ put: put as never, del: vi.fn() }), hubId: () => 'hub-1' })
    await expect(pub.publish(f.prod.id)).rejects.toThrow(/embedded credentials/)
    expect(put).not.toHaveBeenCalled()
    expect(JSON.stringify(auditRows(f.db))).not.toContain('ghp_secrettoken123')
    for (const bad of ['ssh://user:pw-fake-1@github.com/acme/web.git', 'HTTPS://tok-fake-2@github.com/acme/web.git']) {
      f.db.prepare('UPDATE deployments SET repo_url = ? WHERE id = ?').run(bad, dep.id)
      const e2 = await buildManifest(f.prod.id, deps).then(() => null, (e: Error) => e)
      expect(e2?.message, bad).toContain('embedded credentials')
      expect(e2?.message).not.toMatch(/fake-\d/)
    }
    // A plain URL, and an ssh user without a password, publish and ride in the manifest.
    f.db.prepare('UPDATE deployments SET repo_url = ? WHERE id = ?').run('git@github.com:acme/web.git', dep.id)
    expect((await buildManifest(f.prod.id, deps)).deployments[0].repoUrl).toBe('git@github.com:acme/web.git')
  })

  it('manifest contains no secret values', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    const text = JSON.stringify(await buildManifest(f.prod.id, deps))
    expect(text).not.toContain(SUDO_PW)
    expect(text).not.toContain('sekret-value-1')
  })
})

describe('HubPublisher', () => {
  it('publish records hub_env_links and audits', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    f.db.prepare("INSERT INTO hub_link(id, url, hub_id, hub_name, linked_at, updated_at) VALUES (1,'http://127.0.0.1:1','hub-1','Hub','t','t')").run()
    const put = vi.fn(async (_path: string, _body: unknown) => ({ manifestHash: 'abc123', missingSecrets: ['s1'] }))
    const del = vi.fn(async () => undefined)
    const changed = vi.fn()
    const pub = new HubPublisher({ ...deps, audit: f.audit, vault: f.vault, client: () => ({ put: put as never, del }), hubId: () => 'hub-1', now: () => new Date(Date.UTC(2026, 0, 2)), onChanged: changed })
    const res = await pub.publish(f.prod.id)
    expect(res).toEqual({ manifestHash: 'abc123', missingSecrets: ['s1'] })
    expect(put.mock.calls[0][0]).toBe(`/api/v1/admin/environments/${f.prod.id}`)
    const body = put.mock.calls[0][1] as HubEnvManifest
    expect(body.environment.id).toBe(f.prod.id)
    expect(f.db.prepare('SELECT * FROM hub_env_links').all()).toEqual([
      { environment_id: f.prod.id, hub_id: 'hub-1', published_at: '2026-01-02T00:00:00.000Z', manifest_hash: 'abc123' },
    ])
    const rows = auditRows(f.db)
    expect(rows).toContain('hub.publish')
    expect(rows).not.toContain(SUDO_PW)
    const row = f.db.prepare("SELECT target_label, details FROM audit_events WHERE action = 'hub.publish'").get() as { target_label: string; details: string }
    expect(row.target_label).toBe('prod')
    expect(JSON.parse(row.details)).toEqual({ manifestHash: 'abc123', hosts: 1, deployments: 1, missing: 1 })
    expect(changed).toHaveBeenCalled()

    await pub.unpublish(f.prod.id)
    expect(del).toHaveBeenCalledWith(`/api/v1/admin/environments/${f.prod.id}`)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM hub_env_links').get()).toEqual({ n: 0 })
    expect(auditRows(f.db)).toContain('hub.unpublish')
  })

  it('a failed PUT leaves no link and no audit', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    const put = vi.fn(async () => {
      throw new Error('boom')
    })
    const pub = new HubPublisher({ ...deps, audit: f.audit, vault: f.vault, client: () => ({ put: put as never, del: vi.fn() }), hubId: () => 'hub-1' })
    await expect(pub.publish(f.prod.id)).rejects.toThrow('boom')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM hub_env_links').get()).toEqual({ n: 0 })
    expect(auditRows(f.db)).not.toContain('hub.publish')
  })
})

describe('toHubIntegrations', () => {
  it('a published manifest carries the local notify events and recipients, no secret id and no value', async () => {
    const { f, deps, trust } = await setup()
    trust('203.0.113.9', 2222)
    trust('10.0.0.7', 22)
    const local = {
      environmentId: f.prod.id,
      notifyEvents: ['release.failed'],
      teamsWebhookSecretId: 'secret-id-of-the-teams-webhook',
      emailTo: ['ops@example.com'],
      emailCc: ['lead@example.com'],
      qaOnDeploy: true,
      qa: { repo: 'acme/web', workflow: 'qa.yml', ref: 'main' },
      qaWait: true,
      updatedAt: '2026-10-01T00:00:00.000Z',
    } as unknown as EnvironmentIntegrations
    const m = await buildManifest(f.prod.id, { ...deps, integrations: () => toHubIntegrations(local) })
    expect(m.integrations).toEqual({ notifyEvents: ['release.failed'], emailTo: ['ops@example.com'], emailCc: ['lead@example.com'], qaOnDeploy: true, qa: { repo: 'acme/web', workflow: 'qa.yml', ref: 'main' }, qaWait: true })
    expect(JSON.stringify(m)).not.toContain('secret-id-of-the-teams-webhook')
    // an environment with a wait time publishes it; one without publishes the same qa object as before
    const withWait = toHubIntegrations({ ...local, qa: { repo: 'acme/web', workflow: 'qa.yml', ref: 'main', waitMinutes: 90 } })
    expect(withWait.qa).toEqual({ repo: 'acme/web', workflow: 'qa.yml', ref: 'main', waitMinutes: 90 })
    expect(Object.keys(toHubIntegrations(local).qa as object)).toEqual(['repo', 'workflow', 'ref'])
    expect(JSON.stringify(m)).not.toContain('updatedAt')
  })
})

const step = (over: Partial<Step> = {}): Step => ({
  id: 'c_1', name: 'migrate', run: 'shell', service: null, script: 'echo TOPSECRETSCRIPT', cwd: null, sudo: 'docker', timeoutSec: 600,
  onFailure: 'stop', when: { kind: 'always' }, secrets: [], anchor: 'after_up', alsoOnRollback: false, ...over,
})

describe('buildManifest by Hub schema', () => {
  async function ready(trustAll = true) {
    const s = await setup()
    if (trustAll) {
      s.trust('203.0.113.9', 2222)
      s.trust('10.0.0.7', 22)
    }
    const dep = s.f.deploys.list(s.f.prod.id)[0]
    return { ...s, dep }
  }

  it('schema 1 with only hooks publishes preHook and postHook and no steps', async () => {
    const { f, deps, dep } = await ready()
    f.deploys.update(dep.id, { preHook: 'echo pre', postHook: 'echo post' })
    const m = await buildManifest(f.prod.id, deps, { hubSchema: 1 })
    expect(m.schema).toBeUndefined()
    expect(m.deployments[0]).toMatchObject({ preHook: 'echo pre', postHook: 'echo post' })
    expect(m.deployments[0].steps).toBeUndefined()
    expect(m.runbooks).toBeUndefined()
  })

  it('schema 1 with a custom step, a flow or a runbook throws HUB_TOO_OLD', async () => {
    const { f, deps, dep } = await ready()
    const svc = f.services.create({ kind: 'service', environmentId: f.prod.id, name: 'web', deploymentId: dep.id })
    f.deploys.update(dep.id, { steps: [step()] })
    await expect(buildManifest(f.prod.id, deps, { hubSchema: 1 })).rejects.toThrow(HUB_TOO_OLD_MESSAGE)
    f.deploys.update(dep.id, { steps: [] })
    await expect(buildManifest(f.prod.id, deps, { hubSchema: 1 })).resolves.toBeDefined()
    f.deploys.updateSettings(f.prod.id, { flow: { stages: [{ kind: 'services', serviceIds: [svc.id] }], onFailure: 'stop-all' } })
    await expect(buildManifest(f.prod.id, deps, { hubSchema: 1 })).rejects.toThrow(HUB_TOO_OLD_MESSAGE)
    f.deploys.updateSettings(f.prod.id, { flow: null })
    const runbooks = new RunbookStore({ db: f.db, audit: f.audit, vault: f.vault })
    runbooks.create({ environmentId: f.prod.id, name: 'Restart', description: '', targetServiceIds: [svc.id], items: [{ type: 'builtin', builtin: 'restart' }], params: [], lock: true, notify: false }, { osUser: 'a', machine: 'm' })
    await expect(buildManifest(f.prod.id, { ...deps, runbooks }, { hubSchema: 1 })).rejects.toThrow(HUB_TOO_OLD_MESSAGE)
  })

  it('schema 2 round-trips steps, flow, prepare settings, skipUnchanged and runbooks through the Hub readManifest', async () => {
    const { f, deps, dep, sudo } = await ready()
    const svc = f.services.create({ kind: 'service', environmentId: f.prod.id, name: 'web', deploymentId: dep.id, skipUnchanged: true })
    f.deploys.update(dep.id, { steps: [step({ secrets: [{ envName: 'TOKEN', secretId: sudo.id }] })] })
    f.deploys.updateSettings(f.prod.id, { parallelPrepare: false, prepareCap: 2, flow: { stages: [{ kind: 'services', serviceIds: [svc.id] }], onFailure: 'continue-other-hosts' } })
    const runbooks = new RunbookStore({ db: f.db, audit: f.audit, vault: f.vault })
    runbooks.create({ environmentId: f.prod.id, name: 'Restart', description: 'd', targetServiceIds: [svc.id], items: [{ type: 'builtin', builtin: 'restart' }], params: [], lock: true, notify: false }, { osUser: 'a', machine: 'm' })
    const m = await buildManifest(f.prod.id, { ...deps, runbooks }, { hubSchema: 2 })
    expect(m.schema).toBe(2)
    expect(m.environment).toMatchObject({ parallelPrepare: false, prepareCap: 2 })
    expect(m.services.find((s) => s.id === svc.id)?.skipUnchanged).toBe(true)
    expect(m.deployments[0].steps).toEqual([step({ secrets: [{ envName: 'TOKEN', secretId: sudo.id }] })])
    expect(m.runbooks).toHaveLength(1)
    expect(m.runbooks?.[0]).not.toHaveProperty('environmentId')
    const readManifest = await hubReadManifest()
    const back = readManifest(JSON.parse(JSON.stringify(m)))
    expect(back.environment.flow?.onFailure).toBe('continue-other-hosts')
    expect(back.deployments[0].steps).toHaveLength(1)
    expect(back.runbooks?.[0].name).toBe('Restart')
    expect(JSON.stringify(m)).not.toContain(SUDO_PW)
  })

  it('schema 2 sends migrated hooks as steps with the hooks cleared', async () => {
    const { f, deps, dep } = await ready()
    f.deploys.update(dep.id, { preHook: 'echo pre' })
    const readManifest = await hubReadManifest()
    const m = await buildManifest(f.prod.id, deps, { hubSchema: 2 })
    expect(m.deployments[0]).toMatchObject({ preHook: null, postHook: null })
    expect(m.deployments[0].steps?.map((x) => x.id)).toEqual(['pre-hook'])
    expect(() => readManifest(JSON.parse(JSON.stringify(m)))).not.toThrow()
  })

  it('requiredSecrets includes step, flow and runbook secrets', async () => {
    const { f, deps, dep, secrets } = await ready()
    const extra = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'stepsecret', kind: 'password', value: 'step-value-77' })
    const svc = f.services.create({ kind: 'service', environmentId: f.prod.id, name: 'web', deploymentId: dep.id })
    f.deploys.update(dep.id, { steps: [step({ secrets: [{ envName: 'TOKEN', secretId: extra.id }] })] })
    const m = await buildManifest(f.prod.id, deps, { hubSchema: 2 })
    expect(m.requiredSecrets.map((r) => r.name).sort()).toEqual(['envsecret', 'stepsecret', 'sudo'])
    expect(m.requiredSecrets.find((r) => r.name === 'stepsecret')?.usedBy).toEqual([dep.name])
    expect(JSON.stringify(m)).not.toContain('step-value-77')
    void svc
  })
})

describe('HubPublisher by Hub capabilities', () => {
  async function publisher(get: ((path: string) => Promise<unknown>) | undefined) {
    const s = await setup()
    s.trust('203.0.113.9', 2222)
    s.trust('10.0.0.7', 22)
    const dep = s.f.deploys.list(s.f.prod.id)[0]
    s.f.deploys.update(dep.id, { steps: [step()] })
    const put = vi.fn(async (_p: string, _b: unknown) => ({ manifestHash: 'h', missingSecrets: [] }))
    const pub = new HubPublisher({ ...s.deps, audit: s.f.audit, vault: s.f.vault, client: () => ({ put: put as never, del: vi.fn(), ...(get ? { get: get as never } : {}) }), hubId: () => 'hub-1' })
    return { ...s, pub, put }
  }

  it('reads /meta first and publishes schema 2 to a Hub that supports it', async () => {
    const get = vi.fn(async (_p: string) => ({ capabilities: { manifestSchema: 2, playbookEdits: false } }))
    const { f, pub, put } = await publisher(get)
    await pub.publish(f.prod.id)
    expect(get).toHaveBeenCalledWith('/api/v1/meta')
    expect((put.mock.calls[0][1] as HubEnvManifest).schema).toBe(2)
  })

  it('counts a Hub with no capabilities as schema 1 and refuses a custom step before sending', async () => {
    const { f, pub, put } = await publisher(async () => ({ hubId: 'x' }))
    await expect(pub.publish(f.prod.id)).rejects.toThrow(HUB_TOO_OLD_MESSAGE)
    expect(put).not.toHaveBeenCalled()
    expect(auditRows(f.db)).not.toContain('hub.publish')
  })

  it('counts a client that cannot get as schema 1', async () => {
    const { f, pub, put } = await publisher(undefined)
    await expect(pub.publish(f.prod.id)).rejects.toThrow(HUB_TOO_OLD_MESSAGE)
    expect(put).not.toHaveBeenCalled()
  })
})
