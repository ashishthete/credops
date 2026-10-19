import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { EventContract, EventName } from '../../src/shared/ipc'
import {
  PROBE_INTERVAL_MS,
  STABLE_MS,
  STATS_MS,
  type TunnelEvent,
  type TunnelInput,
  type TunnelRuntime,
  type TunnelState,
} from '../../src/shared/tunnels'
import type { SessionPrompt } from '../../src/shared/ssh'
import type { AuthPlan } from '../../src/main/ssh/auth'
import { connectChain } from '../../src/main/ssh/connect'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import { PromptBroker } from '../../src/main/ssh/prompts'
import { SessionManager } from '../../src/main/ssh/sessions'
import { resolveHost } from '../../src/main/inventory/resolve'
import { hostMeta } from '../../src/main/inventory/rows'
import { createInventoryHandlers } from '../../src/main/ipc/handlers/inventory'
import { listen, type PortHolder } from '../../src/main/tunnels/bind'
import { ForwardError, startLocal, startRemote, type ForwardHandle } from '../../src/main/tunnels/forward'
import { TunnelManager, type TunnelManagerDeps } from '../../src/main/tunnels/manager'
import { startDynamic } from '../../src/main/tunnels/socks5'
import { TunnelStore } from '../../src/main/tunnels/tunnel-store'
import { wireVaultHooks, type VaultHookTargets } from '../../src/main/vault/hooks'
import { makeInventory } from './inventory-helpers'
import { generateKey, startServer, type ServerOpts, type TestServer } from './ssh-server'
import { TUNNEL_USER, echoServer, manualTimers, type EchoServer } from './tunnel-helpers'
import { auditRows } from './vault-helpers'

type Emitted = { [K in EventName]: { event: K; payload: EventContract[K] } }[EventName]
type Probe = () => Promise<'probe' | 'keepalive'>

const passwordPlan = (): AuthPlan => ({
  username: TUNNEL_USER.username,
  kind: 'password',
  notes: [],
  methods: [{ type: 'password', password: TUNNEL_USER.password! }],
})

async function server(opts: Partial<ServerOpts> = {}): Promise<TestServer> {
  const s = await startServer({ users: [TUNNEL_USER], allowForward: true, ...opts })
  onTestFinished(() => s.close())
  return s
}

async function target(): Promise<EchoServer> {
  const e = await echoServer()
  onTestFinished(() => e.close())
  return e
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => resolve(sock))
    sock.once('error', reject)
    onTestFinished(() => void sock.destroy())
  })
}

function read(sock: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let got = Buffer.alloc(0)
    const onData = (d: Buffer): void => {
      got = Buffer.concat([got, d])
      if (got.length >= length) {
        sock.off('data', onData)
        resolve(got)
      }
    }
    sock.on('data', onData)
  })
}

async function ping(port: number): Promise<void> {
  const sock = await dial(port)
  sock.write('ping')
  expect((await read(sock, 4)).toString()).toBe('ping')
  sock.destroy()
}

/** Routes each tunnel's probes through `stub` while it is set; otherwise the real probe runs. */
function stubbableEngines() {
  const ctl: { stub: Probe | null } = { stub: null }
  const wrap = (h: ForwardHandle): ForwardHandle => {
    const real = h.probe.bind(h)
    return Object.assign(h, { probe: () => (ctl.stub ? ctl.stub() : real()) })
  }
  const engines: NonNullable<TunnelManagerDeps['engines']> = {
    startLocal: (c, o) => wrap(startLocal(c, o)),
    startRemote: async (c, o) => wrap(await startRemote(c, o)),
    startDynamic: (c, o) => wrap(startDynamic(c, o)),
  }
  return { ctl, engines }
}

const idle = { vaultLocked() {}, closeAll() {} }

/** wireVaultHooks targets with these tunnels and prompts; the rest idle unless given. */
function hookTargets(tunnels: TunnelManager, prompts: PromptBroker, sessions: VaultHookTargets['sessions'] = idle): VaultHookTargets {
  return { sessions, tunnels, runs: idle, links: idle, prompts }
}

interface SetupOpts {
  /** false: leave the vault hooks unwired. */
  wire?: boolean
  deps?: Partial<TunnelManagerDeps>
  whoHolds?: (port: number) => Promise<PortHolder | null>
  plan?: () => AuthPlan
}

