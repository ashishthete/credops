import { Client } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import type { IdentityRef, ResolvedHost } from '../../shared/inventory'
import { READY_TIMEOUT_MS } from '../../shared/ssh'
import type { HopState, HostKeyInfo, SessionError } from '../../shared/ssh'
import { redact } from '../security/redact'
import { authHandler } from './auth'
import type { AuthPlan, KeyboardPrompt } from './auth'
import { fingerprintOf, hostToken } from './known-hosts'

const KEEPALIVE_COUNT_MAX = 3
const AUTH_FAILED = 'All configured authentication methods failed'
const SSH_OPEN_CONNECT_FAILED = 2

export interface HopTarget {
  label: string
  address: string
  port: number
  identity: IdentityRef
}

/** The jump chain first, then the target. */
export function hopsOf(resolved: ResolvedHost, targetLabel: string): HopTarget[] {
  return [
    ...resolved.chain.map(({ label, address, port, identity }) => ({ label, address, port, identity })),
    { label: targetLabel, address: resolved.address, port: resolved.port.value, identity: resolved.identity },
  ]
}

export interface ConnectDeps {
  /** `hop` names the host, so its ~/.ssh/config block can add key files. */
  plan(identity: IdentityRef, hop: HopTarget): Promise<AuthPlan>
  /** True to proceed. Throws `HostKeyError` for a changed or revoked key; asks the user about an unknown one. */
  verifyHostKey(hop: HopTarget, keyType: string, keyBase64: string): Promise<boolean>
  askPassword(hop: HopTarget, username: string): Promise<string | null>
  askKeyboard(hop: HopTarget, name: string, instructions: string, prompts: KeyboardPrompt[]): Promise<string[] | null>
  onHop(index: number, state: HopState): void
  /** 0 turns keepalives off. */
  keepaliveSec: number
  readyTimeoutMs?: number
}

export type HostKeyErrorCode = 'host-key-changed' | 'host-key-revoked' | 'host-key-rejected'

export class HostKeyError extends Error {
  constructor(
    readonly code: HostKeyErrorCode,
    readonly info: HostKeyInfo,
  ) {
    super(code)
    this.name = 'HostKeyError'
  }
}

/** What a refused login tried: names and paths only, never a key or password. */
export interface AuthSummary {
  username: string
  tried: string[]
  missing: string[]
  notes: string[]
}

export class AuthFailedError extends Error {
  constructor(readonly summary: AuthSummary) {
    super(AUTH_FAILED)
    this.name = 'AuthFailedError'
  }
}

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/** "alpha refused user ubuntu. Tried: ssh-agent (no keys loaded), ~/.ssh/id_rsa. ~/.ssh/id_ed25519 not found." */
function authMessage(label: string, { username, tried, missing, notes }: AuthSummary, user: boolean): string {
  const parts = [user ? `${label} refused user ${username}.` : `${label} refused the login.`, `Tried: ${tried.length ? tried.join(', ') : 'nothing'}.`]
  if (missing.length) parts.push(`${listed(missing)} not found.`)
  for (const note of notes) parts.push(`${note}.`)
  return parts.join(' ')
}

class ClosedError extends Error {
  constructor() {
    super('The connection was closed before it was ready')
    this.name = 'ClosedError'
  }
}

class HopTimeoutError extends Error {
  constructor() {
    super('Timed out while waiting for the server')
    this.name = 'HopTimeoutError'
  }
}

const HOST_KEY_MESSAGE: Record<HostKeyErrorCode, (label: string) => string> = {
  'host-key-changed': (l) =>
    `The host key for ${l} has changed. This could be an attack, so OpenSSH-style protection blocked the connection.`,
  'host-key-revoked': (l) => `The host key for ${l} is marked revoked in known_hosts`,
  'host-key-rejected': (l) => `You didn't trust the host key for ${l}`,
}

