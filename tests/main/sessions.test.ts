import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ParsedKey } from 'ssh2'
import type { EventContract, EventName } from '../../src/shared/ipc'
import type { IdentityRef, ResolvedHop, ResolvedHost } from '../../src/shared/inventory'
import { PROMPT_TIMEOUT_MS, SCROLLBACK_CHARS, SESSION_LIMIT } from '../../src/shared/ssh'
import type { SessionMeta, SessionPrompt } from '../../src/shared/ssh'
import type { AuthPlan } from '../../src/main/ssh/auth'
import { connectChain } from '../../src/main/ssh/connect'
import { fingerprintOf, KnownHostStore } from '../../src/main/ssh/known-hosts'
import { PromptBroker } from '../../src/main/ssh/prompts'
import { SessionManager, type SessionManagerDeps } from '../../src/main/ssh/sessions'
import { generateKey, startServer } from './ssh-server'
import type { ServerOpts, TestServer } from './ssh-server'
import { makeVault } from './vault-helpers'
import { VAULT_LOCKED } from '../../src/shared/vault'

const globalId: IdentityRef = { source: 'global', username: 'ops', auth: 'default' }
const userKey = generateKey()
const MARKER = '\r\n\x1b[2m── reconnected ──\x1b[0m\r\n'
const size = { cols: 80, rows: 24 }

const keyPlan = (): AuthPlan => ({
  username: 'ops',
  kind: 'key',
  notes: [],
  methods: [{ type: 'publickey', label: 'test key', key: userKey.private }],
})

async function server(opts: Partial<ServerOpts> = {}): Promise<TestServer> {
  const s = await startServer({ users: [{ username: 'ops', publicKey: userKey.public as ParsedKey }], ...opts })
  onTestFinished(() => s.close())
  return s
}

async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

type Emitted = { [K in EventName]: { event: K; payload: EventContract[K] } }[EventName]

interface Target {
  port: number
  chain?: ResolvedHop[]
}