async function setup(opts: SetupOpts = {}) {
  const f = await makeInventory()
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-tunnels-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  const store = new TunnelStore({ db: f.db, audit: f.audit, vault: f.vault })
  const mt = manualTimers()
  const statsMt = manualTimers()
  const events: Emitted[] = []
  const emit = <K extends EventName>(event: K, payload: EventContract[K]): void => void events.push({ event, payload } as Emitted)
  const isLocked = (): boolean => !f.vault.isUnlocked()
  const broker = new PromptBroker({ emit, isLocked })
  const plan = { current: opts.plan ?? passwordPlan }
  const manager = new TunnelManager({
    store,
    resolve: (hostId, environmentId) => resolveHost(f.db, hostId, environmentId, { localUser: 'tester' }),
    hostInfo: (hostId) => {
      const h = hostMeta(f.db, hostId)
      return { label: h.label, keepaliveSec: h.keepaliveSec }
    },
    connect: connectChain,
    plan: async () => plan.current(),
    knownHosts,
    prompts: broker,
    isLocked,
    listen: (address, port, deps) => listen(address, port, { whoHolds: opts.whoHolds ?? (async () => null), inUseBy: deps.inUseBy }),
    audit: f.audit,
    emit,
    timers: mt.timers,
    statsTimers: statsMt.timers,
    ...opts.deps,
  })
  store.onRemoved = (id) => manager.removed(id)
  store.onChanged = (before, after) => manager.changed(before, after)
  // The app's own wiring; a test that needs live sessions wires them itself.
  if (opts.wire !== false) wireVaultHooks(f.vault, hookTargets(manager, broker))
  onTestFinished(() => manager.stopAll('quit'))

  let hostN = 0
  /** A host row that dials `srv`, whose host key is trusted unless `trust` is false. */
  const host = (srv: TestServer, trust = true): string => {
    if (trust) knownHosts.trust('127.0.0.1', srv.port, srv.hostKeyType, srv.hostKeyBase64)
    return f.hosts.create({ label: `host-${++hostN}`, address: '127.0.0.1', port: srv.port }).id
  }
  const tunnel = (hostId: string, over: Partial<TunnelInput> = {}) =>
    store.create({ label: 'db', hostId, type: 'L', bindPort: 0, targetHost: '127.0.0.1', targetPort: 1, ...over })
  const states = (id: string): TunnelRuntime[] =>
    events.flatMap((e) => (e.event === 'tunnel:state' && e.payload.id === id ? [e.payload] : []))
  const tunnelEvents = (id: string): TunnelEvent[] =>
    events.flatMap((e) => (e.event === 'tunnel:event' && e.payload.tunnelId === id ? [e.payload] : []))
  const prompts = (): SessionPrompt[] => events.flatMap((e) => (e.event === 'session:prompt' ? [e.payload] : []))
  const promptDone = (): string[] => events.flatMap((e) => (e.event === 'session:promptDone' ? [e.payload.promptId] : []))
  const waitFor = <T>(fn: () => T): Promise<T> => vi.waitFor(fn, { timeout: 10_000, interval: 5 })
  const waitState = (id: string, state: TunnelState, check?: (rt: TunnelRuntime) => boolean): Promise<TunnelRuntime> =>
    waitFor(() => {
      const rt = manager.runtime(id)
      if (rt.state !== state || (check && !check(rt))) throw new Error(`state is ${rt.state}`)
      return rt
    })
  const waitPrompt = (n = 1): Promise<SessionPrompt> =>
    waitFor(() => {
      const all = prompts()
      if (all.length < n) throw new Error('no prompt yet')
      return all[n - 1]
    })
  const audits = (action: 'tunnel.start' | 'tunnel.stop' | 'tunnel.delete' | 'tunnel.update') => f.audit.list({ actions: [action] })
  const timeouts = (): number[] => mt.pending().flatMap((t) => (t.kind === 'timeout' ? [t.ms] : []))

  return {
    ...f,
    knownHosts,
    store,
    manager,
    broker,
    mt,
    statsMt,
    events,
    plan,
    host,
    tunnel,
    states,
    tunnelEvents,
    prompts,
    promptDone,
    waitFor,
    waitState,
    waitPrompt,
    audits,
    timeouts,
  }
}

