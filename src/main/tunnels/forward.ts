import { randomBytes } from 'node:crypto'
import { connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { pipeline, type Duplex } from 'node:stream'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import {
  MAX_TUNNEL_CHANNELS,
  PROBE_GRACE_MS,
  PROBE_TIMEOUT_MS,
  isLoopback,
  type TunnelErrorCode,
  type TunnelStats,
} from '../../shared/tunnels'

/** The timer functions the engines use, injected so tests can step them by hand. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(h: unknown): void
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
}

const PROBE_TOKEN_BYTES = 16
/** RFC 4254 open failure reason: the server forbids the channel type. */
const SSH_OPEN_ADMINISTRATIVELY_PROHIBITED = 1

export class ForwardError extends Error {
  constructor(
    readonly code: Extract<TunnelErrorCode, 'probe-failed' | 'remote-refused' | 'closed'>,
    message: string,
  ) {
    super(message)
    this.name = 'ForwardError'
  }
}

/** Byte and connection counts for one tunnel. `bytesIn` is remote to local, `bytesOut` local to remote. */
export class Counter {
  bytesIn = 0
  bytesOut = 0
  /** Connections piping right now. */
  connections = 0
  /** Connections destroyed on arrival (not accepting, or at `MAX_TUNNEL_CHANNELS`). */
  rejected = 0
  private last: { at: number; bytesIn: number; bytesOut: number }

  constructor(private readonly now: () => number = Date.now) {
    this.last = { at: now(), bytesIn: 0, bytesOut: 0 }
  }

  /**
   * The totals, with rates in bytes per second since the previous sample. Each call moves the rate
   * baseline, so only the stats loop should sample a live tunnel.
   */
  sample(): Omit<TunnelStats, 'id'> {
    const at = this.now()
    const sec = (at - this.last.at) / 1000
    const rate = (bytes: number): number => (sec > 0 ? Math.round(bytes / sec) : 0)
    const sample = {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      rateIn: rate(this.bytesIn - this.last.bytesIn),
      rateOut: rate(this.bytesOut - this.last.bytesOut),
      connections: this.connections,
      rejected: this.rejected,
    }
    this.last = { at, bytesIn: this.bytesIn, bytesOut: this.bytesOut }
    return sample
  }
}

/** Single-use random tokens a probe sends as its first chunk, so a listener can recognise and drop it. */
export class ProbeTokens {
  private readonly live = new Set<string>()

  issue(): Buffer {
    const token = randomBytes(PROBE_TOKEN_BYTES)
    this.live.add(token.toString('hex'))
    return token
  }

  /** True, once, when `chunk` is a live token. */
  consume(chunk: Buffer): boolean {
    return chunk.length === PROBE_TOKEN_BYTES && this.live.delete(chunk.toString('hex'))
  }

  /** True when `chunk` is the start of a live token, so a token split across chunks can be waited for. */
  startsToken(chunk: Buffer): boolean {
    if (chunk.length >= PROBE_TOKEN_BYTES) return false
    const hex = chunk.toString('hex')
    for (const token of this.live) if (token.startsWith(hex)) return true
    return false
  }
}

/** The one client call the `L` and `D` engines make, so the manager can route them over whichever link is current. */
export type ForwardOut = Pick<Client, 'forwardOut'>

export interface ForwardHandle {
  readonly accepting: boolean
  /**
   * Off: new connections are destroyed and counted in `rejected` once the hold shows they aren't a
   * probe (at most `PROBE_GRACE_MS`). Probes still pass, and open connections carry on.
   */
  setAccepting(on: boolean): void
  /**
   * Resolves `'probe'` when the forward answered, or `'keepalive'` for an `R` forward whose server
   * prohibits `direct-tcpip`, so only the SSH keepalive can tell it is alive. Rejects with a
   * `ForwardError` coded `probe-failed`.
   */
  probe(): Promise<'probe' | 'keepalive'>
  /** Stops accepting, destroys open connections and releases the listener (or the remote listen). */
  close(): Promise<void>
  readonly address: { address: string; port: number }
}

/**
 * Ends a stream for good. It is resumed first: an ssh2 channel emits `close` only after its readable
 * side has ended, and a paused channel never gets there.
 */
function discard(stream: Duplex): void {
  stream.resume()
  stream.destroy()
}

/**
 * Admission for new connections: closed while not accepting, and capped at `MAX_TUNNEL_CHANNELS`
 * admitted. Connections are tracked from arrival, so `destroyAll` also ends those still held for a
 * probe; admission comes after the hold, so probes pass the gate and the cap.
 */
export class ConnectionGate {
  accepting = true
  private readonly all = new Set<Duplex>()
  private readonly admitted = new Set<Duplex>()

  constructor(private readonly counter: Counter) {}

  track(stream: Duplex): void {
    this.all.add(stream)
    stream.once('close', () => {
      this.all.delete(stream)
      this.admitted.delete(stream)
    })
  }

  /** False, counted in `rejected`, when a connection must be turned away. */
  admit(stream: Duplex): boolean {
    if (!this.accepting || this.admitted.size >= MAX_TUNNEL_CHANNELS) {
      this.counter.rejected += 1
      return false
    }
    this.admitted.add(stream)
    return true
  }

  destroyAll(): void {
    for (const stream of this.all) discard(stream)
    this.all.clear()
    this.admitted.clear()
  }
}

/**
 * Holds a new connection's outbound leg until its first data or `PROBE_GRACE_MS`, whichever comes
 * first. Data that is a live probe token is consumed and the connection ended, so the target never
 * sees a probe; data that starts a token is waited on, in case the token was split. Otherwise the data
 * is put back and `onReal` opens the outbound leg; the stream stays paused until it is piped.
 * When the grace timer fires, the decision waits one `setImmediate`, so a token already pending
 * behind a busy event loop is still read first.
 */
export function holdForProbe(stream: Duplex, tokens: ProbeTokens, timers: Timers, onReal: () => void): void {
  let held = true
  let buffered: Buffer = Buffer.alloc(0)
  const release = (): void => {
    held = false
    stream.pause()
    stream.off('data', onData)
    stream.off('close', release)
    timers.clearTimeout(grace)
  }
  const passOn = (): void => {
    release()
    if (buffered.length > 0) stream.unshift(buffered)
    onReal()
  }
  const onData = (chunk: Buffer): void => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
    if (tokens.consume(buffered)) {
      release()
      stream.resume().end()
    } else if (!tokens.startsToken(buffered)) passOn()
  }
  const grace = timers.setTimeout(() => setImmediate(() => held && passOn()), PROBE_GRACE_MS)
  stream.on('data', onData)
  stream.once('close', release)
}

