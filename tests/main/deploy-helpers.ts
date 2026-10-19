import type { DeployPlan, PlanDeployment, PlanHop } from '../../src/main/deploy/runner'
import { DeployStore, dbSecretRefs } from '../../src/main/deploy/deploy-store'
import { ReleaseStore } from '../../src/main/deploy/release-store'
import type { DeploymentInput } from '../../src/shared/deploy'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeInventory, type InventoryFixture } from './inventory-helpers'

export type DeployFixture = InventoryFixture & {
  staging: { id: string }
  prod: { id: string }
  host: { id: string }
  secretId: string
  deploys: DeployStore
  releases: ReleaseStore
  changed: string[]
  /** A valid input for staging/app1; override fields per test. */
  input(over?: Partial<DeploymentInput>): DeploymentInput
}

/** Inventory plus env staging, protected env prod, host app1 in both, a vault secret, and the deploy stores. */
export async function makeDeployFixture(opts: { maxEvents?: number } = {}): Promise<DeployFixture> {
  const f = await makeInventory()
  const staging = f.envs.create({ name: 'staging', color: '#112233' })
  const prod = f.envs.create({ name: 'prod', color: '#aa0000', protected: true })
  const host = f.hosts.create({ label: 'app1', address: '10.0.0.7' })
  f.envs.putHost(staging.id, host.id, 'app')
  f.envs.putHost(prod.id, host.id, 'app')
  const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const secret = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'envsecret', kind: 'env', value: 'sekret-value-1' })
  const changed: string[] = []
  const deploys = new DeployStore({ db: f.db, audit: f.audit, vault: f.vault, secrets: dbSecretRefs(f.db) })
  deploys.onChanged = (environmentId) => changed.push(environmentId)
  const releases = new ReleaseStore({ db: f.db, maxEvents: opts.maxEvents })
  return {
    ...f,
    staging,
    prod,
    host,
    secretId: secret.id,
    deploys,
    releases,
    changed,
    input: (over = {}) => ({
      name: 'api',
      environmentId: staging.id,
      hostId: host.id,
      repoPath: '/srv/app',
      defaultBranch: 'main',
      deployTag: 'deploy_staging',
      ...over,
    }),
  }
}

// ---- Pure plan fixture (Task 3): no database, no secrets, only references ----

export const FIX = {
  repo: '/srv/apps/alpha',
  branch: 'release-2026',
  tag: 'deploy_prod_x',
  compose: 'deploy/compose.yml',
  hook: `echo '{{ 7*7 }}' "$(id)" ; echo done`,
  releaseId: '0190a1b2-c3d4-7e5f-8a6b-1234567890ab',
}

const hop = (alias: string, over: Partial<PlanHop> = {}): PlanHop => ({
  alias,
  hostId: `host-${alias}`,
  label: `label ${alias}`,
  address: `10.0.0.${alias.slice(3)}${alias === 'od-0' ? '0' : ''}`,
  port: 22,
  user: 'deploy',
  auth: 'key',
  ...over,
})

export function depFixture(n: number, hostId: string, over: Partial<PlanDeployment> = {}): PlanDeployment {
  return {
    runId: `0190a1b2-c3d4-7e5f-8a6b-00000000000${n}`,
    deploymentId: `dep-${n}`,
    name: `dep${n}`,
    hostId,
    repoPath: `${FIX.repo}${n}`,
    branch: FIX.branch,
    composeFile: FIX.compose,
    deployTag: FIX.tag,
    urls: [],
    healthStatus: 200,
    healthTimeoutSec: 60,
    backup: null,
    preHookB64: null,
    postHookB64: null,
    buildTimeoutSec: 300,
    composeTimeoutSec: 120,
    docker: 'plain',
    envSecretKey: null,
    becomeSecretKey: null,
    previousCommit: null,
    useSudo: 'auto',
    ...over,
  }
}

