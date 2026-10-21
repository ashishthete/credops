import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConfigExport, exportConfig, serializeConfig } from '../../src/main/config/export'
import { createConfigHandlers } from '../../src/main/ipc/handlers/config'
import { parseConfigFile, type ConfigFile } from '../../src/shared/config-file'
import { DEFAULT_VAULT_ID, VAULT_LOCKED } from '../../src/shared/vault'
import { makeConfigFixture, NOT_CONFIG, SECRET_VALUES, type ConfigFixture } from './config-helpers'
import { PRODUCT, REGION } from './inventory-helpers'

const clock = () => new Date('2026-10-20T10:00:00.000Z')
const sortedById = <T extends { id: string }>(xs: T[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1].id < x.id)
/** The fixture's own product, not the one every fixture shares. */
const shop = (file: ConfigFile) => file.products.find((p) => p.name === 'Shop')!
const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'opsdeck-config-')), 'opsdeck-config.json')
const exportDeps = (f: ConfigFixture, now = clock) => ({ db: f.db, vault: f.vault, audit: f.audit, now })

describe('config export', () => {
  it('exports every config kind with stable ids and sorted arrays', async () => {
    const f = await makeConfigFixture()
    const { file, counts } = buildConfigExport(f.db, clock)
    expect(file.format).toBe('opsdeck-config')
    expect(file.version).toBe(2)
    expect(file.exportedAt).toBe('2026-10-20T10:00:00.000Z')
    expect(Object.keys(file)).toEqual(['format', 'version', 'exportedAt', 'secretRefs', 'regions', 'products', 'identities', 'hosts', 'environments', 'tunnels', 'deployments', 'services'])
    expect(counts).toEqual({ regions: 1, products: 2, identities: 2, hosts: 2, environments: 2, tunnels: 1, deployments: 1, services: 2 })
    for (const list of [file.regions, file.products, file.identities, file.hosts, file.environments, file.tunnels, file.deployments, file.services] as { id: string }[][]) {
      expect(sortedById(list)).toBe(true)
    }

    expect(file.regions).toEqual([{ id: REGION, code: 'test-1', provider: '', displayName: 'Test' }])
    expect(file.products).toEqual([
      { id: PRODUCT, name: 'Fixture', color: '#445566', icon: 'boxes', description: '', repoUrl: null },
      { id: f.ids.product, name: 'Shop', color: '#3366ff', icon: 'rocket', description: 'The shop', repoUrl: 'git@example.com:shop.git' },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)))
    const byId = <T extends { id: string }>(xs: T[], id: string) => xs.find((x) => x.id === id)!
    expect(byId(file.identities, f.ids.keyIdentity)).toEqual({
      id: f.ids.keyIdentity,
      vault: { vaultName: 'Team' },
      label: 'deployer',
      username: 'deploy',
      auth: 'key',
      key: { vaultName: 'Team', itemName: 'deploy-key' },
    })
    expect(byId(file.identities, f.ids.passwordIdentity)).toEqual({
      id: f.ids.passwordIdentity,
      vault: { vaultName: 'Default' },
      label: 'root-login',
      username: 'root',
      auth: 'password',
      key: null,
    })
    expect(byId(file.hosts, f.host.id)).toEqual({
      id: f.host.id,
      label: 'app1',
      address: '10.0.0.7',
      regionId: REGION,
      port: null,
      identityId: f.ids.passwordIdentity,
      jumpHostId: f.ids.bastion,
      tags: ['web', 'api'],
      osIcon: 'linux',
      notes: 'primary app box',
      keepaliveSec: 30,
      envVars: { LANG: 'C.UTF-8' },
      vaults: [{ vaultName: 'Default' }, { vaultName: 'Team' }],
    })
    const staging = byId(file.environments, f.staging.id)
    expect(staging).toEqual({
      id: f.staging.id,
      name: 'staging',
      color: '#112233',
      protected: false,
      defaultIdentityId: f.ids.keyIdentity,
      defaultPort: 2222,
      defaultJumpHostId: null,
      versioned: true,
      autoRollback: false,
      domain: 'staging.example.com',
      productId: f.ids.product,
      hosts: [{ hostId: f.host.id, role: 'app' }, { hostId: f.ids.bastion, role: 'bastion' }].sort((a, b) => (a.hostId < b.hostId ? -1 : 1)),
    })
    expect(byId(file.environments, f.prod.id)).toMatchObject({ protected: true, productId: PRODUCT })
    expect(file.tunnels).toEqual([
      {
        id: f.ids.tunnel,
        label: 'pg',
        hostId: f.host.id,
        environmentId: f.staging.id,
        type: 'L',
        bindAddress: '127.0.0.1',
        bindPort: 15432,
        targetHost: '127.0.0.1',
        targetPort: 5432,
        autoStart: false,
        autoReconnect: true,
      },
    ])
    const [d] = file.deployments
    expect(Object.keys(d)).toEqual([
      'id', 'environmentId', 'hostId', 'name', 'repoUrl', 'repoPath', 'defaultBranch', 'composeFile', 'composeProject', 'deployTag', 'position',
      'urls', 'healthStatus', 'healthTimeoutSec', 'dbBackup', 'backupDir', 'preHook', 'postHook', 'buildTimeoutSec', 'composeTimeoutSec',
      'useSudo', 'becomeSecret', 'vaults', 'managedEnv', 'envTemplate',
    ])
    expect(d).toMatchObject({
      id: f.ids.deployment,
      environmentId: f.staging.id,
      hostId: f.host.id,
      name: 'api',
      repoPath: '/srv/app',
      urls: [{ url: 'https://staging.example.com/health', from: 'mac' }],
      dbBackup: true,
      backupDir: '/srv/backups',
      useSudo: 'yes',
      vaults: [{ vaultName: 'Default' }, { vaultName: 'Team' }],
      managedEnv: true,
    })
    expect(byId(file.services, f.ids.appService)).toEqual({
      id: f.ids.appService,
      environmentId: f.staging.id,
      name: 'web',
      kind: 'service',
      position: expect.any(Number),
      description: '',
      deploymentId: f.ids.deployment,
      composeService: 'web',
      url: 'https://staging.example.com',
      urlCheckFrom: 'mac',
    })
    expect(byId(file.services, f.ids.dbService)).toEqual({
      id: f.ids.dbService,
      environmentId: f.staging.id,
      name: 'main-db',
      kind: 'db',
      position: expect.any(Number),
      description: '',
      dbEngine: 'postgres',
      dbAddress: '10.0.0.9',
      dbPort: 5432,
      viaHostId: f.host.id,
      localPort: 15432,
      tunnelId: f.ids.tunnel,
    })
    // What it writes is what the strict reader accepts.
    expect(parseConfigFile(serializeConfig(file))).toEqual({ ok: true, file })
  })

  it('export contains no secret', async () => {
    const f = await makeConfigFixture()
    // Secrets that live in plain config columns: a token env var and credentials inside repo URLs.
    f.db
      .prepare('UPDATE hosts SET env_vars = ? WHERE id = ?')
      .run(JSON.stringify({ LANG: 'C.UTF-8', GITHUB_TOKEN: 'ghp-SECRETVAL-env', db_password: '' }), f.host.id)
    f.db.prepare('UPDATE products SET repo_url = ? WHERE id = ?').run('https://u:SECRETVAL@host/x.git', f.ids.product)
    f.db.prepare('UPDATE deployments SET repo_url = ? WHERE id = ?').run('ssh://git:SECRETVAL2@host/x.git', f.ids.deployment)
    const { file, omitted } = buildConfigExport(f.db, clock)
    const text = serializeConfig(file)
    expect(text).not.toContain('SECRETVAL')
    expect(file.hosts.find((h) => h.id === f.host.id)!.envVars).toEqual({ LANG: 'C.UTF-8', GITHUB_TOKEN: '', db_password: '' })
    expect(shop(file).repoUrl).toBe('https://host/x.git')
    // An ssh user is not a secret: only the password goes.
    expect(file.deployments[0].repoUrl).toBe('ssh://git@host/x.git')
    // The token and the two URL passwords; an already blank value is not counted.
    expect(omitted).toBe(3)
    expect(parseConfigFile(text).ok).toBe(true)
    for (const value of Object.values(SECRET_VALUES)) expect(text).not.toContain(value)
    for (const line of f.privateKey.split('\n').filter((l) => l.length > 20)) expect(text).not.toContain(line)
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).not.toMatch(/"[A-Za-z_]*(_enc|_sealed|Enc|Sealed)"/)
    expect(text).not.toMatch(/"(password|passphrase|privateKey|publicKey|fingerprint|value|hasPassword|hasPassphrase)":/i)
    // No local secret id, not even inside the env template.
    for (const id of [f.secretId, f.ids.becomeSecret, f.ids.dotenvSecret]) expect(text).not.toContain(id)
    // Nor any sealed column's stored text.
    const sealed = f.db
      .prepare(
        `SELECT value_enc AS v FROM secrets UNION ALL SELECT private_key_enc FROM ssh_keys UNION ALL SELECT passphrase_enc FROM ssh_keys
         UNION ALL SELECT password_enc FROM identities UNION ALL SELECT script_sealed FROM snippets`,
      )
      .all() as { v: string | null }[]
    for (const { v } of sealed) if (v) expect(text).not.toContain(v)
  })

  it('blanks more secret-looking names, credentialed values and URL tokens', async () => {
    const f = await makeConfigFixture()
    // Fake values only.
    f.db
      .prepare('UPDATE hosts SET env_vars = ? WHERE id = ?')
      .run(
        JSON.stringify({ LANG: 'C.UTF-8', DB_PASS: 'fakepass1', db_pwd: 'fakepass2', SENTRY_DSN: 'https://fakedsn@sentry.example/1', DATABASE_URL: 'postgres://app:fakepw3@db.example/app' }),
        f.host.id,
      )
    f.db
      .prepare('UPDATE deployments SET env_template = ?, repo_url = ?, urls = ? WHERE id = ?')
      .run(
        ['# note', 'DB_PASS=fakepass4', 'db_pwd=fakepass5', 'SENTRY_DSN=https://fakedsn2@sentry.example/1', 'DATABASE_URL=postgres://app:fakepw6@db.example/app', 'APP_ENV=staging', 'EMPTY_PASS=', ''].join('\n'),
        'https://git.example/x.git?private_token=faketok7&ref=main',
        JSON.stringify([{ url: 'https://app.example/health?token=faketok8&x=1', from: 'mac' }]),
        f.ids.deployment,
      )
    f.db.prepare("UPDATE services SET url = ? WHERE kind = 'service'").run('https://svc.example/h?api_key=faketok9')
    const { file, omitted } = buildConfigExport(f.db, clock)
    const text = serializeConfig(file)
    expect(text).not.toMatch(/fakepass|fakepw|fakedsn|faketok/)
    expect(file.hosts.find((h) => h.id === f.host.id)!.envVars).toEqual({ LANG: 'C.UTF-8', DB_PASS: '', db_pwd: '', SENTRY_DSN: '', DATABASE_URL: '' })
    const [d] = file.deployments
    expect(d.envTemplate).toBe(['# note', 'DB_PASS=', 'db_pwd=', 'SENTRY_DSN=', 'DATABASE_URL=', 'APP_ENV=staging', 'EMPTY_PASS=', ''].join('\n'))
    expect(d.repoUrl).toBe('https://git.example/x.git?private_token=&ref=main')
    expect(d.urls[0].url).toBe('https://app.example/health?token=&x=1')
    expect(file.services.find((s) => s.kind === 'service')).toMatchObject({ url: 'https://svc.example/h?api_key=' })
    // 4 env vars + 4 template lines + 3 URL params.
    expect(omitted).toBe(11)
    expect(parseConfigFile(text).ok).toBe(true)
  })

  it('legacy repo URLs the rules would now refuse are omitted, others are stripped', async () => {
    const f = await makeConfigFixture()
    // Rows saved under the old pattern, seeded in SQL. Fake values only.
    f.db.prepare('UPDATE products SET repo_url = ? WHERE id = ?').run('git@https://tok:pw@github.com/a', f.ids.product)
    f.db.prepare('UPDATE deployments SET repo_url = ? WHERE id = ?').run('https:///tok:pw@host/r', f.ids.deployment)
    const { file, omitted } = buildConfigExport(f.db, clock)
    const text = serializeConfig(file)
    expect(text).not.toMatch(/tok|pw@/)
    expect(shop(file).repoUrl).toBeNull()
    expect(file.deployments[0].repoUrl).toBeNull()
    expect(omitted).toBe(2)
    expect(parseConfigFile(text).ok).toBe(true)
    f.db.prepare('UPDATE products SET repo_url = ? WHERE id = ?').run('ssh://u%3Apw@host/r', f.ids.product)
    const again = buildConfigExport(f.db, clock)
    expect(serializeConfig(again.file)).not.toContain('%3Apw')
    expect(shop(again.file).repoUrl).toBe('ssh://u@host/r')
  })

  it('template lines: only a whole ref is exempt, comments are checked, a bare http(s) token counts, a stray ? does not hide params', async () => {
    const f = await makeConfigFixture()
    const ref = '${secret:0190a1b2-c3d4-4e5f-8a6b-aaaaaaaaaaaa}'
    f.db
      .prepare('UPDATE deployments SET env_template = ?, urls = ?, repo_url = ? WHERE id = ?')
      .run(
        ['DB_PASS=fakepw1' + ref, '# DB_PASS=fakepw2', '# note: plain words', '# export DB_PASS=fakepw7', '## DB_PASS=fakepw8', '# DB_PASS = fakepw9', 'R1=https:///faketok@github.com/x', 'R2=https:\\\\faketok@h/x', 'R3=https:/\\faketok@h/x', 'R4=https://\tfaketok@h', 'GIT_REMOTE=https://faketok3@github.com/x', 'APP_ENV=staging', ''].join('\n'),
        JSON.stringify([{ url: 'https://app.example/h?a=1?token=faketok4', from: 'mac' }]),
        null,
        f.ids.deployment,
      )
    const { file, omitted } = buildConfigExport(f.db, clock)
    const [d] = file.deployments
    // The deleted ref inside DB_PASS goes with its whole line; the comment note stays.
    expect(d.envTemplate).toBe(['DB_PASS=', '# DB_PASS=', '# note: plain words', '# export DB_PASS=', '## DB_PASS=', '# DB_PASS=', 'R1=', 'R2=', 'R3=', 'R4=', 'GIT_REMOTE=', 'APP_ENV=staging', ''].join('\n'))
    expect(d.urls[0].url).toBe('https://app.example/h?a=1?token=')
    expect(omitted).toBe(11)
    expect(serializeConfig(file)).not.toMatch(/fakepw|faketok/)
    expect(parseConfigFile(serializeConfig(file)).ok).toBe(true)
  })

  it('env template secret refs become ref-N with vault and item names', async () => {
    const f = await makeConfigFixture()
    const { file } = buildConfigExport(f.db, clock)
    // Sorted by (vault name, item name): Default/envsecret, Default/sudo-pw, Team/db-pass.
    expect(file.secretRefs).toEqual({
      'ref-1': { vaultName: 'Default', itemName: 'envsecret' },
      'ref-2': { vaultName: 'Default', itemName: 'sudo-pw' },
      'ref-3': { vaultName: 'Team', itemName: 'db-pass' },
    })
    const [d] = file.deployments
    expect(d.becomeSecret).toBe('ref-2')
    expect(d.envTemplate).toBe(
      ['# managed', 'DB_PASSWORD=${secret:ref-3}', 'APP_ENV=staging', 'API_TOKEN=${secret:ref-1}', 'DB_PASSWORD_COPY=${secret:ref-3}', ''].join('\n'),
    )
  })

  it('a template ref to a deleted secret is exported blank, without its id', async () => {
    const f = await makeConfigFixture()
    const gone = '0190a1b2-c3d4-4e5f-8a6b-eeeeeeeeeeee'
    f.db.prepare('UPDATE deployments SET env_template = ? WHERE id = ?').run(`GONE=\${secret:${gone}}\nAPP_ENV=x\n`, f.ids.deployment)
    const { file } = buildConfigExport(f.db, clock)
    const { omitted } = buildConfigExport(f.db, clock)
    expect(omitted).toBe(1)
    expect(file.deployments[0].envTemplate).toBe('GONE=\nAPP_ENV=x\n')
    expect(serializeConfig(file)).not.toContain(gone)
    expect(parseConfigFile(serializeConfig(file)).ok).toBe(true)
  })

  it('releases, runs, audit, known_hosts, snippets, current_version and last deployed commits are not exported', async () => {
    const f = await makeConfigFixture()
    const text = serializeConfig(buildConfigExport(f.db, clock).file)
    for (const marker of Object.values(NOT_CONFIG)) expect(text).not.toContain(marker)
    expect(text).not.toContain(f.ids.snippet)
    expect(text).not.toContain('0190a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa')
    expect(text).not.toMatch(/currentVersion|lastDeployed|lastRelease|releases|snippets|knownHosts|audit/i)
    const lastAudit = f.audit.list({ limit: 1 })[0]
    expect(text).not.toContain(lastAudit.hash)
    // Vaults are referenced by name, never exported as objects.
    expect(text).not.toContain(f.teamVaultId)
    expect(text).not.toContain(DEFAULT_VAULT_ID)
  })

  it('two exports of the same data differ only in exportedAt', async () => {
    const f = await makeConfigFixture()
    const a = serializeConfig(buildConfigExport(f.db, () => new Date('2026-10-20T10:00:00.000Z')).file)
    const b = serializeConfig(buildConfigExport(f.db, () => new Date('2026-10-21T11:30:00.000Z')).file)
    expect(a).not.toBe(b)
    expect(a.replace(/"exportedAt": "[^"]*"/, '')).toBe(b.replace(/"exportedAt": "[^"]*"/, ''))
    expect(a.endsWith('}\n')).toBe(true)
    expect(a).toBe(JSON.stringify(JSON.parse(a), null, 2) + '\n')
  })

  it('the file is written with mode 0600 even when it already existed', async () => {
    const f = await makeConfigFixture()
    const fresh = tmpPath()
    await exportConfig(exportDeps(f), fresh)
    expect(statSync(fresh).mode & 0o777).toBe(0o600)

    const existing = tmpPath()
    writeFileSync(existing, 'old', { mode: 0o644 })
    const res = await exportConfig(exportDeps(f), existing)
    expect(statSync(existing).mode & 0o777).toBe(0o600)
    expect(res.counts.hosts).toBe(2)
    const parsed = parseConfigFile(readFileSync(existing, 'utf8'))
    expect(parsed.ok).toBe(true)
  })

  it('config.export audit carries counts only', async () => {
    const f = await makeConfigFixture()
    const path = tmpPath()
    const h = createConfigHandlers({ ...exportDeps(f), openDialog: async () => undefined, saveDialog: async () => path })
    const res = await h['config:export']()
    expect(res).toEqual({ path, counts: { regions: 1, products: 2, identities: 2, hosts: 2, environments: 2, tunnels: 1, deployments: 1, services: 2 }, omitted: 0 })
    const [e] = f.audit.list({ actions: ['config.export'] })
    expect(e).toMatchObject({ outcome: 'success', targetType: 'config', targetLabel: 'config', targetId: null })
    expect(e.details).toEqual({ counts: res!.counts, omitted: 0 })
    const json = JSON.stringify(e)
    for (const leak of [path, 'opsdeck-config', f.host.id, f.ids.bastion, 'app1', 'bastion', '10.0.0.7', 'staging', 'Shop', 'Team']) {
      expect(json).not.toContain(leak)
    }
  })

  it('a cancelled save writes nothing and audits nothing', async () => {
    const f = await makeConfigFixture()
    const h = createConfigHandlers({ ...exportDeps(f), openDialog: async () => undefined, saveDialog: async () => undefined })
    expect(await h['config:export']()).toBeNull()
    expect(f.audit.list({ actions: ['config.export'] })).toEqual([])
  })

  it('export refuses while the vault is locked', async () => {
    const f = await makeConfigFixture()
    f.vault.lock('manual')
    const path = tmpPath()
    let asked = false
    const h = createConfigHandlers({ ...exportDeps(f), openDialog: async () => undefined, saveDialog: async () => ((asked = true), path) })
    await expect(h['config:export']()).rejects.toThrow(VAULT_LOCKED)
    expect(asked).toBe(false)
    await expect(exportConfig(exportDeps(f), path)).rejects.toThrow(VAULT_LOCKED)
    expect(() => statSync(path)).toThrow()
  })

  it('a failed write is audited as a failure without the path or the reason text', async () => {
    const f = await makeConfigFixture()
    const dir = mkdtempSync(join(tmpdir(), 'opsdeck-config-'))
    const path = join(dir, 'missing-dir', 'opsdeck-config.json')
    await expect(exportConfig(exportDeps(f), path)).rejects.toThrow("Couldn't write the config file")
    const [e] = f.audit.list({ actions: ['config.export'] })
    expect(e.outcome).toBe('failure')
    expect(JSON.stringify(e)).not.toContain(dir)
  })

  it('the write is atomic: a failed rename leaves the target and no temp file behind', async () => {
    const f = await makeConfigFixture()
    const dir = mkdtempSync(join(tmpdir(), 'opsdeck-config-'))
    // A non-empty directory at the target path: the temp file is written, the rename over it fails.
    const path = join(dir, 'opsdeck-config.json')
    mkdirSync(path)
    writeFileSync(join(path, 'keep'), 'x')
    await expect(exportConfig(exportDeps(f), path)).rejects.toThrow("Couldn't write the config file")
    expect(readdirSync(dir)).toEqual(['opsdeck-config.json'])
    expect(readdirSync(path)).toEqual(['keep'])

    // Success leaves only the target, and an old file is replaced whole.
    const ok = join(dir, 'out.json')
    writeFileSync(ok, 'old contents that are longer than nothing', { mode: 0o644 })
    await exportConfig(exportDeps(f), ok)
    expect(readdirSync(dir).sort()).toEqual(['opsdeck-config.json', 'out.json'])
    expect(parseConfigFile(readFileSync(ok, 'utf8')).ok).toBe(true)
  })

  it('a config that cannot be read fails with a generic message and no parser text', async () => {
    const f = await makeConfigFixture()
    f.db.prepare('UPDATE hosts SET tags = ? WHERE id = ?').run('{not json SECRETVAL', f.host.id)
    const path = tmpPath()
    const err = await exportConfig(exportDeps(f), path).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("Couldn't read the config")
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toMatch(/SECRETVAL|JSON|position/)
    expect(() => statSync(path)).toThrow()
    const [e] = f.audit.list({ actions: ['config.export'] })
    expect(e.outcome).toBe('failure')
  })
})
