import type { AuditEvent, AuditFilter, ChainVerification } from './audit'

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
}

export type Channel = keyof IpcContract

// Every key of IpcContract, listed literally (the preload needs it at runtime).
export const CHANNELS = ['app:info', 'audit:list', 'audit:verify', 'audit:exportCsv'] as const satisfies readonly Channel[]

// Fails typecheck if IpcContract gains a channel that CHANNELS does not list.
type MissingChannels = Exclude<Channel, (typeof CHANNELS)[number]>
export const channelsAreComplete: [MissingChannels] extends [never] ? true : never = true

export type Handlers = {
  [K in Channel]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']> | IpcContract[K]['result']
}

export interface OpsDeckBridge {
  invoke<K extends Channel>(channel: K, ...args: IpcContract[K]['args']): Promise<IpcContract[K]['result']>
}
