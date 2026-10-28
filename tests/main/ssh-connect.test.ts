import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import * as net from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Client } from 'ssh2'
import type { ParsedKey } from 'ssh2'
import type { IdentityRef, ResolvedHost } from '../../src/shared/inventory'
import type { HopState, SessionError } from '../../src/shared/ssh'
import type { AuthPlan } from '../../src/main/ssh/auth'
import { AuthFailedError, connectChain, describeError, HostKeyError, hopsOf } from '../../src/main/ssh/connect'
import type { ConnectDeps, HopTarget } from '../../src/main/ssh/connect'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import { generateKey, startServer } from './ssh-server'
import type { ServerOpts, TestServer } from './ssh-server'
import { makeVault } from './vault-helpers'

const globalId: IdentityRef = { source: 'global', username: 'ops', auth: 'default' }

function keyPair(): { privateKey: string; publicKey: ParsedKey } {
  const pair = generateKey()
  return { privateKey: pair.private, publicKey: pair.public }
}
const userKey = keyPair()
const otherKey = keyPair()

const keyPlan = (key = userKey.privateKey): AuthPlan => ({
  username: 'ops',
  kind: 'key',
  notes: [],
  methods: [{ type: 'publickey', label: 'test key', key }],
})

async function server(opts: Partial<ServerOpts> = {}): Promise<TestServer> {
  const s = await startServer({ users: [{ username: 'ops', publicKey: userKey.publicKey }], ...opts })
  onTestFinished(() => s.close())
  return s
}

/** A TCP server that accepts and never speaks. */
async function silentServer(): Promise<{ port: number; sockets: () => number }> {
  const sockets = new Set<Socket>()
  const s = createServer((sock) => {
    sockets.add(sock)
    // Read (and drop) input so the client's FIN is seen.
    sock.resume()
    sock.on('error', () => {})
    sock.on('close', () => sockets.delete(sock))
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  onTestFinished(
    () =>
      new Promise<void>((r) => {
        for (const sock of sockets) sock.destroy()
        s.close(() => r())
      }),
  )
  return { port: (s.address() as { port: number }).port, sockets: () => sockets.size }
}

/** A port that nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

const hop = (label: string, port: number): HopTarget => ({ label, address: '127.0.0.1', port, identity: globalId })

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps & { hops: [number, HopState][] } {
  const hops: [number, HopState][] = []
  return {
    hops,
    plan: async () => keyPlan(),
    verifyHostKey: async () => true,
    askPassword: vi.fn(async () => null),
    askKeyboard: vi.fn(async () => null),
    onHop: (i, state) => hops.push([i, state]),
    keepaliveSec: 0,
    ...over,
  }
}

async function connect(hops: HopTarget[], d: ConnectDeps, signal = new AbortController().signal) {
  const conn = await connectChain(hops, d, signal)
  onTestFinished(() => conn.close())
  return conn
}

/** Rejects with the `SessionError` for the hop that failed. */
async function failure(hops: HopTarget[], d: ConnectDeps & { hops: [number, HopState][] }, signal?: AbortSignal) {
  const err = await connectChain(hops, d, signal ?? new AbortController().signal).then(
    () => {
      throw new Error('expected the dial to fail')
    },
    (e: unknown) => e,
  )
  const failed = d.hops.find(([, s]) => s === 'failed')?.[0] ?? d.hops.at(-1)?.[0]
  return { err, described: describeError(err, failed === undefined ? null : hops[failed]) }
}

/** A KnownHostStore whose known_hosts file is `text`, and a verifier built on it. */
async function knownHosts(text: string) {
  const f = makeVault()
  await f.vault.setup({ password: 'correct horse', touchId: true })
  const dir = mkdtempSync(join(tmpdir(), 'credops-connect-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'known_hosts')
  writeFileSync(path, text)
  const store = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: path })
  const ask = vi.fn(async () => true)
  const verifyHostKey: ConnectDeps['verifyHostKey'] = async (h, keyType, keyBase64) => {
    const { status, info } = await store.check(h.address, h.port, keyType, keyBase64)
    if (status === 'match') return true
    if (status === 'changed') throw new HostKeyError('host-key-changed', info)
    if (status === 'revoked') throw new HostKeyError('host-key-revoked', info)
    return ask()
  }
  return { store, ask, verifyHostKey }
}

function shellOutput(client: Client, until: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.shell((err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream.on('data', (d: Buffer) => {
        out += d.toString()
        if (out.includes(until)) {
          stream.close()
          resolve(out)
        }
      })
    })
  })
}

