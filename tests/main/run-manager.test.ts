import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  MAX_ACTIVE_RUNS,
  MAX_RUN_TARGETS,
  MAX_RUNS_KEPT,
  OUTPUT_FLUSH_CHARS,
  RUN_OUTPUT_CHARS,
  type RunRequest,
} from '../../src/shared/ops'
import { VAULT_LOCKED } from '../../src/shared/vault'
import type { AuditEvent } from '../../src/shared/audit'
import type { EventContract } from '../../src/shared/ipc'
import { createOpsHandlers } from '../../src/main/ipc/handlers/ops'
import type { ContainerService } from '../../src/main/ops/containers'
import { CONFIRM_MESSAGE, MULTIPLE_PROTECTED_MESSAGE } from '../../src/main/ops/protect'
import { CANCELLED_RUNNING } from '../../src/main/ops/run-manager'
import { auditRows } from './vault-helpers'
import { GATED, STAGING_HOSTS, makeRunSetup } from './ops-helpers'
import { startServer } from './ssh-server'

type Setup = Awaited<ReturnType<typeof makeRunSetup>>

const text = (t: string): RunRequest['command'] => ({ kind: 'text', text: t })
const onEnv = (t: Setup, env: 'staging' | 'prod', role?: 'app' | 'db'): RunRequest['target'] => ({
  kind: 'environment',
  environmentId: t[env].id,
  ...(role ? { role } : {}),
})
const onHosts = (t: Setup, labels: string[], environmentId?: string): RunRequest['target'] => ({
  kind: 'hosts',
  hostIds: labels.map((l) => t.ids[l]!),
  ...(environmentId ? { environmentId } : {}),
})
// audit.list() is newest first.
const runRows = (t: Setup): AuditEvent[] => t.audit.list().filter((e) => e.action.startsWith('run.')).reverse()

