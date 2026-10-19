import { createServer, type Socket } from 'node:net'
import { Client } from 'ssh2'
import type { Timers } from '../../src/main/tunnels/forward'
import type { TestServer, TestUser } from './ssh-server'

/** The user `linkTo` signs in as; give it to `startServer({ users: [TUNNEL_USER] })`. */
export const TUNNEL_USER: TestUser = { username: 'tunnel', password: 'tunnel-pw' }

export interface EchoServer {
  port: number
  /** TCP accepts so far, so a test can prove that no probe reached the target. */
  accepted(): number
  close(): Promise<void>
}

/** A target on 127.0.0.1:0 that echoes its input. With `greeting`, it writes that first (a server-first protocol). */
export async function echoServer(opts: { greeting?: string } = {}): Promise<EchoServer> {
  let accepted = 0
  const live = new Set<Socket>()
  const server = createServer((sock) => {
    accepted += 1
    live.add(sock)
    sock.on('close', () => live.delete(sock))
    sock.on('error', () => {})
    if (opts.greeting) sock.write(opts.greeting)
    sock.pipe(sock)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of live) sock.destroy()
        server.close(() => resolve())
      }),
  }
}

export interface ManualTimers {
  timers: Timers
  /** Armed timers, oldest first. */
  pending(): { ms: number; kind: 'timeout' | 'interval' }[]
  /** Fires the oldest timer (with delay `ms`, when given). A timeout is then gone; an interval re-arms at the back. */
  fire(ms?: number): void
  /** Fires every timer armed right now, once each. */
  fireAll(): void
}

interface Armed {
  id: number
  fn: () => void
  ms: number
  kind: 'timeout' | 'interval'
}

export function manualTimers(): ManualTimers {
  let next = 1
  let armed: Armed[] = []
  const arm = (kind: Armed['kind']) => (fn: () => void, ms: number) => {
    const id = next++
    armed.push({ id, fn, ms, kind })
    return id
  }
  const clear = (h: unknown): void => {
    armed = armed.filter((t) => t.id !== h)
  }
  const run = (t: Armed): void => {
    armed = armed.filter((a) => a !== t)
    if (t.kind === 'interval') armed.push(t)
    t.fn()
  }
  return {
    timers: { setTimeout: arm('timeout'), clearTimeout: clear, setInterval: arm('interval'), clearInterval: clear },
    pending: () => armed.map(({ ms, kind }) => ({ ms, kind })),
    fire: (ms) => {
      const t = armed.find((a) => ms === undefined || a.ms === ms)
      if (!t) throw new Error(ms === undefined ? 'no timer is armed' : `no ${ms} ms timer is armed`)
      run(t)
    },
    fireAll: () => {
      for (const t of [...armed]) if (armed.includes(t)) run(t)
    },
  }
}

/** A ready `ssh2` client for a test server that has `TUNNEL_USER` (or `user`). */
export function linkTo(server: TestServer, user: TestUser = TUNNEL_USER): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.once('ready', () => resolve(client))
    // Before ready an error fails the link; after it, a dropped link only closes.
    client.on('error', reject)
    client.connect({ host: '127.0.0.1', port: server.port, username: user.username, password: user.password })
  })
}
