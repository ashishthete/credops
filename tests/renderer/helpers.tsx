import { vi } from 'vitest'
import type { AuditEvent } from '../../src/shared/audit'
import type { AppInfo } from '../../src/shared/ipc'

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

/** Installs window.opsdeck with per-channel results; returns the invoke mock. */
export function mockBridge(results: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel in results) return results[channel]
    if (channel === 'app:info') return appInfo
    if (channel === 'audit:list') return []
    return null
  })
  ;(window as unknown as { opsdeck: unknown }).opsdeck = { invoke }
  return invoke
}
