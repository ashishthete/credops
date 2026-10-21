import { describe, expect, it, vi } from 'vitest'
import { openSealed } from '../../src/main/vault/crypto'
import { DEFAULT_VAULT_ID, VAULT_LOCKED } from '../../src/shared/vault'
import { auditRows, fakeQuick, makeVault, type FakeQuick, type VaultFixture } from './vault-helpers'

const PW = 'correct horse'
const PW2 = 'battery staple!'
const PIN = '204816'

function stateRow(f: VaultFixture): { quick_unlock: string; quick_unlock_blob: string | null } {
  return f.db.prepare('SELECT quick_unlock, quick_unlock_blob FROM vault_state WHERE id = 1').get() as never
}

function events(f: VaultFixture): { action: string; outcome: string; details: unknown }[] {
  return f.audit
    .list({ limit: 1000 })
    .reverse()
    .map((e) => ({ action: e.action, outcome: e.outcome, details: e.details }))
}

/** A 'login' row as an older build could leave it: main no longer sets that mode itself. */
function seedLogin(f: VaultFixture): void {
  f.vault.setQuickUnlock('touchId')
  f.db.prepare("UPDATE vault_state SET quick_unlock = 'login' WHERE id = 1").run()
}

async function ready(quick = fakeQuick()): Promise<VaultFixture & { quick: FakeQuick }> {
  const f = makeVault({ quick })
  // A PIN is the mandatory factor here, so each test starts with quick unlock off.
  await f.vault.setup({ password: PW, pin: PIN })
  return { ...f, quick }
}

