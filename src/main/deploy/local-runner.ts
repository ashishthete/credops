import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { CANCEL_GRACE_MS, KILL_GRACE_MS, MAX_LOG_LINE, type PreflightCheck, type RunEventBody, type Tooling } from '../../shared/deploy'
import { redact } from '../security/redact'
import type { PrivateAgent } from './agent'
import { CALLBACK_PLUGIN_SOURCE } from './callback-plugin'
import { EventTranslator, parsePreflight, parseStreamLine } from './events'
import { parseMarker } from './markers'
import { withBase64Forms } from './mask'
import { generateAnsibleCfg, generateInventory, generateKnownHosts, generatePlaybook, generateSshConfig, planSteps, socketPathFits } from './generate'
import type { SshConfigOptions } from './generate'
import type { PreparedHosts } from './hostkeys'
import type { startTap } from './log-tap'
import type { DeployPlan, DeployRunner, RunHandle, RunOutcome, RunSecrets } from './runner'
import { toolingError } from './tooling'
import { uuidv7 } from './uuidv7'

/* Orchestration only: every piece it calls lives in generate / events / agent / hostkeys / log-tap. */

export interface RunChild {
  pid?: number
  stdout: { on(ev: 'data', cb: (c: Buffer | string) => void): unknown }
  stderr: { on(ev: 'data', cb: (c: Buffer | string) => void): unknown }
  on(ev: 'close', cb: (code: number | null, signal: string | null) => void): unknown
  on(ev: 'error', cb: (err: Error) => void): unknown
  kill(signal?: string): boolean
}
export type RunSpawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => RunChild

export interface RunFs {
  /** Creates `<prefix>XXXXXX` with mode 0700 and returns its path. */
  mkdtemp(prefix: string): Promise<string>
  mkdir(path: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  rm(path: string): Promise<void>
}

export interface LocalRunnerDeps {
  tools: () => Promise<Tooling>
  /** Dials and verifies every host chain; the composition root binds its deps (prompts, known hosts, identities). */
  prepare: (plan: DeployPlan, signal: AbortSignal) => Promise<PreparedHosts>
  /** Starts the private agent; the composition root binds the spawn. */
  agent: (o: { dir: string; tools: { sshAgent: string; sshAdd: string }; ttlSec: number }) => Promise<PrivateAgent>
  tap: typeof startTap
  spawn: RunSpawn
  fs: RunFs
  /** Parent of the run dir. Use `/tmp`: the agent socket must fit in 103 bytes, which os.tmpdir() on macOS does not. */
  tmpdir: string
  home: string
  /** The user's own SSH_AUTH_SOCK, handed to ssh_config only for agent / default hops. */
  userAgentSock: string | null
  sshConfig?: SshConfigOptions['sshConfig']
  /** Test-only (Task 8): skip host preparation and taps; the playbook's connection is local. */
  connectionOverride?: 'local'
  now?: () => number
}

interface RunState {
  cancelRequested: boolean
  abort: AbortController
  child: RunChild | null
}

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const MAX_PENDING_LINE = 4 * 1024 * 1024
const cut = (s: string): string => (s.length > MAX_LOG_LINE ? `${s.slice(0, MAX_LOG_LINE - 7)} …(cut)` : s)
const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/'))) || '/'

/** The agent's key lifetime: every timeout the playbook can wait for (each custom step's own), plus 10 minutes. */
export function totalTimeoutSec(plan: DeployPlan): number {
  const sum = plan.deployments.reduce(
    (n, d) => n + d.buildTimeoutSec + 2 * d.composeTimeoutSec + d.healthTimeoutSec + (d.backup ? 1800 : 0) + planSteps(d).reduce((t, p) => t + p.step.timeoutSec, 0) + 5 * 120,
    0,
  )
  return sum + 600
}

/** Splits a byte stream into lines, flushing the remainder at the end. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  const drain = (): void => {
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''))
      buf = buf.slice(i + 1)
    }
    if (buf.length > MAX_PENDING_LINE) {
      onLine(buf)
      buf = ''
    }
  }
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      drain()
    },
    end() {
      buf += decoder.end()
      drain()
      if (buf !== '') onLine(buf.replace(/\r$/, ''))
      buf = ''
    },
  }
}

export class LocalRunner implements DeployRunner {
  private readonly listeners = new Set<(releaseId: string, body: RunEventBody) => void>()
  private readonly runs = new Map<string, RunState>()

  constructor(private readonly o: LocalRunnerDeps) {}

  onEvent(fn: (releaseId: string, body: RunEventBody) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  start(plan: DeployPlan, secrets: RunSecrets): RunHandle {
    const runId = uuidv7()
    const state: RunState = { cancelRequested: false, abort: new AbortController(), child: null }
    this.runs.set(runId, state)
    const done = this.execute(plan, secrets, state).finally(() => this.runs.delete(runId))
    return { runId, done }
  }

  /** SIGINT now, SIGTERM after CANCEL_GRACE_MS, SIGKILL KILL_GRACE_MS later. */
  cancel(runId: string): void {
    const s = this.runs.get(runId)
    if (!s || s.cancelRequested) return
    s.cancelRequested = true
    s.abort.abort()
    // while still preparing there is no child: runAnsible escalates the moment it spawns
    if (s.child) this.escalate(s.child)
  }