describe('RunManager', () => {
  it('runs on every host in an environment and reports per-host exit codes', async () => {
    const t = await makeRunSetup()
    const started = t.runs.start({ target: onEnv(t, 'staging'), command: text('test "$OD_HOST" != db-2') })
    expect(started.state).toBe('running')
    expect(started.hosts.map((h) => [h.label, h.state])).toEqual(STAGING_HOSTS.map((h) => [h.label, 'queued']))
    expect(started.environmentName).toBe('staging')

    const run = await t.finished(started.id)
    expect(run.state).toBe('done')
    expect(run.hosts.map((h) => [h.label, h.state, h.exitCode])).toEqual([
      ['app-1', 'ok', 0],
      ['app-2', 'ok', 0],
      ['app-3', 'ok', 0],
      ['db-1', 'ok', 0],
      ['db-2', 'failed', 1],
    ])
    for (const h of STAGING_HOSTS) {
      const last = h.label === 'db-2' ? 'failed' : 'ok'
      expect(t.hostEvents(run.id, t.ids[h.label]!)).toEqual(['queued', 'connecting', 'running', last])
    }
    const runEvents = t.events.filter((e) => e.runId === run.id && e.kind === 'run')
    expect(runEvents.at(-1)).toMatchObject({ kind: 'run', run: { state: 'done' } })
  })

  it('a role filter picks only that role\'s hosts', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onEnv(t, 'staging', 'db'), command: text('true') })
    expect(run.hosts.map((h) => h.label)).toEqual(['db-1', 'db-2'])
    expect((await t.finished(run.id)).hosts.map((h) => h.state)).toEqual(['ok', 'ok'])
  })

  it('resolves host targets in the given order without duplicates, and refuses empty or oversized targets', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['db-1', 'app-2', 'db-1']), command: text('true') })
    expect(run.hosts.map((h) => h.label)).toEqual(['db-1', 'app-2'])
    expect(run.environmentId).toBeNull()
    await t.finished(run.id)
    t.envs.create({ name: 'empty', color: '#aabbcc' })
    const empty = t.envs.list().find((e) => e.name === 'empty')!
    expect(() => t.runs.start({ target: { kind: 'environment', environmentId: empty.id }, command: text('true') })).toThrow(
      /^No hosts match this target$/,
    )
    expect(() => t.runs.start({ target: onEnv(t, 'staging', 'bastion' as 'app'), command: text('true') })).toThrow(
      /^No hosts match this target$/,
    )
    const many = Array.from({ length: MAX_RUN_TARGETS + 1 }, () => randomUUID())
    expect(() => t.runs.start({ target: { kind: 'hosts', hostIds: many }, command: text('true') })).toThrow(/too many hosts/)
  })

  it('the run title is the first line of the command (60 chars at most) or the snippet label', async () => {
    const t = await makeRunSetup()
    const long = `echo ${'x'.repeat(80)}`
    const a = t.runs.start({ target: onHosts(t, ['app-1']), command: text(`\n${long}\necho two`) })
    expect(a.title.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(a.title.replace(/…$/, ''))).toBe(true)
    const s = t.snippets.create({ label: 'Disk usage', script: 'df -h' })
    const b = t.runs.start({ target: onHosts(t, ['app-1']), command: { kind: 'snippet', snippetId: s.id, values: {} } })
    expect(b.title).toBe('Disk usage')
    await t.finished(a.id)
    await t.finished(b.id)
  })

  it('never exceeds the concurrency limit', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onEnv(t, 'staging'), command: text(GATED), concurrency: 2 })
    await t.waitFor(() => expect(t.server.execs()).toHaveLength(2))
    // Give a third exec time to start if the limit were broken.
    await new Promise((r) => setTimeout(r, 200))
    expect(t.server.execs()).toHaveLength(2)
    expect(run.hosts.filter((h) => t.host(run, h.label).state === 'queued')).toHaveLength(3)
    t.openGate()
    const done = await t.finished(run.id)
    expect(done.hosts.every((h) => h.state === 'ok')).toBe(true)
    expect(t.maxLive()).toBe(2)
  })

  it('streams output in batched chunks per host and caps buffered output at RUN_OUTPUT_CHARS', async () => {
    const t = await makeRunSetup()
    const total = 400_000
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text(`yes | head -c ${total}`) })
    const done = await t.finished(run.id)
    expect(done.hosts[0]).toMatchObject({ state: 'ok', truncated: true })
    const { output } = t.runs.get(run.id)
    expect(output).toHaveLength(1)
    expect(output[0]!.hostId).toBe(t.ids['app-1'])
    expect(output[0]!.text).toHaveLength(RUN_OUTPUT_CHARS)
    expect(output[0]!.text.endsWith('y\ny\n')).toBe(true)
    const chunks = t.outputEvents(run.id, t.ids['app-1'])
    expect(chunks.map((c) => c.chunk).join('')).toHaveLength(total)
    expect(chunks.length).toBeGreaterThanOrEqual(Math.floor(total / OUTPUT_FLUSH_CHARS) - 1)
    expect(chunks.length).toBeLessThan(100)
  })

  it('flags a host truncated as soon as its output passes RUN_OUTPUT_CHARS, even by a little', async () => {
    const t = await makeRunSetup()
    const total = RUN_OUTPUT_CHARS + 1000
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text(`yes | head -c ${total}`) })
    const done = await t.finished(run.id)
    expect(done.hosts[0]).toMatchObject({ state: 'ok', truncated: true })
    const streamed = t.outputEvents(run.id).map((c) => c.chunk).join('')
    expect(streamed).toHaveLength(total)
    const { run: got, output } = t.runs.get(run.id)
    expect(got.hosts[0]!.truncated).toBe(true)
    expect(output[0]!.text).toBe(streamed.slice(-RUN_OUTPUT_CHARS))
  })

  it('output events carry monotonic end offsets that add up to the snapshot total', async () => {
    const t = await makeRunSetup()
    const total = RUN_OUTPUT_CHARS + 1000
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text(`yes | head -c ${total}`) })
    await t.finished(run.id)
    const chunks = t.outputEvents(run.id)
    let end = 0
    for (const c of chunks) {
      end += c.chunk.length
      expect(c.end).toBe(end)
    }
    expect(end).toBe(total)
    expect(t.runs.get(run.id).output[0]!.total).toBe(total)
  })

  it('a snapshot taken while output is still pending reports its total', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text('printf abc; sleep 30') })
    await t.waitFor(() => {
      if (t.runs.get(run.id).output[0]?.total !== 3) throw new Error('no output yet')
    })
    t.runs.cancel(run.id)
    await t.finished(run.id)
    expect(t.outputEvents(run.id).at(-1)).toMatchObject({ end: 3 })
  })

  it('tints stderr: chunks carry stream err and the buffer records their ranges', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text('printf out; sleep 0.1; printf err >&2') })
    await t.finished(run.id)
    const { output } = t.runs.get(run.id)
    expect(output[0]).toEqual({ hostId: t.ids['app-1'], text: 'outerr', errRanges: [[3, 6]], total: 6 })
    const chunks = t.outputEvents(run.id)
    expect(chunks.find((c) => c.chunk === 'err')).toMatchObject({ stream: 'err' })
    expect(chunks.find((c) => c.chunk === 'out')).not.toHaveProperty('stream')
  })

  it('host state events come after that host\'s output', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text('printf last') })
    await t.finished(run.id)
    const mine = t.events.filter((e) => e.runId === run.id)
    const out = mine.findIndex((e) => e.kind === 'output')
    const final = mine.findIndex((e) => e.kind === 'host' && e.host.state === 'ok')
    expect(out).toBeGreaterThanOrEqual(0)
    expect(out).toBeLessThan(final)
  })

  it('cancel skips queued hosts and interrupts running ones', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1', 'app-2', 'app-3']), command: text('sleep 30'), concurrency: 1 })
    await t.reached(run, 'app-1', 'running')
    await t.waitFor(() => expect(t.sh.running()).toBe(1))
    const cancelled = await t.runs.cancel(run.id)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.hosts.map((h) => h.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(cancelled.hosts[0]!.error).toEqual({ code: 'closed', message: CANCELLED_RUNNING })
    expect(CANCELLED_RUNNING).toBe('Cancelled (the command may still be running on the host)')
    expect(t.server.signals()).toContain('INT')
    expect(t.server.execs()).toHaveLength(1)
    // Idempotent, and a no-op once finished.
    expect((await t.runs.cancel(run.id)).state).toBe('cancelled')
    expect(runRows(t).filter((e) => e.action === 'run.finish')).toHaveLength(1)
  })

  it('a host that hangs past the timeout ends as timeout', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1', 'app-2']), command: text('[ "$OD_HOST" = app-2 ] || sleep 30'), timeoutSec: 1 })
    const done = await t.finished(run.id)
    expect(done.state).toBe('done')
    expect(done.hosts.map((h) => h.state)).toEqual(['timeout', 'ok'])
    expect(done.hosts[0]!.error?.code).toBe('timeout')
    expect(done.hosts[0]!.error?.message).toMatch(/may still be running on the host/)
    expect(t.server.signals()).toContain('INT')
  })

  it('a run whose only host timed out finishes as a failure', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text('sleep 30'), timeoutSec: 1 })
    const done = await t.finished(run.id)
    expect(done).toMatchObject({ state: 'done', hosts: [{ state: 'timeout' }] })
    expect(runRows(t).at(-1)).toMatchObject({
      action: 'run.finish',
      outcome: 'failure',
      details: { ok: 0, failed: 0, cancelled: 0, timeout: 1 },
    })
  })

  it('a host that fails to resolve fails alone', async () => {
    const t = await makeRunSetup()
    const command = text(`[ "$OD_HOST" != app-1 ] || ${GATED}`)
    const run = t.runs.start({ target: onEnv(t, 'staging'), command, concurrency: 1 })
    await t.reached(run, 'app-1', 'running')
    // Deleted after the run resolved its targets and before its turn to dial.
    t.hosts.delete(t.ids['db-2']!)
    t.openGate()
    const done = await t.finished(run.id)
    expect(done.hosts.map((h) => [h.label, h.state])).toEqual([
      ['app-1', 'ok'],
      ['app-2', 'ok'],
      ['app-3', 'ok'],
      ['db-1', 'ok'],
      ['db-2', 'failed'],
    ])
    expect(done.hosts[4]!.error).toMatchObject({ code: 'unknown', message: expect.any(String) })
    expect(done.hosts[4]!.exitCode).toBeNull()
  })

  it('a dial failure fails that host with the dial error', async () => {
    const t = await makeRunSetup()
    const bad = t.hosts.create({ label: 'gone-1', address: '127.0.0.1', port: 1 }).id
    const run = t.runs.start({ target: { kind: 'hosts', hostIds: [t.ids['app-1']!, bad] }, command: text('true') })
    const done = await t.finished(run.id)
    expect(done.hosts.map((h) => h.state)).toEqual(['ok', 'failed'])
    expect(done.hosts[1]!.error?.code).toBe('refused')
  })

  it('a host id not in the inventory fails alone, labelled by its id', async () => {
    const t = await makeRunSetup()
    const stale = randomUUID()
    const run = t.runs.start({ target: { kind: 'hosts', hostIds: [t.ids['app-1']!, stale] }, command: text('true') })
    expect(run.hosts.map((h) => h.label)).toEqual(['app-1', stale])
    const done = await t.finished(run.id)
    expect(done.state).toBe('done')
    expect(done.hosts.map((h) => h.state)).toEqual(['ok', 'failed'])
    expect(done.hosts[1]).toMatchObject({ hostId: stale, error: { code: 'unknown', message: 'Host not found' }, exitCode: null })
    expect(t.server.execs()).toHaveLength(1)
    expect(runRows(t).at(-1)).toMatchObject({ action: 'run.finish', outcome: 'failure' })
  })

  it('a multi-host run in a protected environment needs the typed name', async () => {
    const t = await makeRunSetup()
    const req: RunRequest = { target: onEnv(t, 'prod'), command: text('uptime') }
    expect(() => t.runs.start(req)).toThrow(CONFIRM_MESSAGE)
    expect(() => t.runs.start({ ...req, confirm: 'PROD' })).toThrow(CONFIRM_MESSAGE)
    const denied = runRows(t)
    expect(denied.map((e) => [e.action, e.outcome])).toEqual([
      ['run.start', 'denied'],
      ['run.start', 'denied'],
    ])
    expect(denied[0]).toMatchObject({ targetType: 'environment', targetLabel: 'prod' })
    const run = t.runs.start({ ...req, confirm: 'prod' })
    expect(runRows(t).at(-1)).toMatchObject({ action: 'run.start', outcome: 'success', details: { confirmed: true } })
    await t.finished(run.id)
  })

  it('a host-kind target with no environment still needs the name when a host is in prod', async () => {
    const t = await makeRunSetup()
    const req: RunRequest = { target: onHosts(t, ['app-1', 'prod-app-1']), command: text('uptime') }
    expect(() => t.runs.start(req)).toThrow(CONFIRM_MESSAGE)
    // A staging context doesn't lift prod's protection either.
    expect(() => t.runs.start({ ...req, target: onHosts(t, ['prod-app-1', 'prod-db-1'], t.staging.id) })).toThrow(CONFIRM_MESSAGE)
    const run = t.runs.start({ ...req, confirm: 'prod' })
    await t.finished(run.id)
  })

  it('hosts in more than one protected environment are refused', async () => {
    const t = await makeRunSetup()
    const dr = t.envs.create({ name: 'dr', color: '#cc0000', protected: true })
    t.envs.putHost(dr.id, t.ids['app-1']!, 'app')
    const req: RunRequest = { target: onHosts(t, ['app-1', 'prod-app-1']), command: text('uptime'), confirm: 'prod' }
    expect(() => t.runs.start(req)).toThrow(MULTIPLE_PROTECTED_MESSAGE)
    expect(runRows(t).map((e) => [e.action, e.outcome])).toEqual([['run.start', 'denied']])
  })

  it('a single destructive command in a protected environment needs the typed name', async () => {
    const t = await makeRunSetup()
    const one = onHosts(t, ['prod-app-1'])
    expect(() => t.runs.start({ target: one, command: text('rm -f x') })).toThrow(CONFIRM_MESSAGE)
    const a = t.runs.start({ target: one, command: text('rm -f x'), confirm: 'prod' })
    const b = t.runs.start({ target: one, command: text('uptime') })
    const s = t.snippets.create({ label: 'Harmless but flagged', script: 'true', destructive: true })
    const snippet: RunRequest['command'] = { kind: 'snippet', snippetId: s.id, values: {} }
    expect(() => t.runs.start({ target: one, command: snippet })).toThrow(CONFIRM_MESSAGE)
    const c = t.runs.start({ target: one, command: snippet, confirm: 'prod' })
    for (const r of [a, b, c]) await t.finished(r.id)
  })

  it('a hostile variable value reaches the server as one literal argument', async () => {
    const t = await makeRunSetup()
    const s = t.snippets.create({ label: 'Echo', script: 'printf %s {{v}}' })
    // Harmless sentinels: each would create the marker in the shell's tmp dir if it ran.
    const values = ['x; touch "$MARKER"; y', '$(touch "$MARKER")', '`touch "$MARKER"`', "'; touch \"$MARKER\"; '"]
    for (const value of values) {
      const run = t.runs.start({ target: onHosts(t, ['app-1']), command: { kind: 'snippet', snippetId: s.id, values: { v: value } } })
      const done = await t.finished(run.id)
      expect(done.hosts[0]!.state).toBe('ok')
      expect(t.runs.get(run.id).output[0]!.text).toBe(value)
      expect(existsSync(t.marker)).toBe(false)
    }
    expect(t.server.execs()[0]).toBe(`printf %s 'x; touch "$MARKER"; y'`)
  })

  it('audits start and finish by host label without output or variable values', async () => {
    const t = await makeRunSetup()
    const s = t.snippets.create({ label: 'Greet', script: 'printf %s-out {{who}}' })
    const run = t.runs.start({
      target: onEnv(t, 'staging', 'db'),
      command: { kind: 'snippet', snippetId: s.id, values: { who: 'v4lue-q9z' } },
      concurrency: 2,
      timeoutSec: 30,
    })
    await t.finished(run.id)
    const typedText = 'TOKEN=s3cr3t-value echo printed-q9z'
    const typed = t.runs.start({ target: onHosts(t, ['app-1']), command: text(typedText) })
    await t.finished(typed.id)
    const mysql = t.runs.start({ target: onHosts(t, ['app-1']), command: text('mysql -pHunter22 -e x') })
    await t.finished(mysql.id)

    const rows = runRows(t)
    expect(rows.map((e) => [e.action, e.outcome])).toEqual([
      ['run.start', 'success'],
      ['run.finish', 'success'],
      ['run.start', 'success'],
      ['run.finish', 'success'],
      ['run.start', 'success'],
      ['run.finish', 'failure'],
    ])
    expect(rows[0]).toMatchObject({
      targetType: 'environment',
      targetLabel: 'staging',
      details: {
        runId: run.id,
        hosts: ['db-1', 'db-2'],
        concurrency: 2,
        timeoutSec: 30,
        command: { kind: 'snippet', snippetId: s.id, label: 'Greet', variables: ['who'] },
      },
    })
    expect(rows[0]!.details).not.toHaveProperty('confirmed')
    expect(rows[1]).toMatchObject({
      targetLabel: 'staging',
      details: {
        runId: run.id,
        ok: 2,
        failed: 0,
        cancelled: 0,
        timeout: 0,
        results: [
          { host: 'db-1', state: 'ok', exitCode: 0 },
          { host: 'db-2', state: 'ok', exitCode: 0 },
        ],
      },
    })
    expect(rows[2]).toMatchObject({
      targetType: 'hosts',
      targetLabel: '1 host',
      details: { command: { kind: 'text', program: 'echo', chars: typedText.length, lines: 1 } },
    })
    expect(rows[4]!.details).toMatchObject({ command: { kind: 'text', program: 'mysql' } })
    const all = auditRows(t.db)
    for (const leak of ['127.0.0.1', 'v4lue-q9z', '-out', 'printed-q9z', 's3cr3t', 'Hunter22']) {
      expect(JSON.stringify(rows)).not.toContain(leak)
    }
    for (const leak of ['v4lue-q9z', 'printed-q9z', 's3cr3t', 'Hunter22']) expect(all).not.toContain(leak)
  })

  it('locking cancels queued and dialing hosts but lets running ones finish', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1', 'app-2', 'app-3']), command: text(GATED), concurrency: 1 })
    await t.reached(run, 'app-1', 'running')
    t.vault.lock('manual')
    for (const label of ['app-2', 'app-3']) {
      expect(t.host(run, label)).toMatchObject({ state: 'cancelled', error: { code: 'locked' } })
    }
    expect(t.host(run, 'app-1').state).toBe('running')
    t.openGate()
    const done = await t.finished(run.id)
    expect(done.hosts.map((h) => h.state)).toEqual(['ok', 'cancelled', 'cancelled'])
    expect(t.server.execs()).toHaveLength(1)
  })

  it('locking cancels a host that is still dialing', async () => {
    const t = await makeRunSetup()
    // An untrusted key asks a host-key prompt, so the dial waits until the lock.
    const untrusted = await startServer({ users: [{ username: 'x', password: 'y' }] })
    const id = t.hosts.create({ label: 'new-1', address: '127.0.0.1', port: untrusted.port }).id
    try {
      const run = t.runs.start({ target: { kind: 'hosts', hostIds: [id] }, command: text('true') })
      await t.reached(run, 'new-1', 'connecting')
      await t.waitFor(() => expect(t.broker.pending()).toHaveLength(1))
      t.vault.lock('manual')
      const done = await t.finished(run.id)
      expect(done.hosts[0]).toMatchObject({ state: 'cancelled', error: { code: 'locked' } })
    } finally {
      await untrusted.close()
    }
  })

  it('cancel stops a host that is still dialing', async () => {
    const t = await makeRunSetup()
    // An untrusted key asks a host-key prompt, so the dial waits until the cancel.
    const untrusted = await startServer({ users: [{ username: 'x', password: 'y' }] })
    const id = t.hosts.create({ label: 'new-1', address: '127.0.0.1', port: untrusted.port }).id
    try {
      const run = t.runs.start({ target: { kind: 'hosts', hostIds: [id] }, command: text('true') })
      await t.reached(run, 'new-1', 'connecting')
      await t.waitFor(() => expect(t.broker.pending()).toHaveLength(1))
      const done = await t.runs.cancel(run.id)
      expect(done.state).toBe('cancelled')
      expect(done.hosts[0]).toMatchObject({ state: 'cancelled', error: { code: 'closed', message: 'Cancelled' } })
      expect(untrusted.execs()).toHaveLength(0)
      expect(runRows(t).at(-1)).toMatchObject({ action: 'run.finish', outcome: 'info' })
    } finally {
      await untrusted.close()
    }
  })

  it('start while locked throws and audits denied', async () => {
    const t = await makeRunSetup()
    t.vault.lock('manual')
    expect(() => t.runs.start({ target: onEnv(t, 'staging'), command: text('true') })).toThrow(VAULT_LOCKED)
    expect(() => t.runs.start({ target: onHosts(t, ['app-1', 'app-2']), command: text('true') })).toThrow(VAULT_LOCKED)
    expect(runRows(t).map((e) => [e.action, e.outcome, e.targetType, e.targetLabel])).toEqual([
      ['run.start', 'denied', 'environment', 'staging'],
      ['run.start', 'denied', 'hosts', '2 hosts'],
    ])
    expect(runRows(t)[0]!.targetId).toBe(t.staging.id)
    expect(t.server.execs()).toHaveLength(0)
  })

  it('keeps only MAX_RUNS_KEPT finished runs and refuses a fifth active run', async () => {
    const t = await makeRunSetup()
    const blocked = Array.from({ length: MAX_ACTIVE_RUNS }, () =>
      t.runs.start({ target: onHosts(t, ['app-1']), command: text(GATED) }),
    )
    expect(() => t.runs.start({ target: onHosts(t, ['app-1']), command: text('true') })).toThrow(/too many runs/)
    t.openGate()
    for (const r of blocked) await t.finished(r.id)
    const later = []
    for (let i = 0; i < MAX_RUNS_KEPT - MAX_ACTIVE_RUNS + 1; i++) {
      const r = t.runs.start({ target: onHosts(t, ['app-1']), command: text('true') })
      await t.finished(r.id)
      later.push(r)
    }
    const list = t.runs.list()
    expect(list).toHaveLength(MAX_RUNS_KEPT)
    expect(list[0]!.id).toBe(later.at(-1)!.id)
    expect(list.map((r) => r.id)).not.toContain(blocked[0]!.id)
    expect(() => t.runs.get(blocked[0]!.id)).toThrow(/run not found/)
  })

  it('dismiss removes a finished run and refuses a running one', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1']), command: text(GATED) })
    expect(() => t.runs.dismiss(run.id)).toThrow(/still running/)
    t.openGate()
    await t.finished(run.id)
    t.runs.dismiss(run.id)
    expect(t.runs.list()).toEqual([])
  })

  it('closeAll cancels every run and writes run.finish at once', async () => {
    const t = await makeRunSetup()
    const run = t.runs.start({ target: onHosts(t, ['app-1', 'app-2']), command: text('sleep 30'), concurrency: 1 })
    await t.reached(run, 'app-1', 'running')
    t.runs.closeAll()
    expect(t.runs.get(run.id).run.state).toBe('cancelled')
    expect(runRows(t).map((e) => [e.action, e.outcome])).toEqual([
      ['run.start', 'success'],
      ['run.finish', 'info'],
    ])
    expect(() => t.runs.start({ target: onHosts(t, ['app-1']), command: text('true') })).toThrow(/quitting/)
    // The running command got its INT; the queued host never ran.
    await t.waitFor(() => expect(t.server.signals()).toContain('INT'))
    expect(t.server.execs()).toHaveLength(1)
  })

  it('drops the output of the oldest finished runs past the total budget, keeping their summaries', async () => {
    const t = await makeRunSetup({ outputBudget: 1500, outputCap: 1000 })
    const a = t.runs.start({ target: onHosts(t, ['app-1']), command: text('head -c 800 /dev/zero | tr "\\0" a') })
    await t.finished(a.id)
    expect(t.runs.get(a.id).output[0]!.text).toHaveLength(800)
    const b = t.runs.start({ target: onHosts(t, ['app-1']), command: text('head -c 900 /dev/zero | tr "\\0" b') })
    await t.finished(b.id)
    expect(t.runs.get(a.id).run).toMatchObject({ state: 'done', outputDropped: true })
    expect(t.runs.get(a.id).output).toEqual([])
    expect(t.runs.get(b.id).run.outputDropped).toBe(false)
    expect(t.runs.get(b.id).output[0]!.text).toHaveLength(900)
  })

  it('the ops handlers route runs:* to the manager', async () => {
    const t = await makeRunSetup()
    const h = createOpsHandlers({ snippets: t.snippets, runs: t.runs, containers: {} as ContainerService })
    const run = await h['runs:start']({ target: onHosts(t, ['app-1']), command: text('true') })
    await t.finished(run.id)
    expect((await h['runs:list']()).map((r) => r.id)).toEqual([run.id])
    expect((await h['runs:get'](run.id)).run.state).toBe('done')
    expect((await h['runs:cancel'](run.id)).state).toBe('done')
    await h['runs:dismiss'](run.id)
    expect(await h['runs:list']()).toEqual([])
  })
})

