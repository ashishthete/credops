import { connect as netConnect, createServer as netServer, type Server as NetServer } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { Server, utils } from 'ssh2'
import type { AuthContext, Connection, ParsedKey, PseudoTtyInfo, ServerChannel } from 'ssh2'

export interface TestUser {
  username: string
  password?: string
  publicKey?: ParsedKey
}

export interface ServerOpts {
  /** A private key; a fresh ed25519 key when omitted. */
  hostKey?: string
  /** Further host keys of other types, offered alongside `hostKey`. */
  extraHostKeys?: string[]
  users: TestUser[]
  /** Offers keyboard-interactive: one round asking `prompts`, accepted when the replies equal `answers`. */
  keyboard?: { prompts: string[]; answers: string[] }
  onShell?: (stream: ServerChannel, info: { env: Record<string, string>; pty: PseudoTtyInfo | null }) => void
  /**
   * Accepts `exec` requests and hands each one here; without it exec is rejected. `onSignal` receives
   * the channel's `signal` requests by name (`INT`), which the server also records.
   */
  onExec?: (command: string, stream: ServerChannel, info: ExecInfo) => void
  /** Refuses a session channel while this many are open, like OpenSSH's `MaxSessions`. */
  maxSessions?: number
  /**
   * Accepts `direct-tcpip` and pipes it to 127.0.0.1:<destPort>. Without it no `tcpip` listener is
   * registered, so ssh2 refuses the channel with reason 1 (administratively prohibited).
   */
  allowForward?: boolean
  /**
   * Accepts `tcpip-forward` with a real listener on 127.0.0.1:<bindPort> (0 picks a free port) and opens
   * each accepted socket back to the client as `forwarded-tcpip`. Without it both global requests fail.
   */
  allowRemoteForward?: boolean
}

export interface ExecInfo {
  env: Record<string, string>
  pty: PseudoTtyInfo | null
  onSignal(cb: (name: string) => void): void
}

export interface TestServer {
  port: number
  hostKeyType: string
  hostKeyBase64: string
  close(): Promise<void>
  /** Live client connections. */
  connections(): number
  /** `direct-tcpip` channel requests seen (counted only with `allowForward`). */
  tcpipRequests(): number
  /** The ports of the live `tcpip-forward` listeners. */
  remoteListeners(): number[]
  /** Destroys every client connection's socket, like a dead network. */
  dropAll(): void
  /** The commands of the `exec` requests seen, in order (recorded only with `onExec`). */
  execs(): string[]
  /** The names of the `signal` requests seen, in order. */
  signals(): string[]
}

/**
 * A key pair whose public half parses. ssh2's generator now and then drops a leading zero byte
 * from an ed25519 key (about 1 in 300), and that key is unusable, so retry.
 */
export function generateKey(
  type: 'ed25519' | 'rsa' | 'ecdsa' = 'ed25519',
  opts: object = {},
): { private: string; public: ParsedKey } {
  const bits = { rsa: { bits: 2048 }, ecdsa: { bits: 256 }, ed25519: {} }[type]
  for (;;) {
    const pair = utils.generateKeyPairSync(type as 'ed25519', { ...bits, ...opts } as never)
    const pub = utils.parseKey(pair.public)
    if (!(pub instanceof Error)) return { private: pair.private, public: pub }
  }
}

const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

function authenticate(ctx: AuthContext, opts: ServerOpts): void {
  const user = opts.users.find((u) => u.username === ctx.username)
  const offered = [
    ...(opts.users.some((u) => u.publicKey) ? ['publickey'] : []),
    ...(opts.users.some((u) => u.password !== undefined) ? ['password'] : []),
    ...(opts.keyboard ? ['keyboard-interactive'] : []),
  ]
  const reject = (): void => ctx.reject(offered as never)
  if (ctx.method === 'publickey' && user?.publicKey) {
    const key = user.publicKey
    if (ctx.key.algo !== key.type || !same(ctx.key.data, key.getPublicSSH())) return reject()
    // The first publickey request only asks whether the key would be accepted.
    if (!ctx.signature) return ctx.accept()
    return key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : reject()
  }
  if (ctx.method === 'password' && user?.password !== undefined) {
    return ctx.password === user.password ? ctx.accept() : reject()
  }
  if (ctx.method === 'keyboard-interactive' && user && opts.keyboard) {
    const { prompts, answers } = opts.keyboard
    return ctx.prompt(
      prompts.map((prompt) => ({ prompt, echo: false })),
      (replies) => (replies.length === answers.length && replies.every((r, i) => r === answers[i]) ? ctx.accept() : reject()),
    )
  }
  reject()
}

/** Writes READY, echoes its input and exits with 0 on `exit\r`. */
function echoShell(stream: ServerChannel): void {
  stream.write('READY\r\n')
  let typed = ''
  stream.on('data', (d: Buffer) => {
    stream.write(d)
    typed = (typed + d.toString()).slice(-16)
    if (typed.endsWith('exit\r')) {
      stream.exit(0)
      stream.end()
    }
  })
}

