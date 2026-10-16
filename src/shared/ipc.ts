import type { AuditEvent, AuditFilter, ChainVerification } from './audit'
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
} from './inventory'
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
  'env:list': { args: []; result: EnvironmentMeta[] }
  'env:create': { args: [input: EnvironmentInput]; result: EnvironmentMeta }
  'env:update': { args: [id: string, patch: EnvironmentPatch]; result: EnvironmentMeta }
  'env:delete': { args: [id: string]; result: void }
  'env:setProducts': { args: [id: string, productIds: string[]]; result: EnvironmentMeta }
  'env:putHost': { args: [id: string, hostId: string, role: HostRole]; result: EnvironmentMeta }
  'env:removeHost': { args: [id: string, hostId: string]; result: EnvironmentMeta }
  'product:list': { args: []; result: ProductMeta[] }
  'product:create': { args: [input: ProductInput]; result: ProductMeta }
  'product:update': { args: [id: string, patch: ProductPatch]; result: ProductMeta }
  'product:delete': { args: [id: string]; result: void }
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
  'env:list',
  'env:create',
  'env:update',
  'env:delete',
  'env:setProducts',
  'env:putHost',
  'env:removeHost',
  'product:list',
  'product:create',
  'product:update',
  'product:delete',
] as const satisfies readonly Channel[]

// Fails typecheck if IpcContract gains a channel that CHANNELS does not list.
type MissingChannels = Exclude<Channel, (typeof CHANNELS)[number]>
export const channelsAreComplete: [MissingChannels] extends [never] ? true : never = true

export type Handlers = {
  [K in Channel]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']> | IpcContract[K]['result']
}

/** Events main pushes to the window. Payloads are metadata only, never secrets. */
export interface EventContract {
  'vault:locked': { reason: LockReason }
}
export type EventName = keyof EventContract
export const EVENTS = ['vault:locked'] as const satisfies readonly EventName[]

export interface OpsDeckBridge {
  invoke<K extends Channel>(channel: K, ...args: IpcContract[K]['args']): Promise<IpcContract[K]['result']>
  /** Subscribes to a main-process event from EVENTS; returns the unsubscribe. */
  on<K extends EventName>(event: K, listener: (payload: EventContract[K]) => void): () => void
}
