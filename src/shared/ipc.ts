import type { AuditEvent, AuditFilter, ChainVerification } from './audit'
import type {
  QuickUnlockMode,
  SecretInput,
  SecretMeta,
  SecretPatch,
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
] as const satisfies readonly Channel[]

// Fails typecheck if IpcContract gains a channel that CHANNELS does not list.
type MissingChannels = Exclude<Channel, (typeof CHANNELS)[number]>
export const channelsAreComplete: [MissingChannels] extends [never] ? true : never = true

export type Handlers = {
  [K in Channel]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']> | IpcContract[K]['result']
}

export interface OpsDeckBridge {
  invoke<K extends Channel>(channel: K, ...args: IpcContract[K]['args']): Promise<IpcContract[K]['result']>
}