describe('TunnelManager', () => {
  it('L tunnel goes connecting → up and carries traffic', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port })
    expect(t.manager.start(tun.id).state).toBe('connecting')
    const up = await t.waitState(tun.id, 'up')
    expect(t.states(tun.id).map((s) => s.state)).toEqual(['connecting', 'up'])
    expect(up.boundPort).toBeGreaterThan(0)
    expect(up).toMatchObject({ boundAddress: '127.0.0.1', liveness: 'probe', failures: 0, error: null, maxFailures: 5 })
    await ping(up.boundPort!)
    expect(t.tunnelEvents(tun.id).map((e) => e.type)).toEqual(['connecting', 'up'])
    const starts = t.audits('tunnel.start')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      outcome: 'success',
      targetType: 'tunnel',
      targetId: tun.id,
      targetLabel: 'db',
      details: { type: 'L', bindPort: 0, exposed: false, trigger: 'user' },
    })
    expect(JSON.stringify(starts)).not.toContain('127.0.0.1')
  })

  it('never reports up before the first probe passes', async () => {
    const { ctl, engines } = stubbableEngines()
    const t = await setup({ deps: { engines } })
    const srv = await server()
    const echo = await target()
    let pass: ((v: 'probe') => void) | null = null
    ctl.stub = () => new Promise((resolve) => (pass = resolve))
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port })
    t.manager.start(tun.id)
    await t.waitFor(() => expect(pass).not.toBeNull())
    expect(t.manager.runtime(tun.id).state).toBe('connecting')
    pass!('probe')
    await t.waitState(tun.id, 'up')
  })

  it('two tunnels on one host share one SSH connection', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const a = t.tunnel(hostId, { label: 'a', targetPort: echo.port })
    const b = t.tunnel(hostId, { label: 'b', targetPort: echo.port })
    t.manager.start(a.id)
    t.manager.start(b.id)
    await t.waitState(a.id, 'up')
    const upB = await t.waitState(b.id, 'up')
    expect(srv.connections()).toBe(1)
    t.manager.stop(a.id)
    expect(t.manager.runtime(b.id).state).toBe('up')
    await ping(upB.boundPort!)
    expect(srv.connections()).toBe(1)
    t.manager.stop(b.id)
    await t.waitFor(() => expect(srv.connections()).toBe(0))
  })

  it('a dropped link moves every tunnel on it to retrying', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const a = t.tunnel(hostId, { label: 'a', targetPort: echo.port })
    const b = t.tunnel(hostId, { label: 'b', targetPort: echo.port })
    t.manager.start(a.id)
    t.manager.start(b.id)
    await t.waitState(a.id, 'up')
    await t.waitState(b.id, 'up')
    srv.dropAll()
    // No timer fired: leaving up is driven by the link's close, not a probe tick.
    for (const id of [a.id, b.id]) {
      const rt = await t.waitState(id, 'retrying')
      expect(rt).toMatchObject({ error: { code: 'dropped' }, failures: 1 })
      expect(rt.retryAt).not.toBeNull()
    }
    expect(t.timeouts()[0]).toBe(1000)
    t.mt.fire(1000)
    const upA = await t.waitState(a.id, 'up')
    await t.waitState(b.id, 'up')
    for (const id of [a.id, b.id]) expect(t.tunnelEvents(id).at(-1)).toMatchObject({ type: 'up', recovered: true })
    expect(srv.connections()).toBe(1)
    await ping(upA.boundPort!)
    expect(t.timeouts()).toEqual([STABLE_MS, STABLE_MS])
  })

  it('a failed probe leaves up even while the link is healthy', async () => {
    const { ctl, engines } = stubbableEngines()
    const t = await setup({ deps: { engines } })
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    ctl.stub = () => {
      ctl.stub = null
      return Promise.reject(new ForwardError('probe-failed', "The listener didn't answer the probe"))
    }
    t.mt.fire(PROBE_INTERVAL_MS)
    const rt = await t.waitState(tun.id, 'retrying')
    expect(rt).toMatchObject({ failures: 1, error: { code: 'probe-failed' } })
    t.mt.fire(1000)
    await t.waitState(tun.id, 'up')
    expect(srv.connections()).toBe(1)
  })

  it('backs off 1-2-4-8 s and fails on the 5th failure', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port })
    t.manager.start(tun.id)
    const up = await t.waitState(tun.id, 'up')
    await srv.close()
    const delays = (): (number | null)[] =>
      t.tunnelEvents(tun.id).flatMap((e) => (e.type === 'retrying' ? [e.retryInMs] : []))
    for (let n = 1; n <= 4; n++) {
      await t.waitFor(() => expect(delays()).toHaveLength(n))
      t.mt.fire(delays()[n - 1]!)
    }
    const failed = await t.waitState(tun.id, 'failed')
    expect(delays()).toEqual([1000, 2000, 4000, 8000])
    expect(failed.failures).toBe(5)
    const failedEvents = t.tunnelEvents(tun.id).filter((e) => e.type === 'failed')
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]).toMatchObject({ wasUp: true })
    const stops = t.audits('tunnel.stop')
    expect(stops).toHaveLength(1)
    expect(stops[0].details).toMatchObject({ reason: 'failed', failures: 5 })
    await expect(dial(up.boundPort!)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(t.timeouts()).toEqual([])
  })

  it('failure count resets after STABLE_MS up', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    srv.dropAll()
    await t.waitState(tun.id, 'retrying')
    t.mt.fire(1000)
    expect((await t.waitState(tun.id, 'up')).failures).toBe(1)
    t.mt.fire(STABLE_MS)
    expect(t.manager.runtime(tun.id).failures).toBe(0)
    expect(t.states(tun.id).at(-1)).toMatchObject({ state: 'up', failures: 0 })
  })

  it('autoReconnect off fails on the first drop', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port, autoReconnect: false })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    srv.dropAll()
    const rt = await t.waitState(tun.id, 'failed')
    expect(rt.error?.code).toBe('dropped')
    expect(t.states(tun.id).map((s) => s.state)).toEqual(['connecting', 'up', 'failed'])
    expect(t.timeouts()).toEqual([])
  })

  it('port in use fails at once and releases the link', async () => {
    const t = await setup({ whoHolds: async () => ({ pid: 812, command: 'postgres' }) })
    const srv = await server()
    const holder: Server = createServer()
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r))
    onTestFinished(() => new Promise<void>((r) => holder.close(() => r())))
    const p = (holder.address() as { port: number }).port
    const tun = t.tunnel(t.host(srv), { bindPort: p })
    t.manager.start(tun.id)
    const rt = await t.waitState(tun.id, 'failed')
    expect(rt.error).toEqual({ code: 'port-in-use', message: `Port ${p} on 127.0.0.1 is in use by postgres (pid 812)` })
    expect(t.mt.pending()).toEqual([])
    expect(t.statsMt.pending()).toEqual([])
    await t.waitFor(() => expect(srv.connections()).toBe(0))
    const [start] = t.audits('tunnel.start')
    expect(start).toMatchObject({ outcome: 'failure', details: { code: 'port-in-use', type: 'L', trigger: 'user' } })
    expect(t.audits('tunnel.stop')).toEqual([])
    // Clearing the failure back to stopped is a state change like any other: one event, no audit.
    t.manager.stop(tun.id)
    expect(t.manager.runtime(tun.id).state).toBe('stopped')
    expect(t.tunnelEvents(tun.id).at(-1)).toMatchObject({ type: 'stopped', reason: 'user' })
    expect(t.audits('tunnel.stop')).toEqual([])
    t.manager.stop(tun.id)
    expect(t.tunnelEvents(tun.id).filter((e) => e.type === 'stopped')).toHaveLength(1)
  })

  it('two tunnels on the same port name each other', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const p = await freePort()
    const first = t.tunnel(hostId, { label: 'first', bindPort: p, targetPort: echo.port })
    const second = t.tunnel(hostId, { label: 'second', bindPort: p, targetPort: echo.port })
    t.manager.start(first.id)
    await t.waitState(first.id, 'up')
    t.manager.start(second.id)
    const rt = await t.waitState(second.id, 'failed')
    expect(rt.error).toEqual({ code: 'port-in-use', message: `Port ${p} on 127.0.0.1 is used by tunnel "first"` })
    expect(t.manager.runtime(first.id).state).toBe('up')
  })

  it('a redial while locked waits for unlock without counting a failure', async () => {
    const t = await setup()
    const srv1 = await server()
    const srv2 = await server()
    const echo = await target()
    const a = t.tunnel(t.host(srv1), { label: 'a', targetPort: echo.port })
    const b = t.tunnel(t.host(srv2, false), { label: 'b', targetPort: echo.port })
    t.manager.start(a.id)
    const upA = await t.waitState(a.id, 'up')
    t.manager.start(b.id)
    const prompt = await t.waitPrompt()
    expect(prompt).toMatchObject({ kind: 'host-key', sessionId: b.id })

    t.vault.lock('manual')
    expect(t.promptDone()).toEqual([prompt.promptId])
    const paused = await t.waitState(b.id, 'retrying')
    expect(paused).toMatchObject({ error: { code: 'locked', message: 'Waiting for unlock' }, retryAt: null, failures: 0 })
    expect(t.tunnelEvents(b.id).at(-1)).toMatchObject({ type: 'retrying', retryInMs: null, failures: 0 })
    // Only A's STABLE_MS timer: nothing is scheduled for B.
    expect(t.timeouts()).toEqual([STABLE_MS])
    expect(t.manager.runtime(a.id).state).toBe('up')
    await ping(upA.boundPort!)

    srv1.dropAll()
    await t.waitState(a.id, 'retrying', (rt) => rt.error?.code === 'dropped')
    expect(t.manager.runtime(a.id).failures).toBe(1)
    t.mt.fire(1000)
    const pausedA = await t.waitState(a.id, 'retrying', (rt) => rt.error?.code === 'locked')
    expect(pausedA).toMatchObject({ failures: 1, retryAt: null })
    expect(t.timeouts()).toEqual([])

    await t.vault.unlock('correct horse')
    await t.waitState(a.id, 'up')
    const again = await t.waitPrompt(2)
    t.broker.answer(again.promptId, { kind: 'host-key', trust: true })
    await t.waitState(b.id, 'up')
    expect(t.manager.runtime(b.id).failures).toBe(0)
  })

  it('a lock and unlock while a dial is in flight resumes at once', async () => {
    let settle!: () => void
    const held = new Promise<void>((r) => (settle = r))
    // Holds the spoiled dial's failure until after the unlock, as a slow network would.
    const t = await setup({
      deps: { connect: (hops, deps, signal) => connectChain(hops, deps, signal).catch(async (err: unknown) => {
        await held
        throw err
      }) },
    })
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv, false)
    const b = t.tunnel(hostId, { label: 'b', targetPort: echo.port })
    const c = t.tunnel(hostId, { label: 'c', targetPort: echo.port })
    t.manager.start(b.id)
    const prompt = await t.waitPrompt()
    t.vault.lock('manual')
    expect(t.promptDone()).toEqual([prompt.promptId])
    await t.vault.unlock('correct horse')
    // C joins the dial the lock spoiled, after the unlock.
    t.manager.start(c.id)
    settle()
    const again = await t.waitPrompt(2)
    t.broker.answer(again.promptId, { kind: 'host-key', trust: true })
    await t.waitState(b.id, 'up')
    await t.waitState(c.id, 'up')
    for (const id of [b.id, c.id]) {
      expect(t.states(id).some((rt) => rt.error?.code === 'locked')).toBe(false)
      expect(t.manager.runtime(id).failures).toBe(0)
    }
    expect(t.prompts()).toHaveLength(2)
  })

  it('stopping the tunnel that owns a dial keeps its prompt for the others', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv, false)
    const a = t.tunnel(hostId, { label: 'a', targetPort: echo.port })
    const b = t.tunnel(hostId, { label: 'b', targetPort: echo.port })
    t.manager.start(a.id)
    const prompt = await t.waitPrompt()
    expect(prompt.sessionId).toBe(a.id)
    t.manager.start(b.id)
    t.manager.stop(a.id)
    expect(t.promptDone()).toEqual([])
    t.broker.answer(prompt.promptId, { kind: 'host-key', trust: true })
    await t.waitState(b.id, 'up')
    expect(t.manager.runtime(a.id).state).toBe('stopped')
    expect(srv.connections()).toBe(1)
  })

  it('auto-start runs once on the first unlock', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const one = t.tunnel(hostId, { label: 'one', targetPort: echo.port, autoStart: true })
    const two = t.tunnel(hostId, { label: 'two', targetPort: echo.port })
    const three = t.tunnel(hostId, { label: 'three', targetPort: echo.port, autoStart: true })
    expect(t.manager.status().map((r) => r.state)).toEqual(['stopped', 'stopped', 'stopped'])
    t.vault.lock('manual')
    expect(t.events.filter((e) => e.event === 'tunnel:state')).toEqual([])
    await t.vault.unlock('correct horse')
    await t.waitState(one.id, 'up')
    await t.waitState(three.id, 'up')
    expect(t.manager.runtime(two.id).state).toBe('stopped')
    const starts = t.audits('tunnel.start')
    expect(starts.map((s) => s.targetLabel).sort()).toEqual(['one', 'three'])
    // Started in label order.
    const connecting = t.events.flatMap((e) => (e.event === 'tunnel:event' && e.payload.type === 'connecting' ? [e.payload.label] : []))
    expect(connecting).toEqual(['one', 'three'])
    expect(starts.every((s) => s.details.trigger === 'auto')).toBe(true)
    expect(t.tunnelEvents(one.id)[0]).toMatchObject({ type: 'connecting', trigger: 'auto' })

    t.vault.lock('manual')
    await t.vault.unlock('correct horse')
    expect(t.audits('tunnel.start')).toHaveLength(2)
    expect(t.events.filter((e) => e.event === 'tunnel:event' && e.payload.type === 'connecting')).toHaveLength(2)
  })

  it('host-key change blocks without prompting and is not retried', async () => {
    const t = await setup()
    const srv = await server()
    const other = generateKey().public
    t.knownHosts.trust('127.0.0.1', srv.port, other.type, other.getPublicSSH().toString('base64'))
    const tun = t.tunnel(t.host(srv, false))
    t.manager.start(tun.id)
    const rt = await t.waitState(tun.id, 'failed')
    expect(rt.error?.code).toBe('host-key-changed')
    expect(t.prompts()).toEqual([])
    expect(t.timeouts()).toEqual([])
    expect(t.audits('tunnel.start')[0]).toMatchObject({ outcome: 'failure', details: { code: 'host-key-changed' } })
  })

  it('cancelling the password prompt fails as auth without re-prompting', async () => {
    const t = await setup({ plan: () => ({ username: TUNNEL_USER.username, kind: 'default', notes: [], methods: [] }) })
    const srv = await server()
    const tun = t.tunnel(t.host(srv))
    t.manager.start(tun.id)
    const prompt = await t.waitPrompt()
    expect(prompt).toMatchObject({ kind: 'password', sessionId: tun.id })
    t.broker.answer(prompt.promptId, { kind: 'password', password: null })
    const rt = await t.waitState(tun.id, 'failed')
    expect(rt.error?.code).toBe('auth')
    expect(t.prompts()).toHaveLength(1)
  })

  it('stop while connecting audits nothing and cancels the prompt', async () => {
    const t = await setup()
    const srv = await server()
    const tun = t.tunnel(t.host(srv, false))
    t.manager.start(tun.id)
    const prompt = await t.waitPrompt()
    t.manager.stop(tun.id)
    expect(t.promptDone()).toEqual([prompt.promptId])
    expect(t.manager.runtime(tun.id).state).toBe('stopped')
    expect(t.tunnelEvents(tun.id).at(-1)).toMatchObject({ type: 'stopped', reason: 'user' })
    expect(t.audits('tunnel.start')).toEqual([])
    expect(t.audits('tunnel.stop')).toEqual([])
    expect(t.broker.pending()).toEqual([])
    await t.waitFor(() => expect(srv.connections()).toBe(0))
    expect(t.mt.pending()).toEqual([])
    expect(t.statsMt.pending()).toEqual([])
  })

  it("editing a running tunnel's port restarts it; renaming does not", async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    const p = await freePort()
    t.store.update(tun.id, { bindPort: p })
    expect(t.audits('tunnel.stop')[0].details).toMatchObject({ reason: 'edited' })
    const up = await t.waitState(tun.id, 'up')
    expect(up.boundPort).toBe(p)
    await ping(p)
    expect(t.states(tun.id).map((s) => s.state)).toEqual(['connecting', 'up', 'stopped', 'connecting', 'up'])

    t.store.update(tun.id, { label: 'renamed', autoReconnect: false })
    expect(t.states(tun.id)).toHaveLength(5)
    expect(t.audits('tunnel.stop')).toHaveLength(1)
    t.manager.stop(tun.id)
    expect(t.tunnelEvents(tun.id).at(-1)).toMatchObject({ type: 'stopped', label: 'renamed' })
    expect(t.audits('tunnel.stop')[0]).toMatchObject({ targetLabel: 'renamed' })
  })

  it('deleting a running tunnel stops it with reason deleted', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { targetPort: echo.port })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    t.store.delete(tun.id)
    const [stop] = t.audits('tunnel.stop')
    const [del] = t.audits('tunnel.delete')
    expect(stop.details).toMatchObject({ reason: 'deleted' })
    expect(stop.id).toBeLessThan(del.id)
    expect(t.tunnelEvents(tun.id).at(-1)).toMatchObject({ type: 'stopped', reason: 'deleted' })
    expect(t.manager.status()).toEqual([])
    expect(t.mt.pending()).toEqual([])
    expect(t.statsMt.pending()).toEqual([])
    await t.waitFor(() => expect(srv.connections()).toBe(0))
  })

  it('stopAll quits every running tunnel', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const a = t.tunnel(hostId, { label: 'a', targetPort: echo.port })
    const b = t.tunnel(hostId, { label: 'b', targetPort: echo.port })
    t.manager.start(a.id)
    t.manager.start(b.id)
    await t.waitState(a.id, 'up')
    await t.waitState(b.id, 'up')
    t.manager.stopAll('quit')
    const stops = t.audits('tunnel.stop')
    expect(stops.map((s) => s.targetLabel).sort()).toEqual(['a', 'b'])
    expect(stops.every((s) => s.details.reason === 'quit')).toBe(true)
    expect(t.manager.status().map((r) => r.state)).toEqual(['stopped', 'stopped'])
    expect(t.mt.pending()).toEqual([])
    expect(t.statsMt.pending()).toEqual([])
    await t.waitFor(() => expect(srv.connections()).toBe(0))
  })

  it('host:delete hook stops the host tunnels', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const tun = t.tunnel(hostId, { targetPort: echo.port })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    t.manager.stopForHost(hostId, 'deleted')
    expect(t.manager.runtime(tun.id).state).toBe('stopped')
    expect(t.audits('tunnel.stop')[0].details).toMatchObject({ reason: 'deleted' })
  })

  it('a refused host:delete leaves the host tunnels running', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    t.hosts.create({ label: 'behind', address: '10.0.0.9', port: 22, jumpHostId: hostId })
    const tun = t.tunnel(hostId, { targetPort: echo.port })
    t.manager.start(tun.id)
    const up = await t.waitState(tun.id, 'up')
    const handlers = createInventoryHandlers({
      hosts: t.hosts,
      environments: t.envs,
      products: t.products,
      resolve: vi.fn(),
      tunnels: t.manager,
    })
    expect(() => handlers['host:delete'](hostId)).toThrow('host is the jump host for behind')
    t.vault.lock('manual')
    expect(() => handlers['host:delete'](hostId)).toThrow()
    await t.vault.unlock('correct horse')
    expect(t.manager.runtime(tun.id).state).toBe('up')
    expect(t.audits('tunnel.stop')).toEqual([])
    await ping(up.boundPort!)
  })

  it('a tunnel whose environment was deleted redials host-only', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const env = t.envs.create({ name: 'staging', color: '#aabbcc' })
    t.envs.putHost(env.id, hostId, 'db')
    const tun = t.tunnel(hostId, { targetPort: echo.port, environmentId: env.id })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    srv.dropAll()
    await t.waitState(tun.id, 'retrying')
    // The FK's SET NULL clears the row without telling the manager.
    t.envs.delete(env.id)
    expect(t.store.get(tun.id).environmentId).toBeNull()
    t.mt.fire(1000)
    const up = await t.waitState(tun.id, 'up')
    expect(t.tunnelEvents(tun.id).at(-1)).toMatchObject({ type: 'up', recovered: true })
    expect(JSON.stringify(t.events)).not.toContain('environment not found')
    await ping(up.boundPort!)
  })

  it('a tunnel whose host left its environment redials host-only', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const env = t.envs.create({ name: 'staging', color: '#aabbcc' })
    t.envs.putHost(env.id, hostId, 'db')
    const tun = t.tunnel(hostId, { targetPort: echo.port, environmentId: env.id })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    srv.dropAll()
    await t.waitState(tun.id, 'retrying')
    t.envs.removeHost(env.id, hostId)
    t.mt.fire(1000)
    await t.waitState(tun.id, 'up')
    expect(JSON.stringify(t.events)).not.toContain('host is not in that environment')
  })

  it('renaming a running tunnel after its environment was cleared does not restart it', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const env = t.envs.create({ name: 'staging', color: '#aabbcc' })
    t.envs.putHost(env.id, hostId, 'db')
    const tun = t.tunnel(hostId, { targetPort: echo.port, environmentId: env.id })
    t.manager.start(tun.id)
    await t.waitState(tun.id, 'up')
    t.envs.delete(env.id)
    t.store.update(tun.id, { label: 'renamed' })
    expect(t.audits('tunnel.stop')).toEqual([])
    expect(t.manager.runtime(tun.id).state).toBe('up')
    t.manager.stop(tun.id)
  })

  it('R tunnel goes up and its probe falls back to keepalive when prohibited', async () => {
    const t = await setup()
    const srv = await server({ allowForward: false, allowRemoteForward: true })
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { type: 'R', targetPort: echo.port })
    t.manager.start(tun.id)
    const up = await t.waitState(tun.id, 'up')
    expect(up.liveness).toBe('keepalive')
    expect(up.boundPort).toBe(srv.remoteListeners()[0])
    await ping(srv.remoteListeners()[0])
    // Keepalive-only liveness has no probe to run.
    expect(t.mt.pending()).toEqual([{ ms: STABLE_MS, kind: 'timeout' }])
    t.manager.stop(tun.id)
    await t.waitFor(() => expect(srv.remoteListeners()).toEqual([]))
  })

  it('D tunnel goes up and serves SOCKS', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const tun = t.tunnel(t.host(srv), { type: 'D', targetHost: undefined, targetPort: undefined })
    t.manager.start(tun.id)
    const up = await t.waitState(tun.id, 'up')
    expect(up.liveness).toBe('probe')
    const sock = await dial(up.boundPort!)
    sock.write(Buffer.from([5, 1, 0]))
    expect([...(await read(sock, 2))]).toEqual([5, 0])
    sock.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, echo.port >> 8, echo.port & 0xff]))
    expect((await read(sock, 10))[1]).toBe(0)
    sock.write('ping')
    expect((await read(sock, 4)).toString()).toBe('ping')
  })

  it('stats are batched and only for running tunnels', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const a = t.tunnel(hostId, { label: 'a', targetPort: echo.port })
    const b = t.tunnel(hostId, { label: 'b', targetPort: echo.port })
    t.tunnel(hostId, { label: 'idle', targetPort: echo.port })
    expect(t.statsMt.pending()).toEqual([])
    t.manager.start(a.id)
    t.manager.start(b.id)
    const upA = await t.waitState(a.id, 'up')
    await t.waitState(b.id, 'up')
    await ping(upA.boundPort!)
    expect(t.statsMt.pending()).toEqual([{ ms: STATS_MS, kind: 'interval' }])
    t.statsMt.fire(STATS_MS)
    const stats = t.events.flatMap((e) => (e.event === 'tunnel:stats' ? [e.payload] : []))
    expect(stats).toHaveLength(1)
    expect(stats[0].map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
    expect(stats[0].find((s) => s.id === a.id)).toMatchObject({ bytesIn: 4, bytesOut: 4 })
    t.manager.stop(a.id)
    t.manager.stop(b.id)
    expect(t.statsMt.pending()).toEqual([])
  })

  it('running limit', async () => {
    const t = await setup({ deps: { connect: () => new Promise(() => {}) } })
    const hostId = t.hosts.create({ label: 'h', address: '127.0.0.1', port: 22 }).id
    const ids = Array.from({ length: 65 }, (_, i) => t.tunnel(hostId, { label: `t${i}` }).id)
    for (const id of ids.slice(0, 64)) t.manager.start(id)
    let err: unknown
    try {
      t.manager.start(ids[64])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Too many running tunnels (64)')
    expect((err as { code?: string }).code).toBe('limit')
    expect(t.manager.runtime(ids[64]).state).toBe('stopped')
    expect(t.audits('tunnel.start')).toEqual([])
    // Starting a running tunnel again is a no-op, even at the limit.
    expect(t.manager.start(ids[0]).state).toBe('connecting')
  })

  it('errors never leak secrets', async () => {
    const warn = vi.spyOn(console, 'warn')
    onTestFinished(() => warn.mockRestore())
    const t = await setup()
    const good = await server()
    const bad = await server({ users: [{ username: TUNNEL_USER.username, password: 'something-else' }] })
    const echo = await target()
    const ok = t.tunnel(t.host(good), { label: 'ok', targetPort: echo.port })
    const denied = t.tunnel(t.host(bad), { label: 'denied', targetPort: echo.port })
    t.manager.start(ok.id)
    t.manager.start(denied.id)
    await t.waitState(ok.id, 'up')
    // The stored password is refused, so the user is asked once; a typed one that fails is final.
    const prompt = await t.waitPrompt()
    expect(prompt).toMatchObject({ kind: 'password', sessionId: denied.id })
    t.broker.answer(prompt.promptId, { kind: 'password', password: 'typed-secret-42' })
    expect((await t.waitState(denied.id, 'failed')).error?.code).toBe('auth')
    expect(t.prompts()).toHaveLength(1)
    good.dropAll()
    await t.waitState(ok.id, 'retrying')
    t.manager.stop(ok.id)
    const everything = JSON.stringify(t.events) + auditRows(t.db) + JSON.stringify(warn.mock.calls)
    expect(everything).not.toContain(TUNNEL_USER.password)
    expect(everything).not.toContain('typed-secret-42')
  })

  it('the SSH username never reaches tunnel events, errors or audit', async () => {
    const warn = vi.spyOn(console, 'warn')
    onTestFinished(() => warn.mockRestore())
    const t = await setup()
    const echo = await target()
    // Auth failure: the stored password is refused, and so is the typed one.
    const bad = await server({ users: [{ username: TUNNEL_USER.username, password: 'something-else' }] })
    const denied = t.tunnel(t.host(bad), { label: 'denied', targetPort: echo.port })
    t.manager.start(denied.id)
    const prompt = await t.waitPrompt()
    t.broker.answer(prompt.promptId, { kind: 'password', password: 'wrong' })
    expect((await t.waitState(denied.id, 'failed')).error?.code).toBe('auth')
    // Host-key failure.
    const changed = await server()
    const other = generateKey().public
    t.knownHosts.trust('127.0.0.1', changed.port, other.type, other.getPublicSSH().toString('base64'))
    const blocked = t.tunnel(t.host(changed, false), { label: 'blocked', targetPort: echo.port })
    t.manager.start(blocked.id)
    expect((await t.waitState(blocked.id, 'failed')).error?.code).toBe('host-key-changed')
    // A drop and a refused redial after being up.
    const good = await server()
    const ok = t.tunnel(t.host(good), { label: 'ok', targetPort: echo.port })
    t.manager.start(ok.id)
    await t.waitState(ok.id, 'up')
    await good.close()
    await t.waitState(ok.id, 'retrying')
    t.mt.fire(1000)
    await t.waitState(ok.id, 'retrying', (rt) => rt.failures === 2)
    t.manager.stop(ok.id)

    // Prompts name the user on purpose (the dialog asks for that user's password); nothing else may.
    expect(JSON.stringify(t.prompts())).toContain(TUNNEL_USER.username)
    const tunnelSide = t.events.filter((e) => e.event.startsWith('tunnel:'))
    expect(tunnelSide.some((e) => e.event === 'tunnel:event' && e.payload.type === 'failed')).toBe(true)
    const runtimes = [denied.id, blocked.id, ok.id].map((id) => t.manager.runtime(id))
    const everything = JSON.stringify(tunnelSide) + JSON.stringify(runtimes) + auditRows(t.db) + JSON.stringify(warn.mock.calls)
    expect(everything).not.toContain(TUNNEL_USER.username)
  })
})

