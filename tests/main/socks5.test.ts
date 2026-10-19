import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from 'ssh2'
import { SOCKS_HANDSHAKE_MS } from '../../src/shared/tunnels'
import { Counter, ProbeTokens, realTimers, type ForwardHandle, type Timers } from '../../src/main/tunnels/forward'
import { REP, parseGreeting, parseRequest, reply, startDynamic } from '../../src/main/tunnels/socks5'
import { startServer, type TestServer } from './ssh-server'
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

async function rig(): Promise<Rig> {
  const srv = await startServer({ users: [TUNNEL_USER], allowForward: true })
  cleanup.push(() => srv.close())
  const echo = await echoServer()
  cleanup.push(() => echo.close())
  const client = await linkTo(srv)
  cleanup.push(() => client.end())
  return { srv, client, echo, counter: new Counter(), tokens: new ProbeTokens() }
}

async function dynamic(r: Rig, timers: Timers = realTimers): Promise<ForwardHandle> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const handle = startDynamic(r.client, { server, counter: r.counter, tokens: r.tokens, timers })
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

/** The next `length` bytes, or what arrived when the socket closed. */
function readBytes(sock: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let got: Buffer = Buffer.alloc(0)
    const done = (): void => {
      sock.off('data', onData)
      sock.off('close', done)
      resolve(got)
    }
    const onData = (d: Buffer): void => {
      got = Buffer.concat([got, d])
      if (got.length >= length) done()
    }
    sock.on('data', onData)
    sock.once('close', done)
  })
}

const closed = (sock: Socket, ms = 100): Promise<boolean> =>
  new Promise((resolve) => {
    if (sock.destroyed) return resolve(true)
    const t = setTimeout(() => resolve(false), ms)
    sock.once('close', () => (clearTimeout(t), resolve(true)))
  })

const connectRequest = (port: number): Buffer => Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 0xff])

async function handshake(port: number): Promise<Socket> {
  const sock = await dial(port)
  sock.write(Buffer.from([5, 1, 0]))
  expect([...(await readBytes(sock, 2))]).toEqual([5, 0])
  return sock
}

describe('SOCKS5 parsing', () => {
  it('parses IPv4, domain and IPv6 requests', () => {
    const v4 = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80])
    const name = Buffer.from('example.internal')
    const dom = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0x01, 0xbb])])
    const v6 = Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.alloc(15), Buffer.from([1, 0, 22])])
    expect(parseRequest(v4)).toEqual({ cmd: 1, host: '127.0.0.1', port: 80, length: 10 })
    expect(parseRequest(dom)).toEqual({ cmd: 1, host: 'example.internal', port: 443, length: dom.length })
    expect(parseRequest(v6)).toEqual({ cmd: 1, host: '::1', port: 22, length: 22 })
  })

  it('compresses the longest zero run in IPv6 text', () => {
    const addr = Buffer.alloc(16)
    addr.writeUInt16BE(0x2001, 0)
    addr.writeUInt16BE(0xdb8, 2)
    addr.writeUInt16BE(1, 14)
    const parsed = parseRequest(Buffer.concat([Buffer.from([5, 1, 0, 4]), addr, Buffer.from([0, 22])]))
    expect(parsed).toMatchObject({ host: '2001:db8::1' })
  })

  it('returns short on partial input', () => {
    const name = Buffer.from('example.internal')
    const fixtures = [
      Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]),
      Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 0xbb])]),
      Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.alloc(16), Buffer.from([0, 22])]),
    ]
    for (const full of fixtures) for (let n = 0; n < full.length; n++) expect(parseRequest(full.subarray(0, n))).toBe('short')
    expect(parseGreeting(Buffer.from([5, 2, 0]))).toBe('short')
    expect(parseGreeting(Buffer.from([5, 2, 0, 2]))).toEqual({ methods: [0, 2] })
  })

  it('rejects a wrong version, a reserved byte, an empty domain and port 0', () => {
    expect(parseGreeting(Buffer.from([4, 1, 0]))).toBe('bad')
    expect(parseRequest(Buffer.from([4, 1, 0, 1, 1, 1, 1, 1, 0, 80]))).toBe('bad')
    expect(parseRequest(Buffer.from([5, 1, 1, 1]))).toBe('bad')
    expect(parseRequest(Buffer.from([5, 1, 0, 3, 0, 0, 80]))).toBe('bad')
    expect(parseRequest(Buffer.from([5, 1, 0, 1, 1, 1, 1, 1, 0, 0]))).toBe('bad')
    expect(parseRequest(Buffer.from([5, 1, 0, 5]))).toBe('bad-atyp')
  })

  it('replies with bound address 0.0.0.0:0', () => {
    expect([...reply(REP.refused)]).toEqual([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])
  })
})

