import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementSync } from 'node:sqlite'
import { deriveKek, openSealed, type KdfParams } from '../../src/main/vault/crypto'
import { unlockDelayMs, VaultService } from '../../src/main/vault/vault-service'
import { DEFAULT_VAULT_ID, MAX_MASTER_PASSWORD, MIN_MASTER_PASSWORD, VAULT_LOCKED } from '../../src/shared/vault'
import { auditRows, FAST_KDF, makeVault } from './vault-helpers'

vi.mock('../../src/main/vault/crypto', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/main/vault/crypto')>()
  return { ...mod, deriveKek: vi.fn(mod.deriveKek) }
})

const PW = 'correct horse'
const PW2 = 'battery staple!'

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(deriveKek).mockClear()
})

function defaultRow(db: ReturnType<typeof makeVault>['db']): { wrapped_key: string | null; kdf_params: string | null } {
  return db.prepare('SELECT wrapped_key, kdf_params FROM vaults WHERE id = ?').get(DEFAULT_VAULT_ID) as never
}

function actions(f: ReturnType<typeof makeVault>): { action: string; outcome: string; details: unknown; targetLabel: string | null }[] {
  return f.audit
    .list({ limit: 1000 })
    .reverse()
    .map((e) => ({ action: e.action, outcome: e.outcome, details: e.details, targetLabel: e.targetLabel }))
}