describe('vault reset', () => {
  it('closes every session, local shells too, and stops every tunnel, paused ones too, before reset() resolves', async () => {
    const t = await setup({ wire: false })
    const srv = await server()
    const unknown = await server()
    let localOutput: ((chunk: string) => void) | null = null
    const localKill = vi.fn()
    const echo = await target()
    const sessions = new SessionManager({
      resolve: (hostId, environmentId) => resolveHost(t.db, hostId, environmentId, { localUser: 'tester' }),
      hostInfo: (hostId) => ({ ...hostMeta(t.db, hostId), envVars: {} }),
      envColor: () => null,
      connect: connectChain,
      plan: async () => passwordPlan(),
      knownHosts: t.knownHosts,
      prompts: t.broker,
      audit: t.audit,
      isLocked: () => !t.vault.isUnlocked(),
      emit: () => {},
      // A fake local shell: its scrollback may hold earlier SSH output, so a reset ends it too.
      openLocal: () => ({
        write: () => {},
        resize: () => {},
        onData: (cb) => void (localOutput = cb),
        onExit: () => {},
        kill: localKill,
      }),
    })
    wireVaultHooks(t.vault, hookTargets(t.manager, t.broker, sessions))
    onTestFinished(() => sessions.closeAll('quit'))

    const hostId = t.host(srv)
    const shell = sessions.openSsh({ hostId, cols: 80, rows: 24 })
    await t.waitFor(() => expect(sessions.list()[0]?.state).toBe('ready'))
    const local = sessions.openLocal({ cols: 80, rows: 24 })
    localOutput!('$ ssh prod-db\r\n')
    expect(sessions.attach(local.id).buffer).toContain('ssh prod-db')
    const up = t.tunnel(hostId, { label: 'up', targetPort: echo.port })
    const paused = t.tunnel(t.host(unknown, false), { label: 'paused', targetPort: echo.port })
    t.manager.start(up.id)
    const { boundPort } = await t.waitState(up.id, 'up')
    t.manager.start(paused.id)
    await t.waitPrompt()

    t.vault.lock('manual')
    await t.waitState(paused.id, 'retrying', (rt) => rt.error?.code === 'locked')
    // Locking keeps both: the reset is what has to end them.
    expect(sessions.list().map((s) => s.id)).toEqual([shell.id, local.id])
    expect(t.manager.runtime(up.id).state).toBe('up')

    await t.vault.reset('RESET')
    expect(sessions.list()).toEqual([])
    expect(() => sessions.attach(shell.id)).toThrow('session not found')
    expect(() => sessions.attach(local.id)).toThrow('session not found')
    expect(localKill).toHaveBeenCalledOnce()
    expect(t.audit.list({ actions: ['shell.close'] }).map((a) => a.details.reason)).toEqual(['reset'])
    expect(t.manager.status().map((r) => r.state)).toEqual(['stopped', 'stopped'])
    expect(t.audits('tunnel.stop').map((a) => [a.targetLabel, a.details.reason])).toEqual([['up', 'reset']])
    expect(t.audit.list({ actions: ['ssh.close'] }).map((a) => a.details.reason)).toEqual(['reset'])
    await expect(dial(boundPort!)).rejects.toThrow()
    await t.waitFor(() => expect(srv.connections() + unknown.connections()).toBe(0))

    // Setup is a first unlock again: nothing paused comes back.
    await t.vault.setup('a new password')
    expect(t.manager.status().map((r) => r.state)).toEqual(['stopped', 'stopped'])
  })

  it('one tunnel failing to stop never leaves the others running; the error is logged redacted', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const hostId = t.host(srv)
    const ids = ['a', 'b', 'c'].map((label) => t.tunnel(hostId, { label, targetPort: echo.port }).id)
    for (const id of ids) t.manager.start(id)
    const ports = await Promise.all(ids.map(async (id) => (await t.waitState(id, 'up')).boundPort!))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const realStop = t.manager.stop.bind(t.manager)
    // The first stop does its work and then throws, as a late failure would.
    vi.spyOn(t.manager, 'stop').mockImplementationOnce((id, reason) => {
      realStop(id, reason)
      throw new Error('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----')
    })
    t.vault.lock('manual')
    await t.vault.reset('RESET')
    expect(t.manager.status().map((r) => r.state)).toEqual(['stopped', 'stopped', 'stopped'])
    for (const port of ports) await expect(dial(port)).rejects.toThrow()
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('Tunnel stop failed:')
    expect(logged).not.toContain('b3BlbnNzaC1rZXk')
  })

  it('lets the first unlock after setup auto-start again', async () => {
    const t = await setup()
    const srv = await server()
    const echo = await target()
    const auto = t.tunnel(t.host(srv), { label: 'auto', targetPort: echo.port, autoStart: true })
    t.vault.lock('manual')
    await t.vault.unlock('correct horse')
    await t.waitState(auto.id, 'up')
    t.vault.lock('manual')
    await t.vault.reset('RESET')
    expect(t.manager.runtime(auto.id).state).toBe('stopped')
    await t.vault.setup('a new password')
    await t.waitState(auto.id, 'up')
  })
})
