import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localAllowAll, DeployError } from '../../src/main/deploy/access'
import { noopFinalize } from '../../src/main/deploy/finalize'
import { LocalRunner } from '../../src/main/deploy/local-runner'
import { ReleaseService } from '../../src/main/deploy/release-service'
import { copyServices } from '../../src/main/deploy/service-copy'
import { resolveHost } from '../../src/main/inventory/resolve'
import { createConfigHandlers } from '../../src/main/ipc/handlers/config'
import { createDeployHandlers } from '../../src/main/ipc/handlers/deploy'
import { createServiceHandlers } from '../../src/main/ipc/handlers/services'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_RELEASE_OPTIONS, type ReleaseConfirm, type StepKind } from '../../src/shared/deploy'
import type { AppServiceMeta, ServiceMeta } from '../../src/shared/services'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { FakeAnsible, TOOLS_OK, fakeAgent, fakePrepare, fakeTap, makeDeployFixture, memFs, scriptFromPlaybook } from './deploy-helpers'
import { makeInventory, REGION } from './inventory-helpers'

const P0 = '1'.repeat(40)
const S1 = '2'.repeat(40)
const S2 = '3'.repeat(40)
const S3 = '4'.repeat(40)
const S5 = '5'.repeat(40)
const SECRET = 'sekret-value-1'
const NOW = Date.parse('2026-10-19T12:00:00Z')
const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }

type Task = { name: string; tags: string[]; deployment: string | null; json: string }
type Spawned = { kind: string; playbook: string; env: Record<string, string | undefined> }

