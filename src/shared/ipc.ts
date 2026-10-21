import type { AuditEvent, AuditFilter, ChainVerification } from './audit'
import type { ConfigCounts } from './config-file'
import type {
  AccessTarget,
  GrantScope,
  HubAction,
  HubAuditEvent,
  HubAuditFilter,
  HubCatalogEnv,
  HubDeployKey,
  HubEnvLock,
  HubSecretKind,
  HubSecretMeta,
  HubDecision,
  HubGroup,
  HubPublishResult,
  HubRole,
  HubStatus,
  HubUser,
} from './hub'
import type {
  EnvironmentInput,
  EnvironmentMeta,
  EnvironmentPatch,
  HostInput,
  HostMeta,
  HostPatch,
  HostRole,
  ProductInput,
  ProductMeta,
  ProductPatch,
  ResolvedHost,
  SshImportPreview,
  SshImportRequest,
  SshImportResult,
} from './inventory'
import type {
  ContainerAction,
  ContainerList,
  ContainerLogEvent,
  RunEvent,
  RunOutput,
  RunRequest,
  RunSummary,
  SnippetInput,
  SnippetMeta,
} from './ops'
import type {
  DeploymentInput,
  DeploymentMeta,
  Tooling,
  DeploymentPatch,
  EnvDeploySettings,
  EnvDeploySettingsPatch,
  BreakLockConfirm,
  PreflightRequest,
  ReleaseConfirm,
  ReleaseDetail,
  ReleaseListFilter,
  ReleaseSummary,
  RunEvent as DeployRunEvent,
} from './deploy'
import type { CopyServicesRequest, CopyServicesResult, ServiceInput, ServiceMeta, ServicePatch, ServiceUpdateResult } from './services'
import type { TunnelEvent, TunnelInput, TunnelMeta, TunnelPatch, TunnelRuntime, TunnelStats } from './tunnels'
import type {
  KnownHostMeta,
  OpenLocalRequest,
  OpenSshRequest,
  PromptAnswer,
  SessionMeta,
  SessionPrompt,
} from './ssh'
import type {
  IdentityInput,
  IdentityMeta,
  IdentityPatch,
  KeyGenerateInput,
  KeyImportInput,
  KeyLinkInput,
  LocalKeyCandidate,
  LockReason,
  QuickUnlockMode,
  SecretInput,
  SecretMeta,
  SecretPatch,
  SshKeyMeta,
  UnlockResult,
  VaultInput,
  VaultMeta,
  VaultStatus,
} from './vault'

// Mirrors Platform the renderer tsconfig has no node types.
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

export interface AppInfo {
  version: string
  platform: Platform
  userDataPath: string
  actor: { osUser: string; machine: string }
}

