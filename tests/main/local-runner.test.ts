import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalRunner, nodeFs, nodeSpawn, type LocalRunnerDeps, type RunChild, type RunSpawn } from '../../src/main/deploy/local-runner'
import type { RunSecrets } from '../../src/main/deploy/runner'
import { ToolingError } from '../../src/main/deploy/tooling'
import { CANCEL_GRACE_MS, KILL_GRACE_MS, type RunEventBody } from '../../src/shared/deploy'
import { FakeAnsible, TOOLS_OK, fakeAgent, fakePrepare, fakeTap, fixtureLines, memFs, planFixture } from './deploy-helpers'

const R2 = '0190a1b2-c3d4-7e5f-8a6b-000000000002'
const SECRETS: RunSecrets = { values: { env_1: 'sekret-AAA-1', become_1: 'pw-BBB-2' }, known: ['sekret-AAA-1', 'pw-BBB-2'] }

afterEach(() => vi.useRealTimers())

function setup(over: Partial<LocalRunnerDeps> = {}, prep = fakePrepare()) {
  const ansible = new FakeAnsible()
  const fs = memFs()
  const agent = fakeAgent()
  const tap = fakeTap()
  const runner = new LocalRunner({
    tools: async () => TOOLS_OK,
    prepare: prep.fn,
    agent: agent.fn,
    tap: tap.fn,
    spawn: ansible.spawn,
    fs,
    tmpdir: '/tmp',
    home: '/Users/ana',
    userAgentSock: '/private/tmp/com.apple.launchd.x/Listeners',
    ...over,
  })
  const events: RunEventBody[] = []
  runner.onEvent((rid, b) => {
    expect(rid).toBe(planFixture().releaseId)
    events.push(b)
  })
  return { runner, ansible, fs, agent, tap, prep, events }
}