describe('RunManager on a vault reset', () => {
  it('cancels every run in flight, forgets every run and closes its links; runs start again after setup', async () => {
    const t = await makeRunSetup()
    const done = t.runs.start({ target: onHosts(t, ['app-3']), command: text('echo before') })
    await t.finished(done.id)
    const run = t.runs.start({ target: onHosts(t, ['app-1', 'app-2']), command: text('sleep 30'), concurrency: 1 })
    await t.reached(run, 'app-1', 'running')
    await t.waitFor(() => expect(t.sh.running()).toBe(1))

    t.vault.lock('manual')
    await t.vault.reset('RESET')
    // Gone before reset() resolves: the runs, with their output, and every link.
    expect(t.runs.list()).toEqual([])
    expect(() => t.runs.get(run.id)).toThrow('run not found')
    expect(() => t.runs.get(done.id)).toThrow('run not found')
    const last = t.events.filter((e) => e.runId === run.id && e.kind === 'run').at(-1)
    expect(last).toMatchObject({ kind: 'run', run: { state: 'cancelled' } })
    expect(t.hostEvents(run.id, t.ids['app-2']!)).toEqual(['queued', 'cancelled'])
    expect(runRows(t).filter((e) => e.action === 'run.finish').map((e) => e.outcome)).toEqual(['success', 'info'])
    await t.waitFor(() => expect(t.server.connections()).toBe(0))
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
    expect(t.server.execs()).toHaveLength(2)

    expect(() => t.runs.start({ target: onHosts(t, ['app-1']), command: text('true') })).toThrow(VAULT_LOCKED)
    await t.vault.setup('a new password')
    const after = t.runs.start({ target: onHosts(t, ['app-1']), command: text('echo after') })
    expect(await t.finished(after.id)).toMatchObject({ state: 'done' })
    expect(t.runs.get(after.id).output[0]!.text).toBe('after\n')
  })

  it('a run whose cancel throws still has every host interrupted, and nothing comes from it later', async () => {
    let boom = false
    let late = 0
    const t = await makeRunSetup({
      emit: () => {
        late++
        if (!boom) return
        boom = false
        throw new Error('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----')
      },
    })
    const run = t.runs.start({ target: onHosts(t, ['app-1', 'app-2']), command: text('sleep 30'), concurrency: 2 })
    await t.reached(run, 'app-1', 'running')
    await t.reached(run, 'app-2', 'running')
    await t.waitFor(() => expect(t.sh.running()).toBe(2))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())

    // The first host's state event throws, before the second host is aborted. Called directly: on
    // a real reset the links close next, and that would end the commands without any INT.
    boom = true
    t.vault.lock('manual')
    t.runs.vaultReset()
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['Run cancel failed:'])
    late = 0
    await t.waitFor(() => expect(t.server.signals().filter((s) => s === 'INT')).toHaveLength(2))
    // Its hosts end without a host event, a run event or a run.finish.
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
    await new Promise((r) => setTimeout(r, 200))
    expect(late).toBe(0)
    expect(t.audit.list().filter((e) => e.action === 'run.finish')).toEqual([])
  })

  it('a run whose finish throws on reset is finished quietly: a waiting cancel returns, nothing comes later', async () => {
    let boom = false
    const seen: EventContract['run:event'][] = []
    const t = await makeRunSetup({
      emit: (_event, payload) => {
        seen.push(payload)
        if (!boom || payload.kind !== 'run') return
        boom = false
        throw new Error('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----')
      },
    })
    const run = t.runs.start({ target: onHosts(t, ['app-1', 'app-2']), command: text('sleep 30'), concurrency: 2 })
    await t.reached(run, 'app-1', 'running')
    await t.reached(run, 'app-2', 'running')
    await t.waitFor(() => expect(t.sh.running()).toBe(2))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())

    // The cancel waits for both commands to end; the reset comes first and its run event throws,
    // after the run is already marked finished.
    const cancelled = t.runs.cancel(run.id)
    boom = true
    t.vault.lock('manual')
    await t.vault.reset('RESET')
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['Run cancel failed:'])
    const after = seen.length
    await expect(cancelled).resolves.toMatchObject({ state: 'cancelled' })
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
    await new Promise((r) => setTimeout(r, 200))
    expect(seen.slice(after)).toEqual([])
    expect(t.audit.list().filter((e) => e.action === 'run.finish')).toEqual([])
  })

  it('one run failing to cancel never keeps the others; the error is logged redacted', async () => {
    let boom = false
    const events: unknown[] = []
    const t = await makeRunSetup({
      emit: (_event, payload) => {
        if (boom && payload.kind === 'host') {
          boom = false
          throw new Error('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----')
        }
        events.push(payload)
      },
    })
    const first = t.runs.start({ target: onHosts(t, ['app-1']), command: text('sleep 30') })
    const second = t.runs.start({ target: onHosts(t, ['app-2']), command: text('sleep 30') })
    await t.reached(first, 'app-1', 'running')
    await t.reached(second, 'app-2', 'running')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())

    boom = true
    t.vault.lock('manual')
    await t.vault.reset('RESET')
    expect(t.runs.list()).toEqual([])
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['Run cancel failed:'])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('b3BlbnNzaC1rZXk')
    // The second run still ended as cancelled, and both commands are gone with their links.
    expect(events).toContainEqual(expect.objectContaining({ runId: second.id, kind: 'run', run: expect.objectContaining({ state: 'cancelled' }) }))
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
  })
})
