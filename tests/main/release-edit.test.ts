import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/main/deploy/access'
import { maskDetail } from '../../src/main/deploy/mask'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { EDIT_INVALID_MESSAGE, PLAYBOOK_CHANGED_MESSAGE, ROLLBACK_GENERATED_NOTE } from '../../src/shared/deploy'
import { A, B, dep, opReady, ready, rig, runbook, tracked, type Rig } from './release-rig'

/** Task 10b: a reviewed playbook, edited once, runs in place of the generated one. */
const EXTRA = { name: 'extra', 'ansible.builtin.shell': 'echo extra-step', timeout: 30, tags: ['extra'] }
const runIds = (plan: DeployPlan): string[] => plan.deployments.map((d) => d.runId)
const audits = (r: Rig, action: string) => r.f.audit.list({ actions: [action as never] })

/** The preview with one harmless task added to its first play, and the hash `validateEdit` binds it to. */
async function edited(r: Rig, id: string): Promise<{ generated: string; text: string; sha256: string }> {
  const p = await r.svc.previewPlaybook(id)
  const plays = JSON.parse(p.playbook) as Record<string, unknown[]>[]
  plays[0].tasks.push(EXTRA)
  const res = await r.svc.validateEdit(id, JSON.stringify(plays, null, 2))
  if (!res.ok) throw new Error(JSON.stringify(res.errors))
  return { generated: p.playbook, text: res.canonical, sha256: res.sha256 }
}

