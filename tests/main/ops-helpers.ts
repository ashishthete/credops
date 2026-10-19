import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, vi } from 'vitest'
import type { EventContract } from '../../src/shared/ipc'
import type { RunHostMeta, RunHostState, RunSummary } from '../../src/shared/ops'
import { resolveHost } from '../../src/main/inventory/resolve'
import { hostMeta } from '../../src/main/inventory/rows'
import { ExecLinks } from '../../src/main/ops/exec-links'
import { RunManager, type RunManagerDeps } from '../../src/main/ops/run-manager'
import { SnippetStore } from '../../src/main/ops/snippet-store'
import { connectChain } from '../../src/main/ssh/connect'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import { PromptBroker } from '../../src/main/ssh/prompts'
import { makeInventory } from './inventory-helpers'
import { startServer, type ServerOpts } from './ssh-server'
import { TUNNEL_USER } from './tunnel-helpers'

export interface ShellHost {
  /** The tmp dir every command runs in; also its `HOME`. */
  dir: string
  /** Holds the fake `docker`, first on `PATH`. */
  bin: string
  /** The fake docker's fixtures: `<subcommand>.out`, `.err` and `.code` (the exit code, 0 when absent). */
  fixtures: string
  /** The fake docker appends each argument it receives here, one per line. */
  dockerLog: string
  onExec: NonNullable<ServerOpts['onExec']>
  /** Children still running. */
  running(): number
  /** Kills what is still running and removes the tmp dir. */
  close(): void
}

/**
 * A fake `docker`: only shell builtins, and it never runs another program by name, so it can't fall
 * through to a real docker. `ps`, `logs`, `start`, `stop` and `restart` answer from fixture files.
 */
const fakeDocker = (fixtures: string, log: string): string => `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done
case "$1" in
  ps|logs|start|stop|restart) f='${fixtures}'/"$1" ;;
  *) printf 'docker: unknown command\\n' >&2; exit 127 ;;
esac
if [ -f "$f.out" ]; then while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < "$f.out"; fi
if [ -f "$f.err" ]; then while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l" >&2; done < "$f.err"; fi
code=0
if [ -f "$f.code" ]; then read -r code < "$f.code"; fi
exit "$code"
`

/**
 * An `onExec` that runs each received command with the local `/bin/sh -c`, so tests see real shell
 * parsing of what OpsDeck sends while staying on localhost. The env is built from scratch (nothing
 * from `process.env`): the channel's env, then `PATH` = the tmp `bin` plus /usr/bin:/bin, `HOME` = the
 * tmp dir and `LANG=C`, which the channel can't override. A channel `signal` reaches the child; a
 * channel close kills it.
 */
