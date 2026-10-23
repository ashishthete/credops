import { vi } from 'vitest'
import type { AuditEvent } from '../../src/shared/audit'
import type { DeploymentMeta, EnvDeploySettings, Tooling } from '../../src/shared/deploy'
import type { EnvironmentMeta, HostMeta, ProductMeta, RegionMeta } from '../../src/shared/inventory'
import type { AppServiceMeta, DbServiceMeta } from '../../src/shared/services'
import type { AppInfo } from '../../src/shared/ipc'
import type { SessionMeta } from '../../src/shared/ssh'
import type { TunnelMeta, TunnelRuntime } from '../../src/shared/tunnels'
import { DEFAULT_VAULT_ID, type IdentityMeta, type VaultMeta, type VaultStatus } from '../../src/shared/vault'

export const appInfo: AppInfo = {
  version: '0.1.0',
  platform: 'darwin',
  userDataPath: '/tmp/credops',
  actor: { osUser: 'tester', machine: 'mac' },
}

export function auditEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 1,
    ts: '2026-10-16T09:30:00.000Z',
    action: 'app.start',
    outcome: 'success',
    actorOsUser: 'tester',
    actorMachine: 'mac',
    targetType: null,
    targetId: null,
    targetLabel: null,
    details: {},
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    ...over,
  }
}

export function vaultStatus(over: Partial<VaultStatus> = {}): VaultStatus {
  return {
    setUp: true,
    unlocked: false,
    quickUnlock: 'off',
    quickUnlockAvailable: { touchId: true, login: false },
    autoLockMinutes: 15,
    retryAfterMs: 0,
    corruptVaultIds: [],
    hasPassword: true,
    pin: { enabled: false, attemptsLeft: 5 },
    lastMethod: null,
    resetRequired: false,
    touchIdNeedsReenable: false,
    sso: { required: false },
    ...over,
  }
}

export const defaultVault: VaultMeta = {
  id: DEFAULT_VAULT_ID,
  name: 'Default',
  color: '#5b8cff',
  isDefault: true,
  counts: { secrets: 0, keys: 0, identities: 0 },
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T09:00:00.000Z',
}

const STAMP = '2026-10-16T09:00:00.000Z'

