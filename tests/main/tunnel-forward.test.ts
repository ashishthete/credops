import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'
import { MAX_TUNNEL_CHANNELS, PROBE_GRACE_MS, PROBE_TIMEOUT_MS } from '../../src/shared/tunnels'
import {
  Counter,
  ProbeTokens,
  realTimers,
  startLocal,
  startRemote,
  type ForwardHandle,
  type Timers,
} from '../../src/main/tunnels/forward'
import { startServer, type ServerOpts, type TestServer } from './ssh-server'
import { TUNNEL_USER, echoServer, linkTo, manualTimers, type EchoServer } from './tunnel-helpers'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

interface Rig {
  srv: TestServer
  client: Client
  echo: EchoServer
  counter: Counter
  tokens: ProbeTokens
}

async function rig(opts: Partial<ServerOpts> = {}, echoOpts: { greeting?: string } = {}): Promise<Rig> {
  const srv = await startServer({ users: [TUNNEL_USER], allowForward: true, ...opts })
  cleanup.push(() => srv.close())
  const echo = await echoServer(echoOpts)
  cleanup.push(() => echo.close())
  const client = await linkTo(srv)
  cleanup.push(() => client.end())
  return { srv, client, echo, counter: new Counter(), tokens: new ProbeTokens() }
}

async function listenLocal(): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function local(r: Rig, timers: Timers = realTimers): Promise<{ handle: ForwardHandle; server: Server }> {
  const server = await listenLocal()
  const handle = startLocal(r.client, { server, targetHost: '127.0.0.1', targetPort: r.echo.port, counter: r.counter, tokens: r.tokens, timers })
  cleanup.push(() => handle.close())
  return { handle, server }
}

async function remote(r: Rig, timers: Timers = realTimers): Promise<ForwardHandle> {
  const handle = await startRemote(r.client, {
    bindAddress: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: r.echo.port,
    counter: r.counter,
    tokens: r.tokens,
    timers,
  })
  cleanup.push(() => handle.close())
  return handle
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => resolve(sock))
    sock.once('error', reject)
    cleanup.push(() => sock.destroy())
  })
}

function read(sock: Socket, length: number): Promise<string> {
  return new Promise((resolve) => {
    let got = ''
    const onData = (d: Buffer): void => {
      got += d.toString()
      if (got.length >= length) {
        sock.off('data', onData)
        resolve(got)
      }
    }
    sock.on('data', onData)
  })
}

const closed = (sock: Socket): Promise<void> => new Promise((resolve) => (sock.destroyed ? resolve() : sock.once('close', () => resolve())))

async function pingThrough(port: number): Promise<Socket> {
  const sock = await dial(port)
  sock.write('ping')
  expect(await read(sock, 4)).toBe('ping')
  return sock
}

const codeOf = (p: Promise<unknown>): Promise<unknown> => p.then(
  () => 'resolved',
  (e: { code?: unknown }) => e.code,
)

