import { generateKeyPairSync } from 'node:crypto'
import { SecretStore } from '../../src/main/vault/secret-store'
import { SnippetStore } from '../../src/main/ops/snippet-store'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeDeployFixture, type DeployFixture } from './deploy-helpers'
import { REGION } from './inventory-helpers'

/** Fixture secret values: none of them may appear anywhere in an export. */
export const SECRET_VALUES = {
  envSecret: 'sekret-value-1', // the deploy fixture's `envsecret`
  dotenv: 'dotenv-db-pass-3Xz8',
  become: 'become-pw-7Hq2',
  passphrase: 'key-passphrase-9Lm4',
  identityPassword: 'id-password-4Rt6',
  snippetScript: 'snippet-script-body-5Kp1',
}

/** Text that only lives in release state, history or snippets: it must not appear in an export either. */
export const NOT_CONFIG = {
  releaseNotes: 'release-notes-marker-1',
  runHostLabel: 'run-host-label-marker-2',
  eventLine: 'run-event-line-marker-3',
  knownHostKey: 'AAAAknown-host-key-marker-4',
  snippetLabel: 'snippet-label-marker-5',
  currentVersion: 'v9.8.7',
  deployedCommit: 'c0ffee1234567890c0ffee1234567890c0ffee12',
}

export type ConfigFixture = DeployFixture & {
  teamVaultId: string
  privateKey: string
  ids: {
    product: string
    keyIdentity: string
    passwordIdentity: string
    bastion: string
    tunnel: string
    deployment: string
    appService: string
    dbService: string
    becomeSecret: string
    dotenvSecret: string
    snippet: string
  }
}

