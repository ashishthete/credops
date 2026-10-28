import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { REDACTED, SENSITIVE_KEY, redact } from '../security/redact'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogFileOptions {
  dir: string
  /** Base name of the live file; rotated copies are `<stem>.1.log`, `<stem>.2.log`, ... */
  name?: string
  /** The live file rotates once a line would take it past this size. */
  maxBytes?: number
  /** Rotated copies kept besides the live file. */
  keep?: number
  /** Vault values decrypted right now: masked wherever they appear in a line. */
  knownSecrets?: () => readonly string[]
  now?: () => Date
}

export const LOG_FILE_NAME = 'main.log'
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_KEEP = 3
/** One line never holds more than this; a runaway stack or payload is cut. */
const MAX_LINE_CHARS = 8 * 1024

// `password=hunter2`, `"token": "abc"`, `Authorization: Bearer x`: the value after a sensitive name.
const SENSITIVE_PAIR = new RegExp(
  `((?:${SENSITIVE_KEY.source})[\\w-]*["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|(?:bearer|basic)\\s+\\S+|[^\\s,;}&]+)`,
  'gi',
)

/**
 * The text one log line carries, masked: objects go through `redact` (values under sensitive keys, PEM
 * keys, known secrets), then the joined text is masked again for known secrets, PEM blocks and
 * `name=value` pairs whose name looks sensitive.
 */
export function formatLogText(args: readonly unknown[], knownSecrets: readonly string[] = []): string {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
    return inspect(redact(a, knownSecrets), { depth: 4, breakLength: Infinity, maxStringLength: 2000 })
  })
  const joined = parts.join(' ').replace(/\r?\n/g, ' ↵ ')
  const masked = redact(joined, knownSecrets).replace(SENSITIVE_PAIR, (_m, name: string) => `${name}${REDACTED}`)
  return masked.length > MAX_LINE_CHARS ? `${masked.slice(0, MAX_LINE_CHARS)}… [cut]` : masked
}

/**
 * An append-only, size-capped log file: `<dir>/main.log`, rotated to main.1.log ... main.<keep>.log.
 * Every line is redacted before it is written. Writing never throws: a full disk or a missing folder
 * must not take the app down with it.
 */
export class LogFile {
  readonly file: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly stem: string
  private size: number | null = null

  constructor(private readonly opts: LogFileOptions) {
    const name = opts.name ?? LOG_FILE_NAME
    this.file = join(opts.dir, name)
    this.stem = name.replace(/\.log$/, '')
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.keep = opts.keep ?? DEFAULT_KEEP
  }

  private rotated(n: number): string {
    return join(this.opts.dir, `${this.stem}.${n}.log`)
  }

  write(level: LogLevel, ...args: unknown[]): void {
    try {
      const ts = (this.opts.now?.() ?? new Date()).toISOString()
      const line = `${ts} ${level.toUpperCase().padEnd(5)} ${formatLogText(args, this.opts.knownSecrets?.() ?? [])}\n`
      const bytes = Buffer.byteLength(line)
      if (this.size === null) {
        mkdirSync(this.opts.dir, { recursive: true })
        this.size = existsSync(this.file) ? statSync(this.file).size : 0
      }
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate()
      appendFileSync(this.file, line, { mode: 0o600 })
      if (this.size === 0) chmodSync(this.file, 0o600)
      this.size += bytes
    } catch {
      // Logging is best effort.
    }
  }

  info(...args: unknown[]): void {
    this.write('info', ...args)
  }

  warn(...args: unknown[]): void {
    this.write('warn', ...args)
  }

  error(...args: unknown[]): void {
    this.write('error', ...args)
  }

  private rotate(): void {
    rmSync(this.rotated(this.keep), { force: true })
    for (let n = this.keep - 1; n >= 1; n--) {
      if (existsSync(this.rotated(n))) renameSync(this.rotated(n), this.rotated(n + 1))
    }
    if (this.keep >= 1) renameSync(this.file, this.rotated(1))
    else rmSync(this.file, { force: true })
    this.size = 0
  }

  /** The last `n` lines, oldest first, reading into the newest rotated copy when the live file is short. */
  tail(n: number): string[] {
    const lines: string[] = []
    for (const f of [this.file, ...Array.from({ length: this.keep }, (_, i) => this.rotated(i + 1))]) {
      if (lines.length >= n) break
      let text: string
      try {
        text = readFileSync(f, 'utf8')
      } catch {
        break
      }
      lines.unshift(...text.split('\n').filter((l) => l.length > 0))
    }
    return lines.slice(-n)
  }
}

type ConsoleLike = Pick<Console, 'warn' | 'error'>

/**
 * Copies every console.warn and console.error into `log` as well (the console still prints them).
 * Returns a function that puts the originals back.
 */
export function captureConsole(log: Pick<LogFile, 'write'>, target: ConsoleLike = console): () => void {
  const original = { warn: target.warn, error: target.error }
  let inside = false
  const wrap =
    (level: 'warn' | 'error') =>
    (...args: unknown[]): void => {
      original[level].apply(target, args)
      if (inside) return
      inside = true
      try {
        log.write(level, ...args)
      } finally {
        inside = false
      }
    }
  target.warn = wrap('warn')
  target.error = wrap('error')
  return () => {
    target.warn = original.warn
    target.error = original.error
  }
}
