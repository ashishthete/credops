import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function planFor(hosts: { hostId: string; label: string }[]): DeployPlan {
  return { releaseId: 'rel-1', hosts: hosts.map((h, i) => ({ ...h, alias: `od-${i + 1}`, hops: [] })) } as unknown as DeployPlan
}

function resolved(port: number, identity: ResolvedHost['identity'] = { source: 'global', username: 'ops', auth: 'default' }) {
  return (hostId: string): ResolvedHost =>
    ({ hostId, environmentId: null, address: '127.0.0.1', port: { value: port, source: 'host' }, identity, jump: { hostId: null, source: null }, chain: [], conflicts: [] }) as unknown as ResolvedHost
}

async function fixture(resolve: PrepareDeps['resolve'], identities: PrepareDeps['identities'] = { resolve: vi.fn() as never }) {
  const f = makeVault()
  await f.vault.setup('correct horse')
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
    const { deps, raised, knownHosts } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }]), deps)
    cleanups.push(() => prepared.close())
    expect(prepared.checks).toEqual([])
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({ kind: 'host-key', sessionId: 'rel-1', hopLabel: 'web' })
    expect(prepared.knownHosts).toEqual([{ token: hostToken('127.0.0.1', s.port), keyType: s.hostKeyType, keyBase64: s.hostKeyBase64 }])
    expect(prepared.links.has(HOST_ID)).toBe(true)
    expect(prepared.userAgentNeeded).toBe(true)
    expect((await knownHosts.check('127.0.0.1', s.port, s.hostKeyType, s.hostKeyBase64)).status).toBe('match')

    // A second preparation finds the key trusted and asks nothing.
    const again = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }]), deps)
    cleanups.push(() => again.close())
    expect(raised).toHaveLength(1)
    expect(again.knownHosts).toHaveLength(1)
  })

  it('password identity is rejected with the §9a message before dialling', async () => {
    const s = await server()
    const identities = { resolve: vi.fn(async () => ({ username: 'ops', auth: 'password' as const, password: 'x' })) }
    const identity = { source: 'host', identityId: 'i1', label: 'pw', username: 'ops', auth: 'password', vaultId: 'v' } as ResolvedHost['identity']
    const { deps, connect } = await fixture(resolved(s.port, identity), identities as never)
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }]), deps)
    expect(connect).not.toHaveBeenCalled()
    expect(prepared.checks).toEqual([
      { id: 'auth', deploymentId: null, hostId: HOST_ID, label: 'web', level: 'block', message: 'Deploys need key or agent auth; "web" uses a password' },
    ])
    expect(prepared.links.size).toBe(0)
  })

  it('unreachable host becomes a reachable block check', async () => {
    const s = await server()
    const port = s.port
    await s.close()
    const { deps } = await fixture(resolved(port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }]), deps)
    expect(prepared.checks).toHaveLength(1)
    expect(prepared.checks[0]).toMatchObject({ id: 'reachable', level: 'block', hostId: HOST_ID, label: 'web' })
    expect(prepared.checks[0].message).toMatch(/refused/)
  })

  it('collects key identities once and closes every link, idempotently', async () => {
    const s = await server()
    const identity = { source: 'host', identityId: 'i1', label: 'k', username: 'ops', auth: 'key', vaultId: 'v' } as ResolvedHost['identity']
    const identities = { resolve: vi.fn(async () => ({ username: 'ops', auth: 'key' as const, privateKey: user.private, passphrase: 'pp' })) }
    const { deps } = await fixture(resolved(s.port, identity), identities as never)
    const prepared = await prepareHosts(planFor([{ hostId: 'h1', label: 'a' }, { hostId: 'h2', label: 'b' }]), deps)
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
    const { deps } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }]), deps)
    cleanups.push(() => prepared.close())
    const lines: string[] = []
    const tap = startTap(prepared.links.get(HOST_ID)!, 'rel-1', (l) => lines.push(l), { host: 'web' })
    await vi.waitFor(() => expect(lines).toEqual(['first line', 'second line']))
    expect(s.execs()).toEqual([tapCommand('rel-1')])
    expect(s.execs()[0]).toBe('mkdir -p ~/.opsdeck/runs/rel-1 && touch ~/.opsdeck/runs/rel-1/stream.log && exec tail -n +1 -F ~/.opsdeck/runs/rel-1/stream.log')
    tap.stop()
  })

  it('a refused tap logs one unavailable line and the run goes on', async () => {
    const s = await server() // no onExec: exec is refused
    const { deps } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }]), deps)
    cleanups.push(() => prepared.close())
    const lines: string[] = []
    startTap(prepared.links.get(HOST_ID)!, 'rel-1', (l) => lines.push(l), { host: 'web' })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(lines).toEqual(['Live output unavailable on web; output will appear when each step ends'])
  })

  it('a channel that drops mid-run logs the line once', async () => {
    const s = await server({ onExec: (_c, stream) => void setTimeout(() => stream.close(), 30) })
    const { deps } = await fixture(resolved(s.port))
    const prepared = await prepareHosts(planFor([{ hostId: HOST_ID, label: 'web' }]), deps)
    cleanups.push(() => prepared.close())
    const lines: string[] = []
    startTap(prepared.links.get(HOST_ID)!, 'rel-1', (l) => lines.push(l), { host: 'web' })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(lines).toHaveLength(1)
  })

  it('refuses an unsafe release id', () => {
    expect(() => tapCommand('a; rm -rf ~')).toThrow()
  })
})
