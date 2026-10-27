import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionPrompt } from '../../src/shared/ssh'
import type { ResolvedHost } from '../../src/shared/inventory'
import { prepareHosts, type PrepareDeps } from '../../src/main/deploy/hostkeys'
import { startTap, tapCommand } from '../../src/main/deploy/log-tap'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { connectChain } from '../../src/main/ssh/connect'
import { hostToken, KnownHostStore } from '../../src/main/ssh/known-hosts'
import { PromptBroker } from '../../src/main/ssh/prompts'
import { generateKey, startServer, type TestServer } from './ssh-server'
import { makeVault } from './vault-helpers'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const user = generateKey()
const HOST_ID = 'h1'

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'od-home-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.ssh'))
  writeFileSync(join(dir, '.ssh', 'id_ed25519'), user.private, { mode: 0o600 })
  return dir
}

async function server(opts: Partial<Parameters<typeof startServer>[0]> = {}): Promise<TestServer> {
  const s = await startServer({ users: [{ username: 'ops', publicKey: user.public }], ...opts })
  cleanups.push(() => s.close())
  return s
}

function planFor(hosts: { hostId: string; label: string }[], port: number): DeployPlan {
  return {
    releaseId: '0190a1b2-c3d4-7e5f-8a6b-1234567890ab',
    hosts: hosts.map((h, i) => ({
      ...h,
      alias: `od-${i + 1}`,
      hops: [{ alias: `od-${i + 1}`, hostId: h.hostId, label: h.label, address: '127.0.0.1', port, user: 'ops', auth: 'agent' as const }],
    })),
  } as DeployPlan
}

function resolved(port: number, identity: ResolvedHost['identity'] = { source: 'global', username: 'ops', auth: 'default' }) {
  return (hostId: string): ResolvedHost =>
    ({ hostId, environmentId: null, address: '127.0.0.1', port: { value: port, source: 'host' }, identity, jump: { hostId: null, source: null }, chain: [], conflicts: [] }) as unknown as ResolvedHost
}

