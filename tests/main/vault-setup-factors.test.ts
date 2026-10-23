import { describe, expect, it } from 'vitest'
import type { SetupOptions } from '../../src/shared/vault'
import { DEFAULT_VAULT_ID, VAULT_LOCKED } from '../../src/shared/vault'
import { fakeQuick, makeVault, type FakeQuick, type VaultFixture } from './vault-helpers'

const PW = 'correct horse'
const PIN = '204816'
const NEED = 'add Touch ID or a PIN first'

type Fx = VaultFixture & { quick: FakeQuick; avail: { keychain: boolean; touchId: boolean } }

function fixture(avail = { keychain: true, touchId: true }): Fx {
  const quick = fakeQuick(avail)
  return { ...makeVault({ quick }), quick, avail }
}

async function ready(opts: SetupOptions, avail = { keychain: true, touchId: true }): Promise<Fx> {
  const f = fixture(avail)
  await f.vault.setup(opts)
  return f
}

/** Everything a refusal must leave alone: the factor columns and the vault keys. */
function snapshot(f: VaultFixture): unknown {
  return {
    state: f.db.prepare('SELECT * FROM vault_state WHERE id = 1').get(),
    vaults: f.db.prepare('SELECT id, wrapped_key, kdf_params FROM vaults ORDER BY id').all(),
  }
}

function events(f: VaultFixture): { action: string; outcome: string; details: unknown }[] {
  return f.audit
    .list({ limit: 1000 })
    .reverse()
    .map((e) => ({ action: e.action, outcome: e.outcome, details: e.details }))
}