  private escalate(child: RunChild): void {
    child.kill('SIGINT')
    let kill: ReturnType<typeof setTimeout> | undefined
    const term = setTimeout(() => {
      child.kill('SIGTERM')
      kill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, CANCEL_GRACE_MS)
    child.on('close', () => {
      clearTimeout(term)
      if (kill) clearTimeout(kill)
    })
  }

  private emit(releaseId: string, body: RunEventBody): void {
    for (const fn of this.listeners) {
      try {
        fn(releaseId, body)
      } catch {
        // a listener must not break the run
      }
    }
  }

  private async execute(plan: DeployPlan, secrets: RunSecrets, state: RunState): Promise<RunOutcome> {
    const o = this.o
    const now = o.now ?? Date.now
    const tools = await o.tools()
    const bad = toolingError(tools)
    if (bad) throw bad
    const ansible = tools.ansiblePlaybook!.path

    const local = o.connectionOverride === 'local'
    // Every mask site below uses `known`: each secret with its base64 forms. The translator adds the forms itself, so it gets `raw`.
    const raw = [...new Set([...secrets.known, ...Object.values(secrets.values)].filter((s) => s !== ''))]
    const known = [...new Set(withBase64Forms(raw))]
    const red = (s: string): string => redact(s, known)

    const outcome: RunOutcome = { exitCode: null, signal: null, cancelled: false, failedDeploymentRunIds: [], reachedCheckout: [], reachedUp: [], commits: {} }
    const reachedUp: string[] = outcome.reachedUp!
    const send = (body: RunEventBody): void => {
      if (body.type === 'deployment.updated') {
        if (body.status === 'failed' && !outcome.failedDeploymentRunIds.includes(body.deploymentRunId)) outcome.failedDeploymentRunIds.push(body.deploymentRunId)
        if (body.previousCommit || body.deployedCommit) {
          const c = (outcome.commits[body.deploymentRunId] ??= {})
          if (body.previousCommit) c.previous = body.previousCommit
          if (body.deployedCommit) c.deployed = body.deployedCommit
        }
      }
      if (body.type === 'step.started' && body.kind === 'checkout' && body.deploymentRunId && !outcome.reachedCheckout.includes(body.deploymentRunId)) outcome.reachedCheckout.push(body.deploymentRunId)
      if (body.type === 'step.started' && body.kind === 'up' && body.deploymentRunId && !reachedUp.includes(body.deploymentRunId)) reachedUp.push(body.deploymentRunId)
      this.emit(plan.releaseId, body)
    }

    const rundir = await o.fs.mkdtemp(join(o.tmpdir, 'od-'))
    let prepared: PreparedHosts | null = null
    let agent: PrivateAgent | null = null
    const taps: { stop(): void }[] = []
    try {
      if (!socketPathFits(rundir)) throw new Error(`The run directory ${rundir} is too long for an ssh socket; use a shorter temp directory`)
      for (const sub of ['callback_plugins', 'cp', 'ah', 'tmp']) await o.fs.mkdir(join(rundir, sub))

      // 3. host keys and links
      const checks: PreflightCheck[] = []
      let effective = plan
      if (!local) {
        prepared = await o.prepare(plan, state.abort.signal)
        checks.push(...prepared.checks)
        const failed = new Set(prepared.checks.map((c) => c.hostId))
        if (failed.size) {
          effective = { ...plan, hosts: plan.hosts.filter((h) => !failed.has(h.hostId)), deployments: plan.deployments.filter((d) => !failed.has(d.hostId)) }
        }
        // a cancel aborts the dials: those "unreachable" checks are noise
        if (state.cancelRequested) return { ...outcome, cancelled: true }
        checks.splice(0, checks.length, ...checks.map((c) => ({ ...c, message: red(c.message) })))
        for (const c of checks) send({ type: 'preflight.check', check: c })
      }
      if (state.cancelRequested) return { ...outcome, cancelled: true }
      if (checks.length && plan.kind !== 'preflight') {
        // the deployments on unreachable hosts failed whatever else happens
        outcome.failedDeploymentRunIds = plan.deployments.filter((d) => checks.some((c) => c.hostId === d.hostId)).map((d) => d.runId)
      }
      if (checks.length && plan.kind === 'release') {
        // a release never runs on part of its hosts; rollback, unlock and the rest run on whoever is reachable
        outcome.exitCode = 1
        return outcome
      }

      // 4. the private agent
      const keys = prepared?.keys ?? []
      if (keys.length) {
        if (!tools.sshAgent || !tools.sshAdd) throw new Error('ssh-agent and ssh-add are needed for key auth but were not found')
        agent = await o.agent({ dir: rundir, tools: { sshAgent: tools.sshAgent, sshAdd: tools.sshAdd }, ttlSec: totalTimeoutSec(plan) })
        for (const k of keys) await agent.add(k)
      }

      // 2. the run files (the ssh_config needs the agent socket and known_hosts needs the prepared keys)
      const write = (name: string, text: string): Promise<void> => o.fs.writeFile(join(rundir, name), text)
      await write('callback_plugins/opsdeck_jsonl.py', CALLBACK_PLUGIN_SOURCE)
      // An edited playbook runs as validated, whole: a play whose host is unreachable matches no inventory host and is skipped.
      await write('playbook.yml', plan.playbookText ?? generatePlaybook(effective))
      await write('inventory', generateInventory(effective))
      await write('known_hosts', generateKnownHosts(prepared?.knownHosts ?? []))
      await write('ssh_config', generateSshConfig(effective, { privateAgent: agent?.sock ?? join(rundir, 'a'), userAgent: prepared?.userAgentNeeded ? o.userAgentSock : null }, rundir, { sshConfig: o.sshConfig }))
      await write('ansible.cfg', generateAnsibleCfg(effective, rundir))

      const translator = new EventTranslator({ plan: effective, secrets: () => raw, now })

      // 5. live log taps
      if (prepared) {
        for (const h of effective.hosts) {
          const link = prepared.links.get(h.hostId)
          if (!link) continue
          taps.push(
            o.tap(
              link,
              plan.releaseId,
              (line) => {
                translator.observeStreamLine(line)
                const s = parseStreamLine(line)
                // a custom step's own status markers settle the step; they are not log text
                if (s && /^c_\d{1,3}$/.test(s.kind) && ['OD-STEP', 'OD-SKIP'].includes(parseMarker(s.text)?.mark ?? '')) return
                const dep = s ? plan.deployments.find((d) => d.runId === s.runId) : undefined
                send({
                  type: 'log',
                  stepId: s ? `${s.runId}:${s.kind}` : null,
                  hostId: dep?.hostId ?? h.hostId,
                  stream: s ? 'out' : 'ansible',
                  line: cut(red(s ? s.text : line)),
                })
              },
              { host: h.label },
            ),
          )
        }
      }

      // 6. ansible
      if (effective.deployments.length > 0 && !state.cancelRequested) {
        const exit = await this.runAnsible(ansible, rundir, tools, secrets, effective, translator, send, red, state)
        outcome.exitCode = exit.code
        outcome.signal = exit.signal
        outcome.cancelled = state.cancelRequested
        // 7. close what never finished
        for (const b of translator.finish(exit.code, exit.signal, state.cancelRequested)) send(b)
        if (plan.kind === 'preflight') outcome.preflight = this.report(effective, translator, checks, known, now)
      } else {
        outcome.cancelled = state.cancelRequested
        outcome.exitCode = state.cancelRequested ? null : outcome.failedDeploymentRunIds.length ? 1 : 0
        if (plan.kind === 'preflight') outcome.preflight = this.report(effective, translator, checks, known, now)
      }
      return outcome
    } catch (err) {
      throw err instanceof Error ? new Error(red(err.message)) : err
    } finally {
      // taps first: closing the link first would make every tap report "unavailable"
      for (const t of taps) swallow(() => t.stop())
      if (prepared) swallow(() => prepared!.close())
      if (agent) await agent.stop().catch(() => {})
      await o.fs.rm(rundir).catch(() => console.warn(`could not remove the deploy run directory ${rundir}`))
    }
  }

  private report(plan: DeployPlan, translator: EventTranslator, extra: PreflightCheck[], known: string[], now: () => number): NonNullable<RunOutcome['preflight']> {
    const r = parsePreflight(plan, translator.preflightOutput(), { now: now(), cut: translator.preflightCut(), errors: translator.preflightErrors(), secrets: known })
    const checks = [...extra, ...r.checks]
    return { ...r, checks, blocked: checks.some((c) => c.level === 'block') }
  }

  private runAnsible(
    ansible: string,
    rundir: string,
    tools: Tooling,
    secrets: RunSecrets,
    plan: DeployPlan,
    translator: EventTranslator,
    send: (b: RunEventBody) => void,
    red: (s: string) => string,
    state: RunState,
  ): Promise<{ code: number | null; signal: string | null }> {
    const o = this.o
    const env: Record<string, string> = {
      PATH: [...new Set([ansible, tools.ssh, tools.sshAgent, tools.sshAdd].flatMap((p) => (p ? [dirOf(p)] : [])).concat(SYSTEM_PATH))].join(':'),
      HOME: o.home,
      LANG: 'en_US.UTF-8',
      ANSIBLE_CONFIG: join(rundir, 'ansible.cfg'),
      ANSIBLE_HOME: join(rundir, 'ah'),
      ANSIBLE_LOCAL_TEMP: join(rundir, 'tmp'),
      ANSIBLE_KEEP_REMOTE_FILES: '0',
      ANSIBLE_NOCOLOR: '1',
      ANSIBLE_FORCE_COLOR: '0',
      PYTHONUNBUFFERED: '1',
      OPSDECK_SECRETS: JSON.stringify(Object.fromEntries(Object.entries(secrets.values).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]))),
    }
    return new Promise((resolve, reject) => {
      let child: RunChild
      try {
        child = o.spawn(ansible, ['-i', join(rundir, 'inventory'), join(rundir, 'playbook.yml')], { cwd: rundir, env })
      } catch (err) {
        return reject(err)
      }
      state.child = child
      const out = lineSplitter((l) => {
        for (const b of translator.feed(l)) send(b)
      })
      const err = lineSplitter((l) => {
        if (l.trim() === '') return
        send({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: cut(red(l)) })
      })
      child.stdout.on('data', (c) => out.push(c))
      child.stderr.on('data', (c) => err.push(c))
      // 'error' after a successful spawn (a failed kill, a stream fault) leaves the process running: wait for 'close'
      // so cleanup never runs under a live ansible. Without a pid nothing was spawned and 'close' may never come.
      child.on('error', (e) => {
        if (child.pid !== undefined) return void send({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: cut(red(`ansible-playbook reported: ${e.message}`)) })
        reject(new Error(`ansible-playbook could not start: ${red(e.message)}`))
      })
      child.on('close', (code, signal) => {
        state.child = null
        out.end()
        err.end()
        resolve({ code, signal })
      })
      if (state.cancelRequested) this.escalate(child)
    })
  }
}

