// Imported by the renderer: keep this file to plain constants and types (no node or electron imports).
import type { HubUser } from './hub'

export const OFFLINE_GRACE_HOURS = 72
export const SSO_RECHECK_MS = 3_600_000
export const SSO_WATCH_MS = 1_800_000
export const CLOCK_BACK_TOLERANCE_MS = 300_000

export type SsoVerdict = 'not-required' | 'verified' | 'grace' | 'needs-signin' | 'blocked' | 'mismatch'
export type SsoState =
  | { required: false }
  | {
      required: true
      verdict: SsoVerdict
      checking: boolean
      upn: string | null
      hubName: string
      lastVerifiedAt: string | null
      graceEndsAt: string | null
    }
export type SessionCheck =
  | { kind: 'ok'; user: HubUser }
  | { kind: 'offline' }
  | { kind: 'expired' }
  | { kind: 'disabled' }
export type ReverifyProof =
  | { method: 'password'; password: string }
  | { method: 'pin'; pin: string }
  | { method: 'touchId' }
