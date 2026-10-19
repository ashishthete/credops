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
