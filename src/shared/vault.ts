// Imported by the renderer: keep this file to plain constants and types (no node or electron imports).
import type { SsoState } from './sso'
export const DEFAULT_VAULT_ID = '00000000-0000-4000-8000-000000000001'
export const VAULT_LOCKED = 'vault locked'
/** Typed by the user to confirm a forgotten-password reset, which erases every vault secret. */
export const VAULT_RESET_CONFIRM = 'RESET'
export const MIN_MASTER_PASSWORD = 8
export const MAX_MASTER_PASSWORD = 1024
export const MIN_PIN = 6
export const MAX_PIN = 12
export const PIN_ATTEMPTS = 5
export const MAX_SECRET_VALUE = 65536
export const MAX_SECRET_NAME = 120
export const MAX_VAULT_NAME = 64
export const MAX_LABEL = 120 // ssh key and identity labels
export const MAX_USERNAME = 256
export const MAX_KEY_COMMENT = 255
export const MAX_KEY_PATH = 4096
export const MAX_PASSPHRASE = 1024
export const VAULT_COLOR = /^#[0-9a-f]{6}$/i
export const CLIPBOARD_CLEAR_MS = 30_000
export const REVEAL_HIDE_MS = 10_000
export const SECRET_KINDS = ['password', 'token', 'env', 'webhook', 'api_key'] as const
export type SecretKind = (typeof SECRET_KINDS)[number]
export const QUICK_UNLOCK_MODES = ['off', 'touchId', 'login'] as const
export type QuickUnlockMode = (typeof QUICK_UNLOCK_MODES)[number]
export const AUTO_LOCK_CHOICES = [1, 5, 15, 60, null] as const // minutes; null = never
export type LockReason = 'manual' | 'idle' | 'screen' | 'suspend' | 'quit' | 'signin'
export type UnlockMethod = 'touchId' | 'pin' | 'password'
export interface SetupOptions {
  password?: string
  pin?: string
  touchId?: boolean
}

export interface VaultStatus {
  setUp: boolean
  unlocked: boolean
  quickUnlock: QuickUnlockMode
  quickUnlockAvailable: { touchId: boolean; login: boolean }
  autoLockMinutes: number | null
  retryAfterMs: number
  /** Vaults whose wrapped key failed to open at the last unlock; empty while locked. */
  corruptVaultIds: string[]
  hasPassword: boolean
  pin: { enabled: boolean; attemptsLeft: number }
  lastMethod: UnlockMethod | null
  sso: SsoState
}
export type UnlockResult =
  | { ok: true }
  | {
      ok: false
      reason: 'wrong-password' | 'throttled' | 'unavailable' | 'cancelled' | 'signin-required' | 'wrong-pin' | 'pin-wiped'
      retryAfterMs: number
    }

export interface VaultInput {
  name: string
  color: string
}
export interface VaultMeta extends VaultInput {
  id: string
  isDefault: boolean
  counts: { secrets: number; keys: number; identities: number }
  createdAt: string
  updatedAt: string
}

export interface SecretInput {
  vaultId: string
  name: string
  kind: SecretKind
  value: string
}
export type SecretPatch = Partial<Omit<SecretInput, 'vaultId'>>
export interface SecretMeta {
  id: string
  vaultId: string
  name: string
  kind: SecretKind
  createdAt: string
  updatedAt: string
}

export type SshKeyType =
  | 'ssh-ed25519'
  | 'ssh-rsa'
  | 'ecdsa-sha2-nistp256'
  | 'ecdsa-sha2-nistp384'
  | 'ecdsa-sha2-nistp521'
export type SshKeySource = 'file' | 'imported' | 'generated'
export interface SshKeyMeta {
  id: string
  vaultId: string
  label: string
  keyType: SshKeyType
  publicKey: string
  fingerprint: string
  source: SshKeySource
  filePath: string | null
  hasPassphrase: boolean
  createdAt: string
  updatedAt: string
}
export interface LocalKeyCandidate {
  path: string
  keyType: SshKeyType
  fingerprint: string
  encrypted: boolean
  alreadyLinked: boolean
}
export interface KeyLinkInput {
  vaultId: string
  label: string
  path: string
  passphrase?: string
}
export interface KeyImportInput {
  vaultId: string
  label: string
  privateKey: string
  passphrase?: string
}
export interface KeyGenerateInput {
  vaultId: string
  label: string
  comment?: string
}

export const IDENTITY_AUTHS = ['agent', 'key', 'password'] as const
export type IdentityAuth = (typeof IDENTITY_AUTHS)[number]
export interface IdentityInput {
  vaultId: string
  label: string
  username: string
  auth: IdentityAuth
  sshKeyId?: string
  password?: string
}
export type IdentityPatch = Partial<Omit<IdentityInput, 'vaultId'>>
export interface IdentityMeta {
  id: string
  vaultId: string
  label: string
  username: string
  auth: IdentityAuth
  sshKeyId: string | null
  hasPassword: boolean
  createdAt: string
  updatedAt: string
}
