import type { AddressInfo, Server, Socket } from 'node:net'
import type { Client, ClientChannel } from 'ssh2'
import { SOCKS_HANDSHAKE_MS, SOCKS_MAX_REQUEST } from '../../shared/tunnels'
import {
  ConnectionGate,
  pipeCounted,
  probeListener,
  type Counter,
  type ForwardHandle,
  type ProbeTokens,
  type Timers,
} from './forward'

export const REP = {
  ok: 0x00,
  fail: 0x01,
  notAllowed: 0x02,
  netUnreachable: 0x03,
  hostUnreachable: 0x04,
  refused: 0x05,
  ttl: 0x06,
  cmdUnsupported: 0x07,
  atypUnsupported: 0x08,
} as const

const VERSION = 0x05
const CMD_CONNECT = 0x01
const METHOD_NO_AUTH = 0x00
const METHOD_NONE_ACCEPTABLE = 0xff
/** RFC 4254 open failure reason: the server could not connect to the target. */
const SSH_OPEN_CONNECT_FAILED = 2
/** RFC 4254 open failure reason: the server forbids the channel type. */
const SSH_OPEN_ADMINISTRATIVELY_PROHIBITED = 1
/** How long the server may take to open the target before the client is told the TTL expired. */
const SOCKS_CONNECT_MS = 30000

export function parseGreeting(buf: Buffer): { methods: number[] } | 'short' | 'bad' {
  if (buf.length >= 1 && buf[0] !== VERSION) return 'bad'
  if (buf.length < 2) return 'short'
  const count = buf[1]
  if (buf.length < 2 + count) return 'short'
  return { methods: [...buf.subarray(2, 2 + count)] }
}

/** Compressed text form of 16 address bytes: the longest run of two or more zero groups becomes `::`. */
function ipv6Text(bytes: Buffer): string {
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i))
  let bestAt = -1
  let bestLen = 1
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j += 1
    if (j - i > bestLen) [bestAt, bestLen] = [i, j - i]
    i = j
  }
  const hex = (gs: number[]): string => gs.map((g) => g.toString(16)).join(':')
  if (bestAt < 0) return hex(groups)
  return `${hex(groups.slice(0, bestAt))}::${hex(groups.slice(bestAt + bestLen))}`
}

export function parseRequest(buf: Buffer): { cmd: number; host: string; port: number; length: number } | 'short' | 'bad-atyp' | 'bad' {
  if (buf.length >= 1 && buf[0] !== VERSION) return 'bad'
  if (buf.length >= 3 && buf[2] !== 0x00) return 'bad'
  if (buf.length < 4) return 'short'
  const atyp = buf[3]
  let host: string
  let at: number
  if (atyp === 0x01) {
    if (buf.length < 10) return 'short'
    host = [...buf.subarray(4, 8)].join('.')
    at = 8
  } else if (atyp === 0x03) {
    if (buf.length < 5) return 'short'
    const len = buf[4]
    if (len === 0) return 'bad'
    if (buf.length < 5 + len + 2) return 'short'
    host = buf.toString('utf8', 5, 5 + len)
    if (/[\u0000-\u001f\u007f]/.test(host)) return 'bad'
    at = 5 + len
  } else if (atyp === 0x04) {
    if (buf.length < 22) return 'short'
    host = ipv6Text(buf.subarray(4, 20))
    at = 20
  } else return 'bad-atyp'
  const port = buf.readUInt16BE(at)
  if (port === 0) return 'bad'
  return { cmd: buf[1], host, port, length: at + 2 }
}

