import type { HubEnvManifest } from '../../src/shared/hub'

export const ENV_ID = 'e1111111-1111-4111-8111-111111111111'
export const HOST_ID = 'a1111111-1111-4111-8111-111111111111'
export const JUMP_ID = 'a2222222-2222-4222-8222-222222222222'
export const DEP_WEB = 'd1111111-1111-4111-8111-111111111111'
export const DEP_API = 'd2222222-2222-4222-8222-222222222222'
export const SECRET_DB = '51111111-1111-4111-8111-111111111111'
export const SECRET_SUDO = '52222222-2222-4222-8222-222222222222'
export const KEY_LINE = 'prod.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHhwdJ0qF1yq6dQ1m0m3m2g8pQ5r4d9n2c0v1b7x8k3L'

export function deployment(id: string, name: string, over: Record<string, unknown> = {}): HubEnvManifest['deployments'][number] {
  return {
    id,
    name,
    environmentId: ENV_ID,
    hostId: HOST_ID,
    appId: null,
    repoPath: `/srv/${name}`,
    defaultBranch: 'main',
    composeFile: 'docker-compose.yml',
    deployTag: name,
    position: 0,
    urls: [],
    healthStatus: 200,
    healthTimeoutSec: 60,
    dbBackup: false,
    backupDir: null,
    preHook: null,
    postHook: null,
    buildTimeoutSec: 300,
    composeTimeoutSec: 120,
    useSudo: 'auto',
    becomeSecretId: null,
    managedEnv: false,
    envTemplate: null,
    ...over,
  } as HubEnvManifest['deployments'][number]
}

export function manifest(over: Partial<HubEnvManifest> = {}): HubEnvManifest {
  return {
    environment: { id: ENV_ID, name: 'prod', protected: true, versioned: true, autoRollback: false, currentVersion: 'v1.2.3' },
    hosts: [
      {
        id: HOST_ID,
        label: 'web-1',
        address: '10.0.0.5',
        port: 22,
        username: 'deploy',
        useSudo: 'auto',
        hops: [
          { hostId: JUMP_ID, label: 'bastion', address: '203.0.113.9', port: 2222, username: 'jump' },
          { hostId: HOST_ID, label: 'web-1', address: '10.0.0.5', port: 22, username: 'deploy' },
        ],
        knownHosts: [KEY_LINE],
      },
    ],
    apps: [],
    deployments: [
      deployment(DEP_WEB, 'web', { envTemplate: `DB_PASSWORD=\${secret:${SECRET_DB}}\n`, becomeSecretId: SECRET_SUDO }),
      deployment(DEP_API, 'api', { position: 1 }),
    ],
    integrations: { notifyEvents: [], emailTo: [], emailCc: [], qaOnDeploy: false, qa: null, qaWait: false },
    requiredSecrets: [
      { secretId: SECRET_DB, name: 'DB_PASSWORD', usedBy: ['web'] },
      { secretId: SECRET_SUDO, name: 'sudo', usedBy: ['web'] },
    ],
    ...over,
  }
}