export function product(over: Partial<ProductMeta> & { id: string; name: string }): ProductMeta {
  return {
    color: '#5b8cff',
    icon: 'boxes',
    description: '',
    repoUrl: null,
    environmentIds: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

export function environment(over: Partial<EnvironmentMeta> & { id: string; name: string }): EnvironmentMeta {
  return {
    color: '#2fbf71',
    protected: false,
    defaultIdentityId: null,
    defaultPort: null,
    defaultJumpHostId: null,
    domain: null,
    productId: 'none',
    hosts: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

/** The one region mockBridge lists by default; host() puts hosts in it. */
export const REGION: RegionMeta = {
  id: 'region-1',
  code: 'test-1',
  provider: '',
  displayName: 'Test',
  hostCount: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
}

export function host(over: Partial<HostMeta> & { id: string; label: string }): HostMeta {
  return {
    regionId: REGION.id,
    address: `${over.label}.example.com`,
    port: null,
    identityId: null,
    jumpHostId: null,
    tags: [],
    osIcon: 'linux',
    notes: '',
    keepaliveSec: null,
    envVars: {},
    vaultIds: [],
    environments: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

/** Installs window.credops with per-channel results; returns the invoke mock. */
export function mockBridge(results: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel in results) return results[channel]
    if (channel === 'app:info') return appInfo
    if (channel === 'audit:list') return []
    if (channel === 'vault:status') return vaultStatus()
    if (channel === 'vault:list') return [defaultVault]
    if (channel === 'secret:list' || channel === 'key:list' || channel === 'identity:list') return []
    if (channel === 'product:list' || channel === 'env:list' || channel === 'host:list') return []
    if (channel === 'region:list') return [REGION]
    if (channel === 'tunnel:list' || channel === 'tunnel:status') return []
    if (channel === 'runs:list' || channel === 'snippets:list') return []
    if (channel === 'deploy:list' || channel === 'service:list') return []
    if (channel === 'release:list' || channel === 'release:active') return []
    return null
  })
  bridgeListeners.clear()
  const on = (event: string, listener: (payload: unknown) => void) => {
    const set = bridgeListeners.get(event) ?? new Set()
    set.add(listener)
    bridgeListeners.set(event, set)
    return () => {
      set.delete(listener)
    }
  }
  ;(window as unknown as { credops: unknown }).credops = { invoke, on }
  return invoke
}

const bridgeListeners = new Map<string, Set<(payload: unknown) => void>>()

/** Delivers a main-process push event to whatever subscribed through the mock bridge. */
export function emitBridgeEvent(event: string, payload: unknown) {
  bridgeListeners.get(event)?.forEach((l) => l(payload))
}

export function tunnelMeta(over: Partial<TunnelMeta> & { id: string }): TunnelMeta {
  return {
    label: over.id,
    hostId: 'h1',
    environmentId: null,
    type: 'L',
    bindAddress: '127.0.0.1',
    bindPort: 5433,
    targetHost: 'localhost',
    targetPort: 5432,
    autoStart: false,
    autoReconnect: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

export function tunnelRuntime(over: Partial<TunnelRuntime> & { id: string }): TunnelRuntime {
  return {
    state: 'up',
    error: null,
    failures: 0,
    maxFailures: 5,
    retryAt: null,
    boundAddress: '127.0.0.1',
    boundPort: 5433,
    liveness: 'probe',
    startedAt: STAMP,
    upAt: STAMP,
    lastProbeAt: null,
    ...over,
  }
}

/** An SSH session, ready by default. */
export function session(over: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    kind: 'ssh',
    hostId: 'h1',
    environmentId: null,
    label: over.id,
    color: null,
    state: 'ready',
    hops: [],
    error: null,
    openedAt: STAMP,
    readyAt: null,
    closedAt: null,
    attempt: 1,
    container: null,
    ...over,
  }
}

export function identity(over: Partial<IdentityMeta> & { id: string; label: string }): IdentityMeta {
  return {
    vaultId: DEFAULT_VAULT_ID,
    username: 'deploy',
    auth: 'agent',
    sshKeyId: null,
    hasPassword: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

export function deploymentMeta(over: Partial<DeploymentMeta> & { id: string }): DeploymentMeta {
  return {
    name: over.id,
    environmentId: 'e1',
    hostId: 'h1',
    repoUrl: null,
    composeProject: null,
    repoPath: '/srv/app',
    defaultBranch: 'main',
    composeFile: 'docker-compose.yml',
    deployTag: 'deployed-staging',
    position: 0,
    urls: [],
    healthStatus: 200,
    healthTimeoutSec: 60,
    dbBackup: false,
    backupDir: null,
    preHook: null,
    postHook: null,
    steps: [],
    buildTimeoutSec: 300,
    composeTimeoutSec: 120,
    useSudo: 'auto',
    becomeSecretId: null,
    managedEnv: false,
    envTemplate: null,
    vaultIds: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

export function envSettings(over: Partial<EnvDeploySettings> = {}): EnvDeploySettings {
  return { environmentId: 'e1', versioned: true, autoRollback: false, currentVersion: 'v1.2.0', parallelPrepare: true, prepareCap: 3, flow: null, ...over }
}

export function toolingOk(over: Partial<Tooling> = {}): Tooling {
  return {
    ansiblePlaybook: { path: '/opt/homebrew/bin/ansible-playbook', version: '2.17.0' },
    ansibleStatus: 'ok',
    sshAgent: '/usr/bin/ssh-agent',
    sshAdd: '/usr/bin/ssh-add',
    ssh: '/usr/bin/ssh',
    problems: [],
    ...over,
  }
}

export function appService(over: Partial<AppServiceMeta> & { id: string; name: string }): AppServiceMeta {
  return {
    kind: 'service',
    environmentId: 'e1',
    position: 0,
    description: '',
    deploymentId: 'd1',
    composeService: over.name,
    url: null,
    urlCheckFrom: 'mac',
    lastDeployedCommit: null,
    lastReleaseId: null,
    skipUnchanged: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

export function dbService(over: Partial<DbServiceMeta> & { id: string; name: string }): DbServiceMeta {
  return {
    kind: 'db',
    environmentId: 'e1',
    position: 0,
    description: '',
    dbEngine: 'postgres',
    dbAddress: '10.0.0.5',
    dbPort: 5432,
    viaHostId: null,
    localPort: null,
    tunnelId: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}