/**
 * Pipes `local` (the socket on this machine) and `remote` (the SSH channel) both ways with
 * `stream.pipeline`, so an error on either side destroys both, and counts the bytes and the
 * connection in `counter`. The connection ends when `local` closes; a closed socket unpipes the
 * channel, so the channel is discarded rather than left to finish reading.
 */
export function pipeCounted(local: Duplex, remote: Duplex, counter: Counter): void {
  counter.connections += 1
  const failed = (err?: Error | null): void => void (err && local.destroy())
  pipeline(local, remote, failed)
  pipeline(remote, local, failed)
  local.once('close', () => {
    counter.connections -= 1
    discard(remote)
  })
  local.on('data', (d: Buffer) => (counter.bytesOut += d.length))
  remote.on('data', (d: Buffer) => (counter.bytesIn += d.length))
}

interface Shared {
  counter: Counter
  tokens: ProbeTokens
  timers: Timers
}

export interface LocalOpts extends Shared {
  /** Already listening (from `bind.ts`). */
  server: Server
  targetHost: string
  targetPort: number
}

export interface RemoteOpts extends Shared {
  bindAddress: string
  bindPort: number
  targetHost: string
  targetPort: number
}

/** Settles a probe once: the first of a result, an error or `PROBE_TIMEOUT_MS`. */
function probeOnce(
  timers: Timers,
  timeoutMessage: string,
  run: (settle: (result: 'probe' | 'keepalive' | ForwardError) => void) => () => void,
): Promise<'probe' | 'keepalive'> {
  return new Promise((resolve, reject) => {
    let settled = false
    let cleanup = (): void => {}
    const settle = (result: 'probe' | 'keepalive' | ForwardError): void => {
      if (settled) return
      settled = true
      timers.clearTimeout(timer)
      cleanup()
      if (result instanceof ForwardError) reject(result)
      else resolve(result)
    }
    const timer = timers.setTimeout(() => settle(new ForwardError('probe-failed', timeoutMessage)), PROBE_TIMEOUT_MS)
    const stop = run(settle)
    if (settled) stop()
    else cleanup = stop
  })
}

/** The address to dial to reach a listener bound on `address` from this machine. */
const reachable = (address: string): string => (address === '0.0.0.0' ? '127.0.0.1' : address === '::' ? '::1' : address)

/**
 * Probes a local listener: connects, sends a token and passes when the listener consumed it (it
 * consumes a token only in its own hold). Any other outcome means something else answered, or nothing.
 */
export function probeListener(timers: Timers, tokens: ProbeTokens, address: { address: string; port: number }): Promise<'probe' | 'keepalive'> {
  return probeOnce(timers, `The listener on ${address.address}:${address.port} didn't answer the probe`, (settle) => {
    const token = tokens.issue()
    const sock = connect(address.port, reachable(address.address))
    const failed = (): void => settle(new ForwardError('probe-failed', `Nothing is listening on ${address.address}:${address.port}`))
    sock.once('connect', () => sock.write(token))
    sock.on('error', failed)
    // Only our own listener consumes the token; any other close means something else answered.
    const stranger = (): void => settle(new ForwardError('probe-failed', `Something else answered on ${address.address}:${address.port}`))
    sock.once('close', (hadError) => (hadError ? failed() : tokens.consume(token) ? stranger() : settle('probe')))
    return () => {
      tokens.consume(token)
      sock.destroy()
    }
  })
}