export interface IpcContract {
  'app:info': { args: []; result: AppInfo }
  'audit:list': { args: [filter: AuditFilter]; result: AuditEvent[] }
  'audit:verify': { args: []; result: ChainVerification }
  'audit:exportCsv': { args: [filter: AuditFilter]; result: { path: string } | null }
  'vault:status': { args: []; result: VaultStatus }
  'vault:setup': { args: [password: string]; result: VaultStatus }
  'vault:unlock': { args: [password: string]; result: UnlockResult }
  'vault:unlockQuick': { args: []; result: UnlockResult }
  'vault:lock': { args: []; result: void }
  'vault:changePassword': { args: [current: string, next: string]; result: UnlockResult }
  'vault:list': { args: []; result: VaultMeta[] }
  'vault:create': { args: [input: VaultInput]; result: VaultMeta }
  'vault:update': { args: [id: string, patch: Partial<VaultInput>]; result: VaultMeta }
  'vault:delete': { args: [id: string]; result: void }
  'vault:setQuickUnlock': { args: [mode: QuickUnlockMode]; result: VaultStatus }
  'vault:setAutoLock': { args: [minutes: number | null]; result: VaultStatus }
  'secret:list': { args: [vaultId?: string]; result: SecretMeta[] }
  'secret:create': { args: [input: SecretInput]; result: SecretMeta }
  'secret:update': { args: [id: string, patch: SecretPatch]; result: SecretMeta }
  'secret:delete': { args: [id: string]; result: void }
  'secret:reveal': { args: [id: string]; result: { value: string } }
  'secret:copy': { args: [id: string]; result: { clearsInMs: number } }
  'key:list': { args: [vaultId?: string]; result: SshKeyMeta[] }
  'key:scanLocal': { args: []; result: LocalKeyCandidate[] }
  'key:link': { args: [input: KeyLinkInput]; result: SshKeyMeta }
  'key:import': { args: [input: KeyImportInput]; result: SshKeyMeta }
  // Main opens the file dialog and reads the key; null when the dialog is cancelled.
  'key:importFile': { args: [input: Omit<KeyImportInput, 'privateKey'>]; result: SshKeyMeta | null }
  'key:generate': { args: [input: KeyGenerateInput]; result: SshKeyMeta }
  'key:update': { args: [id: string, patch: { label?: string }]; result: SshKeyMeta }
  'key:delete': { args: [id: string]; result: void }
  'key:copyPublic': { args: [id: string]; result: void }
  'identity:list': { args: [vaultId?: string]; result: IdentityMeta[] }
  'identity:create': { args: [input: IdentityInput]; result: IdentityMeta }
  'identity:update': { args: [id: string, patch: IdentityPatch]; result: IdentityMeta }
  'identity:delete': { args: [id: string]; result: void }
  'host:list': { args: []; result: HostMeta[] }
  'host:create': { args: [input: HostInput]; result: HostMeta }
  'host:update': { args: [id: string, patch: HostPatch]; result: HostMeta }
  'host:delete': { args: [id: string]; result: void }
  'host:setVaults': { args: [id: string, vaultIds: string[]]; result: HostMeta }
  'host:resolve': { args: [hostId: string, environmentId?: string]; result: ResolvedHost }
  'env:list': { args: []; result: EnvironmentMeta[] }
  'env:create': { args: [input: EnvironmentInput]; result: EnvironmentMeta }
  'env:update': { args: [id: string, patch: EnvironmentPatch]; result: EnvironmentMeta }
  'env:delete': { args: [id: string]; result: void }
  'env:openDomain': { args: [id: string]; result: void }
  'env:setProducts': { args: [id: string, productIds: string[]]; result: EnvironmentMeta }
  'env:putHost': { args: [id: string, hostId: string, role: HostRole]; result: EnvironmentMeta }
  'env:removeHost': { args: [id: string, hostId: string]; result: EnvironmentMeta }
  'product:list': { args: []; result: ProductMeta[] }
  'product:create': { args: [input: ProductInput]; result: ProductMeta }
  'product:update': { args: [id: string, patch: ProductPatch]; result: ProductMeta }
  'product:delete': { args: [id: string]; result: void }
  'sshconfig:preview': { args: []; result: SshImportPreview }
  'sshconfig:import': { args: [req: SshImportRequest]; result: SshImportResult }
  // Returns at once in the connecting state; progress arrives as session:state events.
  'ssh:open': { args: [req: OpenSshRequest]; result: SessionMeta }
  'shell:open': { args: [req: OpenLocalRequest]; result: SessionMeta }
  'session:reconnect': { args: [id: string]; result: SessionMeta }
  'session:write': { args: [id: string, data: string]; result: void }
  'session:resize': { args: [id: string, cols: number, rows: number]; result: void }
  // Also forgets the session: it leaves the list and its buffer is freed.
  'session:close': { args: [id: string]; result: void }
  'session:list': { args: []; result: SessionMeta[] }
  'session:attach': { args: [id: string]; result: { meta: SessionMeta; buffer: string; end: number } }
  'session:answer': { args: [promptId: string, answer: PromptAnswer]; result: void }
  // Prompts still waiting on the user, oldest first: for a renderer that mounts after they were sent.
  'session:prompts': { args: []; result: SessionPrompt[] }
  'knownhost:list': { args: []; result: KnownHostMeta[] }
  'knownhost:remove': { args: [id: string]; result: void }
  'tunnel:list': { args: []; result: TunnelMeta[] }
  'tunnel:create': { args: [input: TunnelInput]; result: TunnelMeta }
  'tunnel:update': { args: [id: string, patch: TunnelPatch]; result: TunnelMeta }
  'tunnel:delete': { args: [id: string]; result: void }
  'tunnel:start': { args: [id: string]; result: TunnelRuntime }
  'tunnel:stop': { args: [id: string]; result: void }
  'tunnel:status': { args: []; result: TunnelRuntime[] }
  'deploy:list': { args: [environmentId?: string]; result: DeploymentMeta[] }
  'deploy:create': { args: [input: DeploymentInput]; result: DeploymentMeta }
  // The environment and host are fixed at creation: a patch that names either is rejected.
  'deploy:update': { args: [id: string, patch: DeploymentPatch]; result: DeploymentMeta }
  'deploy:delete': { args: [id: string]; result: void }
  'deploy:reorder': { args: [environmentId: string, ids: string[]]; result: void }
  'deploy:settings': { args: [environmentId: string]; result: EnvDeploySettings }
  'deploy:updateSettings': { args: [environmentId: string, patch: EnvDeploySettingsPatch]; result: EnvDeploySettings }
  'deploy:tooling': { args: []; result: Tooling }
  // `release:start` resolves once the run has started; progress arrives as `deploy:event` batches.
  'release:preflight': { args: [request: PreflightRequest]; result: { releaseId: string } }
  'release:start': { args: [releaseId: string, confirm: ReleaseConfirm]; result: void }
  'release:cancel': { args: [releaseId: string]; result: void }
  'release:rollback': { args: [releaseId: string, confirm: ReleaseConfirm]; result: { releaseId: string } }
  'release:break-lock': { args: [releaseId: string, hostId: string, confirm: BreakLockConfirm]; result: void }
  'release:discard': { args: [releaseId: string]; result: void }
  'release:retry-version': { args: [releaseId: string]; result: void }
  'release:list': { args: [filter: ReleaseListFilter]; result: ReleaseSummary[] }
  'release:get': { args: [releaseId: string]; result: ReleaseDetail }
  'release:events': { args: [releaseId: string, afterSeq: number, limit?: number]; result: DeployRunEvent[] }
  'release:active': { args: []; result: ReleaseSummary[] }
  // Hub (Phase 10). Results carry no token; `hub:state` pushes the same token-free HubStatus.
  'hub:status': { args: []; result: HubStatus }
  'hub:connect': { args: [url: string]; result: HubStatus }
  'hub:signIn': { args: []; result: HubStatus }
  'hub:cancelSignIn': { args: []; result: void }
  'hub:signOut': { args: []; result: HubStatus }
  'hub:unlink': { args: []; result: HubStatus }
  'hub:me': { args: []; result: HubUser }
  'hub:access': { args: [action: HubAction, target: AccessTarget]; result: HubDecision }
  'hub:users': { args: []; result: HubUser[] }
  'hub:updateUser': { args: [oid: string, patch: { role?: HubRole; disabled?: boolean }]; result: HubUser }
  'hub:groups': { args: []; result: HubGroup[] }
  'hub:createGroup': { args: [input: { name: string; description?: string }]; result: HubGroup }
  'hub:updateGroup': { args: [id: string, patch: { name?: string; description?: string }]; result: HubGroup }
  'hub:deleteGroup': { args: [id: string]; result: void }
  'hub:addMembers': { args: [groupId: string, oids: string[]]; result: HubGroup }
  'hub:removeMember': { args: [groupId: string, oid: string]; result: HubGroup }
  'hub:addGrant': { args: [groupId: string, scope: GrantScope]; result: HubGroup }
  'hub:removeGrant': { args: [grantId: string]; result: void }
  'hub:audit': { args: [filter: HubAuditFilter]; result: HubAuditEvent[] }
  'hub:verifyAudit': { args: []; result: { ok: boolean; count: number; brokenAtId?: number } }
  'hub:catalog': { args: []; result: HubCatalogEnv[] }
  'hub:publish': { args: [environmentId: string]; result: HubPublishResult }
  'hub:unpublish': { args: [environmentId: string]; result: void }
  'hub:adminEnvironments': { args: []; result: HubCatalogEnv[] }
  // Shared secrets. No channel takes or returns a value: uploads read the local vault in main.
  'hub:secrets': { args: [environmentId: string | null]; result: HubSecretMeta[] }
  'hub:uploadSecrets': { args: [environmentId: string, secretIds?: string[]]; result: { uploaded: number } }
  'hub:setIntegrationSecret': { args: [environmentId: string | null, kind: HubSecretKind, secretId: string]; result: void }
  // environmentId: the environment whose copy to remove; null for a Hub-wide integration secret.
  'hub:deleteSecret': { args: [id: string, environmentId: string | null]; result: void }
  'hub:deployKey': { args: [environmentId: string, rotate: boolean]; result: HubDeployKey }
  'hub:locks': { args: []; result: HubEnvLock[] }
  'hub:freeze': { args: [environmentId: string, reason: string, hours: number | null]; result: HubEnvLock }
  // typedName is the exact environment name, needed to lift someone else's freeze on a protected environment.
  'hub:unfreeze': { args: [environmentId: string, typedName: string | null]; result: void }
  // Writes emit `deploy:changed`. `tunnelRestartNeeded` says a running db tunnel still uses the old target.
  'service:list': { args: [environmentId?: string]; result: ServiceMeta[] }
  'service:create': { args: [input: ServiceInput]; result: ServiceMeta }
  'service:update': { args: [id: string, patch: ServicePatch]; result: ServiceUpdateResult }
  'service:delete': { args: [id: string, opts: { deleteTunnel: boolean }]; result: void }
  'service:reorder': { args: [environmentId: string, ids: string[]]; result: void }
  // One transaction and one `services.copy` audit; name conflicts come back in `skipped`.
  'service:copy': { args: [req: CopyServicesRequest]; result: CopyServicesResult }
  // A kind `service` with a checkout: `docker compose logs -f` streamed as `containers:logs`; stop it with `containers:unfollow`.
  'service:logs': { args: [id: string, tail: number]; result: string }
  // Opens the stored URL in the browser; refused when the service has none.
  'service:open': { args: [id: string]; result: void }
  // A db service's Phase 5 tunnel: open creates it on first use and starts it; sync applies a changed route.
  'service:tunnelOpen': { args: [id: string]; result: TunnelRuntime }
  'service:tunnelClose': { args: [id: string]; result: void }
  'service:tunnelSync': { args: [id: string]; result: TunnelRuntime | null }
  'snippets:list': { args: []; result: SnippetMeta[] }
  'snippets:create': { args: [input: SnippetInput]; result: SnippetMeta }
  'snippets:update': { args: [id: string, input: SnippetInput]; result: SnippetMeta }
  'snippets:delete': { args: [id: string]; result: void }
  // The rendered text for a terminal insert. Needs an unlocked vault: the script is opened from script_sealed.
  'snippets:render': { args: [id: string, values: Record<string, string>]; result: string }
  // Returns at once with every host queued; progress arrives as run:event events.
  'runs:start': { args: [req: RunRequest]; result: RunSummary }
  'runs:cancel': { args: [runId: string]; result: RunSummary }
  'runs:list': { args: []; result: RunSummary[] }
  'runs:get': { args: [runId: string]; result: { run: RunSummary; output: RunOutput[] } }
  'runs:dismiss': { args: [runId: string]; result: void }
  'containers:list': { args: [hostId: string, environmentId: string | null]; result: ContainerList }
  'containers:action': {
    args: [hostId: string, environmentId: string | null, ref: string, action: ContainerAction, confirm?: string]
    result: void
  }
  'containers:logs': { args: [hostId: string, environmentId: string | null, ref: string, tail: number]; result: string }
  // Returns the followId; lines arrive as containers:logs events.
  'containers:follow': { args: [hostId: string, environmentId: string | null, ref: string, tail: number]; result: string }
  'containers:unfollow': { args: [followId: string]; result: void }
  /** Asks where to save with a dialog in main: the renderer never sends a path. */
  'config:export': { args: []; result: { path: string; counts: ConfigCounts } | null }
}

