import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { EventContract, EventName } from '../../src/shared/ipc'
import { LINK_IDLE_MS } from '../../src/shared/ops'
import type { SessionPrompt } from '../../src/shared/ssh'
import type { AuthPlan } from '../../src/main/ssh/auth'
import { connectChain } from '../../src/main/ssh/connect'
import type { Client } from 'ssh2'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import { PromptBroker } from '../../src/main/ssh/prompts'
import { resolveHost } from '../../src/main/inventory/resolve'
import { hostMeta } from '../../src/main/inventory/rows'
import { ExecLinks, type ExecLinksDeps, type Lease } from '../../src/main/ops/exec-links'
import { STOP_GRACE_MS, execOnce, type ExecResult } from '../../src/main/ops/exec'
import { makeInventory } from './inventory-helpers'
import { shellExec, type ShellHost } from './ops-helpers'
import { startServer, type ServerOpts, type TestServer } from './ssh-server'
import { TUNNEL_USER, manualTimers } from './tunnel-helpers'

type Emitted = { [K in EventName]: { event: K; payload: EventContract[K] } }[EventName]

// A password plan, so no test reads a real ~/.ssh or SSH_AUTH_SOCK.
const passwordPlan = (): AuthPlan => ({
  username: TUNNEL_USER.username,
  kind: 'password',
  notes: [],
  methods: [{ type: 'password', password: TUNNEL_USER.password! }],
})

function shell(): ShellHost {
  const sh = shellExec()
  onTestFinished(() => sh.close())
  return sh
}

/** A server on 127.0.0.1:0 whose exec requests run through `sh` (a fresh one when omitted). */
async function server(opts: Partial<ServerOpts> = {}, sh: ShellHost = shell()): Promise<TestServer> {
  const s = await startServer({ users: [TUNNEL_USER], onExec: sh.onExec, ...opts })
  onTestFinished(() => s.close())
  return s
}

async function setup(deps: Partial<ExecLinksDeps> = {}) {
  const f = await makeInventory()
  onTestFinished(() => rmSync(f.home, { recursive: true, force: true }))
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-exec-links-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  const mt = manualTimers()
  const events: Emitted[] = []
  const emit = <K extends EventName>(event: K, payload: EventContract[K]): void => void events.push({ event, payload } as Emitted)
  const isLocked = (): boolean => !f.vault.isUnlocked()
  const broker = new PromptBroker({ emit, isLocked })
  const links = new ExecLinks({
    resolve: (hostId, environmentId) => resolveHost(f.db, hostId, environmentId, { localUser: 'tester' }),
    hostInfo: (hostId) => {
      const h = hostMeta(f.db, hostId)
      return { label: h.label, keepaliveSec: h.keepaliveSec, envVars: h.envVars }
    },
    connect: connectChain,
    plan: async () => passwordPlan(),
    knownHosts,
    prompts: broker,
    isLocked,
    timers: mt.timers,
    ...deps,
  })
  // The same order as src/main/index.ts: links before the broker.
  f.vault.onLock(() => links.vaultLocked())
  f.vault.onLock(() => broker.cancelAll())
  onTestFinished(() => links.closeAll())

  let hostN = 0
  const host = (srv: TestServer, o: { trust?: boolean; envVars?: Record<string, string> } = {}): string => {
    if (o.trust !== false) knownHosts.trust('127.0.0.1', srv.port, srv.hostKeyType, srv.hostKeyBase64)
    return f.hosts.create({ label: `host-${++hostN}`, address: '127.0.0.1', port: srv.port, envVars: o.envVars }).id
  }
  const prompts = (): SessionPrompt[] => events.flatMap((e) => (e.event === 'session:prompt' ? [e.payload] : []))
  const promptDone = (): string[] => events.flatMap((e) => (e.event === 'session:promptDone' ? [e.payload.promptId] : []))
  const waitFor = <T>(fn: () => T): Promise<T> => vi.waitFor(fn, { timeout: 10_000, interval: 5 })
  const waitPrompt = (): Promise<SessionPrompt> =>
    waitFor(() => {
      const p = prompts()[0]
      if (!p) throw new Error('no prompt yet')
      return p
    })
  const lease = (hostId: string, environmentId: string | null = null, signal = new AbortController().signal, owner = 'runs:1') =>
    links.lease(hostId, environmentId, { id: owner }, signal).then((l) => {
      onTestFinished(() => l.release())
      return l
    })
  return { ...f, links, broker, knownHosts, mt, host, prompts, promptDone, waitFor, waitPrompt, lease }
}