describe('setup factors', () => {
  it('setup refuses password-only when the keychain is available', async () => {
    const f = fixture()
    const before = snapshot(f)
    for (const opts of [{ password: PW }, { password: PW, touchId: false }, {}]) {
      await expect(f.vault.setup(opts)).rejects.toThrow('choose Touch ID or a PIN')
    }
    expect(snapshot(f)).toEqual(before)
    expect(f.vault.status()).toMatchObject({ setUp: false, unlocked: false })
    expect(f.quick.touchId.prompt).not.toHaveBeenCalled()
    expect(events(f)).toEqual([])
  })

  it('setup with Touch ID prompts once and enables it', async () => {
    const f = fixture()
    expect(await f.vault.setup({ touchId: true })).toMatchObject({
      setUp: true,
      unlocked: true,
      quickUnlock: 'touchId',
      hasPassword: false,
      pin: { enabled: false },
    })
    expect(f.quick.touchId.prompt).toHaveBeenCalledTimes(1)
    expect(f.quick.touchId.prompt).toHaveBeenCalledWith('unlock your CredOps vaults')
    const sealed = f.vault.seal(DEFAULT_VAULT_ID, 'a', 'v')
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', sealed)).toBe('v')
    expect(events(f)).toContainEqual({ action: 'vault.setup', outcome: 'success', details: { vaults: 1, methods: ['touchId'] } })
  })

  it('setup with Touch ID fails cleanly when the prompt is cancelled', async () => {
    const f = fixture()
    const before = snapshot(f)
    f.quick.touchId.prompt.mockRejectedValueOnce(new Error('User cancelled'))
    await expect(f.vault.setup({ touchId: true, password: PW })).rejects.toThrow('Touch ID was cancelled')
    expect(snapshot(f)).toEqual(before)
    expect(f.vault.status()).toMatchObject({ setUp: false, unlocked: false })
    expect(await f.vault.setup({ touchId: true })).toMatchObject({ setUp: true })
  })

  it('setup with Touch ID refuses when Touch ID is unavailable', async () => {
    const f = fixture({ keychain: true, touchId: false })
    const before = snapshot(f)
    await expect(f.vault.setup({ touchId: true })).rejects.toThrow('Touch ID unavailable')
    expect(snapshot(f)).toEqual(before)
    expect(f.quick.touchId.prompt).not.toHaveBeenCalled()
    // On such a Mac the PIN is the mandatory factor.
    expect(await f.vault.setup({ pin: PIN })).toMatchObject({ setUp: true, quickUnlock: 'off', pin: { enabled: true } })
  })

  it('password-only setup when the keychain is unavailable', async () => {
    for (const quick of [fakeQuick({ keychain: false, touchId: true }), undefined]) {
      const f = makeVault({ quick })
      const before = snapshot(f)
      await expect(f.vault.setup({})).rejects.toThrow('a master password is required without the Keychain')
      await expect(f.vault.setup({ touchId: true, password: PW })).rejects.toThrow('Touch ID unavailable')
      expect(snapshot(f)).toEqual(before)
      expect(await f.vault.setup({ password: PW })).toMatchObject({
        setUp: true,
        hasPassword: true,
        quickUnlock: 'off',
        pin: { enabled: false },
      })
      f.vault.lock('manual')
      expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    }
  })

  it('setup with every factor opens with each of them', async () => {
    const f = await ready({ password: PW, pin: PIN, touchId: true })
    expect(f.vault.status()).toMatchObject({ hasPassword: true, quickUnlock: 'touchId', pin: { enabled: true } })
    expect(events(f)).toContainEqual({
      action: 'vault.setup',
      outcome: 'success',
      details: { vaults: 1, methods: ['password', 'pin', 'touchId'] },
    })
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('Touch ID cache stays when it is the only factor and unreadable', async () => {
    const f = await ready({ touchId: true })
    f.vault.lock('manual')
    const before = snapshot(f)
    f.quick.keychain.decrypt.mockImplementationOnce(() => {
      throw new Error('keychain locked')
    })
    expect(await f.vault.unlockQuick()).toEqual({ ok: false, reason: 'unavailable', retryAfterMs: 0 })
    expect(snapshot(f)).toEqual(before)
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('clearPin refuses when it is the last factor', async () => {
    // A master password does not count: Touch ID or a PIN must remain (spec §3).
    const f = await ready({ password: PW, pin: PIN })
    const before = snapshot(f)
    expect(() => f.vault.clearPin()).toThrow(NEED)
    expect(snapshot(f)).toEqual(before)
    expect(events(f)).toContainEqual({ action: 'vault.pin', outcome: 'failure', details: { op: 'cleared', reason: 'no-other-factor' } })
    f.vault.lock('manual')
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
  })

  it('clearPin refuses when the Touch ID cache does not hold the KEK', async () => {
    const f = await ready({ pin: PIN, touchId: true })
    const before = snapshot(f)
    f.quick.keychain.decrypt.mockImplementationOnce(() => {
      throw new Error('keychain reset')
    })
    expect(() => f.vault.clearPin()).toThrow(NEED)
    expect(snapshot(f)).toEqual(before)
  })

  it('clearPin works with Touch ID set, and needs unlocked', async () => {
    const f = await ready({ pin: PIN, touchId: true })
    expect(f.vault.clearPin()).toMatchObject({ pin: { enabled: false }, quickUnlock: 'touchId' })
    const s = f.db.prepare('SELECT pin_wrap, pin_salt, pin_pepper_blob FROM vault_state').get()
    expect(s).toEqual({ pin_wrap: null, pin_salt: null, pin_pepper_blob: null })
    expect(events(f)).toContainEqual({ action: 'vault.pin', outcome: 'success', details: { op: 'cleared' } })
    f.vault.lock('manual')
    expect(() => f.vault.clearPin()).toThrow(VAULT_LOCKED)
    expect(await f.vault.unlockPin(PIN)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('Touch ID off is refused without a PIN, even with a master password', async () => {
    const f = await ready({ password: PW, touchId: true })
    const before = snapshot(f)
    expect(() => f.vault.setQuickUnlock('off')).toThrow(NEED)
    expect(snapshot(f)).toEqual(before)
    expect(events(f)).toContainEqual({
      action: 'vault.quickunlock',
      outcome: 'failure',
      details: { mode: 'off', reason: 'no-other-factor' },
    })
    await f.vault.setPin(PIN)
    expect(f.vault.setQuickUnlock('off').quickUnlock).toBe('off')
  })

  it('Touch ID off is refused when the PIN pepper is unreadable', async () => {
    const f = await ready({ pin: PIN, touchId: true })
    const before = snapshot(f)
    f.quick.keychain.decrypt.mockImplementationOnce(() => {
      throw new Error('keychain reset')
    })
    expect(() => f.vault.setQuickUnlock('off')).toThrow(NEED)
    expect(snapshot(f)).toEqual(before)
  })

  it('Touch ID off without the Keychain needs a master password', async () => {
    const f = await ready({ password: PW, touchId: true })
    f.avail.keychain = false
    expect(f.vault.setQuickUnlock('off').quickUnlock).toBe('off')

    // No password: the cache is the last copy of the KEK, so it stays.
    const g = await ready({ touchId: true })
    g.avail.keychain = false
    const before = snapshot(g)
    expect(() => g.vault.setQuickUnlock('off')).toThrow(NEED)
    expect(snapshot(g)).toEqual(before)
  })

  it('removePassword needs Touch ID or a usable PIN', async () => {
    const f = await ready({ password: PW, pin: PIN })
    f.quick.keychain.decrypt.mockImplementation(() => {
      throw new Error('keychain reset')
    })
    const before = snapshot(f)
    await expect(f.vault.removePassword(PW)).rejects.toThrow(NEED)
    expect(snapshot(f)).toEqual(before)
    f.quick.keychain.decrypt.mockReset()
    f.quick.keychain.decrypt.mockImplementation((b: Buffer) => [...b.toString('utf8').slice(3)].reverse().join(''))
    expect(await f.vault.removePassword(PW)).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
  })

  it('every allowed change keeps Touch ID or a PIN', async () => {
    const f = await ready({ password: PW, pin: PIN, touchId: true })
    const has = (): boolean => f.vault.status().pin.enabled || f.vault.status().quickUnlock === 'touchId'
    f.vault.clearPin()
    expect(has()).toBe(true)
    expect(() => f.vault.setQuickUnlock('off')).toThrow(NEED)
    await f.vault.setPin(PIN)
    f.vault.setQuickUnlock('off')
    expect(has()).toBe(true)
    expect(() => f.vault.clearPin()).toThrow(NEED)
    expect(await f.vault.removePassword(PW)).toEqual({ ok: true })
    expect(has()).toBe(true)
  })

  it('reverify accepts each set-up method and leaves the lock state alone', async () => {
    const f = await ready({ password: PW, pin: PIN, touchId: true })
    const before = snapshot(f)
    expect(await f.vault.reverify({ method: 'password', password: PW })).toBe(true)
    expect(await f.vault.reverify({ method: 'pin', pin: PIN })).toBe(true)
    expect(await f.vault.reverify({ method: 'touchId' })).toBe(true)
    expect(f.quick.touchId.prompt).toHaveBeenCalledTimes(2) // setup, then reverify
    expect(f.vault.isUnlocked()).toBe(true)
    expect(snapshot(f)).toEqual(before)

    f.quick.touchId.prompt.mockRejectedValueOnce(new Error('cancel'))
    expect(await f.vault.reverify({ method: 'touchId' })).toBe(false)
    expect(await f.vault.reverify({ method: 'password', password: 'wrong password' })).toBe(false)
    expect(f.vault.isUnlocked()).toBe(true)
  })
})