/** Lets queued microtasks (and fake-timer callbacks due now) run. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await vi.advanceTimersByTimeAsync(0).catch(() => Promise.resolve())
  expect(cond()).toBe(true)
}

describe('LocalRunner', () => {
  it('writes the run files, spawns with paths-only argv and a built env', async () => {
    const t = setup()
    let seen: string[] = []
    t.ansible.onSpawn = () => void (seen = [...t.fs.files.keys()].map((f) => f.replace(/^\/tmp\/od-t\d+\//, '')).sort())
    t.ansible.stdout = fixtureLines('release-ok.jsonl')
    const h = t.runner.start(planFixture(), SECRETS)
    expect(h.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await h.done
    expect(seen).toEqual(['ansible.cfg', 'callback_plugins/opsdeck_jsonl.py', 'inventory', 'known_hosts', 'playbook.yml', 'ssh_config'])
    const [call] = t.ansible.calls
    const dir = call.cwd
    expect(dir).toMatch(/^\/tmp\/od-/)
    expect(call.file).toBe(TOOLS_OK.ansiblePlaybook!.path)
    expect(call.args).toEqual(['-i', `${dir}/inventory`, `${dir}/playbook.yml`])
    expect(Object.keys(call.env).sort()).toEqual(
      ['ANSIBLE_CONFIG', 'ANSIBLE_FORCE_COLOR', 'ANSIBLE_HOME', 'ANSIBLE_KEEP_REMOTE_FILES', 'ANSIBLE_LOCAL_TEMP', 'ANSIBLE_NOCOLOR', 'HOME', 'LANG', 'OPSDECK_SECRETS', 'PATH', 'PYTHONUNBUFFERED'].sort(),
    )
    expect(call.env).toMatchObject({
      HOME: '/Users/ana',
      LANG: 'en_US.UTF-8',
      ANSIBLE_CONFIG: `${dir}/ansible.cfg`,
      ANSIBLE_HOME: `${dir}/ah`,
      ANSIBLE_LOCAL_TEMP: `${dir}/tmp`,
      ANSIBLE_KEEP_REMOTE_FILES: '0',
      ANSIBLE_NOCOLOR: '1',
      ANSIBLE_FORCE_COLOR: '0',
      PYTHONUNBUFFERED: '1',
    })
    expect(call.env.SSH_AUTH_SOCK).toBeUndefined()
    expect(call.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    expect(JSON.parse(call.env.OPSDECK_SECRETS)).toEqual({ env_1: Buffer.from('sekret-AAA-1').toString('base64'), become_1: Buffer.from('pw-BBB-2').toString('base64') })
  })

  it('streams translated events in order and resolves the outcome with commits', async () => {
    const t = setup()
    t.ansible.stdout = fixtureLines('release-ok.jsonl')
    const out = await t.runner.start(planFixture(), SECRETS).done
    expect(out).toMatchObject({ exitCode: 0, signal: null, cancelled: false, failedDeploymentRunIds: [], reachedCheckout: [R2], reachedUp: [R2] })
    expect(out.commits[R2]).toEqual({ previous: 'b'.repeat(40), deployed: 'd'.repeat(40) })
    const started = t.events.filter((e) => e.type === 'step.started').map((e) => (e as { stepId: string }).stepId)
    expect(started[0]).toBe('host:host-od-1:lock')
    expect(started).toContain(`${R2}:checkout`)
    expect(started.at(-1)).toBe('host:host-od-1:unlock')
    expect(t.events.at(-1)).toMatchObject({ type: 'step.done', stepId: 'host:host-od-1:unlock', state: 'ok' })
  })

  it('no secret reaches disk, argv, events or audit', async () => {
    const t = setup()
    const task = (name: string, extra: object) =>
      JSON.stringify({ event: 'ok', host: 'od-1', task: name, tags: ['od_step=build', `od_run=${R2}`], no_log: false, rc: 0, truncated: [], ...extra })
    t.ansible.stdout = [
      JSON.stringify({ event: 'task_start', name: 'build dep2', tags: ['od_step=build', `od_run=${R2}`] }),
      task('build dep2', { stdout: 'token=sekret-AAA-1 and b64 ' + Buffer.from('pw-BBB-2').toString('base64') }),
    ]
    t.ansible.stderr = ['ERROR using pw-BBB-2 here']
    let snapshot = ''
    t.ansible.onSpawn = (c) => void (snapshot = JSON.stringify([...t.fs.files.entries()]) + JSON.stringify(c.args))
    const out = await t.runner.start(planFixture(), SECRETS).done
    const all = JSON.stringify(t.events) + JSON.stringify(out) + snapshot
    for (const s of ['sekret-AAA-1', 'pw-BBB-2', Buffer.from('sekret-AAA-1').toString('base64'), Buffer.from('pw-BBB-2').toString('base64')]) expect(all).not.toContain(s)
    const lines = t.events.filter((e): e is Extract<RunEventBody, { type: 'log' }> => e.type === 'log').map((e) => e.line)
    expect(lines.some((l) => l.includes('token=‹redacted›'))).toBe(true)
    expect(lines).toContain('ERROR using ‹redacted› here')
    expect(t.fs.dirs.size).toBe(0)
    expect(t.fs.files.size).toBe(0)

    // errors are redacted too
    const bad = setup({}, fakePrepare({ throws: new Error('dial failed with sekret-AAA-1') }))
    const err = await bad.runner.start(planFixture(), SECRETS).done.catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).not.toContain('sekret-AAA-1')
  })

  it('cleanup runs on failure and on a throw in prepare', async () => {
    const failing = setup({}, fakePrepare({ keys: [{ privateKey: 'KEY', passphrase: 'pp' }] }))
    failing.ansible.exit = { code: 2, signal: null }
    const out = await failing.runner.start(planFixture(), SECRETS).done
    expect(out.exitCode).toBe(2)
    expect(failing.fs.dirs.size).toBe(0)
    expect(failing.prep.log.closed).toBe(1)
    expect(failing.agent.stops).toBe(1)
    expect(failing.tap.taps.length).toBeGreaterThan(0)
    expect(failing.tap.taps.every((x) => x.stopped)).toBe(true)

    const boom = setup({}, fakePrepare({ throws: new Error('boom') }))
    await expect(boom.runner.start(planFixture(), SECRETS).done).rejects.toThrow('boom')
    expect(boom.fs.dirs.size).toBe(0)
    expect(boom.ansible.calls).toHaveLength(0)

    const spawnFails = setup({ spawn: () => { throw new Error('ENOENT') } })
    await expect(spawnFails.runner.start(planFixture(), SECRETS).done).rejects.toThrow('ENOENT')
    expect(spawnFails.fs.dirs.size).toBe(0)
    expect(spawnFails.prep.log.closed).toBe(1)
  })

  it('cancel escalates SIGINT → SIGTERM → SIGKILL on a manual clock', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.ansible.hang = true
    t.ansible.ignore = new Set(['SIGINT', 'SIGTERM'])
    t.ansible.stdout = fixtureLines('release-ok.jsonl').slice(0, 7) // lock, record, fetch, checkout (running)
    const h = t.runner.start(planFixture(), SECRETS)
    await until(() => t.ansible.calls.length === 1)
    await vi.advanceTimersByTimeAsync(0)
    t.runner.cancel(h.runId)
    expect(t.ansible.kills).toEqual(['SIGINT'])
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS - 1)
    expect(t.ansible.kills).toEqual(['SIGINT'])
    await vi.advanceTimersByTimeAsync(1)
    expect(t.ansible.kills).toEqual(['SIGINT', 'SIGTERM'])
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1)
    expect(t.ansible.kills).toEqual(['SIGINT', 'SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    expect(t.ansible.kills).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
    const out = await h.done
    expect(out).toMatchObject({ cancelled: true, signal: 'SIGKILL' })
    const cancelled = t.events.filter((e) => e.type === 'step.done' && e.state === 'cancelled')
    expect(cancelled.length).toBeGreaterThan(0)
    expect(t.fs.dirs.size).toBe(0)
    // a polite exit stops the escalation
    const t2 = setup()
    t2.ansible.hang = true
    const h2 = t2.runner.start(planFixture(), SECRETS)
    await until(() => t2.ansible.calls.length === 1)
    t2.runner.cancel(h2.runId)
    expect((await h2.done).cancelled).toBe(true)
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS + KILL_GRACE_MS)
    expect(t2.ansible.kills).toEqual(['SIGINT'])
  })

  it('missing ansible-playbook fails before creating a run dir', async () => {
    const t = setup({ tools: async () => ({ ...TOOLS_OK, ansiblePlaybook: null, ansibleStatus: 'missing', problems: ['ansible-playbook was not found'] }) })
    await expect(t.runner.start(planFixture(), SECRETS).done).rejects.toBeInstanceOf(ToolingError)
    expect(t.fs.dirs.size).toBe(0)
    expect(t.fs.removed).toEqual([])
    expect(t.prep.log.calls).toBe(0)
    expect(t.ansible.calls).toHaveLength(0)
  })

  it('a key identity starts the private agent; agent-only plans don\'t', async () => {
    const withKey = setup({}, fakePrepare({ keys: [{ privateKey: 'KEYDATA', passphrase: 'pp' }] }))
    await withKey.runner.start(planFixture(), SECRETS).done
    expect(withKey.agent.started).toHaveLength(1)
    expect(withKey.agent.started[0].dir).toMatch(/^\/tmp\/od-/)
    expect(withKey.agent.started[0].ttlSec).toBeGreaterThan(600)
    expect(withKey.agent.added).toEqual([{ privateKey: 'KEYDATA', passphrase: 'pp' }])
    expect(withKey.agent.stops).toBe(1)

    const agentOnly = setup({}, fakePrepare({ userAgentNeeded: true }))
    let cfg = ''
    agentOnly.ansible.onSpawn = () => void (cfg = [...agentOnly.fs.files].find(([p]) => p.endsWith('/ssh_config'))![1])
    await agentOnly.runner.start(planFixture(), SECRETS).done
    expect(agentOnly.agent.started).toHaveLength(0)
    expect(cfg).toContain('/private/tmp/com.apple.launchd.x/Listeners')
  })

  it('tap lines become log events tagged with the step', async () => {
    const t = setup()
    t.ansible.hang = true
    vi.useFakeTimers()
    const h = t.runner.start(planFixture(), SECRETS)
    await until(() => t.tap.taps.length === 2 && t.ansible.calls.length === 1)
    const tap = t.tap.taps[0]
    expect(tap.releaseId).toBe(planFixture().releaseId)
    tap.onLine(`${R2}:build\tStep 3/9 : RUN make with sekret-AAA-1`)
    tap.onLine('something unframed')
    const logs = t.events.filter((e): e is Extract<RunEventBody, { type: 'log' }> => e.type === 'log')
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ stepId: `${R2}:build`, stream: 'out', hostId: 'host-od-1' })
    expect(logs[0].line).not.toContain('sekret-AAA-1')
    expect(logs[1]).toMatchObject({ stepId: null })
    t.runner.cancel(h.runId)
    await h.done
    expect(t.tap.taps.every((x) => x.stopped)).toBe(true)
  })

  const down = (hostId: string) => ({ hostId, id: 'reachable', level: 'block' as const, message: 'Cannot reach host' }) as never

  it('a release is refused when one host fails prepare', async () => {
    const t = setup({}, fakePrepare({ checks: [down('host-od-2')] }))
    const out = await t.runner.start(planFixture(), SECRETS).done
    expect(t.ansible.calls).toHaveLength(0)
    expect(out.exitCode).toBe(1)
    expect(out.failedDeploymentRunIds).toEqual(['0190a1b2-c3d4-7e5f-8a6b-000000000003'])
    expect(t.events.filter((e) => e.type === 'preflight.check')).toHaveLength(1)
    expect(t.fs.dirs.size).toBe(0)
  })

  it.each(['rollback', 'unlock'] as const)('%s still runs on the reachable host and reports the unreachable one failed', async (kind) => {
    const t = setup({}, fakePrepare({ checks: [down('host-od-2')] }))
    let inv = ''
    t.ansible.onSpawn = () => void (inv = [...t.fs.files].find(([f]) => f.endsWith('/inventory'))![1])
    const out = await t.runner.start(planFixture({ kind }), SECRETS).done
    expect(t.ansible.calls).toHaveLength(1)
    expect(inv).toContain('od-1')
    expect(inv).not.toContain('od-2')
    expect(out.failedDeploymentRunIds).toEqual(['0190a1b2-c3d4-7e5f-8a6b-000000000003'])
  })

  it('a cancel during prepare spawns nothing, emits no checks, and double or unknown cancels are no-ops', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const prep = fakePrepare({ checks: [down('host-od-2')] })
    const t = setup({ prepare: async (p) => (await gate, prep.fn(p)) })
    const h = t.runner.start(planFixture(), SECRETS)
    await Promise.resolve()
    t.runner.cancel(h.runId)
    t.runner.cancel(h.runId)
    t.runner.cancel('nope')
    release()
    const out = await h.done
    expect(out.cancelled).toBe(true)
    expect(t.ansible.calls).toHaveLength(0)
    expect(t.events).toEqual([])
    expect(t.fs.dirs.size).toBe(0)
    t.runner.cancel(h.runId)
  })

  it('cleans up when the agent fails to start', async () => {
    const t = setup({ agent: async () => { throw new Error('agent died') } }, fakePrepare({ keys: [{ privateKey: 'K' }] }))
    await expect(t.runner.start(planFixture(), SECRETS).done).rejects.toThrow('agent died')
    expect(t.fs.dirs.size).toBe(0)
    expect(t.prep.log.closed).toBe(1)
  })

  it('creates the real run dir 0700', async () => {
    const base = mkdtempSync(join(tmpdir(), 'od-fs-'))
    try {
      const d = await nodeFs.mkdtemp(join(base, 'od-'))
      expect(statSync(d).mode & 0o777).toBe(0o700)
      await nodeFs.mkdir(join(d, 'x'))
      expect(statSync(join(d, 'x')).mode & 0o777).toBe(0o700)
      await nodeFs.writeFile(join(d, 'f'), 'y')
      expect(statSync(join(d, 'f')).mode & 0o777).toBe(0o600)
      await nodeFs.rm(d)
      expect(() => statSync(d)).toThrow()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('an error event after a successful spawn waits for close before cleanup', async () => {
    const handlers: Record<string, ((...a: never[]) => void)[]> = {}
    const emit = (ev: string, ...a: unknown[]): void => (handlers[ev] ?? []).forEach((h) => (h as (...x: unknown[]) => void)(...a))
    const spawn: RunSpawn = () =>
      ({
        pid: 4242,
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: ((ev: string, cb: never) => void (handlers[ev] ??= []).push(cb)) as RunChild['on'],
        kill: () => true,
      }) as RunChild
    const s = setup({ spawn })
    let settled = false
    const h = s.runner.start(planFixture(), SECRETS)
    void h.done.then(() => (settled = true), () => (settled = true))
    await vi.waitFor(() => expect(handlers.close?.length).toBe(1))
    emit('error', new Error('kill EPERM'))
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    expect(s.fs.removed).toEqual([])
    emit('close', 0, null)
    await h.done
    expect(s.fs.removed.length).toBe(1)
  })

  it('an error with no pid still rejects (nothing was spawned)', async () => {
    const spawn: RunSpawn = () => {
      const handlers: Record<string, ((...a: never[]) => void)[]> = {}
      queueMicrotask(() => (handlers.error ?? []).forEach((h) => (h as (e: Error) => void)(new Error('spawn ansible-playbook ENOENT'))))
      return {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: ((ev: string, cb: never) => void (handlers[ev] ??= []).push(cb)) as RunChild['on'],
        kill: () => true,
      } as RunChild
    }
    const s = setup({ spawn })
    await expect(s.runner.start(planFixture(), SECRETS).done).rejects.toThrow('could not start')
    expect(s.fs.removed.length).toBe(1)
  })

  it('nodeSpawn runs detached and signals the whole process group', () => {
    const calls: { file: string; opts: Record<string, unknown> }[] = []
    const kills: [number, string][] = []
    const inner = { pid: 777, stdout: { on: () => undefined }, stderr: { on: () => undefined }, on: () => undefined, kill: vi.fn(() => true) } as unknown as RunChild
    const spawn = nodeSpawn({
      spawn: (file, _args, opts) => {
        calls.push({ file, opts })
        return inner
      },
      kill: (pid, sig) => void kills.push([pid, sig]),
    })
    const child = spawn('ansible-playbook', ['x'], { cwd: '/tmp/od-1', env: {} })
    expect(calls[0].opts).toMatchObject({ detached: true, cwd: '/tmp/od-1' })
    expect(child.pid).toBe(777)
    child.kill('SIGINT')
    expect(kills).toEqual([[-777, 'SIGINT']])
    expect(inner.kill).not.toHaveBeenCalled()
  })

  it('nodeSpawn falls back to the child kill when the group kill throws', () => {
    const inner = { pid: 9, stdout: { on: () => undefined }, stderr: { on: () => undefined }, on: () => undefined, kill: vi.fn(() => true) } as unknown as RunChild
    const spawn = nodeSpawn({ spawn: () => inner, kill: () => { throw new Error('ESRCH') } })
    spawn('a', [], { cwd: '/', env: {} }).kill('SIGTERM')
    expect(inner.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