async function fixture(resolve: PrepareDeps['resolve'], identities: PrepareDeps['identities'] = { resolve: vi.fn() as never }) {
  const f = makeVault()
  await f.vault.setup({ password: 'correct horse', touchId: true })
  const dir = mkdtempSync(join(tmpdir(), 'od-kh-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  const raised: SessionPrompt[] = []
  let broker!: PromptBroker
  broker = new PromptBroker({
    emit: (event, payload) => {
      if (event !== 'session:prompt') return
      raised.push(payload as SessionPrompt)
      queueMicrotask(() => broker.answer((payload as SessionPrompt).promptId, { kind: 'host-key', trust: true }))
    },
    isLocked: () => false,
    ids: (() => {
      let n = 0
      return () => `p${++n}`
    })(),
    timeoutMs: 2000,
  })
  const connect = vi.fn(connectChain)
  const deps: PrepareDeps = {
    resolve,
    connectChain: connect,
    prompts: broker,
    knownHosts,
    identities,
    auth: { env: {}, home: home(), agentKeys: async () => null },
    signal: new AbortController().signal,
    timeoutMs: 2000,
  }
  return { deps, raised, connect, knownHosts }
}

describe('prepareHosts', () => {
  it('first dial raises a TOFU prompt and the trusted key lands in knownHosts entries', async () => {
    const s = await server()
    const PORT = s.port
    const { deps, raised, knownHosts } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    cleanups.push(() => prepared.close())
    expect(prepared.checks).toEqual([])
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({ kind: 'host-key', sessionId: '0190a1b2-c3d4-7e5f-8a6b-1234567890ab', hopLabel: 'web' })
    expect(prepared.knownHosts).toEqual([{ token: hostToken('127.0.0.1', s.port), keyType: s.hostKeyType, keyBase64: s.hostKeyBase64 }])
    expect(prepared.links.has(HOST_ID)).toBe(true)
    expect(prepared.userAgentNeeded).toBe(true)
    expect((await knownHosts.check('127.0.0.1', s.port, s.hostKeyType, s.hostKeyBase64)).status).toBe('match')

    // A second preparation finds the key trusted and asks nothing.
    const again = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    cleanups.push(() => again.close())
    expect(raised).toHaveLength(1)
    expect(again.knownHosts).toHaveLength(1)
  })

  it('password identity is rejected with the §9a message before dialling', async () => {
    const s = await server()
    const PORT = s.port
    const identities = { resolve: vi.fn(async () => ({ username: 'ops', auth: 'password' as const, password: 'x' })) }
    const identity = { source: 'host', identityId: 'i1', label: 'pw', username: 'ops', auth: 'password', vaultId: 'v' } as ResolvedHost['identity']
    const { deps, connect } = await fixture(resolved(s.port, identity), identities as never)
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    expect(connect).not.toHaveBeenCalled()
    expect(prepared.checks).toEqual([
      { id: 'auth', deploymentId: null, hostId: HOST_ID, label: 'web', level: 'block', message: 'Deploys need key or agent auth; "web" uses a password' },
    ])
    expect(prepared.links.size).toBe(0)
  })

  it('unreachable host becomes a reachable block check', async () => {
    const s = await server()
    const port = s.port
    const PORT = port
    await s.close()
    const { deps } = await fixture(resolved(port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    expect(prepared.checks).toHaveLength(1)
    expect(prepared.checks[0]).toMatchObject({ id: 'reachable', level: 'block', hostId: HOST_ID, label: 'web' })
    expect(prepared.checks[0].message).toMatch(/refused/)
  })

  it('blocks a host whose resolved hops differ from the plan', async () => {
    const s = await server()
    const { deps, connect } = await fixture(resolved(s.port + 1))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], s.port), deps)
    expect(connect).not.toHaveBeenCalled()
    expect(prepared.checks).toEqual([
      { id: 'reachable', deploymentId: null, hostId: HOST_ID, label: 'web', level: 'block', message: 'Host settings changed since the plan was built' },
    ])
    const extra = planFor([{ hostId: HOST_ID, label: 'web' }], s.port)
    extra.hosts[0].hops.unshift({ ...extra.hosts[0].hops[0], alias: 'od-9' })
    const second = await prepareHosts(extra, (await fixture(resolved(s.port))).deps)
    expect(second.checks[0].message).toBe('Host settings changed since the plan was built')
  })

  it('a rejected changed host key blocks that host', async () => {
    const s = await server()
    const { deps, knownHosts } = await fixture(resolved(s.port))
    const other = await server()
    knownHosts.trust('127.0.0.1', s.port, other.hostKeyType, other.hostKeyBase64)
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], s.port), deps)
    expect(prepared.checks).toHaveLength(1)
    expect(prepared.checks[0]).toMatchObject({ level: 'block', hostId: HOST_ID })
    expect(prepared.checks[0].message).toMatch(/host key.*changed/)
    expect(prepared.links.size).toBe(0)
  })

  it('stops dialling once aborted', async () => {
    const s = await server()
    const { deps, connect } = await fixture(resolved(s.port))
    const ac = new AbortController()
    ac.abort()
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], s.port), { ...deps, signal: ac.signal })
    expect(connect).not.toHaveBeenCalled()
    expect(prepared.links.size).toBe(0)
  })

  it('collects key identities once and closes every link, idempotently', async () => {
    const s = await server()
    const identity = { source: 'host', identityId: 'i1', label: 'k', username: 'ops', auth: 'key', vaultId: 'v' } as ResolvedHost['identity']
    const identities = { resolve: vi.fn(async () => ({ username: 'ops', auth: 'key' as const, privateKey: user.private, passphrase: 'pp' })) }
    const { deps } = await fixture(resolved(s.port, identity), identities as never)
    const prepared = await prepareHosts(planFor([{ hostId: 'h1', label: 'a' }, { hostId: 'h2', label: 'b' }], s.port), deps)
    expect(prepared.keys).toEqual([{ privateKey: user.private, passphrase: 'pp' }])
    expect(prepared.userAgentNeeded).toBe(false)
    expect(prepared.links.size).toBe(2)
    prepared.close()
    prepared.close()
    expect(prepared.links.size).toBe(0)
  })
})