async function setup(over: Partial<SessionManagerDeps> = {}) {
  const f = makeVault()
  await f.vault.setup('correct horse')
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-sessions-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  const events: Emitted[] = []
  const targets = new Map<string, Target>()

  const resolve = (hostId: string): ResolvedHost => {
    const t = targets.get(hostId)!
    return {
      hostId,
      environmentId: null,
      address: '127.0.0.1',
      port: { value: t.port, source: 'host' },
      identity: globalId,
      jump: { hostId: t.chain?.[0]?.hostId ?? null, source: t.chain ? 'host' : null },
      chain: t.chain ?? [],
      conflicts: [],
    }
  }
  const emit: SessionManagerDeps['emit'] = (event, payload) => events.push({ event, payload } as Emitted)
  const isLocked = over.isLocked ?? ((): boolean => !f.vault.isUnlocked())
  const broker = new PromptBroker({ emit, isLocked })
  const manager = new SessionManager({
    resolve,
    hostInfo: () => ({ label: 'web-1', keepaliveSec: null, envVars: { LANG: 'C.UTF-8' } }),
    envColor: () => null,
    connect: connectChain,
    plan: async () => keyPlan(),
    knownHosts,
    prompts: broker,
    audit: f.audit,
    isLocked,
    emit,
    ...over,
  })
  onTestFinished(() => manager.closeAll('quit'))

  /** A host id that dials `port` (over `chain`, if any). */
  const host = (port: number, chain?: ResolvedHop[]): string => {
    const id = randomUUID()
    targets.set(id, { port, chain })
    return id
  }
  const trust = (s: TestServer): void => void knownHosts.trust('127.0.0.1', s.port, s.hostKeyType, s.hostKeyBase64)
  const states = (id: string): SessionMeta[] =>
    events.flatMap((e) => (e.event === 'session:state' && e.payload.id === id ? [e.payload] : []))
  const prompts = (): SessionPrompt[] => events.flatMap((e) => (e.event === 'session:prompt' ? [e.payload] : []))
  const promptDone = (): string[] => events.flatMap((e) => (e.event === 'session:promptDone' ? [e.payload.promptId] : []))
  const data = (id: string): string =>
    events.flatMap((e) => (e.event === 'session:data' && e.payload.id === id ? [e.payload.data] : [])).join('')
  const dataEvents = (id: string): number => events.filter((e) => e.event === 'session:data' && e.payload.id === id).length
  const waitState = (id: string, state: SessionMeta['state']): Promise<SessionMeta> =>
    vi.waitFor(
      () => {
        const last = states(id).at(-1)
        if (last?.state !== state) throw new Error(`state is ${last?.state}`)
        return last
      },
      { timeout: 10_000, interval: 5 },
    )
  const waitPrompt = (): Promise<SessionPrompt> =>
    vi.waitFor(
      () => {
        const p = prompts().at(-1)
        if (!p) throw new Error('no prompt yet')
        return p
      },
      { timeout: 10_000, interval: 5 },
    )
  const waitData = (id: string, text: string): Promise<void> =>
    vi.waitFor(
      () => {
        if (!data(id).includes(text)) throw new Error('not yet')
      },
      { timeout: 10_000, interval: 5 },
    )
  const audits = (action: 'ssh.open' | 'ssh.close') => f.audit.list({ actions: [action] })

  return { ...f, knownHosts, manager, broker, events, host, trust, states, prompts, promptDone, data, dataEvents, waitState, waitPrompt, waitData, audits }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionManager', () => {
  it('open → ready → data flows', async () => {
    const t = await setup()
    const srv = await server()
    t.trust(srv)
    const meta = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    expect(meta.state).toBe('connecting')
    expect(meta.attempt).toBe(1)
    const ready = await t.waitState(meta.id, 'ready')
    expect(t.states(meta.id)[0].state).toBe('connecting')
    expect(ready.hops).toEqual([{ label: 'web-1', state: 'up' }])
    await t.waitData(meta.id, 'READY')
    t.manager.write(meta.id, 'hi\r')
    await t.waitData(meta.id, 'hi\r')

    const [open] = t.audits('ssh.open')
    expect(open).toMatchObject({ outcome: 'success', targetType: 'host', targetLabel: 'web-1' })
    expect(open.details).toMatchObject({ hops: 1, auth: 'key' })
    expect(JSON.stringify(open)).not.toContain('127.0.0.1')
  })

  it('first sight asks, trust stores the key and connects', async () => {
    const t = await setup()
    const srv = await server()
    const hostId = t.host(srv.port)
    const meta = t.manager.openSsh({ hostId, ...size })
    const prompt = await t.waitPrompt()
    expect(prompt).toMatchObject({ kind: 'host-key', sessionId: meta.id, hopLabel: 'web-1' })
    if (prompt.kind !== 'host-key') throw new Error('wrong kind')
    expect(prompt.info.fingerprint).toBe(fingerprintOf(srv.hostKeyBase64))

    t.broker.answer(prompt.promptId, { kind: 'host-key', trust: true })
    await t.waitState(meta.id, 'ready')
    expect(t.promptDone()).toEqual([prompt.promptId])
    expect(t.knownHosts.list()).toHaveLength(1)

    const second = t.manager.openSsh({ hostId, ...size })
    await t.waitState(second.id, 'ready')
    expect(t.prompts()).toHaveLength(1)
  })

  it('close during a pending host-key prompt aborts cleanly', async () => {
    const t = await setup()
    const srv = await server()
    const meta = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    const prompt = await t.waitPrompt()
    t.manager.close(meta.id)
    expect(t.promptDone()).toEqual([prompt.promptId])
    await vi.waitFor(() => expect(srv.connections()).toBe(0), { timeout: 5000 })
    // A late trust answer is a no-op: the key is not stored.
    t.broker.answer(prompt.promptId, { kind: 'host-key', trust: true })
    expect(t.knownHosts.list()).toEqual([])
    expect(t.audits('ssh.open')).toEqual([])
    expect(t.manager.list()).toEqual([])
  })

  it('remote exit closes once and reconnect reuses the tab', async () => {
    const t = await setup()
    const srv = await server()
    t.trust(srv)
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    await t.waitState(id, 'ready')
    await t.waitData(id, 'READY')
    t.manager.write(id, 'exit\r')
    await t.waitState(id, 'closed')
    await vi.waitFor(() => expect(srv.connections()).toBe(0), { timeout: 5000 })
    const closes = t.audits('ssh.close')
    expect(closes).toHaveLength(1)
    expect(closes[0].details).toMatchObject({ reason: 'remote' })
    expect(typeof closes[0].details.durationSec).toBe('number')
    const first = t.manager.attach(id).buffer

    const again = t.manager.reconnect(id)
    expect(again).toMatchObject({ id, state: 'connecting', attempt: 2 })
    const ready = await t.waitState(id, 'ready')
    expect(ready.attempt).toBe(2)
    await vi.waitFor(() => expect(t.manager.attach(id).buffer).toContain(`${MARKER}READY`), { timeout: 5000 })
    expect(t.manager.attach(id).buffer.startsWith(first + MARKER)).toBe(true)
    expect(t.manager.list().map((m) => m.id)).toEqual([id])
    expect(t.audits('ssh.open')).toHaveLength(2)
  })

  it('attach while a batch is pending gives a buffer and end consistent with the next event', async () => {
    const t = await setup()
    const srv = await server()
    t.trust(srv)
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    await t.waitState(id, 'ready')
    await t.waitData(id, 'READY')
    await new Promise((r) => setTimeout(r, 100))
    const sent = (): { data: string; end: number }[] =>
      t.events.flatMap((e) => (e.event === 'session:data' && e.payload.id === id ? [e.payload] : []))
    const before = sent().length
    // Output that is appended but not yet flushed to an event.
    const internals = t.manager as unknown as { sessions: Map<string, unknown>; output(s: unknown, text: string): void }
    internals.output(internals.sessions.get(id), 'PENDING')
    const snap = t.manager.attach(id)
    expect(sent()).toHaveLength(before)
    expect(snap.buffer.endsWith('PENDING')).toBe(true)
    await vi.waitFor(() => expect(sent().length).toBeGreaterThan(before))
    const next = sent()[before]
    expect(next.data).toBe('PENDING')
    expect(next.end).toBe(snap.end)
    expect(snap.end - next.data.length).toBe(sent()[before - 1].end)
    expect(snap.end).toBe(sent().reduce((n, e) => n + e.data.length, 0))
  })

  it('coalesces a flood into batched events and caps scrollback', async () => {
    const chunk = (i: number): string => `${String(i).padStart(99, '.')}\n`
    const t = await setup()
    const srv = await server({
      onShell: (stream) => {
        for (let i = 0; i < 20_000; i++) stream.write(chunk(i))
      },
    })
    t.trust(srv)
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    await vi.waitFor(() => expect(t.data(id).endsWith(chunk(19_999))).toBe(true), { timeout: 20_000, interval: 20 })
    expect(t.dataEvents(id)).toBeLessThan(400)
    const { buffer } = t.manager.attach(id)
    expect(buffer.length).toBeLessThanOrEqual(SCROLLBACK_CHARS)
    expect(buffer.length).toBeGreaterThan(SCROLLBACK_CHARS - 100)
    expect(buffer.endsWith(chunk(19_999))).toBe(true)
  }, 30_000)

  it('decodes UTF-8 split across chunks', async () => {
    const t = await setup()
    const srv = await server({
      onShell: (stream) => {
        const [a, b] = Buffer.from('é')
        stream.write(Buffer.from([a]))
        setTimeout(() => stream.write(Buffer.from([b, 0x21])), 50)
      },
    })
    t.trust(srv)
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    await t.waitData(id, '!')
    expect(t.data(id)).toContain('é')
    expect(t.data(id)).not.toContain('�')
  })

  it('sends the window size and env vars', async () => {
    let seen: { env: Record<string, string>; pty: { cols: number; rows: number } | null } | null = null
    const t = await setup()
    const srv = await server({
      onShell: (stream, info) => {
        seen = info
        stream.write('ok')
      },
    })
    t.trust(srv)
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), cols: 132, rows: 40 })
    await t.waitData(id, 'ok')
    expect(seen!.env).toMatchObject({ LANG: 'C.UTF-8' })
    expect(seen!.pty).toMatchObject({ cols: 132, rows: 40 })
  })

  it('failed dial reports the error and audits failure', async () => {
    const t = await setup()
    const { id } = t.manager.openSsh({ hostId: t.host(await closedPort()), ...size })
    const failed = await t.waitState(id, 'failed')
    expect(failed.error).toMatchObject({ code: 'refused', hopLabel: 'web-1' })
    expect(failed.hops).toEqual([{ label: 'web-1', state: 'failed' }])
    const [open] = t.audits('ssh.open')
    expect(open.outcome).toBe('failure')
    expect(open.details).toMatchObject({ code: 'refused' })
    expect(JSON.stringify(open)).not.toContain('127.0.0.1')
  })

  it('names the hop that failed in a jump chain', async () => {
    const t = await setup()
    const jump = await server({ allowForward: true })
    t.trust(jump)
    const chain: ResolvedHop[] = [{ hostId: randomUUID(), label: 'bastion', address: '127.0.0.1', port: jump.port, identity: globalId }]
    const { id } = t.manager.openSsh({ hostId: t.host(await closedPort(), chain), ...size })
    const failed = await t.waitState(id, 'failed')
    expect(failed.hops).toEqual([
      { label: 'bastion', state: 'up' },
      { label: 'web-1', state: 'failed' },
    ])
    expect(failed.error).toMatchObject({ code: 'refused', hopLabel: 'web-1' })
    await vi.waitFor(() => expect(jump.connections()).toBe(0), { timeout: 5000 })
  })

  it('a changed host key is refused without a prompt and recorded', async () => {
    const t = await setup()
    const srv = await server()
    const other = generateKey().public as ParsedKey
    t.knownHosts.trust('127.0.0.1', srv.port, srv.hostKeyType, other.getPublicSSH().toString('base64'))
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    const failed = await t.waitState(id, 'failed')
    expect(failed.error?.code).toBe('host-key-changed')
    expect(t.prompts()).toEqual([])
    expect(t.audit.list({ actions: ['knownhost.mismatch'] })).toHaveLength(1)
  })

  it('a drop after ready closes with its own message and audits an error close', async () => {
    const t = await setup()
    const srv = await server()
    t.trust(srv)
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    await t.waitState(id, 'ready')
    await srv.close()
    const closed = await vi.waitFor(
      () => {
        const last = t.states(id).at(-1)!
        if (last.state === 'ready') throw new Error('still ready')
        return last
      },
      { timeout: 5000 },
    )
    expect(closed.state).toBe('failed')
    expect(closed.error?.message).toMatch(/connection to web-1 was lost/i)
    expect(closed.error?.message).not.toMatch(/didn't answer/)
    const closes = t.audits('ssh.close')
    expect(closes).toHaveLength(1)
    expect(closes[0].details).toMatchObject({ reason: 'error' })
  })

  it('prompt timeout cancels', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = await setup()
    const srv = await server()
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    const prompt = await t.waitPrompt()
    vi.advanceTimersByTime(PROMPT_TIMEOUT_MS)
    expect(t.promptDone()).toEqual([prompt.promptId])
    const failed = await t.waitState(id, 'failed')
    expect(failed.error?.code).toBe('host-key-rejected')
  })

  it('vault lock cancels pending prompts and fails connects still dialling, but keeps ready sessions', async () => {
    const t = await setup()
    const known = await server()
    t.trust(known)
    const unknown = await server()
    const a = t.manager.openSsh({ hostId: t.host(known.port), ...size })
    await t.waitState(a.id, 'ready')
    await t.waitData(a.id, 'READY')
    const b = t.manager.openSsh({ hostId: t.host(unknown.port), ...size })
    const prompt = await t.waitPrompt()

    t.vault.lock('manual')
    t.manager.vaultLocked()
    expect(t.promptDone()).toEqual([prompt.promptId])
    expect(t.broker.pending()).toEqual([])
    const failed = t.states(b.id).at(-1)
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'locked', hopLabel: 'web-1' } })
    await vi.waitFor(() => expect(unknown.connections()).toBe(0), { timeout: 5000 })
    // A late trust answer for the cancelled prompt stores nothing.
    t.broker.answer(prompt.promptId, { kind: 'host-key', trust: true })
    expect(t.knownHosts.list()).toHaveLength(1)
    expect(t.audits('ssh.open').find((e) => e.outcome === 'failure')?.details).toMatchObject({ code: 'locked' })
    t.manager.write(a.id, 'still\r')
    await t.waitData(a.id, 'still\r')
    expect(t.manager.attach(a.id).meta.state).toBe('ready')
  })

  it('a dial in flight at the lock never raises a prompt and ends locked', async () => {
    const t = await setup()
    const srv = await server()
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    t.vault.lock('manual')
    t.manager.vaultLocked()
    expect(t.states(id).at(-1)).toMatchObject({ state: 'failed', error: { code: 'locked' } })
    await vi.waitFor(() => expect(srv.connections()).toBe(0), { timeout: 5000 })
    expect(t.prompts()).toEqual([])
    expect(t.knownHosts.list()).toEqual([])
  })

  it('a prompt the dial reaches while locked is never raised: the attempt fails as locked', async () => {
    let locked = false
    const t = await setup({ isLocked: () => locked })
    const srv = await server()
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    // Locked without the lock hook having run: ask() itself must refuse.
    locked = true
    const failed = await t.waitState(id, 'failed')
    expect(failed.error?.code).toBe('locked')
    expect(t.prompts()).toEqual([])
    expect(t.promptDone()).toEqual([])
    expect(t.knownHosts.list()).toEqual([])
    await vi.waitFor(() => expect(srv.connections()).toBe(0), { timeout: 5000 })
  })

  it('open and reconnect are refused while locked', async () => {
    const t = await setup()
    const srv = await server()
    const hostId = t.host(srv.port)
    const { id } = t.manager.openSsh({ hostId, ...size })
    t.manager.vaultLocked()
    t.vault.lock('manual')
    expect(() => t.manager.openSsh({ hostId, ...size })).toThrow(VAULT_LOCKED)
    expect(() => t.manager.reconnect(id)).toThrow(VAULT_LOCKED)
    expect(t.manager.list()).toHaveLength(1)
  })

  it('pendingPrompts lists the prompts still waiting, for a renderer that mounts late', async () => {
    const t = await setup()
    const srv = await server()
    t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    const prompt = await t.waitPrompt()
    expect(t.broker.pending()).toEqual([prompt])
    t.broker.answer(prompt.promptId, { kind: 'host-key', trust: false })
    expect(t.broker.pending()).toEqual([])
  })

  it('closeAll audits quit for every ready session', async () => {
    const t = await setup()
    const srv = await server()
    t.trust(srv)
    const hostId = t.host(srv.port)
    const a = t.manager.openSsh({ hostId, ...size })
    const b = t.manager.openSsh({ hostId, ...size })
    await t.waitState(a.id, 'ready')
    await t.waitState(b.id, 'ready')
    t.manager.closeAll('quit')
    const closes = t.audits('ssh.close')
    expect(closes).toHaveLength(2)
    expect(closes.every((c) => c.details.reason === 'quit')).toBe(true)
    expect(t.manager.list()).toEqual([])
    await vi.waitFor(() => expect(srv.connections()).toBe(0), { timeout: 5000 })
  })

  it('session limit', async () => {
    const t = await setup({ connect: () => new Promise(() => {}) })
    const hostId = t.host(22)
    for (let i = 0; i < 32; i++) t.manager.openSsh({ hostId, ...size })
    let err: unknown
    try {
      t.manager.openSsh({ hostId, ...size })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(SESSION_LIMIT)
    expect(SESSION_LIMIT).toBe('Too many open sessions (32)')
    expect((err as { code?: string }).code).toBe('limit')
    expect(t.manager.list()).toHaveLength(32)
  })

  it('answer with a mismatched kind throws; unknown prompt id is a no-op', async () => {
    const t = await setup()
    const srv = await server()
    t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    const prompt = await t.waitPrompt()
    expect(() => t.broker.answer(prompt.promptId, { kind: 'password', password: 'x' })).toThrow("prompt answer doesn't match")
    expect(() => t.broker.answer(randomUUID(), { kind: 'host-key', trust: true })).not.toThrow()
    expect(t.promptDone()).toEqual([])
  })

  it('writes before the shell is up are dropped; a resize meanwhile is applied when it comes up', async () => {
    const shell = stubShell()
    const t = await setup({ connect: shell.connect })
    const { id } = t.manager.openSsh({ hostId: t.host(22), ...size })
    await vi.waitFor(() => expect(shell.requested).toEqual({ term: 'xterm-256color', ...size }), { timeout: 5000 })
    t.manager.write(id, 'early')
    t.manager.resize(id, 100, 30)
    expect(() => t.manager.reconnect(id)).toThrow('Only a closed or failed session can be reconnected')

    const stream = shell.open()
    await t.waitState(id, 'ready')
    expect(stream.setWindow).toHaveBeenCalledWith(30, 100, 0, 0)
    t.manager.write(id, 'late')
    expect(stream.write.mock.calls).toEqual([['late']])
  })

  it('a resize matching the requested size sends no extra window change', async () => {
    const shell = stubShell()
    const t = await setup({ connect: shell.connect })
    const { id } = t.manager.openSsh({ hostId: t.host(22), ...size })
    await vi.waitFor(() => expect(shell.requested).not.toBeNull(), { timeout: 5000 })
    t.manager.resize(id, 100, 30)
    t.manager.resize(id, size.cols, size.rows)
    const stream = shell.open()
    await t.waitState(id, 'ready')
    expect(stream.setWindow).not.toHaveBeenCalled()
  })

  it('a keyboard answer must carry one response per prompt', async () => {
    const t = await setup({
      connect: (async (hops, deps) => {
        await deps.askKeyboard(hops[0], '', '', [
          { prompt: 'Code: ', echo: false },
          { prompt: 'PIN: ', echo: false },
        ])
        return new Promise(() => {})
      }) as SessionManagerDeps['connect'],
    })
    t.manager.openSsh({ hostId: t.host(22), ...size })
    const prompt = await t.waitPrompt()
    expect(() => t.broker.answer(prompt.promptId, { kind: 'keyboard', responses: ['123456'] })).toThrow(
      "prompt answer doesn't match",
    )
    expect(t.promptDone()).toEqual([])
    t.broker.answer(prompt.promptId, { kind: 'keyboard', responses: ['123456', '0000'] })
    expect(t.promptDone()).toEqual([prompt.promptId])
  })

  it('a failing audit write inside an ssh2 callback is contained and logged without details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const t = await setup({
      audit: {
        append: () => {
          throw new Error('SQLITE_FULL: database or disk is full')
        },
      },
    })
    const srv = await server()
    t.trust(srv)
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port), ...size })
    await t.waitState(id, 'ready')
    await t.waitData(id, 'READY')
    t.manager.write(id, 'exit\r')
    await t.waitState(id, 'closed')
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'Session audit write failed (ssh.open):',
      'Session audit write failed (ssh.close):',
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('127.0.0.1')
  })

  it('a target exiting on its own ends the jump connection too', async () => {
    const t = await setup()
    const jump = await server({ allowForward: true })
    const srv = await server()
    t.trust(jump)
    t.trust(srv)
    const chain: ResolvedHop[] = [{ hostId: randomUUID(), label: 'bastion', address: '127.0.0.1', port: jump.port, identity: globalId }]
    const { id } = t.manager.openSsh({ hostId: t.host(srv.port, chain), ...size })
    await t.waitState(id, 'ready')
    await t.waitData(id, 'READY')
    expect(jump.connections()).toBe(1)
    t.manager.write(id, 'exit\r')
    await t.waitState(id, 'closed')
    await vi.waitFor(() => expect(jump.connections()).toBe(0), { timeout: 5000 })
  })
})

/** A connect that hands back a fake client; `open()` delivers its shell stream. */
function stubShell() {
  let onShell: ((err: Error | undefined, stream: unknown) => void) | null = null
  const client = Object.assign(new EventEmitter(), {
    shell: (opts: unknown, _env: unknown, cb: typeof onShell) => {
      stub.requested = opts
      onShell = cb
    },
  })
  const stub = {
    requested: null as unknown,
    connect: (async () => ({ client, close: () => {} })) as unknown as SessionManagerDeps['connect'],
    open() {
      const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        write: vi.fn(),
        setWindow: vi.fn(),
        close: vi.fn(() => stream.emit('close')),
      })
      onShell!(undefined, stream)
      return stream
    },
  }
  return stub
}