function swallow(fn: () => void): void {
  try {
    fn()
  } catch {
    // cleanup is best effort
  }
}

export interface NodeSpawnDeps {
  spawn: (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] }) => RunChild
  /** `process.kill`. A negative pid signals the whole process group. */
  kill: (pid: number, signal: string) => void
}

/**
 * Production spawn. The child leads its own process group (`detached`), and `kill` signals that group, so a
 * cancel reaches ansible's fork workers and their ssh children instead of orphaning them.
 */
export function nodeSpawn(deps: NodeSpawnDeps): RunSpawn {
  return (file, args, opts) => {
    const child = deps.spawn(file, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return {
      get pid() {
        return child.pid
      },
      stdout: child.stdout,
      stderr: child.stderr,
      on: ((ev: string, cb: never) => void (child.on as (e: string, c: never) => unknown)(ev, cb)) as RunChild['on'],
      kill: (signal = 'SIGTERM') => {
        const pid = child.pid
        if (pid === undefined) return child.kill(signal)
        try {
          deps.kill(-pid, signal)
          return true
        } catch {
          return child.kill(signal)
        }
      },
    }
  }
}

/** The real filesystem for production wiring. */
export const nodeFs: RunFs = {
  mkdtemp: (prefix) => import('node:fs/promises').then((f) => f.mkdtemp(prefix)),
  mkdir: (path) => import('node:fs/promises').then((f) => f.mkdir(path, { mode: 0o700 }).then(() => undefined)),
  writeFile: (path, data) => import('node:fs/promises').then((f) => f.writeFile(path, data, { mode: 0o600 })),
  rm: (path) => import('node:fs/promises').then((f) => f.rm(path, { recursive: true, force: true })),
}
