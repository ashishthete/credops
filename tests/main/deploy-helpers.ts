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
