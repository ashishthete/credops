import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementSync } from 'node:sqlite'
import { deriveKek, openSealed, randomKey } from '../../src/main/vault/crypto'
import type { QuickUnlockDeps } from '../../src/main/vault/vault-service'
import { DEFAULT_VAULT_ID, VAULT_LOCKED, VAULT_RESET_CONFIRM } from '../../src/shared/vault'
import { auditRows, fakeQuick, makeVault, seedLegacy, type VaultFixture } from './vault-helpers'

const PW = 'correct horse'
const PW2 = 'battery staple!'

interface Row {
  password_wrap: string | null
  password_kdf: string | null
  quick_unlock: string
  quick_unlock_blob: string | null
  failed_attempts: number
}

function state(f: VaultFixture): Row {
  return f.db
    .prepare('SELECT password_wrap, password_kdf, quick_unlock, quick_unlock_blob, failed_attempts FROM vault_state WHERE id = 1')
    .get() as never
}

function kdfParams(f: VaultFixture): (string | null)[] {
  return (f.db.prepare('SELECT kdf_params FROM vaults ORDER BY id').all() as { kdf_params: string | null }[]).map(
    (r) => r.kdf_params,
  )
}

function events(f: VaultFixture): { action: string; outcome: string; details: unknown }[] {
  return f.audit
    .list({ limit: 1000 })
    .reverse()
    .map((e) => ({ action: e.action, outcome: e.outcome, details: e.details }))
}