/** Every task of a generated playbook, block tasks with the deployment (sanitized checkout name) they belong to. */
function tasksOf(playbook: string): Task[] {
  type T = { name?: string; tags?: string[]; block?: T[]; vars?: { d?: { name: string } } }
  const plays = JSON.parse(playbook) as { tasks: T[] }[]
  return plays.flatMap((p) =>
    p.tasks.flatMap((t) =>
      t.block
        ? t.block.map((b) => ({ name: String(b.name), tags: b.tags ?? [], deployment: t.vars?.d?.name ?? null, json: JSON.stringify(b) }))
        : [{ name: String(t.name), tags: t.tags ?? [], deployment: null, json: JSON.stringify(t) }],
    ),
  )
}
const step = (t: Task): string | undefined => t.tags.find((x) => x.startsWith('od_step='))?.slice(8)
/** The compose command line of each task of `kind` for the deployment, unquoted. */
const cmds = (tasks: Task[], kind: StepKind, deployment: string): string[] =>
  tasks.filter((t) => step(t) === kind && t.deployment === deployment).map((t) => (JSON.parse(t.json) as { 'ansible.builtin.shell'?: { cmd: string } })['ansible.builtin.shell']?.cmd ?? '').map((cmd) => /^(?:sudo -n )?docker compose .*$/m.exec(cmd)?.[0] ?? cmd).map((c) => c.replace(/'/g, ''))

async function world() {
  const f = await makeDeployFixture()
  // app1 is shared with protected prod in the fixture; staging starts unprotected.
  f.db.prepare('DELETE FROM environment_hosts WHERE environment_id = ?').run(f.prod.id)
  const home = mkdtempSync(join(tmpdir(), 'opsdeck-e2e-home-'))
  const ansible = new FakeAnsible()
  const fs = memFs()
  const spawned: Spawned[] = []
  const script: { commits: Record<string, { previous: string; deployed: string }>; failStep?: StepKind } = { commits: {} }
  ansible.onSpawn = (call) => {
    const playbook = fs.files.get(join(call.cwd, 'playbook.yml'))!
    const kind = (JSON.parse(playbook) as { name: string }[])[0].name.split(' ')[0]
    spawned.push({ kind, playbook, env: { ...call.env } })
    const failStep = kind === 'release' ? script.failStep : undefined
    ansible.stdout = scriptFromPlaybook(playbook, { commits: script.commits, failStep })
    ansible.exit = { code: failStep ? 2 : 0, signal: null }
  }
  const runner = new LocalRunner({
    tools: async () => TOOLS_OK,
    prepare: fakePrepare().fn,
    agent: fakeAgent().fn,
    tap: fakeTap().fn,
    spawn: ansible.spawn,
    fs,
    tmpdir: '/tmp',
    home,
    userAgentSock: null,
  })
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const svc = new ReleaseService({
    db: f.db,
    deploys: f.deploys,
    services: f.services,
    releases: f.releases,
    runner,
    access: localAllowAll,
    finalize: noopFinalize,
    audit: f.audit,
    vault: f.vault,
    resolve: (hostId, envId) => resolveHost(f.db, hostId, envId, { localUser: 'tester' }),
    secrets,
    emit: () => undefined,
    emitState: () => undefined,
    actor: { osUser: 'tester', machine: 'box' },
    now: () => new Date(NOW),
    clock: { setTimeout: () => undefined, clearTimeout: () => undefined },
  })
  // Every IPC result is kept, so the secret check can search them all.
  const results: unknown[] = []
  const keep = <A extends unknown[], R>(fn: (...a: A) => R) => async (...a: A): Promise<Awaited<R>> => {
    const r = await fn(...a)
    results.push(r)
    return r
  }
  const deployIpc = createDeployHandlers({ deploys: f.deploys, releases: svc, tooling: async () => TOOLS_OK })
  const serviceIpc = createServiceHandlers({
    services: f.services,
    copy: (req) => copyServices({ db: f.db, deploys: f.deploys, services: f.services, audit: f.audit, vault: f.vault }, req),
    deploys: f.deploys,
    containers: { followCompose: () => { throw new Error('not in this test') } } as never,
    tunnels: { afterUpdate: () => undefined, remove: () => undefined, open: () => undefined, close: () => undefined, sync: () => undefined } as never,
    openExternal: async () => undefined,
  })
  const preview = keep(deployIpc['deploy:previewPlaybook'])
  const reviewed: Record<string, string> = {}
  const ipc = {
    preflight: keep(deployIpc['release:preflight']),
    // As the wizard does: review the playbook, then start bound to its hash.
    start: async (id: string, confirm: ReleaseConfirm) => {
      const p = await preview(id)
      reviewed[id] = p.playbook
      return keep(deployIpc['release:start'])(id, { ...confirm, playbookSha256: p.sha256 })
    },
    rollback: keep(deployIpc['release:rollback']),
    discard: keep(deployIpc['release:discard']),
    get: keep(deployIpc['release:get']),
    events: keep(deployIpc['release:events']),
    copy: keep(serviceIpc['service:copy']),
    list: keep(serviceIpc['service:list']),
  }
  return { f, svc, ansible, spawned, script, ipc, results, home, reviewed }
}

type World = Awaited<ReturnType<typeof world>>

/** Preflights the services over IPC and waits until the preflight run is done. */
async function preflight(w: World, serviceIds: string[]): Promise<string> {
  const { releaseId } = await w.ipc.preflight({ environmentId: w.f.staging.id, serviceIds, bump: 'none', options: DEFAULT_RELEASE_OPTIONS })
  for (let i = 0; i < 500 && w.svc.detail(releaseId).status === 'preflight'; i++) await new Promise((res) => setImmediate(res))
  return releaseId
}

const byName = (w: World, name: string): ServiceMeta => w.f.services.list(w.f.staging.id).find((s) => s.name === name)!
const commitOf = (w: World, name: string): string | null => (byName(w, name) as AppServiceMeta).lastDeployedCommit
const lastOf = (w: World, kind: string): string => [...w.spawned].reverse().find((s) => s.kind === kind)!.playbook

describe('services deploy end to end', () => {
  it('deploys, rolls back and copies services over FakeAnsible, without leaking a secret', async () => {
    const w = await world()
    const { f, svc } = w
    const esgCheckout = f.deploys.create(
      f.input({ name: 'webapp/esg', repoPath: '/srv/esg', deployTag: 'deploy_esg', managedEnv: true, envTemplate: `A=1\nB=\${secret:${f.secretId}}`, vaultIds: [DEFAULT_VAULT_ID] }),
    )
    const fastCheckout = f.deploys.create(f.input({ name: 'fast-api', repoPath: '/srv/fast-api', deployTag: 'deploy_fast' }))
    const mk = (name: string, deploymentId: string, over: { url?: string; urlCheckFrom?: 'host' | 'mac' } = {}) =>
      f.services.create({ kind: 'service', environmentId: f.staging.id, name, deploymentId, composeService: name, ...over })
    const esg = mk('esg', esgCheckout.id)
    const jsf = mk('js_foundry', esgCheckout.id)
    const fastapi = mk('fastapi-app', fastCheckout.id, { url: 'http://127.0.0.1:8000/health', urlCheckFrom: 'host' })
    const langgraph = mk('langgraph-api', fastCheckout.id)
    const pg = f.services.create({ kind: 'db', environmentId: f.staging.id, name: 'prod-pg', dbEngine: 'postgres', dbAddress: '10.0.0.9' })
    // Both esg services were last deployed at P0 by an earlier, untracked release.
    f.services.recordDeployed([
      { serviceId: esg.id, commit: P0, releaseId: null },
      { serviceId: jsf.id, commit: P0, releaseId: null },
    ])
    const esgCommits = (deployed: string, previous = P0) => ({ 'webapp/esg': { previous, deployed } })

    // 1. R1: esg alone, partial.
    w.script.commits = esgCommits(S1)
    const r1 = await preflight(w, [esg.id])
    expect(svc.detail(r1).status).toBe('ready')
    await w.ipc.start(r1, {})
    await svc.whenIdle()
    const pb1 = lastOf(w, 'release')
    const t1 = tasksOf(pb1)
    // parallel prepare is on by default: the build is launched async, then polled (async_status, no command)
    expect(cmds(t1, 'build', 'webapp_esg')).toEqual([expect.stringMatching(/ build esg$/), ''])
    expect(cmds(t1, 'up', 'webapp_esg').join('\n')).toMatch(/ up -d --no-deps esg$/)
    expect(t1.some((t) => t.deployment === 'fast-api' || t.json.includes('fast-api'))).toBe(false)
    expect(pb1).not.toContain('prod-pg')
    expect(commitOf(w, 'esg')).toBe(S1)
    expect(commitOf(w, 'js_foundry')).toBe(P0)
    expect(svc.detail(r1)).toMatchObject({ status: 'succeeded', serviceCount: 1 })

    // 2. All services: both checkouts whole, in position order; discarded without starting.
    w.script.commits = { ...esgCommits(S2, S1), 'fast-api': { previous: P0, deployed: S2 } }
    const all = await preflight(w, [esg.id, jsf.id, fastapi.id, langgraph.id])
    const allDetail = svc.detail(all)
    expect(allDetail.status).toBe('ready')
    expect(allDetail.runs.map((r) => [r.deploymentName, r.wholeCheckout])).toEqual([
      ['webapp/esg', true],
      ['fast-api', true],
    ])
    // The playbook is generated at start; the preflight one lists the checkouts in the order they'd run.
    expect(allDetail.playbook).toBeNull()
    const pf = tasksOf(lastOf(w, 'preflight'))
    expect([...new Set(pf.flatMap((t) => (t.deployment ? [t.deployment] : [])))]).toEqual(['webapp_esg', 'fast-api'])
    await w.ipc.discard(all)
    expect(f.releases.latestTouching([esg.id, fastapi.id])).toEqual(new Map([[esg.id, r1]]))

    // 3. R2: the whole fast-api checkout, health checked from the host.
    w.script.commits = { 'fast-api': { previous: P0, deployed: S2 } }
    const r2 = await preflight(w, [fastapi.id, langgraph.id])
    await w.ipc.start(r2, {})
    await svc.whenIdle()
    expect(svc.detail(r2).status).toBe('succeeded')
    const t2 = tasksOf(lastOf(w, 'release'))
    expect(cmds(t2, 'build', 'fast-api')).toEqual([expect.stringMatching(/ build$/), ''])
    expect(cmds(t2, 'up', 'fast-api').join('\n')).toMatch(/ up -d$/)
    const health = t2.filter((t) => step(t) === 'health')
    expect(health).toHaveLength(1)
    expect(health[0].json).toContain('curl')
    expect(health[0].json).not.toContain('ansible.builtin.uri')
    expect(health[0].json).not.toContain('delegate_to')
    expect(t2.some((t) => t.deployment === 'webapp_esg' || t.json.includes('webapp'))).toBe(false)

    // 4. R3: js_foundry fails at up; the auto-rollback rebuilds only js_foundry.
    w.script.commits = esgCommits(S3)
    w.script.failStep = 'up'
    const r3 = await preflight(w, [jsf.id])
    await w.ipc.start(r3, {})
    await svc.whenIdle()
    w.script.failStep = undefined
    expect(svc.detail(r3).status).toBe('rolled_back')
    const rb3 = tasksOf(lastOf(w, 'rollback'))
    expect(cmds(rb3, 'rb_build', 'webapp_esg').join('\n')).toMatch(/ build js_foundry$/)
    expect(cmds(rb3, 'rb_up', 'webapp_esg').join('\n')).toMatch(/ up -d --no-deps js_foundry$/)
    expect(commitOf(w, 'js_foundry')).toBe(P0)
    expect(commitOf(w, 'esg')).toBe(S1)

    // 5. Roll back R1 by hand: only esg, back to P0.
    const { releaseId: r4 } = await w.ipc.rollback(r1, {})
    await svc.whenIdle()
    expect(svc.detail(r4).status).toBe('succeeded')
    const rb4 = tasksOf(lastOf(w, 'rollback'))
    expect(cmds(rb4, 'rb_up', 'webapp_esg').join('\n')).toMatch(/ up -d --no-deps esg$/)
    expect(f.releases.get(r4).serviceIds).toEqual([esg.id])
    expect(commitOf(w, 'esg')).toBe(P0)

    // 6. R1 again is refused; R2 is still the latest release for its services, so the real rollback path takes it,
    // and only once.
    await expect(w.ipc.rollback(r1, {})).rejects.toThrow(/^Nothing to roll back: this release was already rolled back$/)
    expect(f.releases.latestTouching([fastapi.id, langgraph.id])).toEqual(
      new Map([
        [fastapi.id, r2],
        [langgraph.id, r2],
      ]),
    )
    const { releaseId: r2back } = await w.ipc.rollback(r2, {})
    await svc.whenIdle()
    expect(svc.detail(r2back).status).toBe('succeeded')
    expect(f.releases.get(r2back).serviceIds).toEqual([fastapi.id, langgraph.id])
    expect(cmds(tasksOf(lastOf(w, 'rollback')), 'rb_up', 'fast-api').join('\n')).toMatch(/ up -d$/)
    await expect(w.ipc.rollback(r2, {})).rejects.toThrow(/^Nothing to roll back: this release was already rolled back$/)

    // 7. A database is never deployed.
    await expect(w.ipc.preflight({ environmentId: f.staging.id, serviceIds: [pg.id], bump: 'none', options: DEFAULT_RELEASE_OPTIONS })).rejects.toThrow(
      /^prod-pg is a database; databases are never deployed$/,
    )

    // 8. Protected staging needs the typed name.
    f.envs.update(f.staging.id, { protected: true })
    w.script.commits = esgCommits(S5)
    const r5 = await preflight(w, [esg.id])
    const err = await w.ipc.start(r5, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).code).toBe('CONFIRM_REQUIRED')
    await w.ipc.start(r5, { typedName: 'staging' })
    await svc.whenIdle()
    expect(svc.detail(r5).status).toBe('succeeded')
    expect(commitOf(w, 'esg')).toBe(S5)

    // 9. Copy to prod on a new host, branch and path.
    const app2 = f.hosts.create({ regionId: REGION, label: 'app2', address: '10.0.0.8' })
    const auditBefore = f.audit.list({ actions: ['services.copy'] }).length
    const copied = await w.ipc.copy({
      sourceEnvironmentId: f.staging.id,
      targetEnvironmentId: f.prod.id,
      checkouts: [esgCheckout, fastCheckout].map((d) => ({ deploymentId: d.id, branch: 'prod-2026', repoPath: `/opt/${d.name}`, hostId: app2.id, deployTag: `prod_${d.id.slice(0, 4)}` })),
      dbs: [{ serviceId: pg.id, dbAddress: '10.1.0.9', dbPort: 5432, viaHostId: app2.id }],
    })
    expect(copied).toMatchObject({ created: { services: 5, checkouts: 2 }, skipped: [] })
    expect(f.audit.list({ actions: ['services.copy'] }).length - auditBefore).toBe(1)
    const prodServices = (await w.ipc.list(f.prod.id)) as ServiceMeta[]
    expect(prodServices.map((s) => (s.kind === 'service' ? s.url : null))).toEqual([null, null, null, null, null])
    for (const d of f.deploys.list(f.prod.id)) {
      expect(d.managedEnv).toBe(false)
      expect(d.envTemplate ?? '').not.toContain('${secret:')
      expect(d.vaultIds ?? []).toEqual([])
    }
    // The target's own rows: no secret id, become secret, vault link or tunnel anywhere.
    const prodCheckoutRows = f.db.prepare('SELECT * FROM deployments WHERE environment_id = ?').all(f.prod.id) as { id: string; become_secret_id: string | null; env_template: string | null }[]
    expect(prodCheckoutRows).toHaveLength(2)
    for (const r of prodCheckoutRows) {
      expect(r.become_secret_id).toBeNull()
      expect(r.env_template ?? '').not.toMatch(/\$\{secret:/)
    }
    const placeholders = prodCheckoutRows.map(() => '?').join(',')
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM deployment_vaults WHERE deployment_id IN (${placeholders})`).get(...prodCheckoutRows.map((r) => r.id))).toEqual({ n: 0 })
    const prodRows = JSON.stringify([prodCheckoutRows, f.db.prepare('SELECT * FROM services WHERE environment_id = ?').all(f.prod.id)])
    expect(prodRows).not.toContain(f.secretId)
    expect(prodRows).not.toContain(SECRET)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM services WHERE environment_id = ? AND tunnel_id IS NOT NULL').get(f.prod.id)).toEqual({ n: 0 })

    // 10. Audit rows carry counts, never a host id or label.
    const rows = f.db.prepare('SELECT * FROM audit_events ORDER BY id').all() as { action: string; details: string }[]
    const hostIds = [f.host.id, app2.id]
    // The deploy, service and config rows; the inventory's own host.create and environment.host rows name their
    // host by design and predate this plan.
    const owned = rows.filter((r) => /^(release|deploy|service|services|config)\./.test(r.action))
    expect(owned.map((r) => r.action)).toEqual(expect.arrayContaining(['release.preflight', 'release.start', 'release.finish', 'release.rollback', 'release.discard', 'services.copy']))
    for (const r of owned) {
      const json = JSON.stringify(r)
      for (const id of hostIds) expect(json).not.toContain(id)
      expect(json).not.toMatch(/\bapp[12]\b/)
    }
    for (const r of rows.filter((x) => x.action.startsWith('release.'))) {
      expect(JSON.parse(r.details)).toEqual(expect.objectContaining({ serviceCount: expect.any(Number), hostCount: expect.any(Number) }))
    }

    // 11. The managed .env secret never leaves the vault. It did reach the runs that render the .env, as the
    // runner's base64 secrets env, and the playbook renders it from there; so the checks below aren't vacuous.
    const handedOver = w.spawned
      .filter((s) => s.kind === 'release' && s.env.OPSDECK_SECRETS)
      .flatMap((s) => Object.values(JSON.parse(s.env.OPSDECK_SECRETS!) as Record<string, string>).map((v) => Buffer.from(v, 'base64').toString('utf8')))
    // Each value is a rendered .env, so the secret sits inside one.
    expect(handedOver.some((v) => v.includes(`B='${SECRET}'`))).toBe(true)
    expect(tasksOf(lastOf(w, 'release')).some((t) => step(t) === 'env' && t.deployment === 'webapp_esg')).toBe(true)
    const ids = svc.list({ limit: 100 }).map((r) => r.id)
    expect(Object.keys(w.reviewed).length).toBe(4)
    for (const id of ids) {
      expect(f.releases.detail(id).playbook ?? '').not.toContain(SECRET)
      if (w.reviewed[id] !== undefined && f.releases.detail(id).kind === 'release') expect(f.releases.detail(id).playbook).toBe(w.reviewed[id])
      expect(JSON.stringify(await w.ipc.get(id))).not.toContain(SECRET)
      expect(JSON.stringify(await w.ipc.events(id, 0, 1000))).not.toContain(SECRET)
    }
    expect(w.spawned.map((s) => s.playbook).join('\n')).not.toContain(SECRET)
    expect(JSON.stringify(rows)).not.toContain(SECRET)
    expect(JSON.stringify(w.results)).not.toContain(SECRET)

    // 12. Config export holds no secrets or release state, and round-trips.
    const out = join(w.home, 'opsdeck-config.json')
    const configIpc = createConfigHandlers({ db: f.db, vault: f.vault, audit: f.audit, now: () => new Date(NOW), saveDialog: async () => out, openDialog: async () => undefined })
    const exported = await configIpc['config:export']()
    expect(exported).toMatchObject({ path: out })
    const text = readFileSync(out, 'utf8')
    expect(text).not.toContain(SECRET)
    for (const sha of [P0, S1, S2, S3, S5]) expect(text).not.toContain(sha)
    for (const id of ids) expect(text).not.toContain(id)
    expect(text).not.toMatch(/lastDeployedCommit|lastReleaseId|currentVersion/)

    const t = await makeInventory()
    new SecretStore(t.db, t.vault, t.audit, { clipboard }).create({ vaultId: DEFAULT_VAULT_ID, name: 'envsecret', kind: 'env', value: 'other-env' })
    const out2 = join(t.home, 'opsdeck-config.json')
    const target = createConfigHandlers({ db: t.db, vault: t.vault, audit: t.audit, now: () => new Date(NOW + 60_000), saveDialog: async () => out2, openDialog: async () => out })
    const preview = await target['config:importOpen']()
    if (!preview || 'errors' in preview) throw new Error(`import preview failed: ${JSON.stringify(preview)}`)
    expect(preview.counts.skip).toBe(0)
    await target['config:importApply'](preview.token, { typedNames: [] })
    await target['config:export']()
    const again = JSON.parse(readFileSync(out2, 'utf8')) as { exportedAt: string }
    const first = JSON.parse(text) as { exportedAt: string }
    expect(again.exportedAt).not.toBe(first.exportedAt)
    expect({ ...again, exportedAt: '' }).toEqual({ ...first, exportedAt: '' })
    const second = await target['config:importOpen']()
    if (!second || 'errors' in second) throw new Error(`second preview failed: ${JSON.stringify(second)}`)
    // Both fixtures have the same region and product ids: those were unchanged the first time too.
    expect(second.counts).toEqual({ add: 0, update: 0, unchanged: preview.counts.add + preview.counts.unchanged, skip: 0 })

    svc.close()
  })
})