/** Every config kind, plus secrets, release state and history that an export must leave out. */
export async function makeConfigFixture(): Promise<ConfigFixture> {
  const f = await makeDeployFixture()
  const team = f.vault.createVault({ name: 'Team', color: '#22aa66' })
  const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const become = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'sudo-pw', kind: 'password', value: SECRET_VALUES.become })
  const dotenv = secrets.create({ vaultId: team.id, name: 'db-pass', kind: 'env', value: SECRET_VALUES.dotenv })

  const privateKey = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: SECRET_VALUES.passphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
  const key = f.keys.import({ vaultId: team.id, label: 'deploy-key', privateKey, passphrase: SECRET_VALUES.passphrase })
  const keyIdentity = f.identities.create({ vaultId: team.id, label: 'deployer', username: 'deploy', auth: 'key', sshKeyId: key.id })
  const passwordIdentity = f.identities.create({
    vaultId: DEFAULT_VAULT_ID,
    label: 'root-login',
    username: 'root',
    auth: 'password',
    password: SECRET_VALUES.identityPassword,
  })

  const product = f.products.create({ name: 'Shop', color: '#3366ff', icon: 'rocket', description: 'The shop', repoUrl: 'git@example.com:shop.git' })
  f.envs.setProduct(f.staging.id, product.id)
  f.envs.update(f.staging.id, { defaultIdentityId: keyIdentity.id, defaultPort: 2222, domain: 'staging.example.com' })
  const bastion = f.hosts.create({ regionId: REGION, label: 'bastion', address: 'bastion.example.com', port: 22, tags: ['edge', 'ssh'], osIcon: 'linux' })
  f.envs.putHost(f.staging.id, bastion.id, 'bastion')
  f.hosts.update(f.host.id, {
    jumpHostId: bastion.id,
    identityId: passwordIdentity.id,
    tags: ['web', 'api'],
    notes: 'primary app box',
    keepaliveSec: 30,
    envVars: { LANG: 'C.UTF-8' },
  })
  f.hosts.setVaults(f.host.id, [team.id, DEFAULT_VAULT_ID])
  const tunnel = f.tunnels.create({ label: 'pg', hostId: f.host.id, environmentId: f.staging.id, type: 'L', bindPort: 15432, targetHost: '127.0.0.1', targetPort: 5432 })

  const template = [
    '# managed',
    `DB_PASSWORD=\${secret:${dotenv.id}}`,
    'APP_ENV=staging',
    `API_TOKEN=\${secret:${f.secretId}}`,
    `DB_PASSWORD_COPY=\${secret:${dotenv.id}}`,
    '',
  ].join('\n')
  const deployment = f.deploys.create(
    f.input({
      becomeSecretId: become.id,
      managedEnv: true,
      envTemplate: template,
      vaultIds: [DEFAULT_VAULT_ID, team.id],
      urls: [{ url: 'https://staging.example.com/health', from: 'mac' }],
      dbBackup: true,
      backupDir: '/srv/backups',
      preHook: 'echo pre',
      useSudo: 'yes',
    }),
  )
  const appService = f.services.create({ kind: 'service', environmentId: f.staging.id, name: 'web', deploymentId: deployment.id, url: 'https://staging.example.com', urlCheckFrom: 'mac' })
  const dbService = f.services.create({ kind: 'db', environmentId: f.staging.id, name: 'main-db', dbEngine: 'postgres', dbAddress: '10.0.0.9', hostId: f.host.id, localPort: 15432 })
  // app1 joined staging with a placeholder app; it runs real services now, so drop the placeholder. Prod keeps its
  // own (that is how app1 is in prod) and staging keeps the bastion's.
  f.db.prepare("DELETE FROM services WHERE environment_id = ? AND host_id = ? AND name = 'app1'").run(f.staging.id, f.host.id)
  f.services.setTunnel(dbService.id, tunnel.id, 15432)

  const snippets = new SnippetStore({ db: f.db, audit: f.audit, vault: f.vault })
  const snippet = snippets.create({ label: NOT_CONFIG.snippetLabel, script: `echo ${SECRET_VALUES.snippetScript}` })

  // Release state and history, written directly: only their absence from the export matters here.
  f.deploys.updateSettings(f.staging.id, { versioned: true, autoRollback: false, currentVersion: NOT_CONFIG.currentVersion })
  const releaseId = '0190a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa'
  const at = '2026-01-01T00:00:00.000Z'
  f.db
    .prepare(`INSERT INTO releases(id, environment_id, kind, status, release_notes, triggered_by, created_at) VALUES (?, ?, 'release', 'succeeded', ?, 'u@m', ?)`)
    .run(releaseId, f.staging.id, NOT_CONFIG.releaseNotes, at)
  f.db
    .prepare(`INSERT INTO deployment_runs(id, release_id, deployment_id, deployment_name, host_id, host_label, position, branch, status) VALUES (?, ?, ?, 'api', ?, ?, 0, 'main', 'succeeded')`)
    .run('0190a1b2-c3d4-7e5f-8a6b-bbbbbbbbbbbb', releaseId, deployment.id, f.host.id, NOT_CONFIG.runHostLabel)
  f.db
    .prepare(`INSERT INTO run_events(id, release_id, seq, at, type, payload) VALUES (?, ?, 1, ?, 'log', ?)`)
    .run('0190a1b2-c3d4-7e5f-8a6b-cccccccccccc', releaseId, at, JSON.stringify({ line: NOT_CONFIG.eventLine }))
  f.db
    .prepare(`INSERT INTO known_hosts(id, host, key_type, key, fingerprint, first_seen, last_seen) VALUES (?, '10.0.0.7', 'ssh-ed25519', ?, 'SHA256:x', ?, ?)`)
    .run('0190a1b2-c3d4-7e5f-8a6b-dddddddddddd', NOT_CONFIG.knownHostKey, at, at)
  f.services.recordDeployed([{ serviceId: appService.id, commit: NOT_CONFIG.deployedCommit, releaseId }])

  return {
    ...f,
    teamVaultId: team.id,
    privateKey,
    ids: {
      product: product.id,
      keyIdentity: keyIdentity.id,
      passwordIdentity: passwordIdentity.id,
      bastion: bastion.id,
      tunnel: tunnel.id,
      deployment: deployment.id,
      appService: appService.id,
      dbService: dbService.id,
      becomeSecret: become.id,
      dotenvSecret: dotenv.id,
      snippet: snippet.id,
    },
  }
}