describe('log tap', () => {
  it('tap streams appended lines', async () => {
    const s = await server({
      onExec: (_cmd, stream) => {
        stream.write('first line\nsecond ')
        setTimeout(() => stream.write('line\n'), 20)
      },
    })
    const PORT = s.port
    const { deps } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    cleanups.push(() => prepared.close())
    const lines: string[] = []
    const tap = startTap(prepared.links.get(HOST_ID)!, '0190a1b2-c3d4-7e5f-8a6b-1234567890ab', (l) => lines.push(l), { host: 'web' })
    await vi.waitFor(() => expect(lines).toEqual(['first line', 'second line']))
    expect(s.execs()).toEqual([tapCommand('0190a1b2-c3d4-7e5f-8a6b-1234567890ab')])
    expect(s.execs()[0]).toBe('umask 077; mkdir -p -m 700 ~/.opsdeck/runs/0190a1b2-c3d4-7e5f-8a6b-1234567890ab && touch ~/.opsdeck/runs/0190a1b2-c3d4-7e5f-8a6b-1234567890ab/stream.log && exec tail -n +1 -F ~/.opsdeck/runs/0190a1b2-c3d4-7e5f-8a6b-1234567890ab/stream.log')
    tap.stop()
  })

  it('a refused tap logs one unavailable line and the run goes on', async () => {
    const s = await server() // no onExec: exec is refused
    const PORT = s.port
    const { deps } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    cleanups.push(() => prepared.close())
    const lines: string[] = []
    startTap(prepared.links.get(HOST_ID)!, '0190a1b2-c3d4-7e5f-8a6b-1234567890ab', (l) => lines.push(l), { host: 'web' })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(lines).toEqual(['Live output unavailable on web; output will appear when each step ends'])
  })

  it('a channel that drops mid-run logs the line once', async () => {
    const s = await server({ onExec: (_c, stream) => void setTimeout(() => stream.close(), 30) })
    const PORT = s.port
    const { deps } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    cleanups.push(() => prepared.close())
    const lines: string[] = []
    startTap(prepared.links.get(HOST_ID)!, '0190a1b2-c3d4-7e5f-8a6b-1234567890ab', (l) => lines.push(l), { host: 'web' })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(lines).toHaveLength(1)
  })

  it('a long line is cut and a split multibyte character survives', async () => {
    const euro = Buffer.from('€')
    const s = await server({
      onExec: (_c, stream) => {
        stream.write(Buffer.concat([Buffer.from('a'), euro.subarray(0, 2)]))
        setTimeout(() => stream.write(Buffer.concat([euro.subarray(2), Buffer.from('\n' + 'x'.repeat(5000))])), 20)
      },
    })
    const PORT = s.port
    const { deps } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }], PORT), deps)
    cleanups.push(() => prepared.close())
    const lines: string[] = []
    startTap(prepared.links.get(HOST_ID)!, '0190a1b2-c3d4-7e5f-8a6b-1234567890ab', (l) => lines.push(l), { host: 'web' })
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    expect(lines[0]).toBe('a€')
    expect(lines[1].length).toBe(4096)
    expect(lines[1].endsWith(' …(cut)')).toBe(true)
  })

  it('the tap creates the run tree private to the user', () => {
    const home = mkdtempSync(join(tmpdir(), 'od-tap-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const id = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
    // Everything before the never-ending tail, under a permissive umask the login shell might have.
    const setup = tapCommand(id).split(' && exec tail')[0]
    execFileSync('/bin/sh', ['-c', `umask 022; ${setup}`], { env: { ...process.env, HOME: home } })
    const mode = (p: string): number => statSync(join(home, p)).mode & 0o777
    expect(mode('.opsdeck')).toBe(0o700)
    expect(mode('.opsdeck/runs')).toBe(0o700)
    expect(mode(`.opsdeck/runs/${id}`)).toBe(0o700)
    expect(mode(`.opsdeck/runs/${id}/stream.log`)).toBe(0o600)
  })

  it('refuses an unsafe release id', () => {
    expect(() => tapCommand('a; rm -rf ~')).toThrow()
    expect(() => tapCommand('..')).toThrow()
    expect(() => tapCommand('rel-1')).toThrow()
  })
})
