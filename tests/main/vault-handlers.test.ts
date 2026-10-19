import { describe, expect, it, vi } from 'vitest'
import { createVaultHandlers } from '../../src/main/ipc/handlers/vault'
import type { VaultService } from '../../src/main/vault/vault-service'
import { DEFAULT_VAULT_ID, type VaultStatus } from '../../src/shared/vault'

const status: VaultStatus = {
  setUp: true,
  unlocked: false,
  quickUnlock: 'off',
  quickUnlockAvailable: { touchId: false, login: false },
  autoLockMinutes: 15,
  retryAfterMs: 0,
  corruptVaultIds: [],
}

function fakeVault() {
  return {
    status: vi.fn(() => status),
    setup: vi.fn(async () => status),
    unlock: vi.fn(async () => ({ ok: true }) as const),
    lock: vi.fn(),
    changePassword: vi.fn(async () => ({ ok: true }) as const),
    listVaults: vi.fn(() => []),
    createVault: vi.fn(),
    updateVault: vi.fn(),
    deleteVault: vi.fn(),
    unlockQuick: vi.fn(async () => ({ ok: true }) as const),
    setQuickUnlock: vi.fn(() => status),
    setAutoLock: vi.fn(() => status),
    reset: vi.fn(async () => status),
  }
}

describe('createVaultHandlers', () => {
  it('maps each channel onto the service', async () => {
    const vault = fakeVault()
    const h = createVaultHandlers(vault as unknown as VaultService)
    expect(await h['vault:status']()).toBe(status)
    await h['vault:lock']()
    expect(vault.lock).toHaveBeenCalledWith('manual')
    await h['vault:unlock']('pw')
    expect(vault.unlock).toHaveBeenCalledWith('pw')
    await h['vault:changePassword']('a', 'b')
    expect(vault.changePassword).toHaveBeenCalledWith('a', 'b')
    expect(await h['vault:unlockQuick']()).toEqual({ ok: true })
    expect(await h['vault:setQuickUnlock']('login')).toBe(status)
    expect(vault.setQuickUnlock).toHaveBeenCalledWith('login')
    expect(await h['vault:setAutoLock'](null)).toBe(status)
    expect(vault.setAutoLock).toHaveBeenCalledWith(null)
    await h['vault:update'](DEFAULT_VAULT_ID, { name: 'N' })
    expect(vault.updateVault).toHaveBeenCalledWith(DEFAULT_VAULT_ID, { name: 'N' })
    await h['vault:delete'](DEFAULT_VAULT_ID)
    expect(vault.deleteVault).toHaveBeenCalledWith(DEFAULT_VAULT_ID)
    expect(await h['vault:reset']('RESET')).toBe(status)
    expect(vault.reset).toHaveBeenCalledWith('RESET')
  })
})