/** A reply with the bound address always `0.0.0.0:0`. */
export function reply(code: number): Buffer {
  return Buffer.from([VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

/** Maps a channel open failure the way `ssh/connect.ts` reads a jump host's: an empty description is a refusal. */
export function failureCode(err: Error & { reason?: unknown }): number {
  if (err.reason === SSH_OPEN_ADMINISTRATIVELY_PROHIBITED) return REP.notAllowed
  if (err.reason !== SSH_OPEN_CONNECT_FAILED) return REP.fail
  const description = err.message.replace(/^\(SSH\) Channel open failure:\s*/, '')
  if (/network is unreachable|no route/i.test(description)) return REP.netUnreachable
  if (/not known|nodename|resolve/i.test(description)) return REP.hostUnreachable
  if (description === '' || /refused/i.test(description)) return REP.refused
  return REP.fail
}

export interface DynamicOpts {
  /** Already listening (from `bind.ts`). */
  server: Server
  counter: Counter
  tokens: ProbeTokens
  timers: Timers
}

/** The longest greeting: version, count and 255 methods. */
const MAX_GREETING = 257

/**
 * The `D` engine: a SOCKS5 server (no authentication, `CONNECT` only) whose connections are forwarded
 * over `client`, with domain names resolved by the server like `ssh -D`. A SOCKS client always speaks
 * first, so the probe check needs no hold: the first chunk is compared with the live tokens before it
 * is parsed, and a token is consumed and never reaches the SSH link.
 */
export function startDynamic(client: Client, opts: DynamicOpts): ForwardHandle {
  const { server, counter, tokens, timers } = opts
  const bound = server.address() as AddressInfo
  const address = { address: bound.address, port: bound.port }
  const gate = new ConnectionGate(counter)

  const onConnection = (sock: Socket): void => {
    sock.on('error', () => {})
    gate.track(sock)
    let state: 'first' | 'greeting' | 'request' | 'opening' = 'first'
    let buf: Buffer = Buffer.alloc(0)
    const timer = timers.setTimeout(() => sock.destroy(), SOCKS_HANDSHAKE_MS)
    const onClose = (): void => timers.clearTimeout(timer)
    sock.once('close', onClose)

    const refuse = (code: number): void => {
      sock.removeListener('data', onData)
      sock.end(reply(code))
    }
    const open = (host: string, port: number, early: Buffer): void => {
      state = 'opening'
      sock.removeListener('data', onData)
      sock.pause()
      // The handshake is done; opening gets its own bound.
      timers.clearTimeout(timer)
      let timedOut = false
      const connectTimer = timers.setTimeout(() => {
        timedOut = true
        refuse(REP.ttl)
      }, SOCKS_CONNECT_MS)
      const onOpenClose = (): void => timers.clearTimeout(connectTimer)
      sock.once('close', onOpenClose)
      const opened = (err: (Error & { reason?: unknown }) | undefined, channel: ClientChannel): void => {
        timers.clearTimeout(connectTimer)
        sock.off('close', onOpenClose)
        if (err) return timedOut ? undefined : refuse(failureCode(err))
        if (timedOut || sock.destroyed) return void (channel.resume(), channel.destroy())
        sock.off('close', onClose)
        sock.write(reply(REP.ok))
        if (early.length > 0) sock.unshift(early)
        pipeCounted(sock, channel, counter)
      }
      try {
        client.forwardOut('127.0.0.1', 0, host, port, opened)
      } catch {
        refuse(REP.fail)
      }
    }
    const step = (): void => {
      if (state === 'greeting') {
        const greeting = parseGreeting(buf)
        if (greeting === 'bad') return void sock.destroy()
        if (greeting === 'short') return buf.length > MAX_GREETING ? void sock.destroy() : undefined
        buf = buf.subarray(2 + greeting.methods.length)
        if (!greeting.methods.includes(METHOD_NO_AUTH)) return void sock.end(Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE]))
        sock.write(Buffer.from([VERSION, METHOD_NO_AUTH]))
        state = 'request'
      }
      if (state === 'request') {
        const request = parseRequest(buf)
        if (request === 'bad') return void sock.destroy()
        if (request === 'bad-atyp') return refuse(REP.atypUnsupported)
        // No valid request is short beyond SOCKS_MAX_REQUEST, so this only bounds the buffer defensively.
        if (request === 'short') return buf.length > SOCKS_MAX_REQUEST ? void sock.destroy() : undefined
        if (request.cmd !== CMD_CONNECT) return refuse(REP.cmdUnsupported)
        open(request.host, request.port, buf.subarray(request.length))
      }
    }
    function onData(chunk: Buffer): void {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      if (state === 'first') {
        if (tokens.consume(buf)) {
          sock.removeListener('data', onData)
          return void sock.resume().end()
        }
        // A token can arrive split; the handshake timer bounds the wait.
        if (tokens.startsToken(buf)) return
        if (!gate.admit(sock)) return void sock.destroy()
        state = 'greeting'
      }
      step()
    }
    sock.on('data', onData)
  }
  server.on('connection', onConnection)

  let closing: Promise<void> | null = null
  return {
    get accepting() {
      return gate.accepting
    },
    setAccepting: (on) => void (gate.accepting = on),
    address,
    probe: () => probeListener(timers, tokens, address),
    close: () =>
      (closing ??= new Promise((resolve) => {
        gate.accepting = false
        server.off('connection', onConnection)
        gate.destroyAll()
        server.close(() => resolve())
      })),
  }
}