/** `user: false` leaves the username out of an auth failure (tunnel events and errors never carry it). */
export function describeError(err: unknown, hop: HopTarget | null, opts: { user?: boolean } = {}): SessionError {
  const label = hop?.label ?? 'The host'
  const make = (code: SessionError['code'], message: string): SessionError => ({
    code,
    message,
    ...(hop ? { hopLabel: hop.label } : {}),
  })
  const refused = (): SessionError => make('refused', `${label} refused the connection${hop ? ` on port ${hop.port}` : ''}`)
  const notFound = (address: string | undefined): SessionError => make('not-found', `Couldn't find ${address ?? 'the host'}`)
  const timeout = (): SessionError => make('timeout', `${label} didn't answer within ${READY_TIMEOUT_MS / 1000} s`)

  if (err instanceof HostKeyError) return { ...make(err.code, HOST_KEY_MESSAGE[err.code](label)), hostKey: err.info }
  if (err instanceof AuthFailedError) return make('auth', authMessage(label, err.summary, opts.user !== false))
  if (err instanceof ClosedError) return make('closed', err.message)
  if (err instanceof HopTimeoutError) return timeout()
  const e = (err ?? {}) as { code?: unknown; message?: unknown; reason?: unknown; level?: unknown; hostname?: string }
  const message = typeof e.message === 'string' ? e.message : String(err)
  if (e.code === 'ECONNREFUSED') return refused()
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return notFound(hop?.address ?? e.hostname)
  if (e.code === 'ETIMEDOUT' || e.level === 'client-timeout') return timeout()
  if (message === AUTH_FAILED) return make('auth', `${label} didn't accept any of the keys or passwords tried`)
  // A jump host that couldn't reach the next hop. OpenSSH puts the connect error in the description.
  if (e.reason === SSH_OPEN_CONNECT_FAILED) {
    const description = message.replace(/^\(SSH\) Channel open failure:\s*/, '')
    if (/not known|nodename|resolve/i.test(description)) return notFound(hop?.address)
    if (/timed out/i.test(description)) return timeout()
    if (description === '' || /refused/i.test(description)) return refused()
  }
  return make('unknown', redact(message))
}

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** The key type is the blob's first length-prefixed string (`ssh-rsa` even when `rsa-sha2-256` was negotiated). */
function blobKeyType(blob: Buffer): string {
  if (blob.length < 4) return ''
  const len = blob.readUInt32BE(0)
  return blob.length < 4 + len ? '' : blob.subarray(4, 4 + len).toString('latin1')
}

