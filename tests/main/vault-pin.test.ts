import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveKek } from '../../src/main/vault/crypto'
import { checkPin, checkPinFormat } from '../../src/main/vault/pin'
import { DEFAULT_VAULT_ID, PIN_ATTEMPTS, PIN_WIPED, VAULT_LOCKED, VAULT_RESET_CONFIRM } from '../../src/shared/vault'
import { auditRows, fakeQuick, makeVault, type FakeQuick, type VaultFixture } from './vault-helpers'

vi.mock('../../src/main/vault/crypto', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/main/vault/crypto')>()
  return { ...mod, deriveKek: vi.fn(mod.deriveKek) }
})
// Passes through; a test turns it off once to store a PIN set before the 6-8 rule.
vi.mock('../../src/main/vault/pin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/main/vault/pin')>()
  return { ...mod, checkPin: vi.fn(mod.checkPin) }
})

const PW = 'correct horse'
const PW2 = 'battery staple!'
const PIN = '204816'
const PIN2 = '730952'

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(deriveKek).mockClear()
})

/** A vault whose PIN was set before the 6-8 rule. */
async function legacy(pin: string, opts: { password?: string; touchId?: boolean } = {}): Promise<Fx> {
  vi.mocked(checkPin).mockImplementationOnce(() => {})
  return ready({ ...opts, pin })
}

interface PinRow {
  pin_wrap: string | null
  pin_salt: string | null
  pin_pepper_blob: string | null
  pin_failed: number
  pin_length: number | null
  last_method: string | null
  failed_attempts: number
}

function row(f: VaultFixture): PinRow {
  return f.db
    .prepare('SELECT pin_wrap, pin_salt, pin_pepper_blob, pin_failed, pin_length, last_method, failed_attempts FROM vault_state WHERE id = 1')
    .get() as never
}

function events(f: VaultFixture): { action: string; outcome: string; details: unknown }[] {
  return f.audit
    .list({ limit: 1000 })
    .reverse()
    .map((e) => ({ action: e.action, outcome: e.outcome, details: e.details }))
}

type Fx = VaultFixture & { quick: FakeQuick }

async function ready(opts: { password?: string; pin?: string; touchId?: boolean } = { pin: PIN }, quick = fakeQuick()): Promise<Fx> {
  const f = makeVault({ quick })
  await f.vault.setup(opts)
  return { ...f, quick }
}

async function miss(f: Fx, n: number): Promise<unknown[]> {
  const out: unknown[] = []
  for (let i = 0; i < n; i++) out.push(await f.vault.unlockPin(PIN2))
  return out
}

describe('checkPin', () => {
  it('accepts 6-8 digits for a new PIN and refuses the rest', () => {
    for (const ok of ['204816', '013579', '2048162', '20481620']) expect(() => checkPin(ok)).not.toThrow()
    for (const bad of ['204', '2048', '20481', '204816204', '204816204816', '12 34 56', '20481a', '', '２０４８１６']) {
      expect(() => checkPin(bad)).toThrow('PIN must be 6-8 digits')
    }
  })

  it('an attempt may carry 4 to 12 digits, for a PIN set before the current rule', () => {
    for (const ok of ['2048', '20481', '20481620', '204816204816']) expect(() => checkPinFormat(ok)).not.toThrow()
    for (const bad of ['204', '2048162048161', '20481a']) expect(() => checkPinFormat(bad)).toThrow('PIN must be 6-8 digits')
  })

  it('refuses repeated digits and straight runs', () => {
    for (const easy of ['111111', '00000000', '123456', '987654', '01234567', '3456789']) {
      expect(() => checkPin(easy)).toThrow('PIN is too easy to guess')
    }
    for (const ok of ['112233', '123457', '890123', '135791']) expect(() => checkPin(ok)).not.toThrow()
  })
})