/** Two hosts behind one bastion, three deployments; dep 1 uses every optional feature. */
export function planFixture(over: Partial<DeployPlan> = {}): DeployPlan {
  const bastion = hop('od-0', { auth: 'agent', hostId: null })
  const a = hop('od-1', { auth: 'key' })
  const b = hop('od-2', { auth: 'default' })
  return {
    releaseId: FIX.releaseId,
    kind: 'release',
    environment: { id: 'env-1', name: 'prod east' },
    version: 'v1.2.3',
    actor: { osUser: 'ana', machine: 'mbp' },
    hosts: [
      { hostId: a.hostId!, label: a.label, alias: 'od-1', hops: [bastion, a] },
      { hostId: b.hostId!, label: b.label, alias: 'od-2', hops: [bastion, b] },
    ],
    deployments: [
      depFixture(1, a.hostId!, {
        urls: [{ url: 'https://app.example.com/health', from: 'mac' }],
        backup: { dir: '/var/backups/app', label: 'alpha' },
        preHookB64: Buffer.from(FIX.hook).toString('base64'),
        postHookB64: Buffer.from('echo post').toString('base64'),
        docker: 'sudo-password',
        envSecretKey: 'env_1',
        becomeSecretKey: 'become_1',
        previousCommit: 'a'.repeat(40),
      }),
      depFixture(2, a.hostId!, { urls: [{ url: 'http://127.0.0.1:8080/up', from: 'host' }], docker: 'sudo', previousCommit: 'b'.repeat(40) }),
      depFixture(3, b.hostId!, { previousCommit: 'c'.repeat(40) }),
    ],
    secretRefs: { env_1: { envTemplate: { deploymentId: 'dep-1' } }, become_1: { secretId: 'sec-1' } },
    lock: {},
    startedAt: '2026-10-19T10:00:00.000Z',
    ...over,
  }
}

// ---- LocalRunner fakes (Task 6) ----

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'ssh2'
import type { PrivateAgent } from '../../src/main/deploy/agent'
import type { PreparedHosts } from '../../src/main/deploy/hostkeys'
import type { RunChild, RunSpawn } from '../../src/main/deploy/local-runner'
import type { PreflightCheck, Tooling } from '../../src/shared/deploy'

export const FIXTURE_DIR = join(__dirname, 'fixtures/ansible')
export const fixtureLines = (file: string): string[] => readFileSync(join(FIXTURE_DIR, file), 'utf8').split('\n').filter((l) => l !== '')

export const TOOLS_OK: Tooling = {
  ansiblePlaybook: { path: '/opt/homebrew/bin/ansible-playbook', version: '2.18.6' },
  ansibleStatus: 'ok',
  sshAgent: '/usr/bin/ssh-agent',
  sshAdd: '/usr/bin/ssh-add',
  ssh: '/usr/bin/ssh',
  problems: [],
}

export interface SpawnCall {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** Replays JSON lines as ansible-playbook's stdout. Never runs a process. */
export class FakeAnsible {
  calls: SpawnCall[] = []
  stdout: string[] = []
  stderr: string[] = []
  exit: { code: number | null; signal: string | null } = { code: 0, signal: null }
  /** Runs at spawn time, while the run dir still exists. */
  onSpawn: ((call: SpawnCall) => void) | null = null
  /** The child never exits by itself; only a signal that is not ignored ends it. */
  hang = false
  ignore = new Set<string>()
  kills: string[] = []
  private closeChild: (() => void) | null = null

