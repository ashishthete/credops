import { beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { migrate, migrations } from '../../src/main/db/migrations'
import { SSO_N } from '../../src/main/db/sso-migration'
import { makeVault, type VaultFixture } from './vault-helpers'

const PW = 'correct horse'
let f: VaultFixture
let db: Db

beforeAll(async () => {
  db = openDatabase(':memory:')
  migrate(db, migrations.filter((m) => m.version < SSO_N))
  f = makeVault({ db })
  await f.vault.setup(PW)
  migrate(db)
})

describe('sso migration', () => {
  it('adds the PIN and password columns with defaults', () => {
    const row = db
      .prepare('SELECT pin_failed, pin_wrap, password_wrap, last_method FROM vault_state WHERE id = 1')
      .get() as Record<string, unknown>
    expect(row.pin_failed).toBe(0)
    expect(row.pin_wrap).toBeNull()
    expect(row.password_wrap).toBeNull()
    expect(row.last_method).toBeNull()
  })

  it('creates an empty sso_binding', () => {
    expect((db.prepare('SELECT COUNT(*) AS n FROM sso_binding').get() as { n: number }).n).toBe(0)
    expect(() =>
      db
        .prepare("INSERT INTO sso_binding(id, hub_id, user_oid, user_upn, bound_at) VALUES (2, 'h', 'o', 'u', 't')")
        .run(),
    ).toThrow()
  })

  it('keeps an existing vault opening with its password', async () => {
    const g = makeVault({ db })
    expect(await g.vault.unlock(PW)).toEqual({ ok: true })
  })

  it('rejects an unknown last_method', () => {
    expect(() => db.prepare("UPDATE vault_state SET last_method = 'face' WHERE id = 1").run()).toThrow()
  })

  it('status reports the new fields', () => {
    expect(f.vault.status()).toMatchObject({
      hasPassword: true,
      pin: { enabled: false, attemptsLeft: 5 },
      lastMethod: null,
      sso: { required: false },
    })
  })
})