describe('startDynamic', () => {
  it('connects through the link to an echo target', async () => {
    const r = await rig()
    const handle = await dynamic(r)
    const sock = await handshake(handle.address.port)
    sock.write(connectRequest(r.echo.port))
    expect([...(await readBytes(sock, 10))]).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    sock.write('ping')
    expect((await readBytes(sock, 4)).toString()).toBe('ping')
    expect(r.srv.tcpipRequests()).toBe(1)
  })

  it('resolves a domain request on the server side', async () => {
    const r = await rig()
    const handle = await dynamic(r)
    const sock = await handshake(handle.address.port)
    const name = Buffer.from('localhost')
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([r.echo.port >> 8, r.echo.port & 0xff])]))
    expect((await readBytes(sock, 10))[1]).toBe(REP.ok)
    sock.write('ping')
    expect((await readBytes(sock, 4)).toString()).toBe('ping')
  })

  it('rejects malformed greetings and unsupported commands', async () => {
    const r = await rig()
    const port = (await dynamic(r)).address.port

    const v4 = await dial(port)
    v4.write(Buffer.from([4, 1, 0]))
    expect((await readBytes(v4, 2)).length).toBe(0)
    expect(await closed(v4)).toBe(true)

    const noAuth = await dial(port)
    noAuth.write(Buffer.from([5, 1, 2]))
    expect([...(await readBytes(noAuth, 2))]).toEqual([5, 0xff])
    expect(await closed(noAuth)).toBe(true)

    const bind = await handshake(port)
    bind.write(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]))
    expect((await readBytes(bind, 10))[1]).toBe(REP.cmdUnsupported)
    expect(await closed(bind)).toBe(true)

    const atyp = await handshake(port)
    atyp.write(Buffer.from([5, 1, 0, 5, 1, 2, 3, 4]))
    expect((await readBytes(atyp, 10))[1]).toBe(REP.atypUnsupported)
    expect(await closed(atyp)).toBe(true)

    const big = await handshake(port)
    big.write(Buffer.concat([Buffer.from([5, 1, 0, 3, 255]), Buffer.alloc(300, 0x61)]))
    expect(await closed(big)).toBe(true)
    expect(r.srv.tcpipRequests()).toBe(0)
  })

  it('refused target maps to REP.refused', async () => {
    const r = await rig()
    const dead = createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = (dead.address() as { port: number }).port
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    const port = (await dynamic(r)).address.port
    const sock = await handshake(port)
    sock.write(connectRequest(deadPort))
    const got = await readBytes(sock, 10)
    expect(got[1]).toBe(REP.refused)
    expect(await closed(sock)).toBe(true)
  })

  it('handshake timeout closes a silent client', async () => {
    const r = await rig()
    const mt = manualTimers()
    const port = (await dynamic(r, mt.timers)).address.port
    const sock = await dial(port)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sock.destroyed).toBe(false)
    mt.fire(SOCKS_HANDSHAKE_MS)
    expect(await closed(sock, 500)).toBe(true)
  })

  it('probe never opens a channel', async () => {
    const r = await rig()
    const handle = await dynamic(r)
    await expect(handle.probe()).resolves.toBe('probe')
    expect(r.srv.tcpipRequests()).toBe(0)
  })

  it('probe fails when the listener is closed', async () => {
    const r = await rig()
    const handle = await dynamic(r)
    await handle.close()
    await expect(handle.probe()).rejects.toMatchObject({ code: 'probe-failed' })
  })

  it('counts SOCKS traffic without the handshake bytes', async () => {
    const r = await rig()
    const handle = await dynamic(r)
    const sock = await handshake(handle.address.port)
    sock.write(connectRequest(r.echo.port))
    await readBytes(sock, 10)
    sock.write('ping')
    await readBytes(sock, 4)
    expect(r.counter.bytesIn).toBe(4)
    expect(r.counter.bytesOut).toBe(4)
    expect(r.counter.connections).toBe(1)
  })

  it('destroys connections once not accepting and counts them as rejected', async () => {
    const r = await rig()
    const handle = await dynamic(r)
    handle.setAccepting(false)
    const sock = await dial(handle.address.port)
    sock.write(Buffer.from([5, 1, 0]))
    expect(await closed(sock, 500)).toBe(true)
    expect(r.counter.rejected).toBe(1)
    await expect(handle.probe()).resolves.toBe('probe')
  })
})
