import { execFile as nodeExecFile } from 'node:child_process'
import net from 'node:net'
import { isLoopback, LSOF_TIMEOUT_MS } from '../../shared/tunnels'

export { isLoopback }

export class BindError extends Error {
  constructor(
    readonly code: 'port-in-use' | 'bind-denied',
    message: string
  ) {
    super(message)
    this.name = 'BindError'
  }
}

export interface PortHolder {
  pid: number
  command: string
}

/** The slice of `child_process.execFile` we use; injected so tests never run lsof against arbitrary ports. */
export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (err: Error | null, stdout: string) => void
) => { kill?: () => unknown } | void

export const realExecFile: ExecFile = (file, args, options, callback) =>
  nodeExecFile(file, args, options, (err, stdout) => callback(err, String(stdout ?? '')))

const MAX_COMMAND_LEN = 64

function cleanCommand(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_COMMAND_LEN)
}

/** Parses `lsof -Fpc` output (`p812\ncpostgres\n`) and returns the first process. */
export function parseLsof(out: string): PortHolder | null {
  let pid: number | null = null
  for (const line of String(out).split('\n')) {
    if (line.startsWith('p')) {
      if (pid !== null) return null // a second pid arrived before any command for the first
      const n = /^p(\d{1,10})$/.exec(line.trimEnd())
      pid = n ? Number(n[1]) : null
      if (pid === null || pid <= 0) return null
    } else if (line.startsWith('c') && pid !== null) {
      const command = cleanCommand(line.slice(1))
      return command ? { pid, command } : null
    }
  }
  return null
}

/** Who is listening on `port`? Any failure, non-zero exit or timeout is `null`. */
export function whoHolds(
  port: number,
  deps: { execFile?: ExecFile; timeoutMs?: number } = {}
): Promise<PortHolder | null> {
  const run = deps.execFile ?? realExecFile
  const timeoutMs = deps.timeoutMs ?? LSOF_TIMEOUT_MS
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    let child: { kill?: () => unknown } | void
    const finish = (value: PortHolder | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child?.kill?.()
      } catch {
        /* already gone */
      }
      finish(null)
    }, timeoutMs)
    try {
      child = run(
        'lsof',
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
        { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
        (err, stdout) => finish(err ? null : parseLsof(stdout))
      )
    } catch {
      finish(null)
    }
  })
}

export interface ListenDeps {
  whoHolds: (port: number) => Promise<PortHolder | null>
  /** The manager's check for another running tunnel on this address and port; returns its label. */
  inUseBy?: (address: string, port: number) => string | null
  /** Test seam for a stub server. */
  createServer?: () => net.Server
}

/** Binds a listener, mapping the common bind failures to `BindError` with readable messages. */
export async function listen(address: string, port: number, deps: ListenDeps): Promise<net.Server> {
  const host = address.trim().toLowerCase() === 'localhost' ? '127.0.0.1' : address
  const other = deps.inUseBy?.(host, port)
  if (other) throw new BindError('port-in-use', `Port ${port} on ${host} is used by tunnel "${other}"`)

  const server = (deps.createServer ?? (() => net.createServer()))()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (err) {
    server.close()
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EADDRINUSE') {
      const holder = await deps.whoHolds(port).catch(() => null)
      throw new BindError(
        'port-in-use',
        holder
          ? `Port ${port} on ${host} is in use by ${holder.command} (pid ${holder.pid})`
          : `Port ${port} on ${host} is already in use`
      )
    }
    if (code === 'EACCES') throw new BindError('bind-denied', `Port ${port} needs admin rights; pick a port above 1023`)
    if (code === 'EADDRNOTAVAIL') throw new BindError('bind-denied', `${host} isn't an address on this machine`)
    throw err
  }
  return server
}