/** Runs `command` on the lease's client and collects its output by stream. */
async function run(
  l: Lease,
  command: string,
  o: Partial<Parameters<typeof execOnce>[2]> = {},
): Promise<ExecResult & { out: string; err: string; chunks: { chunk: string; stream: 'out' | 'err' }[] }> {
  const chunks: { chunk: string; stream: 'out' | 'err' }[] = []
  const result = await execOnce(l.client, command, {
    signal: new AbortController().signal,
    ...o,
    onData: (chunk, stream) => {
      chunks.push({ chunk, stream })
      o.onData?.(chunk, stream)
    },
  })
  const text = (s: 'out' | 'err'): string => chunks.flatMap((c) => (c.stream === s ? [c.chunk] : [])).join('')
  return { ...result, out: text('out'), err: text('err'), chunks }
}

/** An `onData` and a wait for `text` in stdout: a command prints it once its trap is set. */
function watch() {
  let out = ''
  return {
    onData: (chunk: string, stream: 'out' | 'err'): void => void (stream === 'out' && (out += chunk)),
    seen: (text: string) => vi.waitFor(() => expect(out).toContain(text), { timeout: 10_000, interval: 5 }),
  }
}

/** True when `p` is still pending after the event loop turns a few times. */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let done = false
  void p.then(
    () => (done = true),
    () => (done = true),
  )
  await new Promise((r) => setTimeout(r, 50))
  return !done
}

