import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { socketPathFits } from './ssh-files'

/* A private ssh-agent per release. Key material reaches ssh-add on stdin and the passphrase only through the ssh-add child's env. */

export interface ChildLike {
  pid?: number
  stdin: { write(chunk: string | Buffer): unknown; end(): unknown; on?(ev: 'error', cb: (err: Error) => void): unknown }
  stdout: { on(ev: 'data', cb: (c: Buffer) => void): unknown }
  stderr: { on(ev: 'data', cb: (c: Buffer) => void): unknown }
  on(ev: 'exit', cb: (code: number | null, signal: string | null) => void): unknown
  on(ev: 'error', cb: (err: Error) => void): unknown
  kill(signal?: string): boolean
}
export type SpawnFn = (file: string, args: string[], opts: { env: Record<string, string> }) => ChildLike

export interface PrivateAgent {
  sock: string
  pid?: number
  add(material: { privateKey: string; passphrase?: string }): Promise<void>
  stop(): Promise<void>
}

export interface AgentOptions {
  dir: string
  tools: { sshAgent: string; sshAdd: string }
  spawn: SpawnFn
  /** The release's total timeout plus 10 minutes. */
  ttlSec: number
  /** Where PATH comes from; defaults to process.env. */
  env?: Record<string, string | undefined>
  /** ssh-add can loop on a wrong passphrase; it is killed after this long. Default 30 s (a key with many KDF rounds is slow to decrypt). */
  addTimeoutMs?: number
}

/** An allow-list copy of `base`: only the named, defined variables survive. */
export function childEnv(base: Record<string, string | undefined>, allow: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of allow) {
    const v = base[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

const SOCKET_WAIT_MS = 3000
const STOP_WAIT_MS = 2000
const ASKPASS = '#!/bin/sh\nprintf \'%s\\n\' "$CREDOPS_ASKPASS"\n'

/** ssh-add's stderr with the passphrase and any long key-like run removed. */
function scrub(text: string, secrets: string[]): string {
  let t = text
  for (const s of secrets) if (s) t = t.split(s).join('[redacted]')
  t = t.replace(/-----BEGIN [\s\S]*?(-----END [^-]*-----|$)/g, '[redacted]').replace(/[A-Za-z0-9+/=]{20,}/g, '[redacted]')
  return t.trim().slice(0, 300)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function startPrivateAgent(opts: AgentOptions): Promise<PrivateAgent> {
  const { dir, tools, spawn, ttlSec } = opts
  const base = opts.env ?? process.env
  if (!socketPathFits(dir)) throw new Error(`agent directory is too long for a socket (${Buffer.byteLength(dir)} bytes); use a shorter one such as /tmp/od-XXXXXX`)
  const sock = join(dir, 'a')
  const askpass = join(dir, 'askpass')
  writeFileSync(askpass, ASKPASS, { mode: 0o700 })
  chmodSync(askpass, 0o700)

  const child = spawn(tools.sshAgent, ['-D', '-a', sock], { env: childEnv(base, ['PATH']) })
  let exited = false
  let stopping: Promise<void> | null = null
  const exitWaiters: (() => void)[] = []
  child.on('exit', () => {
    exited = true
    for (const w of exitWaiters.splice(0)) w()
  })
  child.on('error', () => {
    exited = true
    for (const w of exitWaiters.splice(0)) w()
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  const cleanup = (): void => {
    rmSync(sock, { force: true })
    rmSync(askpass, { force: true })
  }
  const kill = async (): Promise<void> => {
    if (!exited) {
      const gone = new Promise<void>((r) => exitWaiters.push(r))
      child.kill('SIGTERM')
      await Promise.race([gone, sleep(STOP_WAIT_MS)])
      if (!exited) child.kill('SIGKILL')
    }
    cleanup()
  }

  const deadline = Date.now() + SOCKET_WAIT_MS
  while (!existsSync(sock)) {
    if (exited || Date.now() > deadline) {
      await kill()
      throw new Error(exited ? 'ssh-agent exited before it created its socket' : 'ssh-agent did not create its socket in time')
    }
    await sleep(10)
  }

  return {
    sock,
    pid: child.pid,
    async add({ privateKey, passphrase }) {
      const env = childEnv(
        { SSH_AUTH_SOCK: sock, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'none', ...(passphrase ? { CREDOPS_ASKPASS: passphrase } : {}) },
        ['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY', 'CREDOPS_ASKPASS'],
      )
      const add = spawn(tools.sshAdd, ['-t', String(ttlSec), '-'], { env })
      let err = ''
      add.stderr.on('data', (c) => (err += c.toString()))
      add.stdout.on('data', (c) => (err += c.toString()))
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          add.kill('SIGKILL')
          reject(new Error('ssh-add timed out; the key or its passphrase was probably not accepted'))
        }, opts.addTimeoutMs ?? 30_000)
        add.on('exit', () => clearTimeout(timer))
        add.on('error', (e) => {
          clearTimeout(timer)
          reject(new Error(`ssh-add failed to start: ${scrub(e.message, [privateKey, passphrase ?? ''])}`))
        })
        add.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ssh-add failed (exit ${code}): ${scrub(err, [privateKey, passphrase ?? ''])}`))
        })
      })
      // An EPIPE when ssh-add exits early surfaces through its exit code, not as an uncaught error.
      add.stdin.on?.('error', () => {})
      add.stdin.write(privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`)
      add.stdin.end()
      await done
    },
    stop() {
      stopping ??= kill()
      return stopping
    },
  }
}