describe('hopsOf', () => {
  it('lists the chain first and the target last', () => {
    const resolved: ResolvedHost = {
      hostId: 't',
      environmentId: null,
      address: 'db.internal',
      addressSource: 'host',
      port: { value: 2222, source: 'host' },
      identity: globalId,
      jump: { hostId: 'b', source: 'host' },
      chain: [{ hostId: 'b', label: 'bastion', address: 'bastion.example', addressSource: 'host', port: 22, identity: globalId }],
      conflicts: [],
    }
    expect(hopsOf(resolved, 'db')).toEqual([
      { label: 'bastion', address: 'bastion.example', port: 22, identity: globalId },
      { label: 'db', address: 'db.internal', port: 2222, identity: globalId },
    ])
  })
})

describe('connectChain', () => {
  it('connects with a key and opens a shell', async () => {
    const s = await server()
    const { client } = await connect([hop('target', s.port)], deps())
    expect(await shellOutput(client, 'READY')).toContain('READY')
  })

  it('sends keystrokes at once, without Nagle batching, like OpenSSH', async () => {
    const s = await server()
    const noDelay = vi.spyOn(net.Socket.prototype, 'setNoDelay')
    onTestFinished(() => noDelay.mockRestore())
    await connect([hop('target', s.port)], deps())
    expect(noDelay).toHaveBeenCalledWith(true)
  })

  it('connects through a jump host', async () => {
    const bastion = await server({ allowForward: true })
    const target = await server()
    const d = deps()
    const { client } = await connect([hop('bastion', bastion.port), hop('target', target.port)], d)
    expect(d.hops).toEqual([
      [0, 'connecting'],
      [0, 'up'],
      [1, 'connecting'],
      [1, 'up'],
    ])
    expect(await shellOutput(client, 'READY')).toContain('READY')
    expect(target.connections()).toBe(1)
  })

  it('names the failing hop when the jump target is closed', async () => {
    const bastion = await server({ allowForward: true })
    const d = deps()
    const { described } = await failure([hop('bastion', bastion.port), hop('target', await closedPort())], d)
    expect(described).toMatchObject({ code: 'refused', hopLabel: 'target' })
    expect(d.hops.at(-1)).toEqual([1, 'failed'])
    await vi.waitFor(() => expect(bastion.connections()).toBe(0), { timeout: 1000 })
  })

  it('refused when nothing listens', async () => {
    const port = await closedPort()
    const d = deps()
    const { described } = await failure([hop('target', port)], d)
    expect(described).toEqual({
      code: 'refused',
      message: `target refused the connection on port ${port}`,
      hopLabel: 'target',
    })
    expect(d.hops).toEqual([
      [0, 'connecting'],
      [0, 'failed'],
    ])
  })

  it('times out with readyTimeoutMs', async () => {
    const silent = await silentServer()
    const started = Date.now()
    const { described } = await failure([hop('target', silent.port)], deps({ readyTimeoutMs: 300 }))
    expect(described).toMatchObject({ code: 'timeout', message: "target didn't answer within 20 s", hopLabel: 'target' })
    expect(Date.now() - started).toBeLessThan(2000)
    await vi.waitFor(() => expect(silent.sockets()).toBe(0), { timeout: 1000 })
  })

  it('refuses a changed key without prompting', async () => {
    const s = await server()
    const other = keyPair().publicKey.getPublicSSH().toString('base64')
    const kh = await knownHosts(`[127.0.0.1]:${s.port} ssh-ed25519 ${other}\n`)
    const { err, described } = await failure([hop('target', s.port)], deps({ verifyHostKey: kh.verifyHostKey }))
    expect(described.code).toBe('host-key-changed')
    expect(described.message).toBe(
      'The host key for target has changed. This could be an attack, so OpenSSH-style protection blocked the connection.',
    )
    expect(kh.ask).not.toHaveBeenCalled()
    expect(err).toBeInstanceOf(HostKeyError)
    expect((err as HostKeyError).info).toMatchObject({ host: `[127.0.0.1]:${s.port}`, keyType: 'ssh-ed25519' })
    expect((err as HostKeyError).info.known).toEqual([expect.objectContaining({ keyType: 'ssh-ed25519', source: 'openssh', line: 1 })])
    expect(described.hostKey).toEqual((err as HostKeyError).info)
    await vi.waitFor(() => expect(s.connections()).toBe(0), { timeout: 1000 })
  })

  it('compares an RSA host key by its key type, not the negotiated algorithm', async () => {
    const rsa = generateKey('rsa')
    const s = await server({ hostKey: rsa.private })
    expect(s.hostKeyType).toBe('ssh-rsa')
    const otherRsa = generateKey('rsa').public
    const kh = await knownHosts(`[127.0.0.1]:${s.port} ssh-rsa ${otherRsa.getPublicSSH().toString('base64')}\n`)
    const { described } = await failure([hop('target', s.port)], deps({ verifyHostKey: kh.verifyHostKey }))
    expect(described.code).toBe('host-key-changed')
    expect(described.hostKey?.keyType).toBe('ssh-rsa')
    expect(kh.ask).not.toHaveBeenCalled()

    const seen = vi.fn(async () => true)
    await connect([hop('target', s.port)], deps({ verifyHostKey: seen }))
    expect(seen).toHaveBeenCalledWith(expect.anything(), 'ssh-rsa', s.hostKeyBase64)
  })

  it('refuses a key of another type than the pinned one, listing the pin', async () => {
    const s = await server({ hostKey: generateKey('ecdsa').private })
    const pin = keyPair().publicKey.getPublicSSH().toString('base64')
    const kh = await knownHosts(`[127.0.0.1]:${s.port} ssh-ed25519 ${pin}\n`)
    const { err, described } = await failure(
      [hop('target', s.port)],
      deps({ verifyHostKey: kh.verifyHostKey, pinnedKeyTypes: (h) => kh.store.pinnedKeyTypes(h.address, h.port) }),
    )
    expect(described.code).toBe('host-key-changed')
    expect(kh.ask).not.toHaveBeenCalled()
    expect((err as HostKeyError).info.keyType).toBe('ecdsa-sha2-nistp256')
    expect((err as HostKeyError).info.known).toEqual([expect.objectContaining({ keyType: 'ssh-ed25519', source: 'openssh', line: 1 })])
  })

  it('asks a server with several host keys for the pinned type first', async () => {
    const ecdsa = generateKey('ecdsa')
    const rsa = generateKey('rsa')
    // ssh2 prefers the server's ed25519 key; the pins name the others.
    const s = await server({ extraHostKeys: [ecdsa.private, rsa.private] })
    for (const pub of [ecdsa.public, rsa.public]) {
      const b64 = pub.getPublicSSH().toString('base64')
      const kh = await knownHosts(`[127.0.0.1]:${s.port} ${pub.type} ${b64}\n`)
      const seen = vi.fn(kh.verifyHostKey)
      await connect([hop('target', s.port)], deps({ verifyHostKey: seen, pinnedKeyTypes: (h) => kh.store.pinnedKeyTypes(h.address, h.port) }))
      expect(seen).toHaveBeenCalledWith(expect.anything(), pub.type, b64)
      expect(kh.ask).not.toHaveBeenCalled()

      // Without the pinned order the ed25519 key comes first, which the pin blocks.
      const { described } = await failure([hop('target', s.port)], deps({ verifyHostKey: kh.verifyHostKey }))
      expect(described.code).toBe('host-key-changed')
    }
  })

  it('unknown key asks and rejection stops the dial', async () => {
    const s = await server()
    const verifyHostKey = vi.fn(async () => false)
    const { described } = await failure([hop('target', s.port)], deps({ verifyHostKey }))
    expect(described).toMatchObject({
      code: 'host-key-rejected',
      message: "You didn't trust the host key for target",
      hopLabel: 'target',
      hostKey: { host: `[127.0.0.1]:${s.port}`, keyType: 'ssh-ed25519' },
    })
    expect(verifyHostKey).toHaveBeenCalledWith(hop('target', s.port), s.hostKeyType, s.hostKeyBase64)
  })

  it('asks for the plan with the hop it dials, so ~/.ssh/config can be matched', async () => {
    const s = await server()
    const plan = vi.fn(async () => keyPlan())
    await connect([hop('target', s.port)], deps({ plan }))
    expect(plan).toHaveBeenCalledWith(globalId, hop('target', s.port))
  })

  it('an auth failure says who was refused and what was tried, with no secrets', async () => {
    const s = await server()
    const plan: AuthPlan = {
      ...keyPlan(otherKey.privateKey),
      kind: 'agent',
      methods: [{ type: 'publickey', label: '~/.ssh/id_rsa', key: otherKey.privateKey }],
      tried: ['ssh-agent (no keys loaded)', '~/.ssh/id_rsa'],
      missing: ['~/.ssh/id_ed25519'],
      notes: ['~/.ssh/work needs a passphrase: add it to ssh-agent (ssh-add) or link it in a vault'],
    }
    const { err, described } = await failure([hop('alpha', s.port)], deps({ plan: async () => plan }))
    expect(err).toBeInstanceOf(AuthFailedError)
    expect(described).toEqual({
      code: 'auth',
      hopLabel: 'alpha',
      message:
        'alpha refused user ops. Tried: ssh-agent (no keys loaded), ~/.ssh/id_rsa. ~/.ssh/id_ed25519 not found. ' +
        '~/.ssh/work needs a passphrase: add it to ssh-agent (ssh-add) or link it in a vault.',
    })
    expect(described.message).not.toContain('PRIVATE KEY')
  })

  it('a typed password shows up in what was tried', async () => {
    const s = await server({ users: [{ username: 'ops', password: 'right', publicKey: userKey.publicKey }] })
    const askPassword = vi.fn(async () => 'wrong-secret')
    const { described } = await failure([hop('target', s.port)], deps({ plan: async () => ({ ...keyPlan(otherKey.privateKey), tried: ['test key'] }), askPassword }))
    expect(described.message).toBe('target refused user ops. Tried: test key, a typed password.')
    expect(described.message).not.toContain('wrong-secret')
  })

  it('a cancelled password prompt is not listed as tried', async () => {
    const s = await server({ users: [{ username: 'ops', password: 'right', publicKey: userKey.publicKey }] })
    const askPassword = vi.fn(async () => null)
    const { described } = await failure([hop('target', s.port)], deps({ plan: async () => ({ ...keyPlan(otherKey.privateKey), tried: ['test key'] }), askPassword }))
    expect(askPassword).toHaveBeenCalled()
    expect(described.message).toBe('target refused user ops. Tried: test key.')
  })

  it('an agent that fails mid-dial is passed over for the next key', async () => {
    const s = await server()
    const dir = mkdtempSync(join(tmpdir(), 'credops-agent-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const stale = join(dir, 'agent.sock')
    writeFileSync(stale, '')
    const plan: AuthPlan = { ...keyPlan(), kind: 'agent', methods: [{ type: 'agent', agent: stale }, ...keyPlan().methods] }
    const { client } = await connect([hop('target', s.port)], deps({ plan: async () => plan }))
    expect(await shellOutput(client, 'READY')).toContain('READY')
  })

  it('an agent that fails mid-dial is named in the failure message when nothing else works', async () => {
    const s = await server()
    const dir = mkdtempSync(join(tmpdir(), 'credops-agent-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const stale = join(dir, 'agent.sock')
    writeFileSync(stale, '')
    const plan: AuthPlan = { ...keyPlan(otherKey.privateKey), kind: 'agent', methods: [{ type: 'agent', agent: stale }], tried: ['ssh-agent'] }
    const { described } = await failure([hop('target', s.port)], deps({ plan: async () => plan }))
    expect(described.message).toBe('target refused user ops. Tried: ssh-agent. ssh-agent failed during login.')
  })

  it('falls back to one password prompt', async () => {
    const s = await server({ users: [{ username: 'ops', password: 'pw', publicKey: userKey.publicKey }] })
    const askPassword = vi.fn(async () => 'pw')
    const { client } = await connect([hop('target', s.port)], deps({ plan: async () => keyPlan(otherKey.privateKey), askPassword }))
    expect(askPassword).toHaveBeenCalledTimes(1)
    expect(askPassword).toHaveBeenCalledWith(hop('target', s.port), 'ops')
    expect(await shellOutput(client, 'READY')).toContain('READY')
  })

  it("keyboard-interactive is answered by the renderer when it isn't a lone password prompt", async () => {
    const s = await server({ users: [{ username: 'ops' }], keyboard: { prompts: ['Password:', 'OTP:'], answers: ['pw', '123456'] } })
    const askKeyboard = vi.fn(async () => ['pw', '123456'])
    const askPassword = vi.fn(async () => 'wrong')
    await connect([hop('target', s.port)], deps({ plan: async () => keyPlan(otherKey.privateKey), askKeyboard, askPassword }))
    expect(askKeyboard).toHaveBeenCalledTimes(1)
    expect(askKeyboard).toHaveBeenCalledWith(hop('target', s.port), '', '', [
      { prompt: 'Password:', echo: false },
      { prompt: 'OTP:', echo: false },
    ])
    expect(askPassword).not.toHaveBeenCalled()
  })

  it('a stored password answers a keyboard-only server without asking', async () => {
    const s = await server({ users: [{ username: 'ops' }], keyboard: { prompts: ['Password:'], answers: ['stored'] } })
    const askPassword = vi.fn(async () => 'typed')
    const askKeyboard = vi.fn(async () => null)
    const plan = async (): Promise<AuthPlan> => ({
      username: 'ops',
      kind: 'password',
      notes: [],
      methods: [{ type: 'password', password: 'stored' }],
    })
    const { client } = await connect([hop('target', s.port)], deps({ plan, askPassword, askKeyboard }))
    expect(askPassword).not.toHaveBeenCalled()
    expect(askKeyboard).not.toHaveBeenCalled()
    expect(await shellOutput(client, 'READY')).toContain('READY')
  })

  it('a prompt longer than readyTimeoutMs does not time the hop out', async () => {
    const s = await server({ users: [{ username: 'ops', password: 'pw' }] })
    const later = <T>(value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), 600))
    const verifyHostKey = vi.fn(() => later(true))
    const askPassword = vi.fn(() => later<string | null>('pw'))
    await connect([hop('target', s.port)], deps({ readyTimeoutMs: 300, verifyHostKey, askPassword, plan: async () => keyPlan(otherKey.privateKey) }))
    expect(verifyHostKey).toHaveBeenCalledTimes(1)
    expect(askPassword).toHaveBeenCalledTimes(1)
  })

  it('abort while a prompt is open rejects with closed and leaves no connections', async () => {
    const s = await server({ users: [{ username: 'ops', password: 'pw' }] })
    const ac = new AbortController()
    const askPassword = vi.fn(() => {
      setTimeout(() => ac.abort(), 20)
      return new Promise<string | null>(() => {})
    })
    const d = deps({ askPassword, plan: async () => keyPlan(otherKey.privateKey) })
    const { described } = await failure([hop('target', s.port)], d, ac.signal)
    expect(described.code).toBe('closed')
    expect(askPassword).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(s.connections()).toBe(0), { timeout: 1000 })
  })

  it('abort mid-dial ends every opened client', async () => {
    const bastion = await server({ allowForward: true })
    const silent = await silentServer()
    const ac = new AbortController()
    const d = deps()
    const onHop = d.onHop
    d.onHop = (i, state) => {
      onHop(i, state)
      if (i === 1 && state === 'connecting') setTimeout(() => ac.abort(), 50)
    }
    const { described } = await failure([hop('bastion', bastion.port), hop('target', silent.port)], d, ac.signal)
    expect(described.code).toBe('closed')
    expect(d.hops).toContainEqual([0, 'up'])
    await vi.waitFor(
      () => {
        expect(bastion.connections()).toBe(0)
        expect(silent.sockets()).toBe(0)
      },
      { timeout: 1000 },
    )
  })

  it('an already aborted signal dials nothing', async () => {
    const s = await server()
    const ac = new AbortController()
    ac.abort()
    const d = deps()
    const { described } = await failure([hop('target', s.port)], d, ac.signal)
    expect(described.code).toBe('closed')
    expect(s.connections()).toBe(0)
  })

  it('keepalive 0 disables keepaliveInterval', async () => {
    const spy = vi.spyOn(Client.prototype, 'connect')
    onTestFinished(() => spy.mockRestore())
    const s = await server()
    await connect([hop('target', s.port)], deps({ keepaliveSec: 0 }))
    expect(spy.mock.calls[0][0]).toMatchObject({ keepaliveInterval: 0 })
    await connect([hop('target', s.port)], deps({ keepaliveSec: 15 }))
    expect(spy.mock.calls[1][0]).toMatchObject({ keepaliveInterval: 15_000, keepaliveCountMax: 3 })
    expect(spy.mock.calls[1][0]).not.toHaveProperty('hostHash')
  })

  it('close() ends every hop', async () => {
    const bastion = await server({ allowForward: true })
    const target = await server()
    const conn = await connectChain([hop('bastion', bastion.port), hop('target', target.port)], deps(), new AbortController().signal)
    expect(bastion.connections()).toBe(1)
    conn.close()
    await vi.waitFor(
      () => {
        expect(bastion.connections()).toBe(0)
        expect(target.connections()).toBe(0)
      },
      { timeout: 1000 },
    )
  })
})

describe('describeError', () => {
  const h = hop('db', 2222)
  const codeErr = (code: string, message = code): Error => Object.assign(new Error(message), { code })
  const cases: [unknown, SessionError][] = [
    [codeErr('ENOTFOUND'), { code: 'not-found', message: "Couldn't find 127.0.0.1", hopLabel: 'db' }],
    [codeErr('EAI_AGAIN'), { code: 'not-found', message: "Couldn't find 127.0.0.1", hopLabel: 'db' }],
    [
      new Error('All configured authentication methods failed'),
      { code: 'auth', message: "db didn't accept any of the keys or passwords tried", hopLabel: 'db' },
    ],
    [
      Object.assign(new Error('(SSH) Channel open failure: Connection refused'), { reason: 2 }),
      { code: 'refused', message: 'db refused the connection on port 2222', hopLabel: 'db' },
    ],
    [
      new Error('boom -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'),
      { code: 'unknown', message: 'boom ‹redacted›', hopLabel: 'db' },
    ],
  ]
  it.each(cases)('maps %s', (err, expected) => {
    expect(describeError(err, h)).toEqual(expected)
  })

  it('host key errors carry their info and message', () => {
    const info = { host: '[127.0.0.1]:2222', keyType: 'ssh-ed25519', fingerprint: 'SHA256:x', known: [] }
    expect(describeError(new HostKeyError('host-key-revoked', info), h)).toEqual({
      code: 'host-key-revoked',
      message: 'The host key for db is marked revoked in known_hosts',
      hopLabel: 'db',
      hostKey: info,
    })
  })

  it('an auth failure with nothing to try says so', () => {
    const err = new AuthFailedError({ username: 'ubuntu', tried: [], missing: ['~/.ssh/id_ed25519', '~/.ssh/id_rsa'], notes: [] })
    expect(describeError(err, h).message).toBe('db refused user ubuntu. Tried: nothing. ~/.ssh/id_ed25519 and ~/.ssh/id_rsa not found.')
    // Tunnels keep the username out of their events and errors.
    expect(describeError(err, h, { user: false }).message).toBe('db refused the login. Tried: nothing. ~/.ssh/id_ed25519 and ~/.ssh/id_rsa not found.')
  })

  it('leaves out hopLabel without a hop', () => {
    expect(describeError(new Error('odd'), null)).toEqual({ code: 'unknown', message: 'odd' })
  })
})