describe('L forwards', () => {
  it('L forwards bytes both ways and counts them', async () => {
    const r = await rig()
    const { handle } = await local(r)
    const sock = await pingThrough(handle.address.port)
    await vi.waitFor(() => expect(r.counter.sample()).toMatchObject({ bytesOut: 4, bytesIn: 4, connections: 1, rejected: 0 }))
    sock.end()
    await vi.waitFor(() => expect(r.counter.sample().connections).toBe(0))
  })

  it('a probe never opens a connection to the target', async () => {
    const r = await rig()
    const { handle } = await local(r)
    await expect(handle.probe()).resolves.toBe('probe')
    expect(r.echo.accepted()).toBe(0)
    expect(r.srv.tcpipRequests()).toBe(0)
    expect(r.counter.sample()).toMatchObject({ bytesOut: 0, bytesIn: 0, connections: 0 })
  })

  it('L probe fails when the listener is gone', async () => {
    const r = await rig()
    const { handle, server } = await local(r)
    await new Promise((resolve) => server.close(resolve))
    const started = Date.now()
    expect(await codeOf(handle.probe())).toBe('probe-failed')
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS)
  })

  it('L probe fails when nothing closes it within PROBE_TIMEOUT_MS', async () => {
    const r = await rig()
    const mt = manualTimers()
    const { handle, server } = await local(r, mt.timers)
    // Something else answers on the port and keeps the connection open.
    server.removeAllListeners('connection')
    server.on('connection', (sock: Socket) => cleanup.push(() => sock.destroy()))
    const result = codeOf(handle.probe())
    await vi.waitFor(() => expect(mt.pending()).toContainEqual({ ms: PROBE_TIMEOUT_MS, kind: 'timeout' }))
    mt.fire(PROBE_TIMEOUT_MS)
    expect(await result).toBe('probe-failed')
  })

  it('L probe fails when a different listener on the port closes cleanly', async () => {
    const r = await rig()
    const { handle, server } = await local(r)
    // A stranger answers on our port and closes without reading.
    server.removeAllListeners('connection')
    server.on('connection', (sock: Socket) => sock.resume().end())
    expect(await codeOf(handle.probe())).toBe('probe-failed')
  })

  it('L probe recognises a token split across chunks', async () => {
    const r = await rig()
    const mt = manualTimers()
    const { handle } = await local(r, mt.timers)
    const sock = await dial(handle.address.port)
    const token = r.tokens.issue()
    sock.write(token.subarray(0, 7))
    await new Promise((resolve) => setTimeout(resolve, 20))
    sock.write(token.subarray(7))
    await closed(sock)
    expect(r.tokens.consume(token)).toBe(false)
    expect(r.srv.tcpipRequests()).toBe(0)
    expect(r.echo.accepted()).toBe(0)
  })

  it('L probe token arriving as the grace timer fires is still consumed', async () => {
    const r = await rig()
    const mt = manualTimers()
    const { handle } = await local(r, mt.timers)
    const sock = await dial(handle.address.port)
    await vi.waitFor(() => expect(mt.pending()).toEqual([{ ms: PROBE_GRACE_MS, kind: 'timeout' }]))
    const token = r.tokens.issue()
    sock.write(token)
    mt.fire()
    await closed(sock)
    expect(r.tokens.consume(token)).toBe(false)
    expect(r.srv.tcpipRequests()).toBe(0)
  })

  it('L server-first protocol waits at most the grace period', async () => {
    const r = await rig({}, { greeting: 'HELLO' })
    const mt = manualTimers()
    const { handle } = await local(r, mt.timers)
    const sock = await dial(handle.address.port)
    const hello = read(sock, 5)
    await vi.waitFor(() => expect(mt.pending()).toEqual([{ ms: PROBE_GRACE_MS, kind: 'timeout' }]))
    expect(PROBE_GRACE_MS).toBe(25)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(r.srv.tcpipRequests()).toBe(0)
    mt.fire()
    expect(await hello).toBe('HELLO')
    expect(r.srv.tcpipRequests()).toBe(1)
  })

  it('L rejects connections while not accepting', async () => {
    const r = await rig()
    const { handle } = await local(r)
    handle.setAccepting(false)
    expect(handle.accepting).toBe(false)
    await closed(await dial(handle.address.port))
    await vi.waitFor(() => expect(r.counter.sample().rejected).toBe(1))
    expect(r.srv.tcpipRequests()).toBe(0)
    // A probe still gets through, so a retrying tunnel can be re-probed.
    await expect(handle.probe()).resolves.toBe('probe')
    expect(r.counter.sample().rejected).toBe(1)
  })

  it('L enforces MAX_TUNNEL_CHANNELS', async () => {
    const r = await rig()
    const { handle } = await local(r)
    const open = await Promise.all(Array.from({ length: MAX_TUNNEL_CHANNELS }, () => pingThrough(handle.address.port)))
    expect(r.counter.sample()).toMatchObject({ connections: MAX_TUNNEL_CHANNELS, rejected: 0 })
    await closed(await dial(handle.address.port))
    await vi.waitFor(() => expect(r.counter.sample().rejected).toBe(1))
    expect(r.counter.sample().connections).toBe(MAX_TUNNEL_CHANNELS)
    await expect(handle.probe()).resolves.toBe('probe')
    // Closing one frees its slot.
    open[0]!.destroy()
    await vi.waitFor(() => expect(r.counter.sample().connections).toBe(MAX_TUNNEL_CHANNELS - 1))
    await pingThrough(handle.address.port)
    expect(r.counter.sample().rejected).toBe(1)
  })

  it('a channel open failure destroys the local socket', async () => {
    const r = await rig()
    const { handle } = await local(r)
    await r.echo.close()
    const sock = await dial(handle.address.port)
    sock.write('ping')
    await closed(sock)
    expect(r.counter.sample().connections).toBe(0)
  })
})