describe('quick unlock', () => {
  it('touch id unlock', async () => {
    const f = await ready()
    expect(f.vault.setQuickUnlock('touchId').quickUnlock).toBe('touchId')
    expect(f.vault.status().quickUnlock).toBe('touchId')
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(f.quick.touchId.prompt).toHaveBeenCalledTimes(1)
    expect(f.quick.touchId.prompt).toHaveBeenCalledWith('unlock your OpsDeck vaults')
    expect(f.vault.isUnlocked()).toBe(true)
    // The installed keys work: a sealed value round-trips.
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', f.vault.seal(DEFAULT_VAULT_ID, 'a', 'v'))).toBe('v')
    const ev = events(f)
    expect(ev).toContainEqual({ action: 'vault.quickunlock', outcome: 'success', details: { mode: 'touchId' } })
    expect(ev).toContainEqual({ action: 'vault.unlock', outcome: 'success', details: { method: 'touchId' } })
  })

  it('cancelled prompt stays locked', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    f.vault.lock('manual')
    f.quick.touchId.prompt.mockRejectedValueOnce(new Error('User cancelled'))
    expect(await f.vault.unlockQuick()).toEqual({ ok: false, reason: 'cancelled', retryAfterMs: 0 })
    expect(f.vault.isUnlocked()).toBe(false)
    expect(f.vault.status().quickUnlock).toBe('touchId')
    expect(f.quick.keychain.decrypt).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT failed_attempts FROM vault_state').get()).toEqual({ failed_attempts: 0 })
  })

  it('a lock during the prompt cancels the unlock', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    f.vault.lock('manual')
    let resolve!: () => void
    f.quick.touchId.prompt.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)))
    const pending = f.vault.unlockQuick()
    await vi.waitFor(() => expect(f.quick.touchId.prompt).toHaveBeenCalled())
    f.vault.lock('idle')
    resolve()
    expect(await pending).toEqual({ ok: false, reason: 'cancelled', retryAfterMs: 0 })
    expect(f.vault.isUnlocked()).toBe(false)
    expect(f.quick.keychain.decrypt).not.toHaveBeenCalled()
    expect(f.vault.status().quickUnlock).toBe('touchId')
    // The cache survives and works next time.
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('a password unlock queued behind the prompt waits for it', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    f.vault.lock('manual')
    let reject!: (e: Error) => void
    f.quick.touchId.prompt.mockImplementationOnce(() => new Promise<void>((_r, j) => (reject = j)))
    const quick = f.vault.unlockQuick()
    const pw = f.vault.unlock(PW)
    await vi.waitFor(() => expect(f.quick.touchId.prompt).toHaveBeenCalled())
    reject(new Error('cancel'))
    expect(await quick).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(await pw).toEqual({ ok: true })
  })

  it('refuses to turn on login mode', async () => {
    const f = await ready()
    expect(() => f.vault.setQuickUnlock('login')).toThrow('login quick unlock is not offered')
    expect(stateRow(f)).toEqual({ quick_unlock: 'off', quick_unlock_blob: null })
    expect(events(f).filter((e) => e.action === 'vault.quickunlock')).toHaveLength(0)
    // An existing login row can still be turned off.
    seedLogin(f)
    expect(f.vault.status().quickUnlock).toBe('login')
    expect(f.vault.setQuickUnlock('off').quickUnlock).toBe('off')
    expect(stateRow(f)).toEqual({ quick_unlock: 'off', quick_unlock_blob: null })
  })

  it('a quick unlock success resets the password backoff', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    f.vault.lock('manual')
    for (let i = 0; i < 3; i++) expect(await f.vault.unlock('wrong password')).toMatchObject({ ok: false })
    expect(f.vault.status().retryAfterMs).toBeGreaterThan(0)
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(f.db.prepare('SELECT failed_attempts FROM vault_state').get()).toEqual({ failed_attempts: 0 })
    expect(f.vault.status().retryAfterMs).toBe(0)
  })

  it('an existing login row skips the prompt', async () => {
    const f = await ready()
    seedLogin(f)
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(f.quick.touchId.prompt).not.toHaveBeenCalled()
    expect(events(f)).toContainEqual({ action: 'vault.unlock', outcome: 'success', details: { method: 'login' } })
  })

  it('a broken cache is discarded', async () => {
    const f = await ready()
    seedLogin(f)
    f.vault.lock('manual')
    f.quick.keychain.decrypt.mockImplementationOnce(() => {
      throw new Error('keychain changed')
    })
    expect(await f.vault.unlockQuick()).toEqual({ ok: false, reason: 'unavailable', retryAfterMs: 0 })
    expect(f.vault.isUnlocked()).toBe(false)
    expect(stateRow(f)).toEqual({ quick_unlock: 'off', quick_unlock_blob: null })
    expect(f.vault.status().quickUnlock).toBe('off')
    expect(events(f)).toContainEqual(expect.objectContaining({ action: 'vault.unlock', outcome: 'failure' }))
    expect(f.db.prepare('SELECT failed_attempts FROM vault_state').get()).toEqual({ failed_attempts: 0 })
  })

  it('a stale cache falls back to the password without counting a failure', async () => {
    const f = await ready()
    seedLogin(f)
    // Another key in the cache, e.g. the password changed with quick unlock off elsewhere.
    f.db
      .prepare('UPDATE vault_state SET quick_unlock_blob = ? WHERE id = 1')
      .run(f.quick.keychain.encrypt(Buffer.alloc(32, 7).toString('base64')).toString('base64'))
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: false, reason: 'unavailable', retryAfterMs: 0 })
    expect(f.vault.isUnlocked()).toBe(false)
    expect(stateRow(f)).toEqual({ quick_unlock: 'off', quick_unlock_blob: null })
    expect(f.vault.status().retryAfterMs).toBe(0)
    expect(f.db.prepare('SELECT failed_attempts FROM vault_state').get()).toEqual({ failed_attempts: 0 })
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
  })

  it('reports unavailable when off or the dependency went away, keeping the cache', async () => {
    const avail = { keychain: true, touchId: true }
    const f = await ready(fakeQuick(avail))
    f.vault.lock('manual')
    const rows = events(f).length
    expect(await f.vault.unlockQuick()).toMatchObject({ ok: false, reason: 'unavailable' })
    // Off is not an attempt: nothing audited.
    expect(events(f)).toHaveLength(rows)
    await f.vault.unlock(PW)
    f.vault.setQuickUnlock('touchId')
    f.vault.lock('manual')
    avail.touchId = false
    expect(await f.vault.unlockQuick()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(f.quick.touchId.prompt).not.toHaveBeenCalled()
    expect(stateRow(f).quick_unlock).toBe('touchId')
    avail.touchId = true
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('requires unlocked and availability', async () => {
    const avail = { keychain: true, touchId: false }
    const f = await ready(fakeQuick(avail))
    expect(f.vault.status().quickUnlockAvailable).toEqual({ touchId: false, login: true })
    expect(() => f.vault.setQuickUnlock('touchId')).toThrow(/unavailable/)
    avail.touchId = true
    expect(f.vault.status().quickUnlockAvailable).toEqual({ touchId: true, login: true })
    // Touch ID mode stores its cache in the keychain too.
    avail.keychain = false
    expect(f.vault.status().quickUnlockAvailable).toEqual({ touchId: false, login: false })
    expect(() => f.vault.setQuickUnlock('touchId')).toThrow(/quick unlock unavailable/)
    avail.keychain = true
    f.vault.lock('manual')
    expect(() => f.vault.setQuickUnlock('touchId')).toThrow(VAULT_LOCKED)
    expect(stateRow(f)).toEqual({ quick_unlock: 'off', quick_unlock_blob: null })

    const none = makeVault({ quick: undefined })
    await none.vault.setup({ password: PW })
    expect(none.vault.status().quickUnlockAvailable).toEqual({ touchId: false, login: false })
    expect(() => none.vault.setQuickUnlock('touchId')).toThrow(/unavailable/)
  })

  it('turning it off clears the cache', async () => {
    const f = await ready()
    seedLogin(f)
    expect(stateRow(f).quick_unlock_blob).not.toBeNull()
    expect(f.vault.setQuickUnlock('off').quickUnlock).toBe('off')
    expect(stateRow(f)).toEqual({ quick_unlock: 'off', quick_unlock_blob: null })
    expect(events(f)).toContainEqual({ action: 'vault.quickunlock', outcome: 'success', details: { mode: 'off' } })
  })

  // The KEK is stable across a password change, so the cache stays valid as it is.
  it('rekey keeps the cache', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    const before = stateRow(f)
    expect(await f.vault.changePassword(PW, PW2)).toEqual({ ok: true })
    expect(stateRow(f)).toEqual(before)
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW2)).toEqual({ ok: true })
  })

  it('rekey does not need the keychain', async () => {
    const avail = { keychain: true, touchId: true }
    const f = await ready(fakeQuick(avail))
    f.vault.setQuickUnlock('touchId')
    const before = stateRow(f)
    avail.keychain = false
    expect(await f.vault.changePassword(PW, PW2)).toEqual({ ok: true })
    expect(stateRow(f)).toEqual(before)
    expect(events(f).filter((e) => e.action === 'vault.quickunlock')).toHaveLength(1)
    avail.keychain = true
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('a failed keychain encrypt propagates and writes nothing', async () => {
    const quick = fakeQuick()
    const f = await ready(quick)
    quick.keychain.encrypt = () => {
      throw new Error('keychain denied')
    }
    const rows = events(f).length
    expect(() => f.vault.setQuickUnlock('touchId')).toThrow(/keychain denied/)
    expect(stateRow(f)).toEqual({ quick_unlock: 'off', quick_unlock_blob: null })
    expect(events(f)).toHaveLength(rows)
  })

  it('cache holds no password', async () => {
    const f = await ready()
    seedLogin(f)
    const blob = stateRow(f).quick_unlock_blob!
    const decoded = f.quick.keychain.decrypt(Buffer.from(blob, 'base64')) as string
    expect(decoded).not.toContain(PW)
    // It is the KEK, base64: it opens the Default vault's wrapped key.
    const kek = Buffer.from(decoded, 'base64')
    expect(kek).toHaveLength(32)
    const row = f.db.prepare('SELECT wrapped_key FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as {
      wrapped_key: string
    }
    expect(openSealed(kek, row.wrapped_key, `vault:${DEFAULT_VAULT_ID}`)).toHaveLength(32)
    const audit = auditRows(f.db)
    expect(audit).not.toContain(blob)
    expect(audit).not.toContain(decoded)
  })
})