export type Channel = keyof IpcContract

// Every key of IpcContract, listed literally (the preload needs it at runtime).
export const CHANNELS = [
  'app:info',
  'audit:list',
  'audit:verify',
  'audit:exportCsv',
  'vault:status',
  'vault:setup',
  'vault:unlock',
  'vault:unlockQuick',
  'vault:lock',
  'vault:changePassword',
  'vault:list',
  'vault:create',
  'vault:update',
  'vault:delete',
  'vault:setQuickUnlock',
  'vault:setAutoLock',
  'secret:list',
  'secret:create',
  'secret:update',
  'secret:delete',
  'secret:reveal',
  'secret:copy',
  'key:list',
  'key:scanLocal',
  'key:link',
  'key:import',
  'key:importFile',
  'key:generate',
  'key:update',
  'key:delete',
  'key:copyPublic',
  'identity:list',
  'identity:create',
  'identity:update',
  'identity:delete',
  'host:list',
  'host:create',
  'host:update',
  'host:delete',
  'host:setVaults',
  'host:resolve',
  'env:list',
  'env:create',
  'env:update',
  'env:delete',
  'env:openDomain',
  'env:setProducts',
  'env:putHost',
  'env:removeHost',
  'product:list',
  'product:create',
  'product:update',
  'product:delete',
  'sshconfig:preview',
  'sshconfig:import',
  'ssh:open',
  'shell:open',
  'session:reconnect',
  'session:write',
  'session:resize',
  'session:close',
  'session:list',
  'session:attach',
  'session:answer',
  'session:prompts',
  'knownhost:list',
  'knownhost:remove',
  'tunnel:list',
  'tunnel:create',
  'tunnel:update',
  'tunnel:delete',
  'tunnel:start',
  'tunnel:stop',
  'tunnel:status',
  'deploy:list',
  'deploy:create',
  'deploy:update',
  'deploy:delete',
  'deploy:reorder',
  'deploy:settings',
  'deploy:updateSettings',
  'deploy:tooling',
  'release:preflight',
  'release:start',
  'release:cancel',
  'release:rollback',
  'release:break-lock',
  'release:discard',
  'release:retry-version',
  'release:list',
  'release:get',
  'release:events',
  'release:active',
  'hub:status',
  'hub:connect',
  'hub:signIn',
  'hub:cancelSignIn',
  'hub:signOut',
  'hub:unlink',
  'hub:me',
  'hub:access',
  'hub:users',
  'hub:updateUser',
  'hub:groups',
  'hub:createGroup',
  'hub:updateGroup',
  'hub:deleteGroup',
  'hub:addMembers',
  'hub:removeMember',
  'hub:addGrant',
  'hub:removeGrant',
  'hub:audit',
  'hub:verifyAudit',
  'hub:catalog',
  'hub:publish',
  'hub:unpublish',
  'hub:adminEnvironments',
  'hub:secrets',
  'hub:uploadSecrets',
  'hub:setIntegrationSecret',
  'hub:deleteSecret',
  'hub:deployKey',
  'hub:locks',
  'hub:freeze',
  'hub:unfreeze',
  'service:list',
  'service:create',
  'service:update',
  'service:delete',
  'service:reorder',
  'service:copy',
  'service:logs',
  'service:open',
  'service:tunnelOpen',
  'service:tunnelClose',
  'service:tunnelSync',
  'snippets:list',
  'snippets:create',
  'snippets:update',
  'snippets:delete',
  'snippets:render',
  'runs:start',
  'runs:cancel',
  'runs:list',
  'runs:get',
  'runs:dismiss',
  'containers:list',
  'containers:action',
  'containers:logs',
  'containers:follow',
  'containers:unfollow',
  'config:export',
] as const satisfies readonly Channel[]