describe('R forwards', () => {
  it('R listens remotely and forwards to the local target', async () => {
    const r = await rig({ allowRemoteForward: true })
    const handle = await remote(r)
    expect(r.srv.remoteListeners()).toEqual([handle.address.port])
    expect(handle.address).toEqual({ address: '127.0.0.1', port: expect.any(Number) })
    const sock = await pingThrough(handle.address.port)
    expect(r.echo.accepted()).toBe(1)
    await vi.waitFor(() => expect(r.counter.sample()).toMatchObject({ bytesIn: 4, bytesOut: 4, connections: 1 }))
    sock.end()
    await vi.waitFor(() => expect(r.counter.sample().connections).toBe(0))
  })

  it('R probe round-trips the token without reaching the target', async () => {
    const r = await rig({ allowRemoteForward: true })
    const handle = await remote(r)
    await expect(handle.probe()).resolves.toBe('probe')
    expect(r.echo.accepted()).toBe(0)
    expect(r.counter.sample()).toMatchObject({ bytesIn: 0, bytesOut: 0 })
  })

  it('R probe falls back to keepalive when the server prohibits direct-tcpip', async () => {
    const r = await rig({ allowRemoteForward: true, allowForward: false })
    const handle = await remote(r)
    await expect(handle.probe()).resolves.toBe('keepalive')
  })

  it('R probe passes while not accepting, and real connections are rejected', async () => {
    const r = await rig({ allowRemoteForward: true })
    const handle = await remote(r)
    handle.setAccepting(false)
    await expect(handle.probe()).resolves.toBe('probe')
    expect(r.counter.sample().rejected).toBe(0)
    await closed(await dial(handle.address.port))
    await vi.waitFor(() => expect(r.counter.sample().rejected).toBe(1))
    expect(r.echo.accepted()).toBe(0)
  })

  it('R probe fails when the token does not come back', async () => {
    const r = await rig({ allowRemoteForward: true })
    const handle = await remote(r)
    // Nothing handles the forwarded connection, so ssh2 refuses it and the token is never read.
    r.client.removeAllListeners('tcp connection')
    expect(await codeOf(handle.probe())).toBe('probe-failed')
  })

  it('R listen interrupted by a dropped link is retryable, not remote-refused', async () => {
    const r = await rig({ allowRemoteForward: true })
    const started = codeOf(remote(r))
    r.srv.dropAll()
    expect(await started).toBe('closed')
  })

  it('R refused by the server rejects with remote-refused', async () => {
    const r = await rig()
    expect(await codeOf(remote(r))).toBe('remote-refused')
    expect(r.srv.remoteListeners()).toEqual([])
  })

  it('R close cancels the remote listen', async () => {
    const r = await rig({ allowRemoteForward: true })
    const handle = await remote(r)
    expect(r.srv.remoteListeners()).toHaveLength(1)
    await handle.close()
    await vi.waitFor(() => expect(r.srv.remoteListeners()).toEqual([]))
  })
})

describe('probe tokens and counters', () => {
  it('probe tokens are single-use', () => {
    const tokens = new ProbeTokens()
    const token = tokens.issue()
    expect(token).toHaveLength(16)
    expect(tokens.consume(Buffer.from(token))).toBe(true)
    expect(tokens.consume(token)).toBe(false)
    expect(tokens.consume(Buffer.alloc(16))).toBe(false)
  })

  it('sample reports rates since the last sample', () => {
    let now = 0
    const counter = new Counter(() => now)
    counter.bytesIn = 2000
    counter.bytesOut = 500
    now = 1000
    expect(counter.sample()).toEqual({ bytesIn: 2000, bytesOut: 500, rateIn: 2000, rateOut: 500, connections: 0, rejected: 0 })
    counter.bytesIn += 1000
    now = 3000
    expect(counter.sample()).toMatchObject({ bytesIn: 3000, rateIn: 500, rateOut: 0 })
  })
})