/** Dials one hop, directly or over `prev`. `track` receives the client as soon as it exists. */
async function dialHop(
  hop: HopTarget,
  prev: Client | null,
  deps: ConnectDeps,
  signal: AbortSignal,
  track: (client: Client) => void,
): Promise<Client> {
  const plan = await deps.plan(hop.identity, hop)
  if (signal.aborted) throw new ClosedError()
  // What the user typed in, by kind only, for the failure message.
  const typed = new Set<string>()
  const authFailed = (): AuthFailedError =>
    new AuthFailedError({
      username: plan.username,
      tried: [...(plan.tried ?? plan.methods.map((m) => (m.type === 'publickey' ? m.label : m.type === 'agent' ? 'ssh-agent' : 'saved password'))), ...typed],
      missing: plan.missing ?? [],
      notes: plan.notes,
    })
  const client = new Client()
  // Errors after ready also emit 'close', which is what the caller watches.
  client.on('error', () => {})
  track(client)

  return new Promise<Client>((resolve, reject) => {
    const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let hostKeyError: Error | null = null

    // Our own ready timer, since ssh2's also runs while the user answers a prompt. It pauses
    // while a prompt is open and resumes with the time that was left.
    let remaining = timeoutMs
    let armedAt = 0
    let prompting = 0
    const arm = (): void => {
      armedAt = Date.now()
      timer = setTimeout(() => fail(new HopTimeoutError()), Math.max(0, remaining))
    }
    const waitOnUser = async <T>(prompt: () => Promise<T>): Promise<T> => {
      if (prompting++ === 0) {
        clearTimeout(timer)
        remaining -= Date.now() - armedAt
      }
      try {
        return await prompt()
      } finally {
        if (--prompting === 0 && !settled) arm()
      }
    }
    const done = (): void => {
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (err: Error): void => {
      if (settled) return
      done()
      client.destroy()
      reject(err)
    }
    const onAbort = (): void => fail(new ClosedError())

    signal.addEventListener('abort', onAbort, { once: true })
    client.on('error', (err: Error & { level?: string }) => {
      // ssh2 reports an agent that fails mid-dial, then goes on to the next method itself.
      if (err.level === 'agent') return
      fail(hostKeyError ?? (err.message === AUTH_FAILED ? authFailed() : err))
    })
    client.on('close', () => fail(hostKeyError ?? new Error('The server closed the connection')))
    client.once('ready', () => {
      if (settled) return
      done()
      resolve(client)
    })

    const start = (sock?: ClientChannel): void => {
      try {
        dial(sock)
      } catch (err) {
        fail(toError(err))
      }
    }
    const dial = (sock?: ClientChannel): void => {
      client.connect({
        ...(sock ? { sock } : { host: hop.address, port: hop.port }),
        username: plan.username,
        authHandler: authHandler(
          plan,
          async () => {
            const answer = await waitOnUser(() => deps.askPassword(hop, plan.username))
            if (answer !== null) typed.add('a typed password')
            return answer
          },
          async (name, instructions, prompts) => {
            const answers = await waitOnUser(() => deps.askKeyboard(hop, name, instructions, prompts))
            if (answers !== null) typed.add('keyboard-interactive answers')
            return answers
          },
        ),
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const keyType = blobKeyType(key)
          const keyBase64 = key.toString('base64')
          waitOnUser(() => deps.verifyHostKey(hop, keyType, keyBase64))
            .then(
              (ok) => {
                if (!ok) {
                  const info = { host: hostToken(hop.address, hop.port), keyType, fingerprint: fingerprintOf(keyBase64), known: [] }
                  hostKeyError = new HostKeyError('host-key-rejected', info)
                }
                verify(ok)
              },
              (err: unknown) => {
                hostKeyError = toError(err)
                verify(false)
              },
            )
            // A throw from inside ssh2's verify callback.
            .catch((err: unknown) => fail(toError(err)))
        },
        readyTimeout: 0,
        keepaliveInterval: deps.keepaliveSec * 1000,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      })
    }

    arm()
    if (!prev) return start()
    try {
      prev.forwardOut('127.0.0.1', 0, hop.address, hop.port, (err, stream) => {
        if (err) return fail(err)
        if (settled) return stream.close()
        start(stream)
      })
    } catch (err) {
      fail(toError(err))
    }
  })
}

/**
 * Dials `hops` in order, each after the first over a forward from the one before. On abort or
 * any failure every client opened so far is ended, last first.
 */
export async function connectChain(
  hops: HopTarget[],
  deps: ConnectDeps,
  signal: AbortSignal,
): Promise<{ client: Client; close(): void }> {
  const opened: Client[] = []
  const close = (): void => {
    for (const c of [...opened].reverse()) c.end()
  }
  try {
    if (hops.length === 0) throw new Error('No hops to dial')
    for (const [i, hop] of hops.entries()) {
      if (signal.aborted) throw new ClosedError()
      deps.onHop(i, 'connecting')
      try {
        await dialHop(hop, opened.at(-1) ?? null, deps, signal, (c) => opened.push(c))
      } catch (err) {
        if (!(err instanceof ClosedError)) deps.onHop(i, 'failed')
        throw err
      }
      deps.onHop(i, 'up')
    }
  } catch (err) {
    close()
    throw err
  }
  return { client: opened.at(-1)!, close }
}