// Fails typecheck if IpcContract gains a channel that CHANNELS does not list.
type MissingChannels = Exclude<Channel, (typeof CHANNELS)[number]>
export const channelsAreComplete: [MissingChannels] extends [never] ? true : never = true

export type Handlers = {
  [K in Channel]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']> | IpcContract[K]['result']
}

/** Events main pushes to the window. Payloads never carry secrets; session:data is terminal output. */
export interface EventContract {
  'vault:locked': { reason: LockReason }
  // `end` is the stream offset after this chunk; attach returns the offset its buffer reaches.
  'session:data': { id: string; data: string; end: number }
  'session:state': SessionMeta
  'session:prompt': SessionPrompt
  'session:promptDone': { promptId: string }
  'tunnel:state': TunnelRuntime
  'tunnel:stats': TunnelStats[]
  'tunnel:event': TunnelEvent
  // Output chunks are run output: never logged, audited or toasted.
  'run:event': RunEvent
  'containers:logs': ContainerLogEvent
  // Pushed after a committed deploy-config change; the payload says which environment to refetch.
  'deploy:changed': { environmentId: string }
  // Batched run events of a release (about every EVENT_BATCH_MS), already persisted with their seq.
  'deploy:event': DeployRunEvent[]
  'release:state': ReleaseSummary
  'hub:state': HubStatus
  // The signed-in person's catalog changed; refetch with hub:catalog.
  'hub:catalog': Record<string, never>
  // A lock was taken or lifted by this client; refetch with hub:locks.
  'hub:locks': Record<string, never>
}
export type EventName = keyof EventContract
export const EVENTS = [
  'vault:locked',
  'session:data',
  'session:state',
  'session:prompt',
  'session:promptDone',
  'tunnel:state',
  'tunnel:stats',
  'tunnel:event',
  'run:event',
  'containers:logs',
  'deploy:changed',
  'deploy:event',
  'release:state',
  'hub:state',
  'hub:catalog',
  'hub:locks',
] as const satisfies readonly EventName[]
type MissingEvents = Exclude<EventName, (typeof EVENTS)[number]>
export const eventsAreComplete: [MissingEvents] extends [never] ? true : never = true

export interface OpsDeckBridge {
  invoke<K extends Channel>(channel: K, ...args: IpcContract[K]['args']): Promise<IpcContract[K]['result']>
  /** Subscribes to a main-process event from EVENTS; returns the unsubscribe. */
  on<K extends EventName>(event: K, listener: (payload: EventContract[K]) => void): () => void
}