  spawn: RunSpawn = (file, args, opts) => {
    const call = { file, args, cwd: opts.cwd, env: opts.env }
    this.calls.push(call)
    this.onSpawn?.(call)
    const handlers: Record<string, ((...a: never[]) => void)[]> = {}
    const out: ((c: string) => void)[] = []
    const err: ((c: string) => void)[] = []
    const emit = (ev: string, ...a: unknown[]): void => (handlers[ev] ?? []).forEach((h) => (h as (...x: unknown[]) => void)(...a))
    let closed = false
    const close = (code: number | null, signal: string | null): void => {
      if (closed) return
      closed = true
      emit('close', code, signal)
    }
    this.closeChild = () => close(this.exit.code, this.exit.signal)
    const child: RunChild = {
      stdout: { on: (_e, cb) => void out.push(cb as never) },
      stderr: { on: (_e, cb) => void err.push(cb as never) },
      on: ((ev: string, cb: never) => void (handlers[ev] ??= []).push(cb)) as RunChild['on'],
      kill: (sig = 'SIGTERM') => {
        this.kills.push(sig)
        if (!this.ignore.has(sig)) Promise.resolve().then(() => close(null, sig))
        return true
      },
    }
    Promise.resolve().then(() => {
      for (const l of this.stdout) out.forEach((cb) => cb(`${l}\n`))
      for (const l of this.stderr) err.forEach((cb) => cb(`${l}\n`))
      if (!this.hang) close(this.exit.code, this.exit.signal)
    })
    return child
  }
}

type AgentStart = { dir: string; ttlSec: number }
type AgentKey = { privateKey: string; passphrase?: string }

export function fakeAgent() {
  const state = { started: [] as AgentStart[], added: [] as AgentKey[], stops: 0 }
  const fn = async (o: { dir: string; tools: { sshAgent: string; sshAdd: string }; ttlSec: number }): Promise<PrivateAgent> => {
    state.started.push({ dir: o.dir, ttlSec: o.ttlSec })
    return { sock: join(o.dir, 'a'), add: async (m: AgentKey) => void state.added.push(m), stop: async () => void state.stops++ } as PrivateAgent
  }
  return {
    fn,
    get started() { return state.started },
    get added() { return state.added },
    get stops() { return state.stops },
  }
}

export function fakeTap() {
  const taps: { link: unknown; releaseId: string; onLine: (l: string) => void; host?: string; stopped: boolean }[] = []
  const fn = (link: unknown, releaseId: string, onLine: (l: string) => void, opts: { host?: string } = {}) => {
    const t = { link, releaseId, onLine, host: opts.host, stopped: false }
    taps.push(t)
    return { stop: () => void (t.stopped = true) }
  }
  return { fn: fn as never, taps }
}

export function fakePrepare(opts: { checks?: PreflightCheck[]; keys?: PreparedHosts['keys']; userAgentNeeded?: boolean; throws?: Error; hostKeys?: PreparedHosts['knownHosts'] } = {}) {
  const log = { calls: 0, closed: 0, order: [] as string[] }
  const fn = async (plan: DeployPlan): Promise<PreparedHosts> => {
    log.calls++
    if (opts.throws) throw opts.throws
    const failed = new Set((opts.checks ?? []).map((c) => c.hostId))
    const links = new Map<string, Client>(plan.hosts.filter((h) => !failed.has(h.hostId)).map((h) => [h.hostId, { fake: h.hostId } as unknown as Client]))
    return {
      knownHosts: opts.hostKeys ?? [{ token: '10.0.0.1', keyType: 'ssh-ed25519', keyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIAAA' }],
      links,
      keys: opts.keys ?? [],
      userAgentNeeded: opts.userAgentNeeded ?? false,
      checks: opts.checks ?? [],
      close: () => void log.closed++,
    }
  }
  return { fn, log }
}

import type { RunFs } from '../../src/main/deploy/local-runner'

/** In-memory RunFs: no disk, and `files` can be snapshotted mid-run. */
export function memFs(): RunFs & { dirs: Set<string>; files: Map<string, string>; removed: string[] } {
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const removed: string[] = []
  let n = 0
  return {
    dirs,
    files,
    removed,
    async mkdtemp(prefix) {
      const d = `${prefix}t${String(++n).padStart(5, '0')}`
      dirs.add(d)
      return d
    },
    async mkdir(p) {
      dirs.add(p)
    },
    async writeFile(p, data) {
      files.set(p, data)
    },
    async rm(p) {
      removed.push(p)
      for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
      for (const f of [...files.keys()]) if (f.startsWith(`${p}/`)) files.delete(f)
    },
  }
}