describe('ReleaseService edited runs', () => {
  it('runs the edited text, stores it beside the generated one and audits only the line delta', async () => {
    const r = await rig()
    const id = await ready(r)
    const e = await edited(r, id)
    expect(e.text).toContain('echo extra-step')
    await r.svc.start(id, { editedPlaybook: e.text, playbookSha256: e.sha256 })
    await r.svc.whenIdle()
    expect(r.runner.call('release').playbookText).toBe(e.text)
    const d = r.svc.detail(id)
    expect(d.status).toBe('succeeded')
    expect(d.playbook).toBe(e.text)
    expect(d.playbookGenerated).toBe(e.generated)
    expect(d.playbookSource).toBe('edited')
    const [ev] = audits(r, 'playbook.edited')
    expect(ev.outcome).toBe('success')
    expect(ev.details).toEqual({ lineDelta: e.text.split('\n').length - e.generated.split('\n').length })
    expect(JSON.stringify(ev.details)).not.toContain('extra')
  })

  it('an edit that equals the generated playbook runs as generated', async () => {
    const r = await rig()
    const id = await ready(r)
    const p = await r.svc.previewPlaybook(id)
    const res = await r.svc.validateEdit(id, p.playbook)
    if (!res.ok) throw new Error('rejected')
    await r.svc.start(id, { editedPlaybook: res.canonical, playbookSha256: res.sha256 })
    await r.svc.whenIdle()
    expect(r.runner.call('release').playbookText).toBeUndefined()
    expect(r.svc.detail(id).playbookSource).toBe('generated')
    expect(audits(r, 'playbook.edited')).toEqual([])
  })

  it('refuses an edit whose hash is not the validated one, before anything runs', async () => {
    const r = await rig()
    const id = await ready(r)
    const e = await edited(r, id)
    const changed = e.text.replace('echo extra-step', 'echo other-step')
    const err = await r.svc.start(id, { editedPlaybook: changed, playbookSha256: e.sha256 }).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).message).toBe(PLAYBOOK_CHANGED_MESSAGE)
    await expect(r.svc.start(id, { editedPlaybook: e.text })).rejects.toThrow(PLAYBOOK_CHANGED_MESSAGE)
    expect(r.runner.kinds).toEqual(['preflight'])
    expect(r.svc.detail(id).status).toBe('ready')
    expect(audits(r, 'playbook.edited')).toEqual([])
  })

  it('validates the edit again at start and refuses one that fails its checks', async () => {
    const r = await rig()
    const id = await ready(r)
    const p = await r.svc.previewPlaybook(id)
    const plays = JSON.parse(p.playbook) as Record<string, unknown[]>[]
    plays[0].tasks.push({ name: 'leak', 'ansible.builtin.debug': { msg: '{{ s }}' } })
    const err = await r.svc.start(id, { editedPlaybook: JSON.stringify(plays), playbookSha256: p.sha256 }).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(DeployError)
    expect((err as DeployError).code).toBe('VALIDATION')
    expect((err as Error).message.startsWith(EDIT_INVALID_MESSAGE)).toBe(true)
    expect(r.runner.kinds).toEqual(['preflight'])
    expect(r.svc.detail(id).status).toBe('ready')
  })

  it('masks both stored texts in the detail', async () => {
    const r = await rig()
    const id = await ready(r)
    const e = await edited(r, id)
    await r.svc.start(id, { editedPlaybook: e.text, playbookSha256: e.sha256 })
    await r.svc.whenIdle()
    expect(e.generated).toContain('/srv/api')
    const m = maskDetail(r.svc.detail(id), ['/srv/api', 'extra-step'])
    expect(m.playbook).not.toContain('extra-step')
    expect(m.playbook).not.toContain('/srv/api')
    expect(m.playbookGenerated).not.toContain('/srv/api')
    expect(m.playbookGenerated).toContain('‹redacted›')
  })

  it('an auto-rollback of an edited release says the rollback was generated', async () => {
    const r = await rig()
    const id = await ready(r, [dep(r, 'one')])
    r.runner.on.release = (plan) => {
      const [r1] = runIds(plan)
      return { exitCode: 2, failedDeploymentRunIds: [r1], reachedCheckout: [r1], commits: { [r1]: { previous: A } } }
    }
    const e = await edited(r, id)
    await r.svc.start(id, { editedPlaybook: e.text, playbookSha256: e.sha256 })
    await r.svc.whenIdle()
    expect(r.runner.kinds).toEqual(['preflight', 'release', 'rollback', 'unlock'])
    expect(r.runner.call('rollback').playbookText).toBeUndefined()
    const d = r.svc.detail(id)
    expect(d.status).toBe('rolled_back')
    expect(d.releaseNotes).toContain(ROLLBACK_GENERATED_NOTE)
  })

  it('a manual rollback of an edited release runs the generated rollback and notes it', async () => {
    const r = await rig()
    r.f.deploys.updateSettings(r.f.staging.id, { autoRollback: false })
    const id = await ready(r, [dep(r, 'one')])
    r.runner.on.release = (plan) => ({ commits: Object.fromEntries(runIds(plan).map((x) => [x, { previous: A, deployed: B }])) })
    const e = await edited(r, id)
    await r.svc.start(id, { editedPlaybook: e.text, playbookSha256: e.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')
    const { releaseId } = await r.svc.rollback(id, {})
    await r.svc.whenIdle()
    expect(r.runner.call('rollback').playbookText).toBeUndefined()
    const rb = r.svc.detail(releaseId)
    expect(rb.playbookSource).toBe('generated')
    expect(rb.playbook).not.toContain('echo extra-step')
    expect(rb.releaseNotes).toBe(ROLLBACK_GENERATED_NOTE)
  })

  it('an operation runs an edit the same way and keeps its builds empty', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const [svcA] = tracked(r, d)
    const rb = runbook(r, [svcA.id])
    const id = await opReady(r, rb)
    const e = await edited(r, id)
    await r.svc.start(id, { editedPlaybook: e.text, playbookSha256: e.sha256 })
    await r.svc.whenIdle()
    const plan = r.runner.call('operation')
    expect(plan.playbookText).toBe(e.text)
    expect(plan.killBuilds ?? []).toEqual([])
    const done = r.svc.detail(id)
    expect(done.status).toBe('succeeded')
    expect(done.playbookSource).toBe('edited')
    expect(done.playbookGenerated).toBe(e.generated)
    expect(audits(r, 'playbook.edited').map((x) => x.details)).toEqual([{ lineDelta: e.text.split('\n').length - e.generated.split('\n').length }])
  })
})
