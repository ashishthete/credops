import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HubAudit } from './audit'
import { EntraVerifier } from './auth/entra'
import { buildApp } from './app'
import { checkDataDir, loadConfig, type HubConfig } from './config'
import { openHubDb } from './db'
import { createMasterKeyFile, loadMasterKey } from './secrets/keyring'

const USAGE = `usage:
  credops-hub serve --config <file>
  credops-hub gen-master-key --out <file>
  credops-hub check-config --config <file>`

const TOOLS = ['ansible-playbook', 'ssh-agent', 'ssh-add'] as const

async function serve(configFile: string): Promise<void> {
  const config = loadConfig(configFile)
  checkDataDir(config.dataDir)
  const masterKey = loadMasterKey({ ...(config.masterKeyFile ? { file: config.masterKeyFile } : {}) })
  const db = openHubDb(join(config.dataDir, 'hub.db'))
  const audit = new HubAudit(db)
  const app = buildApp({ config, db, audit, masterKey, verifier: new EntraVerifier(config.entra), now: () => new Date(), ids: randomUUID })
  const shutdown = (): void => {
    void app.close().finally(() => {
      db.close()
      process.exit(0)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  // A restart ends every release: fail what it interrupted and drop their locks before anyone can ask.
  const recovered = app.releases.recover()
  await app.listen({ host: config.listen.host, port: config.listen.port })
  audit.append({ action: 'hub.start', outcome: 'info', actor: null, details: { name: config.name, recovered } })
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    try {
      accessSync(p, constants.X_OK)
      if (statSync(p).isFile()) return p
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Prints a checklist and returns the exit code. A line only ever names what was checked and why it
 * failed; no key, token or file content is printed.
 */
async function checkConfig(configFile: string, out: (line: string) => void): Promise<number> {
  let failed = false
  const line = (ok: boolean, what: string, detail = ''): void => {
    if (!ok) failed = true
    out(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`)
  }
  let config: HubConfig | null = null
  try {
    config = loadConfig(configFile)
    line(true, 'config', 'valid')
  } catch (err) {
    line(false, 'config', err instanceof Error ? err.message : 'invalid')
    return 1
  }

  try {
    const key = loadMasterKey({ ...(config.masterKeyFile ? { file: config.masterKeyFile } : {}) })
    line(key.length === 32, 'master key', key.length === 32 ? '32 bytes, readable' : 'wrong length')
  } catch (err) {
    line(false, 'master key', err instanceof Error ? err.message : 'unreadable')
  }

  try {
    const st = statSync(config.dataDir)
    if (!st.isDirectory()) line(false, 'dataDir', 'is not a directory')
    else if ((st.mode & 0o077) !== 0) line(false, 'dataDir', 'is readable by other users (chmod 700)')
    else {
      accessSync(config.dataDir, constants.W_OK)
      line(true, 'dataDir', 'private and writable')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') line(true, 'dataDir', 'does not exist yet; it is created (0700) on first start')
    else line(false, 'dataDir', `cannot be checked (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
  }

  for (const t of TOOLS) {
    const p = findOnPath(t)
    line(p !== null, t, p ?? 'not found on PATH')
  }

  const discovery = `${config.entra.authority.replace(/\/$/, '')}/.well-known/openid-configuration`
  try {
    const res = await fetch(discovery, { redirect: 'error', signal: AbortSignal.timeout(5000) })
    await res.body?.cancel()
    line(res.ok, 'Entra discovery', res.ok ? 'reachable' : `HTTP ${res.status}`)
  } catch {
    line(false, 'Entra discovery', `could not reach ${new URL(discovery).origin}`)
  }
  return failed ? 1 : 0
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, flag, file] = argv
  if (cmd === 'serve' && flag === '--config' && file) {
    await serve(file)
    return -1 // keeps running
  }
  if ((cmd === 'gen-master-key' || cmd === 'keygen') && (flag === '--out' || flag === '--file') && file) {
    try {
      createMasterKeyFile(file)
      console.log(`master key written to ${file} (mode 600). Back it up apart from hub.db: without it the stored secrets cannot be opened.`)
      return 0
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'gen-master-key failed')
      return 1
    }
  }
  if (cmd === 'check-config' && flag === '--config' && file) return checkConfig(file, (l) => console.log(l))
  console.error(USAGE)
  return 2
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isEntry()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code)
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : 'startup failed')
      process.exit(1)
    },
  )
}