describe('PIN unlock', () => {
  it('PIN unlock', async () => {
    const f = await ready()
    expect(f.vault.status().pin).toEqual({ enabled: true, attemptsLeft: PIN_ATTEMPTS, length: PIN.length })
    const sealed = f.vault.seal(DEFAULT_VAULT_ID, 'a', 'v')
    f.vault.lock('manual')
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
    expect(f.vault.isUnlocked()).toBe(true)
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', sealed)).toBe('v')
    expect(f.vault.status().lastMethod).toBe('pin')
    expect(events(f)).toContainEqual({ action: 'vault.unlock', outcome: 'success', details: { method: 'pin' } })
  })

  it('leading zero PIN works', async () => {
    const f = await ready({ pin: '013579' })
    f.vault.lock('manual')
    expect(await f.vault.unlockPin('013579')).toEqual({ ok: true })
    f.vault.lock('manual')
    // Not read as a number: an extra leading zero is a different PIN.
    expect(await f.vault.unlockPin('0013579')).toMatchObject({ ok: false, reason: 'wrong-pin' })
  })

  it('rejects non-digit and short PINs without counting', async () => {
    const f = await ready()
    f.vault.lock('manual')
    for (const bad of ['12 34 56', '204', 'abcdef', '2048162048161']) {
      await expect(f.vault.unlockPin(bad)).rejects.toThrow('PIN must be 6-8 digits')
    }
    expect(row(f).pin_failed).toBe(0)
    expect(deriveKek).toHaveBeenCalledTimes(1) // setup only
  })

  it('refuses easy PINs', async () => {
    const f = await ready({ password: PW, touchId: true })
    await expect(f.vault.setPin('111111')).rejects.toThrow('PIN is too easy to guess')
    await expect(f.vault.setPin('987654')).rejects.toThrow('PIN is too easy to guess')
    await expect(f.vault.setup({ pin: '123456' })).rejects.toThrow(/already set up/)
    expect(row(f).pin_wrap).toBeNull()
    const fresh = makeVault()
    await expect(fresh.vault.setup({ pin: '123456' })).rejects.toThrow('PIN is too easy to guess')
    expect(fresh.vault.status().setUp).toBe(false)
  })

  it('wrong PIN counts down and resets on success', async () => {
    const f = await ready()
    f.vault.lock('manual')
    expect(await miss(f, 2)).toEqual([
      { ok: false, reason: 'wrong-pin', retryAfterMs: 0 },
      { ok: false, reason: 'wrong-pin', retryAfterMs: 0 },
    ])
    expect(f.vault.status().pin.attemptsLeft).toBe(3)
    expect(row(f).pin_failed).toBe(2)
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
    expect(f.vault.status().pin.attemptsLeft).toBe(5)
    expect(events(f)).toContainEqual({ action: 'vault.unlock', outcome: 'failure', details: { method: 'pin', reason: 'wrong-pin' } })
  })

  it('the count persists across a restart', async () => {
    const f = await ready()
    f.vault.lock('manual')
    await miss(f, 3)
    const again = makeVault({ db: f.db, quick: f.quick })
    expect(again.vault.status().pin.attemptsLeft).toBe(2)
  })

  it("a PIN set before main kept its length gets it learned on the next PIN unlock", async () => {
    const f = await ready()
    f.db.prepare('UPDATE vault_state SET pin_length = NULL WHERE id = 1').run()
    expect(f.vault.status().pin).toEqual({ enabled: true, attemptsLeft: PIN_ATTEMPTS })
    f.vault.lock('manual')
    await miss(f, 1)
    expect(f.vault.status().pin.length).toBeUndefined()
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
    expect(f.vault.status().pin.length).toBe(PIN.length)
  })

  it('a 4- or 5-digit PIN set before the 6-8 rule still unlocks', async () => {
    for (const pin of ['2580', '25801']) {
      const f = await legacy(pin)
      f.vault.lock('manual')
      expect(await f.vault.unlockPin(pin)).toEqual({ ok: true })
      f.vault.lock('manual')
      expect(await f.vault.unlockPin('9999')).toMatchObject({ ok: false, reason: 'wrong-pin' })
    }
  })

  it('a new PIN of 4 or 5 digits is refused, at setup and on change', async () => {
    await expect(makeVault().vault.setup({ pin: '2580' })).rejects.toThrow('PIN must be 6-8 digits')
    const f = await ready({ password: PW, touchId: true })
    for (const pin of ['2580', '25801']) await expect(f.vault.setPin(pin)).rejects.toThrow('PIN must be 6-8 digits')
    expect(row(f).pin_wrap).toBeNull()
  })

  it('a 4-digit PIN reports its length, and removing the PIN clears it', async () => {
    const f = await legacy('2580', { password: PW, touchId: true })
    expect(f.vault.status().pin.length).toBe(4)
    await f.vault.setPin('20481620')
    expect(f.vault.status().pin.length).toBe(8)
    f.vault.clearPin()
    expect(f.vault.status().pin).toEqual({ enabled: false, attemptsLeft: PIN_ATTEMPTS })
    expect(row(f).pin_length).toBeNull()
  })

  it('any successful unlock resets the PIN count', async () => {
    const f = await ready({ password: PW, pin: PIN })
    f.vault.lock('manual')
    await miss(f, 3)
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(f.vault.status()).toMatchObject({ lastMethod: 'password', pin: { enabled: true, attemptsLeft: 5 } })
  })

  it('5th miss with a password wipes the PIN and falls back to the password', async () => {
    const f = await ready({ password: PW, pin: PIN })
    f.vault.lock('manual')
    const res = await miss(f, PIN_ATTEMPTS)
    expect(res.at(-2)).toMatchObject({ ok: false, reason: 'wrong-pin' })
    expect(res.at(-1)).toEqual({ ok: false, reason: 'pin-wiped', retryAfterMs: 0 })
    expect(row(f)).toMatchObject({ pin_wrap: null, pin_salt: null, pin_pepper_blob: null })
    expect(f.vault.status().pin.enabled).toBe(false)
    // Wiped: even the right PIN no longer opens anything, and it does not count.
    expect(await f.vault.unlockPin(PIN)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    const wiped = events(f).filter((e) => e.action === 'vault.pin')
    expect(wiped).toEqual([
      { action: 'vault.pin', outcome: 'failure', details: { op: 'wiped', reason: 'attempts', fallback: 'password' } },
    ])
  })

  it('5th miss with Touch ID only falls back to Touch ID', async () => {
    const f = await ready({ pin: PIN, touchId: true })
    f.vault.lock('manual')
    expect((await miss(f, PIN_ATTEMPTS)).at(-1)).toMatchObject({ ok: false, reason: 'pin-wiped' })
    expect(events(f)).toContainEqual({
      action: 'vault.pin',
      outcome: 'failure',
      details: { op: 'wiped', reason: 'attempts', fallback: 'touchId' },
    })
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(f.vault.status().lastMethod).toBe('touchId')
  })

  it('5th miss with PIN only leaves the vault locked', async () => {
    const f = await ready({ pin: PIN })
    f.vault.lock('manual')
    expect((await miss(f, PIN_ATTEMPTS)).at(-1)).toMatchObject({ ok: false, reason: 'pin-wiped' })
    expect(events(f)).toContainEqual({
      action: 'vault.pin',
      outcome: 'failure',
      details: { op: 'wiped', reason: 'attempts', fallback: 'none' },
    })
    for (let i = 0; i < 3; i++) {
      expect(await f.vault.unlockPin(PIN)).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(await f.vault.unlockQuick()).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(['unavailable', 'wrong-password']).toContain(((await f.vault.unlock(PW)) as { reason: string }).reason)
    }
    expect(f.vault.isUnlocked()).toBe(false)
    expect((await f.vault.reset(VAULT_RESET_CONFIRM)).setUp).toBe(false)
    expect(row(f)).toEqual({ pin_wrap: null, pin_salt: null, pin_pepper_blob: null, pin_failed: 0, pin_length: null, last_method: null, failed_attempts: 0 })
    expect(await f.vault.setup({ pin: PIN2 })).toMatchObject({ setUp: true, unlocked: true })
  })

  // Preflight F12: the lock must land while scrypt runs, so deriveKek is held open.
  it('lock during PIN derivation abandons the attempt uncounted', async () => {
    const f = await ready()
    f.vault.lock('manual')
    vi.mocked(deriveKek).mockClear()
    const derived = Buffer.alloc(32, 7)
    let release!: () => void
    vi.mocked(deriveKek).mockImplementationOnce(() => new Promise<Buffer>((resolve) => (release = () => resolve(derived))))
    const pending = f.vault.unlockPin(PIN2)
    await vi.waitFor(() => expect(deriveKek).toHaveBeenCalled())
    f.vault.lock('screen')
    release()
    expect(await pending).toEqual({ ok: false, reason: 'cancelled', retryAfterMs: 0 })
    expect(derived.every((b) => b === 0)).toBe(true)
    expect(row(f).pin_failed).toBe(0)
    expect(f.vault.isUnlocked()).toBe(false)
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
  })

  it('db copy alone cannot open the PIN wrap', async () => {
    const f = await ready()
    f.vault.lock('manual')
    const before = row(f)
    f.quick.keychain.decrypt.mockImplementation(() => {
      throw new Error('not this Mac')
    })
    for (const pin of [PIN, PIN2]) expect(await f.vault.unlockPin(pin)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(row(f)).toEqual(before)
    expect(deriveKek).toHaveBeenCalledTimes(1) // setup only: nothing to guess against without the pepper
  })

  it('no Keychain at all gives unavailable, uncounted', async () => {
    const avail = { keychain: true, touchId: true }
    const f = await ready({ pin: PIN }, fakeQuick(avail))
    f.vault.lock('manual')
    avail.keychain = false
    expect(await f.vault.unlockPin(PIN)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(row(f).pin_failed).toBe(0)
    avail.keychain = true
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
  })

  it('PIN survives a password change', async () => {
    const f = await ready({ password: PW, pin: PIN })
    const before = row(f)
    expect(await f.vault.changePassword(PW, PW2)).toEqual({ ok: true })
    expect(row(f)).toEqual(before)
    f.vault.lock('manual')
    expect(await f.vault.unlockPin(PIN)).toEqual({ ok: true })
  })

  it('setPin replaces the PIN, resets the count and needs unlocked', async () => {
    const f = await ready()
    f.vault.lock('manual')
    await miss(f, 2)
    await f.vault.unlockPin(PIN)
    expect(await f.vault.setPin(PIN2)).toMatchObject({ pin: { enabled: true, attemptsLeft: 5 } })
    f.vault.lock('manual')
    expect(await f.vault.unlockPin(PIN)).toMatchObject({ ok: false, reason: 'wrong-pin' })
    expect(await f.vault.unlockPin(PIN2)).toEqual({ ok: true })
    f.vault.lock('manual')
    await expect(f.vault.setPin(PIN)).rejects.toThrow(VAULT_LOCKED)
    expect(events(f).filter((e) => e.action === 'vault.pin')).toEqual([
      { action: 'vault.pin', outcome: 'success', details: { op: 'changed' } },
    ])
  })

  // Preflight F4: the PIN never exists without the Keychain pepper.
  it('setPin and setup({ pin }) are refused without the Keychain', async () => {
    const avail = { keychain: true, touchId: true }
    const f = await ready({ password: PW, touchId: true }, fakeQuick(avail))
    avail.keychain = false
    const before = row(f)
    await expect(f.vault.setPin(PIN)).rejects.toThrow('a PIN needs the Keychain')
    expect(row(f)).toEqual(before)

    const fresh = makeVault({ quick: fakeQuick({ keychain: false, touchId: true }) })
    await expect(fresh.vault.setup({ password: PW, pin: PIN })).rejects.toThrow('a PIN needs the Keychain')
    expect(fresh.vault.status().setUp).toBe(false)
  })

  it('a lock during setPin derivation writes nothing', async () => {
    const f = await ready({ password: PW, touchId: true })
    vi.mocked(deriveKek).mockClear()
    let release!: () => void
    const real = vi.mocked(deriveKek).getMockImplementation()!
    vi.mocked(deriveKek).mockImplementationOnce((pw, params) => new Promise<Buffer>((resolve) => (release = () => resolve(real(pw, params)))))
    const pending = f.vault.setPin(PIN)
    await vi.waitFor(() => expect(deriveKek).toHaveBeenCalled())
    f.vault.lock('screen')
    release()
    await expect(pending).rejects.toThrow(VAULT_LOCKED)
    expect(row(f).pin_wrap).toBeNull()
  })

  // Preflight F19: no password wrap means no password to try, so nothing is counted.
  it('unlock with no master password is unavailable, uncounted', async () => {
    const f = await ready({ pin: PIN })
    f.vault.lock('manual')
    for (let i = 0; i < 4; i++) expect(await f.vault.unlock(PW)).toEqual({ ok: false, reason: 'unavailable', retryAfterMs: 0 })
    expect(row(f).failed_attempts).toBe(0)
    expect(f.vault.status().retryAfterMs).toBe(0)
  })

  it('no PIN in audit or errors', async () => {
    const f = await ready({ password: PW, pin: PIN })
    const messages: string[] = []
    const capture = async (p: Promise<unknown>): Promise<void> => {
      await p.catch((e: Error) => messages.push(e.message))
    }
    await capture(f.vault.setPin('111111'))
    await capture(f.vault.setPin('204'))
    await f.vault.setPin(PIN2)
    await f.vault.reverify({ method: 'pin', pin: PIN })
    await f.vault.reverify({ method: 'pin', pin: PIN2 })
    f.vault.lock('manual')
    await capture(f.vault.unlockPin('12 34 56'))
    await capture(f.vault.unlockPin(PIN2 + 'x'))
    await miss(f, PIN_ATTEMPTS)
    expect(messages.length).toBeGreaterThan(3)
    const rows = auditRows(f.db)
    for (const secret of [PIN, PIN2, '111111', '204', '12 34 56']) {
      expect(rows).not.toContain(secret)
      for (const m of messages) expect(m).not.toContain(secret)
    }
  })
})

describe('reverify', () => {
  it('checks the PIN without changing the lock state, sharing the miss path', async () => {
    const f = await ready({ password: PW, pin: PIN })
    expect(await f.vault.reverify({ method: 'pin', pin: PIN })).toBe(true)
    expect(f.vault.isUnlocked()).toBe(true)
    for (let i = 0; i < PIN_ATTEMPTS - 1; i++) expect(await f.vault.reverify({ method: 'pin', pin: PIN2 })).toBe(false)
    expect(f.vault.status().pin.attemptsLeft).toBe(1)
    expect(f.vault.isUnlocked()).toBe(true)
    // Preflight F5: the 5th miss wipes the PIN here too, audited the same way, and says so.
    await expect(f.vault.reverify({ method: 'pin', pin: PIN2 })).rejects.toThrow(PIN_WIPED)
    expect(row(f)).toMatchObject({ pin_wrap: null, pin_salt: null, pin_pepper_blob: null })
    // The password still opens the vaults, so the wipe leaves them unlocked.
    expect(f.vault.status()).toMatchObject({ unlocked: true, resetRequired: false })
    expect(events(f)).toContainEqual({
      action: 'vault.pin',
      outcome: 'failure',
      details: { op: 'wiped', reason: 'attempts', fallback: 'password' },
    })
    expect(await f.vault.reverify({ method: 'pin', pin: PIN })).toBe(false)
    expect(f.vault.isUnlocked()).toBe(true)
  })

  it('a reverify wipe that leaves nothing locks the vault at once', async () => {
    // Allowed while the PIN works: Touch ID off, PIN only, no password.
    const f = await ready({ pin: PIN, touchId: true })
    f.vault.setQuickUnlock('off')
    const kek = (f.vault as unknown as { kek: Buffer }).kek
    for (let i = 0; i < PIN_ATTEMPTS - 1; i++) expect(await f.vault.reverify({ method: 'pin', pin: PIN2 })).toBe(false)
    expect(f.vault.isUnlocked()).toBe(true)
    await expect(f.vault.reverify({ method: 'pin', pin: PIN2 })).rejects.toThrow(PIN_WIPED)
    expect(f.vault.isUnlocked()).toBe(false)
    expect(kek.every((b) => b === 0)).toBe(true)
    expect(f.vault.status()).toMatchObject({
      setUp: true,
      unlocked: false,
      resetRequired: true,
      hasPassword: false,
      quickUnlock: 'off',
      pin: { enabled: false, attemptsLeft: 0 },
    })
    const ev = events(f)
    const wipe = ev.findIndex((e) => e.action === 'vault.pin' && e.outcome === 'failure')
    expect(ev[wipe]).toEqual({ action: 'vault.pin', outcome: 'failure', details: { op: 'wiped', reason: 'attempts', fallback: 'none' } })
    expect(ev.slice(wipe)).toContainEqual({ action: 'vault.lock', outcome: 'success', details: { reason: 'manual' } })
    expect(await f.vault.unlockPin(PIN)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await f.vault.unlockQuick()).toMatchObject({ ok: false, reason: 'unavailable' })
    await expect(f.vault.reverify({ method: 'pin', pin: PIN })).rejects.toThrow(VAULT_LOCKED)
  })

  it('a reverify wipe with Touch ID left keeps the vault unlocked', async () => {
    const f = await ready({ pin: PIN, touchId: true })
    for (let i = 0; i < PIN_ATTEMPTS - 1; i++) await f.vault.reverify({ method: 'pin', pin: PIN2 })
    await expect(f.vault.reverify({ method: 'pin', pin: PIN2 })).rejects.toThrow(PIN_WIPED)
    expect(f.vault.status()).toMatchObject({ unlocked: true, resetRequired: false, quickUnlock: 'touchId', pin: { enabled: false } })
    expect(events(f)).toContainEqual({
      action: 'vault.pin',
      outcome: 'failure',
      details: { op: 'wiped', reason: 'attempts', fallback: 'touchId' },
    })
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('a right PIN resets the count', async () => {
    const f = await ready()
    await f.vault.reverify({ method: 'pin', pin: PIN2 })
    expect(f.vault.status().pin.attemptsLeft).toBe(4)
    expect(await f.vault.reverify({ method: 'pin', pin: PIN })).toBe(true)
    expect(f.vault.status().pin.attemptsLeft).toBe(5)
  })

  it('password reverify uses the password throttle', async () => {
    const f = await ready({ password: PW, pin: PIN })
    for (let i = 0; i < 3; i++) expect(await f.vault.reverify({ method: 'password', password: PW2 })).toBe(false)
    expect(row(f).failed_attempts).toBe(3)
    expect(f.vault.status().retryAfterMs).toBeGreaterThan(0)
    // Throttled: even the right password is refused until the wait is over, and nothing is derived.
    vi.mocked(deriveKek).mockClear()
    expect(await f.vault.reverify({ method: 'password', password: PW })).toBe(false)
    expect(deriveKek).not.toHaveBeenCalled()
    f.now.t += 60_000
    expect(await f.vault.reverify({ method: 'password', password: PW })).toBe(true)
    expect(row(f).failed_attempts).toBe(0)
  })

  it('needs unlocked, and refuses a method that is not set up', async () => {
    const f = await ready({ pin: PIN })
    expect(await f.vault.reverify({ method: 'password', password: PW })).toBe(false)
    expect(await f.vault.reverify({ method: 'touchId' })).toBe(false)
    expect(f.quick.touchId.prompt).not.toHaveBeenCalled()
    expect(row(f).failed_attempts).toBe(0)
    f.vault.lock('manual')
    await expect(f.vault.reverify({ method: 'pin', pin: PIN })).rejects.toThrow(VAULT_LOCKED)
    expect(f.vault.isUnlocked()).toBe(false)
  })

  it('a lock during a reverify fails it and stays locked', async () => {
    const f = await ready({ pin: PIN, touchId: true })
    let resolve!: () => void
    f.quick.touchId.prompt.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)))
    const pending = f.vault.reverify({ method: 'touchId' })
    await vi.waitFor(() => expect(f.quick.touchId.prompt).toHaveBeenCalledTimes(2))
    f.vault.lock('screen')
    resolve()
    expect(await pending).toBe(false)
    expect(f.vault.isUnlocked()).toBe(false)
  })
})
