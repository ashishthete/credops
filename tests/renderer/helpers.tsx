import { vi } from 'vitest'
import type { AuditEvent } from '../../src/shared/audit'
import type { AppInfo } from '../../src/shared/ipc'
import { DEFAULT_VAULT_ID, type VaultMeta, type VaultStatus } from '../../src/shared/vault'

export const appInfo: AppInfo = {
  version: '0.1.0',
  platform: 'darwin',
  userDataPath: '/tmp/opsdeck',
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

/** Installs window.opsdeck with per-channel results; returns the invoke mock. */
export function mockBridge(results: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel in results) return results[channel]
    if (channel === 'app:info') return appInfo
    if (channel === 'audit:list') return []
    if (channel === 'vault:status') return vaultStatus()
    if (channel === 'vault:list') return [defaultVault]
    if (channel === 'secret:list' || channel === 'key:list' || channel === 'identity:list') return []
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
  ;(window as unknown as { opsdeck: unknown }).opsdeck = { invoke, on }
  return invoke
}

const bridgeListeners = new Map<string, Set<(payload: unknown) => void>>()

/** Delivers a main-process push event to whatever subscribed through the mock bridge. */
export function emitBridgeEvent(event: string, payload: unknown) {
  bridgeListeners.get(event)?.forEach((l) => l(payload))
}