describe('ExecLinks and execOnce', () => {
  it('runs a command and reports stdout, stderr and the exit code', async () => {
    const t = await setup()
    const srv = await server()
    const l = await t.lease(t.host(srv))
    expect(l.label).toBe('host-1')
    const r = await run(l, 'printf out; printf err >&2; exit 3')
    expect(r).toMatchObject({ out: 'out', err: 'err', exitCode: 3, signal: null, timedOut: false, cancelled: false })
    expect(srv.execs()).toEqual(['printf out; printf err >&2; exit 3'])
  })

  it('never splits a UTF-8 character across chunks', async () => {
    const t = await setup()
    const srv = await server()
    const l = await t.lease(t.host(srv))
    // The euro sign's three bytes arrive in two writes.
    const r = await run(l, "printf '\\342\\202'; sleep 0.2; printf '\\254'")
    expect(r.out).toBe('€')
    expect(r.chunks.every((c) => !c.chunk.includes('�'))).toBe(true)
  })

  it('reuses one connection for two leases on the same context and closes it after the idle delay', async () => {
    const t = await setup()
    const srv = await server()
    const hostId = t.host(srv)
    const [a, b] = await Promise.all([t.lease(hostId), t.lease(hostId)])
    expect(a.client).toBe(b.client)
    expect(srv.connections()).toBe(1)
    a.release()
    expect(t.mt.pending()).toEqual([])
    b.release()
    b.release()
    expect(t.mt.pending()).toEqual([{ ms: LINK_IDLE_MS, kind: 'timeout' }])
    // A lease before the delay keeps the link.
    const c = await t.lease(hostId)
    expect(c.client).toBe(a.client)
    expect(t.mt.pending()).toEqual([])
    c.release()
    t.mt.fire(LINK_IDLE_MS)
    await t.waitFor(() => expect(srv.connections()).toBe(0))
  })

  it('a different environment context is a different link', async () => {
    const t = await setup()
    const srv = await server()
    const hostId = t.host(srv)
    const env = t.envs.create({ name: 'staging', color: '#aabbcc' })
    t.envs.putHost(env.id, hostId, 'db')
    const a = await t.lease(hostId)
    const b = await t.lease(hostId, env.id)
    expect(a.client).not.toBe(b.client)
    expect(srv.connections()).toBe(2)
  })

  it("an unknown host key asks through the broker under the owner's id; rejecting fails the lease", async () => {
    const t = await setup()
    const srv = await server()
    const leasing = t.lease(t.host(srv, { trust: false }), null, undefined, 'containers:h1')
    const prompt = await t.waitPrompt()
    expect(prompt).toMatchObject({ kind: 'host-key', sessionId: 'containers:h1', hopLabel: 'host-1' })
    t.broker.answer(prompt.promptId, { kind: 'host-key', trust: false })
    await expect(leasing).rejects.toMatchObject({ code: 'host-key-rejected', error: { hopLabel: 'host-1' } })
    await t.waitFor(() => expect(srv.connections()).toBe(0))
  })

  it('a dial waiting on a prompt fails as locked', async () => {
    const t = await setup()
    const srv = await server()
    // Another server, since trust is per address and port.
    const trusted = t.host(await server())
    const leasing = t.lease(t.host(srv, { trust: false }))
    const prompt = await t.waitPrompt()
    t.vault.lock('manual')
    await expect(leasing).rejects.toMatchObject({ code: 'locked' })
    expect(t.promptDone()).toContain(prompt.promptId)
    await t.waitFor(() => expect(srv.connections()).toBe(0))
    // No new dial starts while locked.
    await expect(t.lease(trusted)).rejects.toMatchObject({ code: 'locked' })
  })

  it('a lease after unlock dials afresh instead of joining the dial the lock doomed', async () => {
    // The locked dial's rejection is held until the gate opens, so the new lease lands in that window.
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const t = await setup({
      connect: (hops, deps, signal) =>
        connectChain(hops, deps, signal).catch(async (err: unknown) => {
          await gate
          throw err
        }),
    })
    const srv = await server()
    const hostId = t.host(srv, { trust: false })
    const doomed = t.lease(hostId)
    const first = await t.waitPrompt()
    t.vault.lock('manual')
    await t.vault.unlock('correct horse')
    const fresh = t.lease(hostId, null, undefined, 'runs:2')
    const second = await t.waitFor(() => {
      const p = t.prompts()[1]
      if (!p) throw new Error('no second prompt yet')
      return p
    })
    expect(second.promptId).not.toBe(first.promptId)
    expect(second.sessionId).toBe('runs:2')
    t.broker.answer(second.promptId, { kind: 'host-key', trust: true })
    expect((await run(await fresh, 'printf ok')).out).toBe('ok')
    open()
    await expect(doomed).rejects.toMatchObject({ code: 'locked' })
  })

  it('abort while dialing rejects and never leaks the client', async () => {
    const t = await setup()
    const srv = await server()
    const ctl = new AbortController()
    const leasing = t.lease(t.host(srv, { trust: false }), null, ctl.signal)
    const prompt = await t.waitPrompt()
    expect(srv.connections()).toBe(1)
    ctl.abort()
    await expect(leasing).rejects.toMatchObject({ code: 'closed' })
    expect(t.promptDone()).toContain(prompt.promptId)
    await t.waitFor(() => expect(srv.connections()).toBe(0))
  })

  it('aborting one of two waiters keeps the dial and its prompt for the other', async () => {
    const t = await setup()
    const srv = await server()
    const hostId = t.host(srv, { trust: false })
    const first = new AbortController()
    const a = t.lease(hostId, null, first.signal, 'runs:a')
    const b = t.lease(hostId, null, undefined, 'runs:b')
    const prompt = await t.waitPrompt()
    expect(prompt.sessionId).toBe('runs:a')
    first.abort()
    await expect(a).rejects.toMatchObject({ code: 'closed' })
    expect(t.promptDone()).not.toContain(prompt.promptId)
    t.broker.answer(prompt.promptId, { kind: 'host-key', trust: true })
    const l = await b
    expect((await run(l, 'printf ok')).out).toBe('ok')
    expect(t.prompts()).toHaveLength(1)
  })

  it('execOnce timeout signals then closes and reports timedOut', async () => {
    const t = await setup()
    const srv = await server()
    const l = await t.lease(t.host(srv))
    const mt = manualTimers()
    const w = watch()
    // INT is ignored, so only the close ends it.
    const running = run(l, "trap '' INT; printf started; while :; do sleep 0.1; done", {
      timeoutMs: 5000,
      timers: mt.timers,
      onData: w.onData,
    })
    await w.seen('started')
    expect(mt.pending()).toEqual([{ ms: 5000, kind: 'timeout' }])
    mt.fire(5000)
    await t.waitFor(() => expect(srv.signals()).toEqual(['INT']))
    expect(mt.pending()).toEqual([{ ms: STOP_GRACE_MS, kind: 'timeout' }])
    expect(await pending(running)).toBe(true)
    mt.fire(STOP_GRACE_MS)
    expect(await running).toMatchObject({ timedOut: true, cancelled: false, exitCode: null })
  })

  it('execOnce abort sends INT then closes after 2 s', async () => {
    const t = await setup()
    const sh = shell()
    const srv = await server({}, sh)
    const l = await t.lease(t.host(srv))
    const mt = manualTimers()
    const ctl = new AbortController()
    const w = watch()
    // The trap writes a marker in the shell's tmp dir and keeps looping.
    const running = run(l, "trap ': > got-int' INT; printf started; while :; do sleep 0.1; done", {
      signal: ctl.signal,
      timers: mt.timers,
      onData: w.onData,
    })
    await w.seen('started')
    expect(sh.running()).toBe(1)
    ctl.abort()
    await t.waitFor(() => expect(existsSync(join(sh.dir, 'got-int'))).toBe(true))
    expect(srv.signals()).toEqual(['INT'])
    expect(STOP_GRACE_MS).toBe(2000)
    expect(mt.pending()).toEqual([{ ms: STOP_GRACE_MS, kind: 'timeout' }])
    expect(await pending(running)).toBe(true)
    mt.fire(STOP_GRACE_MS)
    expect(await running).toMatchObject({ cancelled: true, timedOut: false, exitCode: null, out: 'started' })
    await t.waitFor(() => expect(sh.running()).toBe(0))
  })

  it('a command that exits on INT reports its exit code', async () => {
    const t = await setup()
    const srv = await server()
    const l = await t.lease(t.host(srv))
    const ctl = new AbortController()
    const w = watch()
    const running = run(l, "trap 'exit 130' INT; printf started; while :; do sleep 0.1; done", { signal: ctl.signal, onData: w.onData })
    await w.seen('started')
    ctl.abort()
    expect(await running).toMatchObject({ cancelled: true, exitCode: 130 })
  })

  it('execOnce with an already-aborted signal is cancelled without an exec', async () => {
    const t = await setup()
    const srv = await server()
    const l = await t.lease(t.host(srv))
    const ctl = new AbortController()
    ctl.abort()
    expect(await run(l, 'printf no', { signal: ctl.signal })).toMatchObject({ cancelled: true, exitCode: null, out: '' })
    expect(srv.execs()).toEqual([])
  })

  it('an abort before the channel opens stops the exec once it opens', async () => {
    const t = await setup()
    const srv = await server()
    const l = await t.lease(t.host(srv))
    const mt = manualTimers()
    const ctl = new AbortController()
    // The INT can land before any trap is set, so the command lets it end the exec.
    const running = run(l, 'sleep 30', { signal: ctl.signal, timers: mt.timers, timeoutMs: 5000 })
    ctl.abort()
    expect(await running).toMatchObject({ cancelled: true, timedOut: false })
    expect(srv.execs()).toEqual(['sleep 30'])
    expect(srv.signals()).toEqual(['INT'])
    // The timeout was never armed, and the grace timer went with the channel.
    expect(mt.pending()).toEqual([])
  })

  it('a client that throws on exec fails as closed', async () => {
    const client = {
      exec: () => {
        throw new Error('Not connected')
      },
    } as unknown as Client
    await expect(
      execOnce(client, 'printf no', { signal: new AbortController().signal, onData: () => {} }),
    ).rejects.toMatchObject({ code: 'closed', message: 'The connection was closed' })
  })

  it('closeAll fails leases waiting for a link slot, and later leases', async () => {
    const t = await setup({ maxLinks: 1 })
    const srv = await server()
    const [h1, h2] = [t.host(srv), t.host(srv)]
    await t.lease(h1)
    const waiting = t.lease(h2)
    expect(await pending(waiting)).toBe(true)
    t.links.closeAll()
    await expect(waiting).rejects.toMatchObject({ code: 'closed' })
    await t.waitFor(() => expect(srv.connections()).toBe(0))
    await expect(t.lease(h1)).rejects.toMatchObject({ code: 'closed' })
    expect(srv.connections()).toBe(0)
  })

  it('a dropped link fails the leases queued on its channels with closed', async () => {
    const t = await setup({ maxChannels: 1 })
    const srv = await server()
    const hostId = t.host(srv)
    await t.lease(hostId)
    const queued = t.lease(hostId)
    expect(await pending(queued)).toBe(true)
    srv.dropAll()
    await expect(queued).rejects.toMatchObject({ code: 'closed', message: 'The connection to host-1 dropped' })
    // The next lease dials a fresh link.
    expect((await run(await t.lease(hostId), 'printf back')).out).toBe('back')
  })

  it('env vars from the host reach the exec', async () => {
    const t = await setup()
    const srv = await server()
    const l = await t.lease(t.host(srv, { envVars: { FOO: 'bar baz' } }))
    expect(l.envVars).toEqual({ FOO: 'bar baz' })
    expect((await run(l, 'printf %s "$FOO"', { env: l.envVars })).out).toBe('bar baz')
  })

  it('a lease past MAX_LINKS waits for a slot and proceeds when one frees', async () => {
    const t = await setup({ maxLinks: 1 })
    const srv = await server()
    const [h1, h2] = [t.host(srv), t.host(srv)]
    const a = await t.lease(h1)
    const waiting = t.lease(h2)
    expect(await pending(waiting)).toBe(true)
    expect(srv.connections()).toBe(1)
    // The released link is idle, and a lease is waiting, so it goes at once instead of idling.
    a.release()
    const b = await waiting
    expect(b.label).toBe('host-2')
    await t.waitFor(() => expect(srv.connections()).toBe(1))
    expect(t.mt.pending()).toEqual([])
  })

  it('a lease past MAX_LINKS evicts an idle link first', async () => {
    const t = await setup({ maxLinks: 1 })
    const srv = await server()
    const [h1, h2] = [t.host(srv), t.host(srv)]
    ;(await t.lease(h1)).release()
    expect(t.mt.pending()).toHaveLength(1)
    const b = await t.lease(h2)
    expect(b.label).toBe('host-2')
    await t.waitFor(() => expect(srv.connections()).toBe(1))
  })

  it('an aborted wait for a link slot leaves the queue', async () => {
    const t = await setup({ maxLinks: 1 })
    const srv = await server()
    const [h1, h2, h3] = [t.host(srv), t.host(srv), t.host(srv)]
    const a = await t.lease(h1)
    const ctl = new AbortController()
    const gone = t.lease(h2, null, ctl.signal)
    const next = t.lease(h3)
    ctl.abort()
    await expect(gone).rejects.toMatchObject({ code: 'closed' })
    a.release()
    expect((await next).label).toBe('host-3')
  })

  it('leases past the channel limit wait on the same link', async () => {
    const t = await setup({ maxChannels: 1 })
    const srv = await server()
    const hostId = t.host(srv)
    const a = await t.lease(hostId)
    const waiting = t.lease(hostId)
    expect(await pending(waiting)).toBe(true)
    a.release()
    const b = await waiting
    expect(b.client).toBe(a.client)
    expect(srv.connections()).toBe(1)
  })

  it('a channel the host refuses reports MaxSessions', async () => {
    const t = await setup()
    const srv = await server({ maxSessions: 1 })
    const l = await t.lease(t.host(srv))
    const ctl = new AbortController()
    const first = run(l, 'while :; do sleep 0.1; done', { signal: ctl.signal })
    await t.waitFor(() => expect(srv.execs()).toHaveLength(1))
    await expect(run(l, 'printf no')).rejects.toMatchObject({ message: 'The host refused another session (MaxSessions)' })
    ctl.abort()
    expect(await first).toMatchObject({ cancelled: true })
  })

  it('vaultLocked closes idle links and keeps leased ones', async () => {
    const t = await setup()
    const srv = await server()
    const [h1, h2] = [t.host(srv), t.host(srv)]
    ;(await t.lease(h1)).release()
    const held = await t.lease(h2)
    expect(srv.connections()).toBe(2)
    t.vault.lock('manual')
    await t.waitFor(() => expect(srv.connections()).toBe(1))
    expect(t.mt.pending()).toEqual([])
    expect((await run(held, 'printf still')).out).toBe('still')
  })

  it('a resolve error fails the lease without dialing', async () => {
    const t = await setup()
    const srv = await server()
    const hostId = t.host(srv)
    const env = t.envs.create({ name: 'prod', color: '#aabbcc' })
    await expect(t.lease(hostId, env.id)).rejects.toMatchObject({ code: 'unknown', message: 'host is not in that environment' })
    expect(srv.connections()).toBe(0)
  })

  it('a server without onExec rejects exec as before', async () => {
    const t = await setup()
    const srv = await startServer({ users: [TUNNEL_USER] })
    onTestFinished(() => srv.close())
    const l = await t.lease(t.host(srv))
    await expect(run(l, 'printf hi')).rejects.toMatchObject({ code: 'unknown' })
    expect(srv.execs()).toEqual([])
  })

  it('the shell host finds the fake docker first and answers from fixtures', async () => {
    const t = await setup()
    const sh = shell()
    const srv = await server({}, sh)
    const l = await t.lease(t.host(srv))
    expect((await run(l, 'command -v docker')).out.trim()).toBe(join(sh.bin, 'docker'))
    expect((await run(l, 'printf %s "$HOME"')).out).toBe(sh.dir)
    writeFileSync(join(sh.fixtures, 'ps.out'), '{"ID":"abc"}\n')
    expect(await run(l, "docker ps --format '{{json .}}'")).toMatchObject({ out: '{"ID":"abc"}\n', exitCode: 0 })
    expect(await run(l, 'docker pull x')).toMatchObject({ err: 'docker: unknown command\n', exitCode: 127 })
    expect(readFileSync(sh.dockerLog, 'utf8')).toBe('ps\n--format\n{{json .}}\npull\nx\n')
  })
})
