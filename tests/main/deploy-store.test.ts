import { describe, expect, it } from 'vitest'
import { asDeploymentInput, asDeploymentPatch, asEnvDeploySettingsPatch } from '../../src/main/ipc/validators'
import { InvalidArgs } from '../../src/main/ipc/validate'
import { MAX_DEPLOYMENTS } from '../../src/shared/deploy'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture } from './deploy-helpers'
import { auditRows } from './vault-helpers'

describe('DeployStore', () => {
  it('creates a deployment with defaults and audits without paths', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input())
    expect(d).toMatchObject({
      composeFile: 'docker-compose.yml',
      urls: [],
      healthStatus: 200,
      healthTimeoutSec: 60,
      buildTimeoutSec: 300,
      composeTimeoutSec: 120,
      useSudo: 'auto',
      dbBackup: false,
      managedEnv: false,
      repoUrl: null,
      composeProject: null,
      vaultIds: [],
      position: 0,
    })
    expect(f.deploys.get(d.id)).toEqual(d)
    expect(f.deploys.list(f.staging.id)).toEqual([d])
    const [e] = f.audit.list({ actions: ['deploy.create'] })
    expect(e).toMatchObject({ targetType: 'deployment', targetId: d.id, targetLabel: 'api', details: { environment: 'staging' } })
    expect(auditRows(f.db)).not.toContain('/srv')
    expect(f.changed).toEqual([f.staging.id])
  })

  it('rejects unsafe tokens without echoing them', async () => {
    const f = await makeDeployFixture()
    const bad: [Partial<ReturnType<typeof f.input>>, string][] = [
      [{ name: '  ' }, 'deployment name must be 1-64 characters'],
      [{ hostId: '00000000-0000-4000-8000-000000000000' }, 'host not found'],
      [{ repoPath: 'srv/app;rm -rf' }, 'repo path must be an absolute path without spaces or shell characters'],
      [{ defaultBranch: 'a;b' }, "branch isn't a valid git branch name"],
      [{ deployTag: 'x y' }, "deploy tag isn't a valid git tag name"],
      [{ composeFile: '../x$HOME.yml' }, 'compose file must be a relative path inside the repo'],
      [{ dbBackup: true }, 'backup dir is required when DB backup is on'],
      [{ dbBackup: true, backupDir: '/b;x' }, 'backup dir must be an absolute path without spaces or shell characters'],
      [{ urls: [{ url: 'https://ok.example', from: 'host' }, { url: 'https://u:p@x.example', from: 'host' }] }, 'url 2 must be http(s) without credentials'],
      [{ urls: [{ url: 'ftp://x', from: 'mac' }] }, 'url 1 must be http(s) without credentials'],
      [{ urls: Array.from({ length: 9 }, () => ({ url: 'https://a.example', from: 'host' as const })) }, 'too many urls (8)'],
      [{ preHook: 'x'.repeat(4001) }, 'hook is too long (4000)'],
      [{ becomeSecretId: '00000000-0000-4000-8000-000000000000' }, 'become secret not found'],
      [{ healthStatus: 42 }, 'health status must be 100-599'],
      [{ useSudo: 'maybe' as never }, 'use sudo must be auto, yes or no'],
    ]
    for (const [over, msg] of bad) {
      let err: Error | undefined
      try {
        f.deploys.create(f.input(over))
      } catch (e) {
        err = e as Error
      }
      expect(err?.message, JSON.stringify(over).slice(0, 60)).toBe(msg)
      for (const val of ['rm -rf', 'u:p@', '$HOME', 'a;b']) expect(err!.message).not.toContain(val)
    }
    expect(f.deploys.list()).toEqual([])
  })

  it('checks the host is in the environment', async () => {
    const f = await makeDeployFixture()
    const other = f.hosts.create({ label: 'lonely', address: '10.0.0.8' })
    expect(() => f.deploys.create(f.input({ hostId: other.id }))).toThrow("host isn't in that environment")
  })

  it('checkout stores repoUrl and composeProject', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input({ repoUrl: 'git@github.com:acme/webapp.git', composeProject: 'webapp_stg' }))
    expect(d).toMatchObject({ repoUrl: 'git@github.com:acme/webapp.git', composeProject: 'webapp_stg' })
    expect(f.deploys.get(d.id)).toEqual(d)
    const u = f.deploys.update(d.id, { repoUrl: 'https://github.com/acme/webapp', composeProject: null })
    expect(u).toMatchObject({ repoUrl: 'https://github.com/acme/webapp', composeProject: null })
    const [e] = f.audit.list({ actions: ['deploy.update'] })
    expect((e.details as { fields: string[] }).fields.sort()).toEqual(['composeProject', 'repoUrl'])
    expect(f.deploys.update(d.id, { repoUrl: 'ssh://git@host/acme.git' }).repoUrl).toBe('ssh://git@host/acme.git')
    expect(f.deploys.update(d.id, { repoUrl: '  ' }).repoUrl).toBeNull()
    expect(auditRows(f.db)).not.toContain('github.com')
  })

  it('bad repoUrl and composeProject are refused', async () => {
    const f = await makeDeployFixture()
    const bad: [Partial<ReturnType<typeof f.input>>, string][] = [
      [{ repoUrl: 'ftp://x/y' }, 'repository URL must be an http(s), ssh:// or git@ URL without spaces'],
      [{ repoUrl: 'git@host:a b' }, 'repository URL must be an http(s), ssh:// or git@ URL without spaces'],
      [{ repoUrl: 'https://' + 'x'.repeat(2048) }, 'repository URL must be an http(s), ssh:// or git@ URL without spaces'],
      [{ composeProject: '--rm' }, 'compose project must be letters, digits, dashes, dots or underscores'],
      [{ composeProject: 'x;rm' }, 'compose project must be letters, digits, dashes, dots or underscores'],
      [{ composeProject: 'a b' }, 'compose project must be letters, digits, dashes, dots or underscores'],
    ]
    for (const [over, msg] of bad) expect(() => f.deploys.create(f.input(over)), JSON.stringify(over).slice(0, 60)).toThrow(msg)
    expect(f.deploys.list()).toEqual([])
    const d = f.deploys.create(f.input())
    expect(() => f.deploys.update(d.id, { composeProject: '-p' })).toThrow('compose project must be letters')
  })

  it('deploy.* audit details carry the environment name and no host label', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input())
    f.deploys.update(d.id, { name: 'api2' })
    f.deploys.reorder(f.staging.id, [d.id])
    f.deploys.delete(d.id)
    const evs = f.audit.list({ actions: ['deploy.create', 'deploy.update', 'deploy.delete'] })
    expect(evs.map((e) => e.action).sort()).toEqual(['deploy.create', 'deploy.delete', 'deploy.update'])
    for (const e of evs) {
      expect(e.details).not.toHaveProperty('host')
      expect(JSON.stringify(e.details)).not.toContain('app1')
      expect(JSON.stringify(e.details)).not.toContain(f.host.id)
    }
    expect(evs.find((e) => e.action === 'deploy.create')!.details).toEqual({ environment: 'staging' })
    expect(evs.find((e) => e.action === 'deploy.delete')!.details).toEqual({ environment: 'staging' })
  })

  it('vault order is not a change and is not audited', async () => {
    const f = await makeDeployFixture()
    const other = f.vault.createVault({ name: 'Other', color: '#112233' })
    const d = f.deploys.create(f.input({ vaultIds: [DEFAULT_VAULT_ID, other.id] }))
    const before = f.audit.list({ actions: ['deploy.update'] }).length
    const n = f.changed.length
    f.deploys.update(d.id, { vaultIds: [other.id, DEFAULT_VAULT_ID] })
    expect(f.audit.list({ actions: ['deploy.update'] })).toHaveLength(before)
    expect(f.changed).toHaveLength(n)
    expect([...f.deploys.get(d.id).vaultIds].sort()).toEqual([DEFAULT_VAULT_ID, other.id].sort())
  })

  it('reorder rejects an unknown environment and skips a no-op', async () => {
    const f = await makeDeployFixture()
    const a = f.deploys.create(f.input({ name: 'a' }))
    const b = f.deploys.create(f.input({ name: 'b' }))
    expect(() => f.deploys.reorder('00000000-0000-4000-8000-000000000000', [])).toThrow('environment not found')
    const n = f.audit.list({ actions: ['deploy.update'] }).length
    const c = f.changed.length
    f.deploys.reorder(f.staging.id, [a.id, b.id])
    expect(f.audit.list({ actions: ['deploy.update'] })).toHaveLength(n)
    expect(f.changed).toHaveLength(c)
  })

  it('rejects a duplicate name in the environment and caps the count', async () => {
    const f = await makeDeployFixture()
    f.deploys.create(f.input())
    expect(() => f.deploys.create(f.input({ name: 'API' }))).toThrow('a deployment named "API" already exists in this environment')
    expect(f.deploys.create(f.input({ environmentId: f.prod.id })).environmentId).toBe(f.prod.id)
    const ts = '2026-01-01T00:00:00.000Z'
    f.db.exec('BEGIN')
    const ins = f.db.prepare(
      "INSERT INTO deployments(id, name, environment_id, host_id, repo_path, default_branch, deploy_tag, created_at, updated_at) VALUES (?,?,?,?,'/r','main','t',?,?)",
    )
    for (let i = f.deploys.list().length; i < MAX_DEPLOYMENTS; i++) ins.run(`id${i}`, `n${i}`, f.staging.id, f.host.id, ts, ts)
    f.db.exec('COMMIT')
    expect(() => f.deploys.create(f.input({ name: 'one-more' }))).toThrow('too many deployments (512)')
  })

  it('env template with a plain sensitive value is rejected', async () => {
    const f = await makeDeployFixture()
    const err = (() => {
      try {
        f.deploys.create(f.input({ managedEnv: true, envTemplate: 'DB_PASSWORD=hunter2' }))
      } catch (e) {
        return (e as Error).message
      }
    })()
    expect(err).toContain('line 1: DB_PASSWORD looks sensitive; use a vault secret')
    expect(err).not.toContain('hunter2')
  })

  it("env template secret must be in the deployment's vaults", async () => {
    const f = await makeDeployFixture()
    const tpl = `A=1\nB=\${secret:${f.secretId}}`
    expect(() => f.deploys.create(f.input({ managedEnv: true, envTemplate: tpl }))).toThrow(
      "secret 1 in the env template isn't in this deployment's vaults",
    )
    const d = f.deploys.create(f.input({ managedEnv: true, envTemplate: tpl, vaultIds: [DEFAULT_VAULT_ID] }))
    expect(d.vaultIds).toEqual([DEFAULT_VAULT_ID])
    expect(d.envTemplate).toBe(tpl)
    // The audit and the stored row hold the reference, never the value.
    expect(auditRows(f.db)).not.toContain('sekret-value-1')
    // Dropping the vault on update re-checks the template.
    expect(() => f.deploys.update(d.id, { vaultIds: [] })).toThrow("isn't in this deployment's vaults")
    expect(f.deploys.update(d.id, { name: 'api2' }).vaultIds).toEqual([DEFAULT_VAULT_ID])
  })

  it('managed env needs a template; db backup needs a dir', async () => {
    const f = await makeDeployFixture()
    expect(() => f.deploys.create(f.input({ managedEnv: true }))).toThrow('env template is required when the managed .env is on')
    const d = f.deploys.create(f.input({ dbBackup: true, backupDir: '/var/backups/app' }))
    expect(() => f.deploys.update(d.id, { backupDir: null })).toThrow('backup dir is required when DB backup is on')
    expect(f.deploys.update(d.id, { dbBackup: false, backupDir: null })).toMatchObject({ dbBackup: false, backupDir: null })
  })

  it('update audits changed field names only, and clears with null', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input({ preHook: 'echo hi', urls: [{ url: 'https://a.example/h', from: 'host' }] }))
    const u = f.deploys.update(d.id, { preHook: null, urls: [], defaultBranch: 'release/1' })
    expect(u).toMatchObject({ preHook: null, urls: [], defaultBranch: 'release/1' })
    const [e] = f.audit.list({ actions: ['deploy.update'] })
    expect((e.details as { fields: string[] }).fields.sort()).toEqual(['defaultBranch', 'preHook', 'urls'])
    expect(auditRows(f.db)).not.toContain('echo hi')
    const n = f.audit.list({ actions: ['deploy.update'] }).length
    f.deploys.update(d.id, { defaultBranch: 'release/1' })
    expect(f.audit.list({ actions: ['deploy.update'] }).length).toBe(n)
  })

  it('refuses to move a deployment to another environment or host', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input())
    const msg = 'a deployment cannot move to another environment or host; recreate it'
    expect(() => f.deploys.update(d.id, { environmentId: f.prod.id })).toThrow(msg)
    expect(() => f.deploys.update(d.id, { hostId: f.host.id })).not.toThrow()
    const h2 = f.hosts.create({ label: 'h2', address: '10.1.1.1' })
    expect(() => f.deploys.update(d.id, { hostId: h2.id })).toThrow(msg)
    expect(f.deploys.get(d.id).environmentId).toBe(f.staging.id)
    expect(() => asDeploymentPatch({ environmentId: f.prod.id }, 'args[1]')).toThrow(/not an allowed key/)
  })

  it('delete removes the deployment and audits labels', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input())
    f.deploys.delete(d.id)
    expect(f.deploys.list()).toEqual([])
    expect(f.audit.list({ actions: ['deploy.delete'] })[0]).toMatchObject({ targetLabel: 'api', details: { environment: 'staging' } })
    expect(() => f.deploys.get(d.id)).toThrow('deployment not found')
  })

  it('reorder renumbers and rejects foreign ids', async () => {
    const f = await makeDeployFixture()
    const a = f.deploys.create(f.input({ name: 'a' }))
    const b = f.deploys.create(f.input({ name: 'b' }))
    const c = f.deploys.create(f.input({ name: 'c' }))
    const p = f.deploys.create(f.input({ name: 'p', environmentId: f.prod.id }))
    expect(f.deploys.list(f.staging.id).map((d) => d.name)).toEqual(['a', 'b', 'c'])
    f.deploys.reorder(f.staging.id, [c.id, a.id, b.id])
    expect(f.deploys.list(f.staging.id).map((d) => [d.name, d.position])).toEqual([['c', 0], ['a', 1], ['b', 2]])
    expect(() => f.deploys.reorder(f.staging.id, [c.id, a.id, p.id])).toThrow("ids must be exactly the environment's deployments")
    expect(() => f.deploys.reorder(f.staging.id, [c.id, a.id])).toThrow("ids must be exactly the environment's deployments")
    expect(() => f.deploys.reorder(f.staging.id, [c.id, a.id, b.id, b.id])).toThrow("ids must be exactly the environment's deployments")
    expect(f.deploys.get(p.id).position).toBe(0)
  })

  it('settings: versioned and current version validate and audit deploy.settings', async () => {
    const f = await makeDeployFixture()
    expect(f.deploys.settings(f.staging.id)).toEqual({ environmentId: f.staging.id, versioned: false, autoRollback: true, currentVersion: null })
    const s = f.deploys.updateSettings(f.staging.id, { versioned: true, autoRollback: false, currentVersion: 'v1.2.3' })
    expect(s).toEqual({ environmentId: f.staging.id, versioned: true, autoRollback: false, currentVersion: 'v1.2.3' })
    expect(() => f.deploys.updateSettings(f.staging.id, { currentVersion: '1.2' })).toThrow('version must look like v1.2.3')
    expect(f.deploys.updateSettings(f.staging.id, { currentVersion: null }).currentVersion).toBeNull()
    expect(() => f.deploys.settings('00000000-0000-4000-8000-000000000000')).toThrow('environment not found')
    const evs = f.audit.list({ actions: ['deploy.settings'] })
    expect(evs).toHaveLength(2)
    expect(evs.map((e) => (e.details as { fields: string[] }).fields.sort()).flat()).toContain('versioned')
    expect(f.changed).toContain(f.staging.id)
  })

  it('composeSnippet is always null', async () => {
    const f = await makeDeployFixture()
    expect(f.deploys.composeSnippet('x')).toBeNull()
  })

  it('mutations need the vault unlocked', async () => {
    const f = await makeDeployFixture()
    const d = f.deploys.create(f.input())
    f.vault.lock('manual')
    expect(f.deploys.list()).toHaveLength(1)
    expect(() => f.deploys.create(f.input({ name: 'z' }))).toThrow(/locked/i)
    expect(() => f.deploys.update(d.id, { name: 'z' })).toThrow(/locked/i)
    expect(() => f.deploys.delete(d.id)).toThrow(/locked/i)
    expect(() => f.deploys.reorder(f.staging.id, [d.id])).toThrow(/locked/i)
    expect(() => f.deploys.updateSettings(f.staging.id, { versioned: true })).toThrow(/locked/i)
  })

  it('IPC validators reject bad shapes naming the path', async () => {
    const f = await makeDeployFixture()
    const ok = f.input()
    const cases: [object, RegExp][] = [
      [{ ...ok, urls: [{ url: 5, from: 'host' }] }, /args\[0\]\.urls\[0\]\.url must be a string/],
      [{ ...ok, useSudo: 'maybe' }, /args\[0\]\.useSudo is not an allowed value/],
      [{ ...ok, buildTimeoutSec: 99999 }, /args\[0\]\.buildTimeoutSec must be at most 3600/],
      [{ ...ok, healthStatus: 42 }, /args\[0\]\.healthStatus must be at least 100/],
    ]
    for (const [input, re] of cases) {
      expect(() => asDeploymentInput(input, 'args[0]')).toThrow(re)
      expect(() => asDeploymentInput(input, 'args[0]')).toThrow(InvalidArgs)
    }
    expect(asDeploymentInput(ok, 'args[0]')).toMatchObject({ name: 'api' })
    expect(() => asEnvDeploySettingsPatch({ versioned: 'yes' }, 'args[1]')).toThrow(/args\[1\]\.versioned must be a boolean/)
    expect(asDeploymentPatch({ preHook: null, urls: [] }, 'args[1]')).toEqual({ preHook: null, urls: [] })
  })
})