describe('VaultService', () => {
  it('starts not set up and locked', () => {
    const { vault } = makeVault()
    expect(vault.status()).toMatchObject({ setUp: false, unlocked: false, autoLockMinutes: 15, retryAfterMs: 0 })
    expect(vault.isUnlocked()).toBe(false)
    const list = vault.listVaults()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: DEFAULT_VAULT_ID, name: 'Default', isDefault: true })
    expect(list[0]!.counts).toEqual({ secrets: 0, keys: 0, identities: 0 })
  })

  it('setup keys the default vault and unlocks', async () => {
    const f = makeVault()
    expect(await f.vault.setup(PW)).toMatchObject({ setUp: true, unlocked: true })
    expect(f.vault.status().unlocked).toBe(true)
    const row = defaultRow(f.db)
    expect(row.wrapped_key).not.toBeNull()
    const params = JSON.parse(row.kdf_params!) as { N: number; salt: string }
    expect(params.N).toBe(FAST_KDF.N)
    expect(Buffer.from(params.salt, 'base64')).toHaveLength(16)
    await expect(f.vault.setup(PW)).rejects.toThrow(/already set up/)
    expect(actions(f)).toContainEqual(expect.objectContaining({ action: 'vault.setup', outcome: 'success' }))

    const fresh = makeVault()
    await expect(fresh.vault.setup('short')).rejects.toThrow(/too short/)
    await expect(fresh.vault.setup('x'.repeat(MAX_MASTER_PASSWORD + 1))).rejects.toThrow(/too long/)
    expect(fresh.vault.status().setUp).toBe(false)
    // The minimum is MIN_MASTER_PASSWORD (8): 7 is refused, 8 is accepted.
    await expect(fresh.vault.setup('x'.repeat(MIN_MASTER_PASSWORD - 1))).rejects.toThrow(/too short/)
    expect(MIN_MASTER_PASSWORD).toBe(8)
    expect(await fresh.vault.setup('x'.repeat(MIN_MASTER_PASSWORD))).toMatchObject({ setUp: true })
  })

  it('unlock and lock', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    const onLock = vi.fn()
    f.vault.onLock(onLock)
    f.vault.lock('manual')
    expect(f.vault.isUnlocked()).toBe(false)
    expect(onLock).toHaveBeenCalledWith('manual')
    expect(() => f.vault.seal(DEFAULT_VAULT_ID, 'a', 'v')).toThrow(VAULT_LOCKED)
    expect(() => f.vault.assertUnlocked()).toThrow(VAULT_LOCKED)
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', f.vault.seal(DEFAULT_VAULT_ID, 'a', 'v'))).toBe('v')

    const seq = actions(f)
    expect(seq).toContainEqual(expect.objectContaining({ action: 'vault.lock', details: { reason: 'manual' } }))
    expect(seq).toContainEqual(
      expect.objectContaining({ action: 'vault.unlock', outcome: 'success', details: { method: 'password' } }),
    )

    f.vault.lock('manual')
    const count = actions(f).length
    f.vault.lock('manual')
    expect(actions(f)).toHaveLength(count)
    expect(onLock).toHaveBeenCalledTimes(2)
  })

  it('onUnlock fires once per unlock, not on a failed attempt', async () => {
    const quick = {
      keychain: { available: () => true, encrypt: (p: string) => Buffer.from(p, 'utf8'), decrypt: (b: Buffer) => b.toString('utf8') },
      touchId: { available: () => true, prompt: async () => undefined },
    }
    const f = makeVault({ quick })
    await f.vault.setup(PW)
    f.vault.setQuickUnlock('touchId')
    f.vault.lock('manual')
    const onUnlock = vi.fn()
    const off = f.vault.onUnlock(onUnlock)
    expect(await f.vault.unlock('wrong password')).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(onUnlock).not.toHaveBeenCalled()
    f.now.t += 60_000
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(onUnlock).toHaveBeenCalledTimes(1)
    f.vault.lock('manual')
    expect(await f.vault.unlockQuick()).toEqual({ ok: true })
    expect(onUnlock).toHaveBeenCalledTimes(2)
    off()
    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(onUnlock).toHaveBeenCalledTimes(2)
  })

  it('onUnlock fires on first-run setup, after the serial section, and survives a throwing listener', async () => {
    const f = makeVault()
    const seen: { unlocked: boolean; audited: boolean }[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.vault.onUnlock(() => {
      throw new Error('listener broke: -----BEGIN OPENSSH PRIVATE KEY-----abc')
    })
    f.vault.onUnlock(() => {
      // The section's last step, its audit row, is already written.
      seen.push({ unlocked: f.vault.isUnlocked(), audited: actions(f).some((e) => e.action === 'vault.setup') })
    })
    await f.vault.setup(PW)
    expect(seen).toEqual([{ unlocked: true, audited: true }])
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls.flat().map(String).join(' ')).not.toContain('BEGIN OPENSSH')
    // A password change while unlocked is not a transition.
    expect(await f.vault.changePassword(PW, PW2)).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
  })

  it('a rejecting unlock listener and a throwing lock listener are both logged redacted', async () => {
    const f = makeVault()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    f.vault.onUnlock(async () => {
      throw new Error('async broke: -----BEGIN OPENSSH PRIVATE KEY-----abc')
    })
    f.vault.onLock(() => {
      throw new Error('lock broke: -----BEGIN OPENSSH PRIVATE KEY-----abc')
    })
    f.vault.onLock(later)
    await f.vault.setup(PW)
    await new Promise((r) => setTimeout(r, 0))
    f.vault.lock('manual')
    expect(later).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(2)
    expect(error.mock.calls.flat().map(String).join(' ')).not.toContain('BEGIN OPENSSH')
  })

  it('unlock before setup throws', async () => {
    const { vault } = makeVault()
    await expect(vault.unlock(PW)).rejects.toThrow(/not set up/)
  })

  it('backs off after three failures', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    f.vault.lock('manual')

    const delays: number[] = []
    for (let i = 0; i < 3; i++) {
      const r = await f.vault.unlock('wrong password')
      expect(r).toMatchObject({ ok: false, reason: 'wrong-password' })
      delays.push(r.ok ? -1 : r.retryAfterMs)
    }
    expect(delays).toEqual([0, 0, 1000])

    vi.mocked(deriveKek).mockClear()
    expect(await f.vault.unlock(PW)).toEqual({ ok: false, reason: 'throttled', retryAfterMs: 1000 })
    expect(deriveKek).not.toHaveBeenCalled()
    expect(f.vault.status().retryAfterMs).toBe(1000)

    f.now.t += 1000
    expect(await f.vault.unlock('wrong password')).toMatchObject({
      ok: false,
      reason: 'wrong-password',
      retryAfterMs: 2000,
    })

    const again = new VaultService(f.db, f.audit, { kdf: FAST_KDF, now: () => new Date(f.now.t) })
    expect(again.status().retryAfterMs).toBe(2000)
    expect(await again.unlock(PW)).toMatchObject({ ok: false, reason: 'throttled', retryAfterMs: 2000 })

    f.now.t += 2000
    expect(await again.unlock(PW)).toEqual({ ok: true })
    const state = f.db.prepare('SELECT failed_attempts, last_failed_at FROM vault_state').get() as {
      failed_attempts: number
      last_failed_at: string | null
    }
    expect(state).toEqual({ failed_attempts: 0, last_failed_at: null })
    expect(again.status().retryAfterMs).toBe(0)

    expect(unlockDelayMs(0)).toBe(0)
    expect(unlockDelayMs(2)).toBe(0)
    expect(unlockDelayMs(3)).toBe(1000)
    expect(unlockDelayMs(4)).toBe(2000)
    expect(unlockDelayMs(50)).toBe(300000)
  })

  it('tampered wrapped key fails closed', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    f.vault.lock('manual')
    const wrapped = defaultRow(f.db).wrapped_key!
    const i = wrapped.length - 5
    const tampered = wrapped.slice(0, i) + (wrapped[i] === 'A' ? 'B' : 'A') + wrapped.slice(i + 1)
    f.db.prepare('UPDATE vaults SET wrapped_key = ? WHERE id = ?').run(tampered, DEFAULT_VAULT_ID)
    expect(await f.vault.unlock(PW)).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(f.vault.isUnlocked()).toBe(false)
  })

  it('wraps each vault key under aad vault:<id>', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    const prod = f.vault.createVault({ name: 'Prod', color: '#ff0000' })
    const kek = await deriveKek(PW, JSON.parse(defaultRow(f.db).kdf_params!) as KdfParams)
    for (const id of [DEFAULT_VAULT_ID, prod.id]) {
      const row = f.db.prepare('SELECT wrapped_key FROM vaults WHERE id = ?').get(id) as { wrapped_key: string }
      expect(openSealed(kek, row.wrapped_key, `vault:${id}`)).toHaveLength(32)
    }
  })

  it('a corrupt non-default vault does not fail the unlock', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    const prod = f.vault.createVault({ name: 'Prod', color: '#ff0000' })
    const sealed = f.vault.seal(DEFAULT_VAULT_ID, 'a', 'one')
    f.vault.lock('manual')
    const row = f.db.prepare('SELECT wrapped_key FROM vaults WHERE id = ?').get(prod.id) as { wrapped_key: string }
    const i = row.wrapped_key.length - 5
    const bad = row.wrapped_key.slice(0, i) + (row.wrapped_key[i] === 'A' ? 'B' : 'A') + row.wrapped_key.slice(i + 1)
    f.db.prepare('UPDATE vaults SET wrapped_key = ? WHERE id = ?').run(bad, prod.id)

    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    expect(f.vault.status().corruptVaultIds).toEqual([prod.id])
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', sealed)).toBe('one')
    expect(() => f.vault.seal(prod.id, 'x', 'v')).toThrow(/corrupt/)
    expect(f.db.prepare('SELECT failed_attempts FROM vault_state').get()).toEqual({ failed_attempts: 0 })
    expect(actions(f).at(-1)).toMatchObject({
      action: 'vault.unlock',
      outcome: 'success',
      details: { method: 'password', corrupt: [prod.id] },
    })

    // A password change still works and leaves the corrupt vault as it was.
    expect(await f.vault.changePassword(PW, PW2)).toEqual({ ok: true })
    f.vault.lock('manual')
    expect(f.vault.status().corruptVaultIds).toEqual([])
    expect(await f.vault.unlock(PW2)).toEqual({ ok: true })
    expect(f.vault.status().corruptVaultIds).toEqual([prod.id])
    f.vault.deleteVault(prod.id)
    expect(f.vault.status().corruptVaultIds).toEqual([])
  })

  it('a lock during unlock derivation cancels it', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    f.vault.lock('manual')
    const derived = Buffer.alloc(32, 7)
    let release!: () => void
    vi.mocked(deriveKek).mockImplementationOnce(
      () => new Promise<Buffer>((resolve) => (release = () => resolve(derived))),
    )
    const pending = f.vault.unlock(PW)
    await vi.waitFor(() => expect(deriveKek).toHaveBeenCalled())
    f.vault.lock('screen')
    release()
    expect(await pending).toEqual({ ok: false, reason: 'cancelled', retryAfterMs: 0 })
    expect(f.vault.isUnlocked()).toBe(false)
    expect(derived.every((b) => b === 0)).toBe(true)
    expect(f.db.prepare('SELECT failed_attempts FROM vault_state').get()).toEqual({ failed_attempts: 0 })
    expect(await f.vault.unlock(PW)).toEqual({ ok: true })
  })

  it('a lock during setup derivation cancels it', async () => {
    const f = makeVault()
    const derived = Buffer.alloc(32, 7)
    let release!: () => void
    vi.mocked(deriveKek).mockImplementationOnce(
      () => new Promise<Buffer>((resolve) => (release = () => resolve(derived))),
    )
    const pending = f.vault.setup(PW)
    await vi.waitFor(() => expect(deriveKek).toHaveBeenCalled())
    f.vault.lock('screen')
    release()
    await expect(pending).rejects.toThrow(VAULT_LOCKED)
    expect(f.vault.isUnlocked()).toBe(false)
    expect(f.vault.status().setUp).toBe(false)
    expect(derived.every((b) => b === 0)).toBe(true)
  })

  it('a lock during either password-change derivation cancels it', async () => {
    for (const which of [1, 2]) {
      const f = makeVault()
      await f.vault.setup(PW)
      const derived = Buffer.alloc(32, 7)
      let release!: () => void
      const real = vi.mocked(deriveKek).getMockImplementation()!
      let calls = 0
      vi.mocked(deriveKek).mockImplementation((pw, params) => {
        if (++calls !== which) return real(pw, params)
        return new Promise<Buffer>((resolve) => (release = () => resolve(derived)))
      })
      const before = defaultRow(f.db)
      const pending = f.vault.changePassword(PW, PW2)
      await vi.waitFor(() => expect(calls).toBe(which))
      f.vault.lock('screen')
      release()
      expect(await pending).toEqual({ ok: false, reason: 'cancelled', retryAfterMs: 0 })
      vi.mocked(deriveKek).mockImplementation(real)
      expect(f.vault.isUnlocked()).toBe(false)
      expect(derived.every((b) => b === 0)).toBe(true)
      expect(defaultRow(f.db)).toEqual(before)
      expect(await f.vault.unlock(PW)).toEqual({ ok: true })
    }
  })

  it('rejects unusable kdf params without deriving', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    f.vault.lock('manual')
    f.db
      .prepare('UPDATE vaults SET kdf_params = ? WHERE id = ?')
      .run(JSON.stringify({ alg: 'scrypt', N: 2, r: 8, p: 1, salt: 'AAAA' }), DEFAULT_VAULT_ID)
    await expect(f.vault.unlock(PW)).rejects.toThrow(/invalid kdf params/)
    expect(f.vault.isUnlocked()).toBe(false)
  })

  it('vault crud', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    const prod = f.vault.createVault({ name: 'Prod', color: '#ff0000' })
    expect(prod).toMatchObject({ name: 'Prod', color: '#ff0000', isDefault: false })
    const prodRow = f.db.prepare('SELECT wrapped_key, kdf_params FROM vaults WHERE id = ?').get(prod.id) as {
      wrapped_key: string
      kdf_params: string
    }
    expect(prodRow.wrapped_key).toBeTruthy()
    expect(prodRow.wrapped_key).not.toBe(defaultRow(f.db).wrapped_key)
    expect(prodRow.kdf_params).toBe(defaultRow(f.db).kdf_params)

    const sealed = f.vault.seal(prod.id, 'x', 'v')
    f.vault.lock('manual')
    await f.vault.unlock(PW)
    expect(f.vault.open(prod.id, 'x', sealed)).toBe('v')
    expect(f.vault.open(prod.id, 'x', f.vault.seal(prod.id, 'x', 'v'))).toBe('v')
    expect(() => f.vault.open(DEFAULT_VAULT_ID, 'x', sealed)).toThrow(/decrypt failed/)

    expect(() => f.vault.createVault({ name: 'pROD', color: '#00ff00' })).toThrow(/already exists/)
    expect(() => f.vault.createVault({ name: '   ', color: '#00ff00' })).toThrow(/name/)
    expect(() => f.vault.createVault({ name: 'X', color: 'red' })).toThrow(/color/)

    expect(f.vault.listVaults().map((m) => m.name)).toEqual(['Default', 'Prod'])
    f.vault.createVault({ name: 'Alpha', color: '#00ff00' })
    expect(f.vault.listVaults().map((m) => m.name)).toEqual(['Default', 'Alpha', 'Prod'])

    expect(f.vault.updateVault(prod.id, { name: 'Production' })).toMatchObject({ name: 'Production', color: '#ff0000' })
    expect(() => f.vault.updateVault(prod.id, { name: 'alpha' })).toThrow(/already exists/)
    expect(f.vault.updateVault(prod.id, { name: 'PRODUCTION' }).name).toBe('PRODUCTION')
    expect(() => f.vault.deleteVault(DEFAULT_VAULT_ID)).toThrow(/cannot delete the Default vault/)
    f.vault.deleteVault(prod.id)
    expect(f.vault.listVaults().map((m) => m.id)).not.toContain(prod.id)
    expect(() => f.vault.seal(prod.id, 'x', 'v')).toThrow(/not found/)
    expect(() => f.vault.deleteVault(prod.id)).toThrow(/not found/)

    const seq = actions(f)
    expect(seq).toContainEqual(expect.objectContaining({ action: 'vault.create', targetLabel: 'Prod' }))
    expect(seq).toContainEqual(expect.objectContaining({ action: 'vault.update', targetLabel: 'Production' }))
    expect(seq).toContainEqual(expect.objectContaining({ action: 'vault.delete', targetLabel: 'PRODUCTION' }))

    f.vault.lock('manual')
    expect(() => f.vault.createVault({ name: 'Q', color: '#000000' })).toThrow(VAULT_LOCKED)
    expect(() => f.vault.updateVault(DEFAULT_VAULT_ID, { name: 'Q' })).toThrow(VAULT_LOCKED)
    expect(() => f.vault.deleteVault(DEFAULT_VAULT_ID)).toThrow(VAULT_LOCKED)
    expect(() => f.vault.open(DEFAULT_VAULT_ID, 'x', sealed)).toThrow(VAULT_LOCKED)
    expect(f.vault.listVaults()).toHaveLength(2)
  })

  it('delete removes the vault contents', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    const v = f.vault.createVault({ name: 'Ops', color: '#123456' })
    const t = '2026-01-01T00:00:00.000Z'
    f.db
      .prepare("INSERT INTO secrets VALUES ('s1', ?, 'n', 'token', ?, ?, ?)")
      .run(v.id, f.vault.seal(v.id, 'secret:s1:value', 'x'), t, t)
    f.db
      .prepare(
        "INSERT INTO ssh_keys(id,vault_id,label,key_type,public_key,fingerprint,source,file_path,created_at,updated_at) VALUES ('k1',?,'l','ssh-ed25519','p','f','file','/tmp/k',?,?)",
      )
      .run(v.id, t, t)
    f.db
      .prepare(
        "INSERT INTO identities(id,vault_id,label,username,auth,ssh_key_id,created_at,updated_at) VALUES ('i1',?,'l','u','key','k1',?,?)",
      )
      .run(v.id, t, t)
    expect(f.vault.listVaults().find((m) => m.id === v.id)!.counts).toEqual({ secrets: 1, keys: 1, identities: 1 })
    f.vault.deleteVault(v.id)
    for (const table of ['secrets', 'ssh_keys', 'identities']) {
      expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  })

  it('password change is atomic', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    const prod = f.vault.createVault({ name: 'Prod', color: '#ff0000' })
    const a = f.vault.seal(DEFAULT_VAULT_ID, 'a', 'one')
    const b = f.vault.seal(prod.id, 'b', 'two')

    expect(await f.vault.changePassword('not it at all', PW2)).toMatchObject({ ok: false, reason: 'wrong-password' })
    await expect(f.vault.changePassword(PW, 'short')).rejects.toThrow(/too short/)
    expect(await f.vault.changePassword(PW, PW2)).toEqual({ ok: true })
    expect(f.vault.isUnlocked()).toBe(true)
    expect(f.vault.open(prod.id, 'b', b)).toBe('two')
    const rows = f.db.prepare('SELECT DISTINCT kdf_params FROM vaults').all()
    expect(rows).toHaveLength(1)

    f.vault.lock('manual')
    expect(await f.vault.unlock(PW)).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(await f.vault.unlock(PW2)).toEqual({ ok: true })
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', a)).toBe('one')
    expect(f.vault.open(prod.id, 'b', b)).toBe('two')
    expect(actions(f)).toContainEqual(expect.objectContaining({ action: 'vault.rekey', outcome: 'success' }))

    // Fail the second vault's re-wrap: nothing may change on disk or in memory.
    const before = f.db.prepare('SELECT id, wrapped_key, kdf_params FROM vaults ORDER BY id').all()
    const realPrepare = f.db.prepare.bind(f.db)
    let updates = 0
    vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql)
      if (!/^UPDATE vaults\b/.test(sql.trim())) return stmt
      const run = stmt.run.bind(stmt)
      return Object.assign(Object.create(stmt) as StatementSync, {
        run: (...p: Parameters<StatementSync['run']>) => {
          if (++updates === 2) throw new Error('disk full')
          return run(...p)
        },
      })
    })
    await expect(f.vault.changePassword(PW2, 'third password')).rejects.toThrow(/disk full/)
    vi.restoreAllMocks()
    expect(updates).toBe(2)
    expect(f.db.isTransaction).toBe(false)
    expect(f.db.prepare('SELECT id, wrapped_key, kdf_params FROM vaults ORDER BY id').all()).toEqual(before)
    expect(f.vault.open(prod.id, 'b', b)).toBe('two')
    expect(actions(f)).toContainEqual(expect.objectContaining({ action: 'vault.rekey', outcome: 'failure' }))

    f.vault.lock('manual')
    expect(await f.vault.unlock('third password')).toMatchObject({ ok: false, reason: 'wrong-password' })
    expect(await f.vault.unlock(PW2)).toEqual({ ok: true })
    expect(f.vault.open(DEFAULT_VAULT_ID, 'a', a)).toBe('one')
    expect(f.vault.open(prod.id, 'b', b)).toBe('two')
  })

  it('changePassword requires unlocked', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    f.vault.lock('manual')
    await expect(f.vault.changePassword(PW, PW2)).rejects.toThrow(VAULT_LOCKED)
  })

  it('serializes concurrent unlocks so the throttle holds', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    f.vault.lock('manual')
    await f.vault.unlock('wrong password')
    await f.vault.unlock('wrong password')
    vi.mocked(deriveKek).mockClear()
    const results = await Promise.all([f.vault.unlock('wrong one'), f.vault.unlock('wrong two')])
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['wrong-password', 'throttled'])
    expect(deriveKek).toHaveBeenCalledTimes(1)
  })

  it('known values are lock-aware', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    f.vault.registerKnown('secrets', ['hunter22', 'tok'])
    f.vault.registerKnown('keys', ['pp'])
    expect([...f.vault.knownValues()].sort()).toEqual(['hunter22', 'pp', 'tok'])
    f.vault.registerKnown('secrets', ['hunter22'])
    expect([...f.vault.knownValues()].sort()).toEqual(['hunter22', 'pp'])
    f.vault.lock('manual')
    expect(f.vault.knownValues()).toEqual([])
    f.vault.registerKnown('secrets', ['late'])
    expect(f.vault.knownValues()).toEqual([])
  })

  it('no password in audit', async () => {
    const f = makeVault()
    await f.vault.setup(PW)
    await f.vault.changePassword(PW, PW2)
    f.vault.lock('manual')
    await f.vault.unlock(PW)
    await f.vault.unlock(PW2)
    const rows = auditRows(f.db)
    expect(rows).not.toContain(PW)
    expect(rows).not.toContain(PW2)
  })
})
