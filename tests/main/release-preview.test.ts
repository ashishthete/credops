import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/main/deploy/access'
import { PLAYBOOK_CHANGED_MESSAGE, PREVIEW_TTL_MS } from '../../src/main/deploy/release-service'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { NOW, SECRET, dep, ready, rig, type Rig } from './release-rig'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** Everything a preview could have written: rows, events, audit, runs, live state. */
const snapshot = (r: Rig, id: string) => ({
  detail: r.svc.detail(id),
  events: r.svc.events(id, 0),
  audit: r.f.audit.list({}).length,
  kinds: [...r.runner.kinds],
  busy: r.svc.isBusy(id),
  states: r.states.length,
})

describe('ReleaseService.previewPlaybook', () => {
  it('previews exactly the playbook start stores, bound by its sha256', async () => {
    const r = await rig()
    const id = await ready(r)
    const p = await r.svc.previewPlaybook(id)
    expect(p.sha256).toBe(sha(p.playbook))
    expect(JSON.parse(p.playbook)).toBeInstanceOf(Array)
    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    const d = r.svc.detail(id)
    expect(d.status).toBe('succeeded')
    expect(d.playbook).toBe(p.playbook)
  })

  it('still matches when the review took a while (the lock keeps the reviewed start time)', async () => {
    let now = NOW
    const r = await rig({ now: () => new Date(now) })
    const id = await ready(r)
    const p = await r.svc.previewPlaybook(id)
    now += 5 * 60_000
    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).playbook).toBe(p.playbook)
  })

  it('a review older than the limit is refused and must be done again', async () => {
    let now = NOW
    const r = await rig({ now: () => new Date(now) })
    const id = await ready(r)
    const old = await r.svc.previewPlaybook(id)
    now += PREVIEW_TTL_MS + 1
    await expect(r.svc.start(id, { playbookSha256: old.sha256 })).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    const fresh = await r.svc.previewPlaybook(id)
    await r.svc.start(id, { playbookSha256: fresh.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).playbook).toBe(fresh.playbook)
  })

  it('writes nothing, takes no lock, decrypts nothing and starts no agent', async () => {
    const r = await rig()
    const d = dep(r, 'api', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}` })
    const id = await ready(r, [d])
    const before = snapshot(r, id)
    await r.svc.previewPlaybook(id)
    await r.svc.previewPlaybook(id)
    expect(snapshot(r, id)).toEqual(before)
    expect(r.valueCalls).toEqual([])
    expect(r.runner.calls.map((c) => c.plan.kind)).toEqual(['preflight'])
  })

  it('a settings edit after the review refuses the start and writes nothing', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const id = await ready(r, [d])
    const p = await r.svc.previewPlaybook(id)
    r.f.deploys.update(d.id, { healthTimeoutSec: 99 })
    const before = snapshot(r, id)
    const err = await r.svc.start(id, { playbookSha256: p.sha256 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).code).toBe('INVALID_STATE')
    expect((err as DeployError).message).toBe(PLAYBOOK_CHANGED_MESSAGE)
    expect(snapshot(r, id)).toEqual(before)
    expect(r.svc.detail(id).status).toBe('ready')
    expect(r.svc.detail(id).playbook).toBeNull()
    expect(r.valueCalls).toEqual([])
  })

  it('a hash that was never previewed is refused', async () => {
    const r = await rig()
    const id = await ready(r)
    await expect(r.svc.start(id, { playbookSha256: 'f'.repeat(64) })).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    expect(r.runner.kinds).toEqual(['preflight'])
    expect(r.f.audit.list({ actions: ['release.start'] })).toEqual([])
  })

  it('carries no secret value: the fixture secret and literal .env values are absent', async () => {
    const r = await rig()
    const d = dep(r, 'api', { managedEnv: true, vaultIds: [DEFAULT_VAULT_ID], envTemplate: `TOKEN=\${secret:${r.f.secretId}}\nMODE=literal-env-value` })
    const id = await ready(r, [d])
    const p = await r.svc.previewPlaybook(id)
    expect(p.playbook).not.toContain(SECRET)
    expect(p.playbook).not.toContain('literal-env-value')
    expect(p.playbook).toContain('OPSDECK_SECRETS')
    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).playbook).toBe(p.playbook)
  })

  it('refuses a release that cannot start', async () => {
    const r = await rig()
    r.runner.checks = [{ id: 'repo', deploymentId: null, hostId: r.f.host.id, label: 'api', level: 'block', message: 'missing repo' }]
    const id = await ready(r)
    await expect(r.svc.previewPlaybook(id)).rejects.toThrow(/blocked/)
  })
})
