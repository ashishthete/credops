import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ParsedKey } from 'ssh2'
import type { EventContract } from '../../src/shared/ipc'
import type { SessionPrompt } from '../../src/shared/ssh'
import { createSessionHandlers } from '../../src/main/ipc/handlers/sessions'
import { connectChain } from '../../src/main/ssh/connect'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import { PromptBroker } from '../../src/main/ssh/prompts'
import { SessionManager } from '../../src/main/ssh/sessions'
import { generateKey, startServer } from './ssh-server'
import { makeVault } from './vault-helpers'

type Emitted =
  | { event: 'session:prompt'; payload: EventContract['session:prompt'] }
  | { event: 'session:promptDone'; payload: EventContract['session:promptDone'] }

const TIMEOUT_MS = 1000
const password = { kind: 'password', hopLabel: 'db', username: 'u' } as const

function broker(opts: { locked?: () => boolean } = {}) {
  const events: Emitted[] = []
  let n = 0
  const prompts = new PromptBroker({
    emit: (event, payload) => events.push({ event, payload } as Emitted),
    isLocked: opts.locked ?? (() => false),
    ids: () => `p${++n}`,
    timeoutMs: TIMEOUT_MS,
  })
  const raised = (): SessionPrompt[] => events.flatMap((e) => (e.event === 'session:prompt' ? [e.payload] : []))
  const done = (): string[] => events.flatMap((e) => (e.event === 'session:promptDone' ? [e.payload.promptId] : []))
  return { prompts, events, raised, done }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PromptBroker', () => {
  it('asks, answers and emits done', async () => {
    const b = broker()
    const g = new Set<string>()
    const asked = b.prompts.ask('t1', g, password)
    expect(b.raised()).toEqual([{ ...password, promptId: 'p1', sessionId: 't1' }])
    expect([...g]).toEqual(['p1'])
    b.prompts.answer('p1', { kind: 'password', password: 'pw' })
    await expect(asked).resolves.toEqual({ kind: 'password', password: 'pw' })
    expect(b.done()).toEqual(['p1'])
    expect(g.size).toBe(0)
    expect(b.prompts.pending()).toEqual([])
  })

  it('times out as cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const b = broker()
    const g = new Set<string>()
    const asked = b.prompts.ask('t1', g, password)
    vi.advanceTimersByTime(TIMEOUT_MS - 1)
    expect(b.done()).toEqual([])
    vi.advanceTimersByTime(1)
    await expect(asked).resolves.toBeNull()
    expect(b.done()).toEqual(['p1'])
    expect(g.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("locked asks resolve 'locked' and emit nothing", async () => {
    const b = broker({ locked: () => true })
    const g = new Set<string>()
    await expect(b.prompts.ask('t1', g, password)).resolves.toBe('locked')
    expect(b.events).toEqual([])
    expect(g.size).toBe(0)
    expect(b.prompts.pending()).toEqual([])
  })

  it('cancel(group) settles only that group; cancelAll settles everything', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const b = broker()
    const g1 = new Set<string>()
    const g2 = new Set<string>()
    const a = b.prompts.ask('s1', g1, password)
    const c = b.prompts.ask('t1', g2, password)
    const d = b.prompts.ask('t1', g2, { kind: 'host-key', hopLabel: 'db', info: { host: 'db', keyType: 'ssh-ed25519', fingerprint: 'SHA256:x', known: [] } })
    b.prompts.cancel(g2)
    await expect(c).resolves.toBeNull()
    await expect(d).resolves.toBeNull()
    expect(b.done()).toEqual(['p2', 'p3'])
    expect(g2.size).toBe(0)
    expect(b.prompts.pending().map((p) => p.promptId)).toEqual(['p1'])
    b.prompts.cancelAll()
    await expect(a).resolves.toBeNull()
    expect(b.done()).toEqual(['p2', 'p3', 'p1'])
    expect(g1.size).toBe(0)
    expect(b.prompts.pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('mismatched kind throws; unknown id is a no-op', async () => {
    const b = broker()
    const g = new Set<string>()
    void b.prompts.ask('t1', g, password)
    expect(() => b.prompts.answer('p1', { kind: 'host-key', trust: true })).toThrow("prompt answer doesn't match")
    expect(() => b.prompts.answer('nope', { kind: 'password', password: 'pw' })).not.toThrow()
    expect(b.done()).toEqual([])
    expect(b.prompts.pending().map((p) => p.promptId)).toEqual(['p1'])
    b.prompts.cancelAll()
  })

  it('sessions and tunnels share one prompt queue', async () => {
    const f = makeVault()
    await f.vault.setup({ password: 'correct horse', touchId: true })
    const dir = mkdtempSync(join(tmpdir(), 'credops-prompts-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
    const userKey = generateKey()
    const srv = await startServer({ users: [{ username: 'ops', publicKey: userKey.public as ParsedKey }] })
    onTestFinished(() => srv.close())
    const b = broker()
    const isLocked = (): boolean => !f.vault.isUnlocked()
    const sessions = new SessionManager({
      resolve: (hostId) => ({
        hostId,
        environmentId: null,
        addressSource: 'host',
        address: '127.0.0.1',
        port: { value: srv.port, source: 'host' },
        identity: { source: 'global', username: 'ops', auth: 'default' },
        jump: { hostId: null, source: null },
        chain: [],
        conflicts: [],
      }),
      hostInfo: () => ({ label: 'web-1', keepaliveSec: null, envVars: {} }),
      envColor: () => null,
      connect: connectChain,
      plan: async () => ({ username: 'ops', kind: 'key', notes: [], methods: [{ type: 'publickey', label: 'k', key: userKey.private }] }),
      knownHosts,
      prompts: b.prompts,
      audit: f.audit,
      isLocked,
      emit: () => {},
    })
    onTestFinished(() => sessions.closeAll('quit'))
    const handlers = createSessionHandlers({ sessions, prompts: b.prompts, knownHosts })

    const { id } = sessions.openSsh({ hostId: randomUUID(), cols: 80, rows: 24 })
    const hostKey = await vi.waitFor(
      () => {
        const p = b.raised()[0]
        if (!p) throw new Error('no prompt yet')
        return p
      },
      { timeout: 10_000, interval: 5 },
    )
    expect(hostKey).toMatchObject({ kind: 'host-key', sessionId: id })
    const g = new Set<string>()
    const tunnel = b.prompts.ask('tunnel-1', g, password)
    const pending = b.prompts.pending()
    expect(pending.map((p) => [p.sessionId, p.kind])).toEqual([
      [id, 'host-key'],
      ['tunnel-1', 'password'],
    ])
    expect(await handlers['session:prompts']()).toEqual(pending)

    await handlers['session:answer'](pending[1]!.promptId, { kind: 'password', password: 'pw' })
    await expect(tunnel).resolves.toEqual({ kind: 'password', password: 'pw' })
    expect(b.prompts.pending().map((p) => p.promptId)).toEqual([hostKey.promptId])
  })
})