async function ready(quick: QuickUnlockDeps | undefined = fakeQuick()): Promise<VaultFixture> {
  const f = makeVault({ quick })
  // Without the Keychain only a password-only setup is possible.
  await f.vault.setup({ password: PW, touchId: quick?.keychain.available() === true })
  return f
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('vault KEK', () => {
  it('new setup uses a random KEK wrapped by the password', async () => {
    const f = await ready()
    expect(kdfParams(f)).toEqual([null])
    const s = state(f)
    expect(s.password_wrap).not.toBeNull()
    expect(s.password_kdf).not.toBeNull()
    // The wrap is the KEK sealed under the password key, and that KEK opens the Default vault.
    const pwKey = await deriveKek(PW, JSON.parse(s.password_kdf!))
    const kek = openSealed(pwKey, s.password_wrap!, 'pw:kek')
    expect(kek).toHaveLength(32)
    const def = f.db.prepare('SELECT wrapped_key FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as { wrapped_key: string }
    expect(openSealed(kek, def.wrapped_key, `vault:${DEFAULT_VAULT_ID}`)).toHaveLength(32)
    expect(f.vault.hasPassword()).toBe(true)
    expect(f.vault.status().hasPassword).toBe(true)
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW2)).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(state(f).failed_attempts).toBe(1)
  })

  it('changePassword converts a legacy vault and keeps the KEK', async () => {
    const f = await ready()
    f.vault.createVault({ name: 'Prod', color: '#3b82f6' })
    await seedLegacy(f, PW)
    expect(kdfParams(f).every((p) => p !== null)).toBe(true)
    f.vault.setQuickUnlock('touchId')
    const blob = state(f).quick_unlock_blob
    const sealed = f.vault.seal(DEFAULT_VAULT_ID, 'a', 'kept')

    expect(await f.vault.changePassword(PW, PW2)).toEqual({ ok: true })
    expect(kdfParams(f)).toEqual([null, null])
    expect(state(f).quick_unlock_blob).toBe(blob)
    expect(state(f).password_wrap).not.toBeNull()
    expect(f.vault.hasPassword()).toBe(true)

    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', sealed)).toBe('kept')
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(await f.vault.unlock(PW2)).toEqual({ ok: true })
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', sealed)).toBe('kept')
    expect(f.vault.status().corruptVaultIds).toEqual([])
  })

  it('a failed conversion writes nothing', async () => {
    const f = await ready()
    await seedLegacy(f, PW)
    const before = [kdfParams(f), state(f)]
    const realPrepare = f.db.prepare.bind(f.db)
    vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql)
      if (!/^UPDATE vaults SET kdf_params = NULL\b/.test(sql.trim())) return stmt
      return Object.assign(Object.create(stmt) as StatementSync, {
        run: () => {
          throw new Error('disk full')
        },
      })
    })
    await expect(f.vault.changePassword(PW, PW2)).rejects.toThrow(/disk full/)
    vi.restoreAllMocks()
    expect(f.db.isTransaction).toBe(false)
    expect([kdfParams(f), state(f)]).toEqual(before)
    expect(f.vault.hasPassword()).toBe(true)
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
  })

  it('legacy vault still unlocks with its password before any change', async () => {
    const f = await ready()
    await seedLegacy(f, PW)
    const sealed = f.vault.seal(DEFAULT_VAULT_ID, 'a', 'v')
    expect(f.vault.hasPassword()).toBe(true)
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW2)).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', sealed)).toBe('v')
    expect(kdfParams(f).every((p) => p !== null)).toBe(true)
    expect(state(f).password_wrap).toBeNull()
  })

  // Preflight F11: setup(password) is the only setup here, so the trip starts with a password.
  it('setPassword then removePassword round-trips when Touch ID is set', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    expect(f.vault.hasPassword()).toBe(true)

    expect(await f.vault.removePassword(PW)).toEqual({ ok: true })
    expect(f.vault.hasPassword()).toBe(false)
    expect(f.vault.status().hasPassword).toBe(false)
    expect(state(f)).toMatchObject({ password_wrap: null, password_kdf: null })
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })

    expect(await f.vault.setPassword(PW)).toMatchObject({ hasPassword: true, unlocked: true })
    expect(f.vault.hasPassword()).toBe(true)
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })

    expect(events(f)).toEqual(
      expect.arrayContaining([
        { action: 'vault.password', outcome: 'success', details: { op: 'removed' } },
        { action: 'vault.password', outcome: 'success', details: { op: 'set' } },
      ]),
    )
  })

  it('removePassword converts a legacy vault', async () => {
    const f = await ready()
    await seedLegacy(f, PW)
    f.vault.setQuickUnlock('touchId')
    expect(await f.vault.removePassword(PW)).toEqual({ ok: true })
    expect(kdfParams(f)).toEqual([null])
    expect(f.vault.hasPassword()).toBe(false)
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('removePassword refuses with no Touch ID or PIN', async () => {
    // Only a Mac without the Keychain can set up with neither.
    const f = await ready(fakeQuick({ keychain: false, touchId: true }))
    await expect(f.vault.removePassword(PW)).rejects.toThrow('add Touch ID or a PIN first')
    expect(f.vault.hasPassword()).toBe(true)
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
  })

  describe('removePassword counts Touch ID only when its cache holds the live KEK', () => {
    const cases: [string, (q: ReturnType<typeof fakeQuick>, avail: { keychain: boolean; touchId: boolean }) => void][] = [
      [
        'a decrypt that throws',
        (q) =>
          q.keychain.decrypt.mockImplementation(() => {
            throw new Error('keychain reset')
          }),
      ],
      ['a decrypt with the wrong bytes', (q) => q.keychain.decrypt.mockImplementation(() => randomKey().toString('base64'))],
      ['the keychain unavailable', (_q, avail) => (avail.keychain = false)],
    ]
    for (const [name, breakIt] of cases) {
      it(`refuses on ${name}, keeping the password wrap`, async () => {
        const avail = { keychain: true, touchId: true }
        const quick = fakeQuick(avail)
        const f = await ready(quick)
        f.vault.setQuickUnlock('touchId')
        const before = state(f)
        breakIt(quick, avail)
        await expect(f.vault.removePassword(PW)).rejects.toThrow('add Touch ID or a PIN first')
        expect(state(f)).toEqual(before)
        expect(f.vault.hasPassword()).toBe(true)
        expect(events(f)).toContainEqual({
          action: 'vault.password',
          outcome: 'failure',
          details: { op: 'removed', reason: 'no-other-factor' },
        })
        f.vault.lock('manual')
        expect(await f.vault.unlock(PW)).toEqual({ ok: true })
      })
    }
  })

  it('removePassword with no password set refuses before any check', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    await f.vault.removePassword(PW)
    await expect(f.vault.removePassword(PW)).rejects.toThrow('no master password is set')
    expect(state(f).failed_attempts).toBe(0)
  })

  it('removePassword checks the password and needs unlocked', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    expect(await f.vault.removePassword(PW2)).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(f.vault.hasPassword()).toBe(true)
    expect(events(f)).toContainEqual({
      action: 'vault.password',
      outcome: 'failure',
      details: { op: 'removed', reason: 'wrong-password' },
    })
    f.vault.lock('manual')
    await expect(f.vault.removePassword(PW)).rejects.toThrow(VAULT_LOCKED)
  })

  it('setPassword refuses while locked or with a password set', async () => {
    const f = await ready()
    await expect(f.vault.setPassword(PW2)).rejects.toThrow('a master password is already set')
    f.vault.setQuickUnlock('touchId')
    await f.vault.removePassword(PW)
    await expect(f.vault.setPassword('short')).rejects.toThrow(/too short/)
    f.vault.lock('manual')
    await expect(f.vault.setPassword(PW2)).rejects.toThrow(VAULT_LOCKED)
    expect(f.vault.hasPassword()).toBe(false)

    const legacy = await ready()
    await seedLegacy(legacy, PW)
    await expect(legacy.vault.setPassword(PW2)).rejects.toThrow('a master password is already set')
  })

  // Preflight F19: no password wrap means nothing to try, so nothing is counted.
  it('with no password, unlock is unavailable and uncounted', async () => {
    const f = await ready()
    f.vault.setQuickUnlock('touchId')
    await f.vault.removePassword(PW)
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await f.vault.unlock(PW2)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(state(f).failed_attempts).toBe(0)
  })

  it('the last copy of the KEK is never discarded', async () => {
    const quick = fakeQuick()
    const f = await ready(quick)
    f.vault.setQuickUnlock('touchId')
    await f.vault.removePassword(PW)
    expect(() => f.vault.setQuickUnlock('off')).toThrow('add Touch ID or a PIN first')
    const blob = state(f).quick_unlock_blob
    expect(blob).not.toBeNull()

    f.vault.lock('manual')
    quick.keychain.decrypt.mockImplementationOnce(() => {
      throw new Error('keychain locked')
    })
    expect(await f.vault.unlockQuick()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(state(f)).toMatchObject({ quick_unlock: 'touchId', quick_unlock_blob: blob })
    quick.keychain.decrypt.mockImplementationOnce(() => randomKey().toString('base64'))
    expect(await f.vault.unlockQuick()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(state(f)).toMatchObject({ quick_unlock: 'touchId', quick_unlock_blob: blob })
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
  })

  it('reset clears password_wrap and password_kdf', async () => {
    const f = await ready()
    f.vault.lock('manual')
    await f.vault.reset(VAULT_RESET_CONFIRM)
    expect(state(f)).toMatchObject({ password_wrap: null, password_kdf: null })
    expect(f.vault.hasPassword()).toBe(false)
    expect(f.vault.status().setUp).toBe(false)
    await f.vault.setup({ password: PW2, touchId: true })
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW2)).toEqual({ ok: true })
  })

  it('createVault under the wrapped scheme stores null kdf_params', async () => {
    const f = await ready()
    const prod = f.vault.createVault({ name: 'Prod', color: '#3b82f6' })
    const sealed = f.vault.seal(prod.id, 'a', 'p')
    const row = f.db.prepare('SELECT kdf_params FROM vaults WHERE id = ?').get(prod.id) as { kdf_params: string | null }
    expect(row.kdf_params).toBeNull()
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(f.vault.open(prod.id, 'a', sealed)).toBe('p')

    const legacy = await ready()
    await seedLegacy(legacy, PW)
    const old = legacy.vault.createVault({ name: 'Old', color: '#3b82f6' })
    const oldRow = legacy.db.prepare('SELECT kdf_params FROM vaults WHERE id = ?').get(old.id) as { kdf_params: string | null }
    expect(oldRow.kdf_params).not.toBeNull()
  })

  it('audit never carries the password', async () => {
    const f = await ready()
    await seedLegacy(f, PW)
    f.vault.setQuickUnlock('touchId')
    await f.vault.changePassword(PW, PW2)
    await f.vault.removePassword(PW)
    await f.vault.removePassword(PW2)
    await f.vault.setPassword(PW)
    f.vault.lock('manual')
    await f.vault.unlock(PW2)
    await f.vault.unlock(PW)
    const rows = auditRows(f.db)
    expect(rows).not.toContain(PW)
    expect(rows).not.toContain(PW2)
    const s = state(f)
    expect(rows).not.toContain(s.password_wrap!)
  })
})
