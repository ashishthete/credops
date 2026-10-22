import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/main/deploy/access'
import { maskDetail, maskPlaybook } from '../../src/main/deploy/mask'
import { EDIT_RULE } from '../../src/main/deploy/playbook-validate'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { EDIT_INVALID_MESSAGE, PLAYBOOK_CHANGED_MESSAGE, ROLLBACK_GENERATED_NOTE } from '../../src/shared/deploy'
import { LOCK_FREE_EDIT_MESSAGE } from '../../src/shared/runbooks'
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

  it('refuses to check or start an edit of a lock-free runbook, before anything runs; a locking one stays editable', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const ids = tracked(r, d).map((x) => x.id)
    const logs = (lock: boolean) => runbook(r, ids, { name: `Logs ${lock}`, items: [{ type: 'builtin', builtin: 'logs', tail: 20 }], lock })
    const refused = async (p: Promise<unknown>) => {
      const err = await p.catch((x: unknown) => x)
      expect(err).toBeInstanceOf(DeployError)
      expect((err as DeployError).code).toBe('VALIDATION')
      expect((err as DeployError).message).toBe(LOCK_FREE_EDIT_MESSAGE)
    }
    const id = await opReady(r, logs(false))
    expect(r.svc.detail(id).operation).toMatchObject({ readOnly: true, lock: false })
    const p = await r.svc.previewPlaybook(id)
    await refused(r.svc.validateEdit(id, p.playbook))
    // A start that never called validateEdit, with a hash made up or taken from the preview.
    await refused(r.svc.start(id, { editedPlaybook: `${p.playbook}\n`, playbookSha256: p.sha256 }))
    await refused(r.svc.start(id, { editedPlaybook: p.playbook, playbookSha256: 'f'.repeat(64) }))
    expect(r.svc.detail(id).status).toBe('ready')
    expect(r.runner.kinds).not.toContain('operation')
    expect(audits(r, 'playbook.edited')).toEqual([])
    // Run as generated it still runs.
    await r.svc.start(id, { playbookSha256: p.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(id).status).toBe('succeeded')

    // The same read-only runbook with locking on can be edited.
    const locked = await opReady(r, logs(true))
    const e = await edited(r, locked)
    await r.svc.start(locked, { editedPlaybook: e.text, playbookSha256: e.sha256 })
    await r.svc.whenIdle()
    expect(r.svc.detail(locked).playbookSource).toBe('edited')
  })

  it('a lock-free read-only operation still runs beside a release', async () => {
    const r = await rig()
    const d = dep(r, 'api')
    const ids = tracked(r, d).map((x) => x.id)
    const rel = await ready(r, [d])
    const op = await opReady(r, runbook(r, ids, { name: 'Logs', items: [{ type: 'builtin', builtin: 'logs', tail: 20 }], lock: false }))
    let open!: () => void
    const gate = new Promise<void>((res) => (open = res))
    r.runner.on.release = async () => {
      await gate
    }
    await r.svc.start(rel, {})
    await r.svc.start(op, {})
    open()
    await r.svc.whenIdle()
    expect(r.svc.detail(op).status).toBe('succeeded')
    expect(r.svc.detail(rel).status).toBe('succeeded')
  })

  describe('masked secrets', () => {
    /** The repo path stands for a secret value that the generated playbook holds; the preview shows it masked. */
    const HIDDEN = '/srv/api'
    const masked = async (r: Rig, id: string) => maskPlaybook((await r.svc.previewPlaybook(id)).playbook, [HIDDEN])
    const withTask = (text: string, task: Record<string, unknown>, at: (plays: Record<string, any>[]) => unknown[] = (p) => p[0].tasks) => {
      const plays = JSON.parse(text) as Record<string, any>[]
      at(plays).push(task)
      return JSON.stringify(plays, null, 2)
    }
    const inBlock = (p: Record<string, any>[]) => p[0].tasks.find((t: Record<string, any>) => t.block).block as unknown[]

    it('an unrelated edit runs with the raw value and is shown masked', async () => {
      const r = await rig({ knownSecrets: () => [HIDDEN] })
      const id = await ready(r)
      const shown = await masked(r, id)
      expect(shown).not.toContain(HIDDEN)
      const text = withTask(shown, EXTRA, inBlock)
      const res = await r.svc.validateEdit(id, text)
      if (!res.ok) throw new Error(JSON.stringify(res.errors))
      expect(res.canonical).toContain(HIDDEN)
      expect(res.canonical).not.toContain('‹redacted›')
      // The renderer sends back what it was shown: the masked canonical text.
      await r.svc.start(id, { editedPlaybook: maskPlaybook(res.canonical, [HIDDEN]), playbookSha256: res.sha256 })
      await r.svc.whenIdle()
      expect(r.runner.call('release').playbookText).toBe(res.canonical)
      const d = r.svc.detail(id)
      expect(d.playbook).toBe(res.canonical)
      expect(d.playbookSource).toBe('edited')
      const m = maskDetail(d, [HIDDEN])
      expect(m.playbook).not.toContain(HIDDEN)
      expect(m.playbookGenerated).not.toContain(HIDDEN)
    })

    it('rejects an edit that changes a masked task, at validate and at start', async () => {
      const r = await rig({ knownSecrets: () => [HIDDEN] })
      const id = await ready(r)
      const shown = await masked(r, id)
      const plays = JSON.parse(shown) as Record<string, any>[]
      const target = JSON.stringify(plays).includes('‹redacted›') ? plays[0].tasks.find((t: Record<string, any>) => JSON.stringify(t).includes('‹redacted›')) : null
      expect(target).toBeTruthy()
      target.name = `${target.name} changed`
      const text = JSON.stringify(plays, null, 2)
      const res = await r.svc.validateEdit(id, text)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.errors.map((e) => e.message)).toContain(EDIT_RULE.masked)
      const p = await r.svc.previewPlaybook(id)
      await expect(r.svc.start(id, { editedPlaybook: text, playbookSha256: p.sha256 })).rejects.toThrow(EDIT_INVALID_MESSAGE)
      expect(r.runner.kinds).toEqual(['preflight'])
    })

    it('rejects the marker in a new task', async () => {
      const r = await rig({ knownSecrets: () => [HIDDEN] })
      const id = await ready(r)
      const text = withTask(await masked(r, id), { ...EXTRA, 'ansible.builtin.shell': 'echo ‹redacted›' }, inBlock)
      const res = await r.svc.validateEdit(id, text)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.errors.map((e) => e.message)).toEqual([EDIT_RULE.masked])
    })
  })
})