export function shellExec(): ShellHost {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-exec-'))
  const bin = join(dir, 'bin')
  const fixtures = join(dir, 'docker')
  const dockerLog = join(dir, 'docker.log')
  mkdirSync(bin)
  mkdirSync(fixtures)
  writeFileSync(join(bin, 'docker'), fakeDocker(fixtures, dockerLog))
  chmodSync(join(bin, 'docker'), 0o755)
  const children = new Set<ChildProcess>()

  const onExec: ShellHost['onExec'] = (command, stream, info) => {
    const env = { ...info.env, PATH: `${bin}:/usr/bin:/bin`, HOME: dir, LANG: 'C' }
    const child = spawn('/bin/sh', ['-c', command], { cwd: dir, env, stdio: 'pipe' })
    children.add(child)
    let open = true
    stream.on('close', () => {
      open = false
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    info.onSignal((name) => {
      if (/^[A-Z]+$/.test(name)) child.kill(`SIG${name}` as NodeJS.Signals)
    })
    stream.on('data', (d: Buffer) => child.stdin.write(d))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (d: Buffer) => open && stream.write(d))
    child.stderr.on('data', (d: Buffer) => open && stream.stderr.write(d))
    child.on('close', (code, signal) => {
      children.delete(child)
      if (!open) return
      if (signal) stream.exit(signal.replace(/^SIG/, ''), false, '')
      else stream.exit(code ?? 0)
      stream.end()
    })
  }

  return {
    dir,
    bin,
    fixtures,
    dockerLog,
    onExec,
    running: () => children.size,
    close: () => {
      for (const child of children) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Labels of the five staging hosts `makeRunSetup` creates, in label order, with their roles. */
export const STAGING_HOSTS = [
  { label: 'app-1', role: 'app' },
  { label: 'app-2', role: 'app' },
  { label: 'app-3', role: 'app' },
  { label: 'db-1', role: 'db' },
  { label: 'db-2', role: 'db' },
] as const

/** Labels of the two prod hosts, which belong to `prod` only. */
export const PROD_HOSTS = [
  { label: 'prod-app-1', role: 'app' },
  { label: 'prod-db-1', role: 'db' },
] as const

/**
 * A `RunManager` over a tmp inventory. Every host points at one test server on 127.0.0.1:0 whose execs
 * run through `shellExec`, with `OD_HOST` set to the host's label (and `MARKER` to a path in the shell's
 * tmp dir). `staging` (unprotected) holds app-1..3 (app) and db-1..2 (db); `prod` (protected) holds
 * prod-app-1 (app) and prod-db-1 (db). Auth is a password plan, so nothing reads a real ~/.ssh or agent.
 */
export async function makeRunSetup(deps: Partial<RunManagerDeps> = {}) {
  const f = await makeInventory()
  onTestFinished(() => rmSync(f.home, { recursive: true, force: true }))
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-runs-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const sh = shellExec()
  onTestFinished(() => sh.close())
  let live = 0
  let maxLive = 0
  const server = await startServer({
    users: [TUNNEL_USER],
    onExec: (command, stream, info) => {
      live += 1
      maxLive = Math.max(maxLive, live)
      stream.on('close', () => (live -= 1))
      sh.onExec(command, stream, info)
    },
  })
  onTestFinished(() => server.close())

  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  knownHosts.trust('127.0.0.1', server.port, server.hostKeyType, server.hostKeyBase64)
  const isLocked = (): boolean => !f.vault.isUnlocked()
  const events: EventContract['run:event'][] = []
  const broker = new PromptBroker({ emit: () => {}, isLocked })
  const links = new ExecLinks({
    resolve: (hostId, environmentId) => resolveHost(f.db, hostId, environmentId, { localUser: 'tester' }),
    hostInfo: (hostId) => {
      const h = hostMeta(f.db, hostId)
      return { label: h.label, keepaliveSec: h.keepaliveSec, envVars: h.envVars }
    },
    connect: connectChain,
    plan: async () => ({
      username: TUNNEL_USER.username,
      kind: 'password',
      notes: [],
      methods: [{ type: 'password', password: TUNNEL_USER.password! }],
    }),
    knownHosts,
    prompts: broker,
    isLocked,
  })
  const snippets = new SnippetStore({ db: f.db, audit: f.audit, vault: f.vault })
  const runs = new RunManager({
    links,
    snippets,
    environments: () => f.envs.list(),
    hosts: () => f.hosts.list(),
    isLocked,
    audit: f.audit,
    emit: (_event, payload) => void events.push(payload),
    ...deps,
  })
  // The same order as src/main/index.ts: runs, then links, then the broker.
  f.vault.onLock(() => runs.vaultLocked())
  f.vault.onLock(() => links.vaultLocked())
  f.vault.onLock(() => broker.cancelAll())
  onTestFinished(() => {
    runs.closeAll()
    links.closeAll()
  })

  const marker = join(sh.dir, 'marker')
  const ids: Record<string, string> = {}
  for (const h of [...STAGING_HOSTS, ...PROD_HOSTS]) {
    ids[h.label] = f.hosts.create({
      label: h.label,
      address: '127.0.0.1',
      port: server.port,
      envVars: { OD_HOST: h.label, MARKER: marker },
    }).id
  }
  const staging = f.envs.create({ name: 'staging', color: '#aabbcc' })
  for (const h of STAGING_HOSTS) f.envs.putHost(staging.id, ids[h.label]!, h.role)
  const prod = f.envs.create({ name: 'prod', color: '#cc0000', protected: true })
  for (const h of PROD_HOSTS) f.envs.putHost(prod.id, ids[h.label]!, h.role)

  const waitFor = <T>(fn: () => T, timeout = 15_000): Promise<T> => vi.waitFor(fn, { timeout, interval: 5 })
  const hostEvents = (runId: string, hostId: string): RunHostState[] =>
    events.flatMap((e) => (e.runId === runId && e.kind === 'host' && e.host.hostId === hostId ? [e.host.state] : []))
  const outputEvents = (runId: string, hostId?: string) =>
    events.flatMap((e) => (e.runId === runId && e.kind === 'output' && (hostId === undefined || e.hostId === hostId) ? [e] : []))
  /** The run once it has left `running`. */
  const finished = (runId: string): Promise<RunSummary> =>
    waitFor(() => {
      const run = runs.get(runId).run
      if (run.state === 'running') throw new Error('still running')
      return run
    })
  const host = (run: RunSummary, label: string): RunHostMeta => {
    const h = runs.get(run.id).run.hosts.find((x) => x.label === label)
    if (!h) throw new Error(`no host ${label}`)
    return h
  }
  /** Waits until `label` is in `state`. */
  const reached = (run: RunSummary, label: string, state: RunHostState): Promise<RunHostMeta> =>
    waitFor(() => {
      const h = host(run, label)
      if (h.state !== state) throw new Error(`${label} is ${h.state}`)
      return h
    })
  /** A path in the shell's tmp dir; a command can wait for it with `gated`. */
  const gate = join(sh.dir, 'gate')
  const openGate = (): void => writeFileSync(gate, '')
  return {
    ...f,
    sh,
    server,
    links,
    broker,
    snippets,
    runs,
    events,
    ids,
    staging,
    prod,
    marker,
    gate,
    openGate,
    maxLive: () => maxLive,
    waitFor,
    hostEvents,
    outputEvents,
    finished,
    host,
    reached,
  }
}

/** A shell loop that waits until the setup's gate file exists (the command runs in the shell's tmp dir). */
export const GATED = 'while [ ! -f gate ]; do sleep 0.02; done'
