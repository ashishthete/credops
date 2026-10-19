import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel, PseudoTtyOptions } from 'ssh2'
import { redact } from '../security/redact'
import { realTimers, type Timers } from '../tunnels/forward'
import { ExecFailure } from './exec-links'

/** How long a stopped exec gets to exit after its `INT` before the channel is closed. */
export const STOP_GRACE_MS = 2000

export interface ExecOnceOptions {
  env?: Record<string, string>
  pty?: PseudoTtyOptions
  /** Abort is a cancel: `INT`, then a close after `STOP_GRACE_MS` (or, if the channel never opens, settled then). */
  signal: AbortSignal
  /** The same stop as a cancel, reported as `timedOut`. */
  timeoutMs?: number
  onData(chunk: string, stream: 'out' | 'err'): void
  timers?: Timers
}

export interface ExecResult {
  /** Null when the command died by a signal or never reported an exit. */
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
}

/** ssh2's error for a channel the server wouldn't open. */
const isOpenFailure = (err: Error): boolean => typeof (err as { reason?: unknown }).reason === 'number'

/**
 * Runs `command` on one exec channel and resolves when the channel closes. Stdin is left open: an
 * ended stdin would make ssh2 drop the later `signal` request. A stopped command may still be running
 * on the host after the close, since a server without a pty need not kill it.
 */
export function execOnce(client: Client, command: string, o: ExecOnceOptions): Promise<ExecResult> {
  const timers = o.timers ?? realTimers
  const result: ExecResult = { exitCode: null, signal: null, timedOut: false, cancelled: false }
  if (o.signal.aborted) return Promise.resolve({ ...result, cancelled: true })

  return new Promise<ExecResult>((resolve, reject) => {
    let channel: ClientChannel | null = null
    let timeout: unknown = null
    let grace: unknown = null
    let stopped = false
    let settled = false

    const stop = (why: 'cancelled' | 'timedOut'): void => {
      if (stopped) return
      stopped = true
      result[why] = true
      if (!channel) {
        // A server that never answers the channel open must not hold the cancel until keepalive gives up.
        grace = timers.setTimeout(() => {
          settled = true
          cleanup()
          resolve(result)
        }, STOP_GRACE_MS)
        return
      }
      channel.signal('INT')
      const ch = channel
      grace = timers.setTimeout(() => ch.close(), STOP_GRACE_MS)
    }
    const onAbort = (): void => stop('cancelled')
    const cleanup = (): void => {
      o.signal.removeEventListener('abort', onAbort)
      if (timeout !== null) timers.clearTimeout(timeout)
      if (grace !== null) timers.clearTimeout(grace)
    }
    o.signal.addEventListener('abort', onAbort, { once: true })

    const options = { ...(o.env ? { env: o.env } : {}), ...(o.pty ? { pty: o.pty } : {}) }
    const opened = (err: Error | undefined, ch: ClientChannel): void => {
      if (settled) {
        // Already reported as cancelled: a channel that arrives now is closed unused.
        if (!err) ch.close()
        return
      }
      if (err) {
        cleanup()
        const message = isOpenFailure(err) ? 'The host refused another session (MaxSessions)' : redact(err.message)
        return reject(new ExecFailure({ code: 'unknown', message }))
      }
      channel = ch
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
      const emit = (stream: 'out' | 'err', text: string): void => {
        if (text !== '') o.onData(text, stream)
      }
      ch.on('data', (d: Buffer) => emit('out', decoders.out.write(d)))
      ch.stderr.on('data', (d: Buffer) => emit('err', decoders.err.write(d)))
      ch.on('exit', (code: number | null, signalName?: string) => {
        result.exitCode = typeof code === 'number' ? code : null
        result.signal = signalName ?? null
      })
      ch.on('error', () => {})
      ch.on('close', () => {
        emit('out', decoders.out.end())
        emit('err', decoders.err.end())
        cleanup()
        resolve(result)
      })
      // A cancel that came while the channel was opening; the timeout only starts once it is open.
      if (stopped) {
        if (grace !== null) timers.clearTimeout(grace)
        stopped = false
        stop('cancelled')
      } else if (o.timeoutMs !== undefined) timeout = timers.setTimeout(() => stop('timedOut'), o.timeoutMs)
    }
    try {
      client.exec(command, options, opened)
    } catch {
      // ssh2 throws when the connection is already gone.
      cleanup()
      reject(new ExecFailure({ code: 'closed', message: 'The connection was closed' }))
    }
  })
}