/**
 * The `L` engine: connections to `server` are forwarded over `client` to `targetHost:targetPort`.
 * The probe connects to the listener, sends a token and passes when our listener consumed it.
 */
export function startLocal(client: ForwardOut, opts: LocalOpts): ForwardHandle {
  const { server, counter, tokens, timers } = opts
  const bound = server.address() as AddressInfo
  const address = { address: bound.address, port: bound.port }
  const gate = new ConnectionGate(counter)

  const onConnection = (sock: Socket): void => {
    sock.on('error', () => {})
    gate.track(sock)
    holdForProbe(sock, tokens, timers, () => {
      if (!gate.admit(sock)) return void sock.destroy()
      const opened = (err: Error | undefined, channel: ClientChannel): void => {
        if (err) return void sock.destroy()
        if (sock.destroyed) return void discard(channel)
        pipeCounted(sock, channel, counter)
      }
      try {
        client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, opts.targetHost, opts.targetPort, opened)
      } catch {
        sock.destroy()
      }
    })
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

/** Where to send an `R` probe: loopback or wildcard binds are reached on 127.0.0.1 (`::1` stays `::1`). */
const remoteProbeHost = (bindAddress: string): string => {
  const a = bindAddress.trim().toLowerCase()
  if (a === '::1') return '::1'
  return a === '' || a === '*' || a === '0.0.0.0' || a === '::' || isLoopback(a) ? '127.0.0.1' : bindAddress
}

/**
 * The `R` engine: asks the server to listen on `bindAddress:bindPort`, and forwards each incoming
 * connection to `targetHost:targetPort` from this machine. The probe opens a `direct-tcpip` to the
 * remote listen carrying a token, which must come back as an incoming connection.
 */
export function startRemote(client: Client, opts: RemoteOpts): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    client.forwardIn(opts.bindAddress, opts.bindPort, (err, port) => {
      // ssh2 says `Unable to bind` for the server's REQUEST_FAILURE; a link that closes first fails
      // every pending request with `No response from server`, which is a retryable drop.
      if (err && /^Unable to bind/.test(err.message)) {
        const message = `The server refused to listen on port ${opts.bindPort} (it may be in use, or remote forwarding is disabled)`
        return reject(new ForwardError('remote-refused', message))
      }
      if (err) return reject(new ForwardError('closed', 'The connection closed before the server answered the listen request'))
      resolve(remoteHandle(client, opts, port))
    })
  })
}

function remoteHandle(client: Client, opts: RemoteOpts, port: number): ForwardHandle {
  const { bindAddress, counter, tokens, timers } = opts
  const gate = new ConnectionGate(counter)

  const onTcp = (info: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void): void => {
    if (info.destIP !== bindAddress || info.destPort !== port) return
    if (closing) return reject()
    const channel = accept()
    channel.on('error', () => {})
    gate.track(channel)
    holdForProbe(channel, tokens, timers, () => {
      if (!gate.admit(channel)) return discard(channel)
      const sock = connect(opts.targetPort, opts.targetHost)
      const drop = (): void => void sock.destroy()
      sock.on('error', () => discard(channel))
      channel.once('close', drop)
      sock.once('connect', () => {
        channel.off('close', drop)
        pipeCounted(sock, channel, counter)
      })
    })
  }
  client.on('tcp connection', onTcp)

  let closing: Promise<void> | null = null
  return {
    get accepting() {
      return gate.accepting
    },
    setAccepting: (on) => void (gate.accepting = on),
    address: { address: bindAddress, port },
    probe: () =>
      probeOnce(timers, `The remote listen on port ${port} didn't answer the probe`, (settle) => {
        const token = tokens.issue()
        const lost = (): void => settle(new ForwardError('probe-failed', `The remote listen on port ${port} didn't answer the probe`))
        let channel: ClientChannel | null = null
        let done = false
        const opened = (err: (Error & { reason?: unknown }) | undefined, ch: ClientChannel): void => {
          if (done) return void (ch && discard(ch))
          if (err) return err.reason === SSH_OPEN_ADMINISTRATIVELY_PROHIBITED ? settle('keepalive') : lost()
          channel = ch
          ch.on('error', () => {})
          // Our own listener consumes the token before the server closes this channel.
          ch.once('close', () => (tokens.consume(token) ? lost() : settle('probe')))
          ch.resume().write(token)
        }
        try {
          client.forwardOut('127.0.0.1', 0, remoteProbeHost(bindAddress), port, opened)
        } catch {
          lost()
        }
        return () => {
          done = true
          tokens.consume(token)
          if (channel) discard(channel)
        }
      }),
    close: () =>
      (closing ??= new Promise((resolve) => {
        gate.accepting = false
        client.off('tcp connection', onTcp)
        gate.destroyAll()
        try {
          client.unforwardIn(bindAddress, port, () => resolve())
        } catch {
          resolve()
        }
      })),
  }
}
