import { describe, expect, it, vi } from 'vitest'
import { createVaultHandlers } from '../../src/main/ipc/handlers/vault'
import type { VaultService } from '../../src/main/vault/vault-service'
import type { ReverifyProof } from '../../src/shared/sso'
import { DEFAULT_VAULT_ID, PIN_ATTEMPTS, PIN_WIPED, VERIFICATION_FAILED, type VaultStatus } from '../../src/shared/vault'
import { fakeQuick, makeVault } from './vault-helpers'

const status: VaultStatus = {
  setUp: true,
  unlocked: false,
  quickUnlock: 'off',
  quickUnlockAvailable: { touchId: false, login: false },
  autoLockMinutes: 15,
  retryAfterMs: 0,
  corruptVaultIds: [],
  hasPassword: true,
  pin: { enabled: false, attemptsLeft: 5 },
  lastMethod: null,
  resetRequired: false,
  touchIdNeedsReenable: false,
  sso: { required: false },
}

function fakeVault() {
  return {
    status: vi.fn(() => status),
    setup: vi.fn(async () => status),
    unlock: vi.fn(async () => ({ ok: true }) as const),
    unlockPin: vi.fn(async () => ({ ok: true }) as const),
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
    setPin: vi.fn(async () => status),
    clearPin: vi.fn(() => status),
    setPassword: vi.fn(async () => status),
    removePassword: vi.fn(async () => ({ ok: true }) as const),
    reverify: vi.fn(async (_p: ReverifyProof) => true),
  }
}

const PW = 'correct horse'
const PIN = '204816'

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
    expect(await h['vault:setQuickUnlock']('off')).toEqual({ ok: true, status })
    expect(vault.setQuickUnlock).toHaveBeenCalledWith('off')
    expect(await h['vault:setAutoLock'](null)).toBe(status)
    expect(vault.setAutoLock).toHaveBeenCalledWith(null)
    await h['vault:update'](DEFAULT_VAULT_ID, { name: 'N' })
    expect(vault.updateVault).toHaveBeenCalledWith(DEFAULT_VAULT_ID, { name: 'N' })
    await h['vault:delete'](DEFAULT_VAULT_ID)
    expect(vault.deleteVault).toHaveBeenCalledWith(DEFAULT_VAULT_ID)
    expect(await h['vault:reset']('RESET')).toBe(status)
    expect(vault.reset).toHaveBeenCalledWith('RESET')
    expect(await h['vault:setup']({ pin: PIN, touchId: true })).toBe(status)
    expect(vault.setup).toHaveBeenCalledWith({ pin: PIN, touchId: true })
    expect(await h['vault:unlockPin'](PIN)).toEqual({ ok: true })
    expect(vault.unlockPin).toHaveBeenCalledWith(PIN)
    expect(await h['vault:clearPin']()).toBe(status)
    expect(await h['vault:removePassword'](PW)).toEqual({ ok: true })
    expect(vault.removePassword).toHaveBeenCalledWith(PW)
  })

  it('adds a factor only after a reverify', async () => {
    const vault = fakeVault()
    const h = createVaultHandlers(vault as unknown as VaultService)
    const proof: ReverifyProof = { method: 'password', password: PW }
    expect(await h['vault:setPin'](PIN, proof)).toEqual({ ok: true, status })
    expect(vault.reverify).toHaveBeenLastCalledWith(proof, 'set a PIN')
    expect(vault.setPin).toHaveBeenCalledWith(PIN)
    expect(await h['vault:setPassword'](PW, { method: 'pin', pin: PIN })).toEqual({ ok: true, status })
    expect(vault.setPassword).toHaveBeenCalledWith(PW)
    expect(await h['vault:setQuickUnlock']('touchId', proof)).toEqual({ ok: true, status })
    expect(vault.setQuickUnlock).toHaveBeenCalledWith('touchId')

    vault.reverify.mockResolvedValue(false)
    await expect(h['vault:setPin'](PIN, proof)).rejects.toThrow(new Error(VERIFICATION_FAILED))
    await expect(h['vault:setPassword'](PW, proof)).rejects.toThrow(new Error(VERIFICATION_FAILED))
    await expect(h['vault:setQuickUnlock']('touchId', proof)).rejects.toThrow(new Error(VERIFICATION_FAILED))
    expect(vault.setPin).toHaveBeenCalledTimes(1)
    expect(vault.setPassword).toHaveBeenCalledTimes(1)
    expect(vault.setQuickUnlock).toHaveBeenCalledTimes(1)
  })

  it('the Touch ID prompt names the change being approved', async () => {
    const quick = fakeQuick()
    const f = makeVault({ quick })
    await f.vault.setup({ pin: PIN, touchId: true })
    const h = createVaultHandlers(f.vault)
    expect(await h['vault:setPassword'](PW, { method: 'touchId' })).toMatchObject({ ok: true })
    expect(quick.touchId.prompt).toHaveBeenLastCalledWith('set a master password in CredOps')
    expect(await h['vault:setPin']('482913', { method: 'touchId' })).toMatchObject({ ok: true })
    expect(quick.touchId.prompt).toHaveBeenLastCalledWith('set a PIN in CredOps')
  })

  it('never enables Touch ID without a proof', async () => {
    const vault = fakeVault()
    const h = createVaultHandlers(vault as unknown as VaultService)
    await expect(h['vault:setQuickUnlock']('touchId')).rejects.toThrow(new Error(VERIFICATION_FAILED))
    expect(vault.reverify).not.toHaveBeenCalled()
    expect(vault.setQuickUnlock).not.toHaveBeenCalled()
  })

  it('maps a PIN wipe to a coded result, not an error', async () => {
    const vault = fakeVault()
    vault.reverify.mockRejectedValue(new Error(PIN_WIPED))
    const h = createVaultHandlers(vault as unknown as VaultService)
    expect(await h['vault:setPassword'](PW, { method: 'pin', pin: '000000' })).toEqual({ ok: false, reason: 'pin-wiped', status })
    expect(vault.setPassword).not.toHaveBeenCalled()
  })

  it('a real wipe during reverify locks and reports pin-wiped', async () => {
    const f = makeVault()
    await f.vault.setup({ pin: PIN, touchId: false })
    const h = createVaultHandlers(f.vault)
    const wrong: ReverifyProof = { method: 'pin', pin: '135799' }
    for (let i = 1; i < PIN_ATTEMPTS; i++) {
      await expect(h['vault:setPassword'](PW, wrong)).rejects.toThrow(new Error(VERIFICATION_FAILED))
    }
    const res = await h['vault:setPassword'](PW, wrong)
    expect(res).toMatchObject({ ok: false, reason: 'pin-wiped', status: { unlocked: false, resetRequired: true } })
    expect(f.vault.status().hasPassword).toBe(false)
  })
})