interface ExecLog {
  execs: string[]
  signals: string[]
}

function serveSessions(conn: Connection, opts: ServerOpts, log: ExecLog): void {
  let open = 0
  conn.on('session', (acceptSession, rejectSession) => {
    if (opts.maxSessions !== undefined && open >= opts.maxSessions) return rejectSession()
    const session = acceptSession()
    open += 1
    session.on('close', () => (open -= 1))
    const signalled: ((name: string) => void)[] = []
    const env: Record<string, string> = {}
    let pty: PseudoTtyInfo | null = null
    session.on('env', (accept, _reject, info) => {
      env[info.key] = info.val
      accept?.()
    })
    session.on('pty', (accept, _reject, info) => {
      pty = info
      accept?.()
    })
    session.on('window-change', (accept) => accept?.())
    session.on('shell', (accept) => {
      const stream = accept()
      if (opts.onShell) opts.onShell(stream, { env, pty })
      else echoShell(stream)
    })
    session.on('signal', (accept, _reject, info) => {
      log.signals.push(info.name)
      accept?.()
      for (const cb of signalled) cb(info.name)
    })
    session.on('exec', (accept, reject, info) => {
      if (!opts.onExec) return reject?.()
      log.execs.push(info.command)
      opts.onExec(info.command, accept(), { env, pty, onSignal: (cb) => void signalled.push(cb) })
    })
  })
}

/** Serves `tcpip-forward` and `cancel-tcpip-forward` for one connection. */
function serveRemoteForwards(conn: Connection, listeners: Map<string, NetServer>): void {
  const key = (addr: string, port: number): string => `${addr}:${port}`
  conn.on('request', (accept, reject, name, info) => {
    if (name === 'cancel-tcpip-forward') {
      const listener = listeners.get(key(info.bindAddr, info.bindPort))
      if (!listener) return reject?.()
      listeners.delete(key(info.bindAddr, info.bindPort))
      listener.close()
      return accept?.()
    }
    if (name !== 'tcpip-forward') return reject?.()
    const listener = netServer((sock) => {
      sock.on('error', () => {})
      conn.forwardOut(info.bindAddr, port(), sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, (err, channel) => {
        if (err) return void sock.destroy()
        channel.on('error', () => sock.destroy())
        sock.on('error', () => channel.close())
        channel.pipe(sock).pipe(channel)
      })
    })
    const port = (): number => (listener.address() as { port: number }).port
    listener.once('error', () => reject?.())
    listener.listen(info.bindPort, '127.0.0.1', () => {
      listeners.set(key(info.bindAddr, port()), listener)
      accept?.(port())
    })
  })
  conn.on('close', () => {
    for (const listener of listeners.values()) listener.close()
    listeners.clear()
  })
}

export async function startServer(opts: ServerOpts): Promise<TestServer> {
  const hostKey = opts.hostKey ?? generateKey().private
  const parsed = utils.parseKey(hostKey)
  if (parsed instanceof Error) throw parsed
  const live = new Set<Connection>()
  const remoteListeners = new Map<Connection, Map<string, NetServer>>()
  let tcpipRequests = 0
  const log: ExecLog = { execs: [], signals: [] }

  const server = new Server({ hostKeys: [hostKey, ...(opts.extraHostKeys ?? [])] }, (conn) => {
    live.add(conn)
    conn.on('close', () => live.delete(conn))
    conn.on('error', () => {})
    conn.on('authentication', (ctx) => authenticate(ctx, opts))
    conn.on('ready', () => serveSessions(conn, opts, log))
    if (opts.allowRemoteForward) {
      const listeners = new Map<string, NetServer>()
      remoteListeners.set(conn, listeners)
      conn.on('close', () => remoteListeners.delete(conn))
      serveRemoteForwards(conn, listeners)
    }
    if (opts.allowForward) {
      conn.on('tcpip', (accept, reject, info) => {
        tcpipRequests += 1
        const sock = netConnect(info.destPort, '127.0.0.1')
        sock.once('error', () => reject())
        sock.once('connect', () => {
          const channel = accept()
          channel.on('error', () => sock.destroy())
          sock.on('error', () => channel.close())
          channel.pipe(sock).pipe(channel)
        })
      })
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    hostKeyType: parsed.type,
    hostKeyBase64: parsed.getPublicSSH().toString('base64'),
    connections: () => live.size,
    tcpipRequests: () => tcpipRequests,
    remoteListeners: () =>
      [...remoteListeners.values()].flatMap((byKey) => [...byKey.values()].map((l) => (l.address() as { port: number }).port)),
    execs: () => [...log.execs],
    signals: () => [...log.signals],
    dropAll: () => {
      for (const conn of live) (conn as unknown as { _sock: { destroy(): void } })._sock.destroy()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of live) conn.end()
        server.close(() => resolve())
      }),
  }
}
