import { connect as netConnect } from 'node:net'
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
  users: TestUser[]
  /** Offers keyboard-interactive: one round asking `prompts`, accepted when the replies equal `answers`. */
  keyboard?: { prompts: string[]; answers: string[] }
  onShell?: (stream: ServerChannel, info: { env: Record<string, string>; pty: PseudoTtyInfo | null }) => void
  /** Accepts `direct-tcpip` and pipes it to 127.0.0.1:<destPort>. */
  allowForward?: boolean
}

export interface TestServer {
  port: number
  hostKeyType: string
  hostKeyBase64: string
  close(): Promise<void>
  /** Live client connections. */
  connections(): number
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

function serveSessions(conn: Connection, opts: ServerOpts): void {
  conn.on('session', (acceptSession) => {
    const session = acceptSession()
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
  })
}

export async function startServer(opts: ServerOpts): Promise<TestServer> {
  const hostKey = opts.hostKey ?? utils.generateKeyPairSync('ed25519').private
  const parsed = utils.parseKey(hostKey)
  if (parsed instanceof Error) throw parsed
  const live = new Set<Connection>()

  const server = new Server({ hostKeys: [hostKey] }, (conn) => {
    live.add(conn)
    conn.on('close', () => live.delete(conn))
    conn.on('error', () => {})
    conn.on('authentication', (ctx) => authenticate(ctx, opts))
    conn.on('ready', () => serveSessions(conn, opts))
    conn.on('tcpip', (accept, reject, info) => {
      if (!opts.allowForward) return reject()
      const sock = netConnect(info.destPort, '127.0.0.1')
      sock.once('error', () => reject())
      sock.once('connect', () => {
        const channel = accept()
        channel.on('error', () => sock.destroy())
        sock.on('error', () => channel.close())
        channel.pipe(sock).pipe(channel)
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    hostKeyType: parsed.type,
    hostKeyBase64: parsed.getPublicSSH().toString('base64'),
    connections: () => live.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of live) conn.end()
        server.close(() => resolve())
      }),
  }
}
