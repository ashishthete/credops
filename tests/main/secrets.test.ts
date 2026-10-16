import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { openDatabase } from '../../src/main/db/connection'
import { createSecretHandlers } from '../../src/main/ipc/handlers/secrets'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { SecretStore } from '../../src/main/vault/secret-store'
import type { ClipboardLike } from '../../src/main/vault/types'
import { DEFAULT_VAULT_ID, MAX_SECRET_VALUE, VAULT_LOCKED, type SecretInput } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { auditRows, makeVault } from './vault-helpers'

const PW = 'correct horse'

/** Async like Electron's clipboard; `text` reads it synchronously for asserts. */
function fakeClipboard(): ClipboardLike & { text: string } {
  return {
    text: '',
    async writeText(t) {
      this.text = t
    },
    async readText() {
      return this.text
    },
  }
}

/** Lets pending clipboard promises settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function setup(opts: Parameters<typeof makeVault>[0] = {}) {
  const clipboard = fakeClipboard()
  const f = makeVault({ clipboard, ...opts })
  await f.vault.setup(PW)
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  return { ...f, clipboard, secrets }
}

const dbPass: SecretInput = { vaultId: DEFAULT_VAULT_ID, name: 'DB_PASS', kind: 'env', value: 'hunter22' }

function valueEnc(f: Awaited<ReturnType<typeof setup>>, id: string): string {
  return (f.db.prepare('SELECT value_enc FROM secrets WHERE id = ?').get(id) as { value_enc: string }).value_enc
}

function secretEvents(f: Awaited<ReturnType<typeof setup>>) {
  return f.audit
    .list({ limit: 1000 })
    .reverse()
    .filter((e) => e.action.startsWith('secret.'))
    .map((e) => ({ action: e.action, targetLabel: e.targetLabel, details: e.details }))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SecretStore', () => {
  it('creates and lists without values', async () => {
    const f = await setup()
    const meta = f.secrets.create(dbPass)
    expect(meta).toMatchObject({ vaultId: DEFAULT_VAULT_ID, name: 'DB_PASS', kind: 'env' })
    expect(meta).not.toHaveProperty('value')
    expect(f.secrets.list()).toHaveLength(1)
    expect(f.secrets.list()[0]).not.toHaveProperty('value')
    const enc = valueEnc(f, meta.id)
    expect(enc.startsWith('v1.')).toBe(true)
    expect(enc).not.toContain('hunter22')
    expect(secretEvents(f)).toEqual([{ action: 'secret.create', targetLabel: 'DB_PASS', details: { kind: 'env' } }])
    expect(f.vault.listVaults()[0]!.counts.secrets).toBe(1)
  })

  it('lists sorted by name, per vault', async () => {
    const f = await setup()
    const other = f.vault.createVault({ name: 'Prod', color: '#112233' })
    f.secrets.create({ ...dbPass, name: 'zeta' })
    f.secrets.create({ ...dbPass, name: 'Alpha' })
    f.secrets.create({ ...dbPass, vaultId: other.id, name: 'beta' })
    expect(f.secrets.list().map((s) => s.name)).toEqual(['Alpha', 'beta', 'zeta'])
    expect(f.secrets.list(other.id).map((s) => s.name)).toEqual(['beta'])
  })

  it('refuses a name clash in the same vault only', async () => {
    const f = await setup()
    const other = f.vault.createVault({ name: 'Prod', color: '#112233' })
    f.secrets.create(dbPass)
    expect(() => f.secrets.create({ ...dbPass, value: 'other' })).toThrow(/already exists/)
    expect(() => f.secrets.create({ ...dbPass, name: '  DB_PASS ' })).toThrow(/already exists/)
    expect(() => f.secrets.create({ ...dbPass, vaultId: other.id })).not.toThrow()
    const second = f.secrets.create({ ...dbPass, name: 'OTHER' })
    expect(() => f.secrets.update(second.id, { name: 'DB_PASS' })).toThrow(/already exists/)
  })

  it('round-trips odd values', async () => {
    const f = await setup()
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    const values = ['a\nb=c\r\n', '🔑ünïcødé', 'x'.repeat(65536), pem]
    values.forEach((value, i) => {
      const { id } = f.secrets.create({ ...dbPass, name: `odd-${i}`, value })
      expect(f.secrets.reveal(id)).toEqual({ value })
      expect(f.secrets.value(id)).toBe(value)
    })
  })

  it('update keeps or replaces the value', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    const before = valueEnc(f, id)
    expect(f.secrets.update(id, { name: 'DB_PASSWORD' })).toMatchObject({ id, name: 'DB_PASSWORD' })
    expect(valueEnc(f, id)).toBe(before)
    expect(f.secrets.reveal(id).value).toBe('hunter22')
    f.secrets.update(id, { value: 'n3w-value' })
    expect(f.secrets.reveal(id).value).toBe('n3w-value')
    const updates = secretEvents(f).filter((e) => e.action === 'secret.update')
    expect(updates.map((e) => e.details)).toEqual([{ fields: ['name'] }, { fields: ['value'] }])
    expect(auditRows(f.db)).not.toContain('n3w-value')
  })

  it('an update that changes nothing is not audited', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    f.secrets.update(id, { name: 'DB_PASS', kind: 'env' })
    expect(secretEvents(f).filter((e) => e.action === 'secret.update')).toEqual([])
  })

  it('delete removes the row and is audited', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    f.secrets.delete(id)
    expect(f.secrets.list()).toEqual([])
    expect(secretEvents(f).at(-1)).toMatchObject({ action: 'secret.delete', targetLabel: 'DB_PASS' })
    expect(() => f.secrets.reveal(id)).toThrow(/not found/)
    expect(() => f.secrets.delete(id)).toThrow(/not found/)
  })

  it('reveal and copy are audited without values', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    f.secrets.reveal(id)
    await f.secrets.copy(id)
    const events = secretEvents(f)
    expect(events).toContainEqual(expect.objectContaining({ action: 'secret.reveal', targetLabel: 'DB_PASS' }))
    expect(events).toContainEqual(expect.objectContaining({ action: 'secret.copy', targetLabel: 'DB_PASS' }))
    expect(auditRows(f.db)).not.toContain('hunter22')
  })

  it('copy clears the clipboard after 30 s', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    expect(await f.secrets.copy(id)).toEqual({ clearsInMs: 30000 })
    expect(f.clipboard.text).toBe('hunter22')
    await vi.advanceTimersByTimeAsync(29999)
    expect(f.clipboard.text).toBe('hunter22')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.clipboard.text).toBe('')
  })

  it('a second copy restarts the timer for the new value', async () => {
    const f = await setup()
    const a = f.secrets.create(dbPass)
    const b = f.secrets.create({ ...dbPass, name: 'B', value: 'bbbb' })
    await f.secrets.copy(a.id)
    await vi.advanceTimersByTimeAsync(20000)
    await f.secrets.copy(b.id)
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.clipboard.text).toBe('bbbb')
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.clipboard.text).toBe('')
  })

  it('lock clears only our clipboard', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    await f.secrets.copy(id)
    f.vault.lock('idle')
    await settle()
    expect(f.clipboard.text).toBe('')

    await f.vault.unlock(PW)
    await f.secrets.copy(id)
    f.clipboard.text = 'mine'
    f.vault.lock('idle')
    await settle()
    expect(f.clipboard.text).toBe('mine')

    await f.vault.unlock(PW)
    await f.secrets.copy(id)
    f.clipboard.text = 'mine'
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.clipboard.text).toBe('mine')
  })

  it('a lock while the copy is being written clears it', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    const pending = f.secrets.copy(id)
    f.vault.lock('idle')
    await expect(pending).rejects.toThrow(VAULT_LOCKED)
    await settle()
    expect(f.clipboard.text).toBe('')
  })

  it('a failed clipboard write is not audited as a copy', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    f.clipboard.writeText = () => Promise.reject(new Error('clipboard busy'))
    await expect(f.secrets.copy(id)).rejects.toThrow(/clipboard busy/)
    expect(secretEvents(f).map((e) => e.action)).not.toContain('secret.copy')
  })

  it('known values follow lock state', async () => {
    const f = await setup()
    f.secrets.create(dbPass)
    expect(f.secrets.knownValues()).toContain('hunter22')
    f.audit.append({ action: 'app.start', outcome: 'info', details: { note: 'x hunter22' } })
    expect(auditRows(f.db)).toContain('‹redacted›')
    expect(auditRows(f.db)).not.toContain('hunter22')
    f.vault.lock('manual')
    expect(f.secrets.knownValues()).toEqual([])
  })

  it('known values reload once after unlock and follow changes', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    f.vault.lock('manual')
    await f.vault.unlock(PW)
    expect(f.vault.knownValues()).toEqual([])
    expect(f.secrets.knownValues()).toEqual(['hunter22'])
    f.secrets.update(id, { value: 'n3w-value' })
    expect(f.secrets.knownValues()).toEqual(['n3w-value'])
    f.secrets.delete(id)
    expect(f.secrets.knownValues()).toEqual([])
  })

  it('a revealed value is registered for redaction', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    f.vault.lock('manual')
    await f.vault.unlock(PW)
    f.secrets.reveal(id)
    expect(f.vault.knownValues()).toContain('hunter22')
  })

  it('locked writes are refused', async () => {
    const f = await setup()
    const { id } = f.secrets.create(dbPass)
    f.vault.lock('manual')
    expect(() => f.secrets.create({ ...dbPass, name: 'X' })).toThrow(VAULT_LOCKED)
    expect(() => f.secrets.update(id, { name: 'Y' })).toThrow(VAULT_LOCKED)
    expect(() => f.secrets.delete(id)).toThrow(VAULT_LOCKED)
    expect(() => f.secrets.reveal(id)).toThrow(VAULT_LOCKED)
    await expect(f.secrets.copy(id)).rejects.toThrow(VAULT_LOCKED)
    expect(() => f.secrets.value(id)).toThrow(VAULT_LOCKED)
    expect(f.secrets.list()).toHaveLength(1)
    expect(f.clipboard.text).toBe('')
  })

  it('refuses operations on a corrupt vault', async () => {
    const f = await setup()
    const other = f.vault.createVault({ name: 'Prod', color: '#112233' })
    const { id } = f.secrets.create({ ...dbPass, vaultId: other.id })
    f.vault.lock('manual')
    f.db.prepare("UPDATE vaults SET wrapped_key = 'v1.AAAA.AAAA.AAAA' WHERE id = ?").run(other.id)
    await f.vault.unlock(PW)
    expect(f.vault.status().corruptVaultIds).toEqual([other.id])
    expect(f.secrets.list(other.id)).toHaveLength(1)
    expect(f.secrets.knownValues()).toEqual([])
    expect(() => f.secrets.reveal(id)).toThrow(/corrupt/)
    await expect(f.secrets.copy(id)).rejects.toThrow(/corrupt/)
    expect(() => f.secrets.update(id, { name: 'N' })).toThrow(/corrupt/)
    expect(() => f.secrets.delete(id)).toThrow(/corrupt/)
    expect(() => f.secrets.create({ ...dbPass, vaultId: other.id, name: 'N' })).toThrow(/corrupt/)
  })

  it('validates input in the store too', async () => {
    const f = await setup()
    expect(() => f.secrets.create({ ...dbPass, name: '  ' })).toThrow(/name/)
    expect(() => f.secrets.create({ ...dbPass, name: 'x'.repeat(121) })).toThrow(/name/)
    expect(() => f.secrets.create({ ...dbPass, value: '' })).toThrow(/value/)
    expect(() => f.secrets.create({ ...dbPass, value: 'x'.repeat(MAX_SECRET_VALUE + 1) })).toThrow(/value/)
    expect(() => f.secrets.create({ ...dbPass, kind: 'ssh' as never })).toThrow(/kind/)
    expect(() => f.secrets.create({ ...dbPass, vaultId: '00000000-0000-4000-8000-0000000000ff' })).toThrow(
      /vault not found/,
    )
    expect(f.secrets.create({ ...dbPass, name: '  trimmed  ' }).name).toBe('trimmed')
  })

  it('no plaintext on disk', async () => {
    vi.useRealTimers()
    const dir = mkdtempSync(join(tmpdir(), 'opsdeck-secrets-'))
    try {
      const db = openDatabase(join(dir, 'opsdeck.db'))
      const f = await setup({ db })
      f.secrets.create({ ...dbPass, value: 'needle-7f3a' })
      db.exec('PRAGMA wal_checkpoint(FULL)')
      for (const file of ['opsdeck.db', 'opsdeck.db-wal']) {
        let bytes: Buffer
        try {
          bytes = readFileSync(join(dir, file))
        } catch {
          continue // no WAL file at all is fine
        }
        expect(bytes.includes(Buffer.from('needle-7f3a'))).toBe(false)
      }
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('secret ipc', () => {
  type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown
  const frame = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent

  async function wire() {
    const f = await setup()
    const registered = new Map<string, Fn>()
    const ipc = { handle: (c: string, fn: Fn) => void registered.set(c, fn) }
    registerHandlers(ipc, stubHandlers(createSecretHandlers(f.secrets)), (u) => u === 'file:///ok', {
      validators: VALIDATORS,
      knownSecrets: () => f.secrets.knownValues(),
    })
    return { f, call: (c: string, ...a: unknown[]) => registered.get(c)!(frame, ...a) }
  }

  it('rejects bad secret args', async () => {
    const { call } = await wire()
    const bad = [
      { ...dbPass, value: '' },
      { ...dbPass, value: 'y'.repeat(MAX_SECRET_VALUE + 1) },
      { ...dbPass, kind: 'ssh' },
      { ...dbPass, name: '   ' },
      { ...dbPass, name: 'n'.repeat(121) },
      { ...dbPass, value: 'hunter22', extra: 1 },
    ]
    for (const input of bad) {
      const err = await (call('secret:create', input) as Promise<unknown>).then(
        () => null,
        (e: Error) => e,
      )
      expect(err?.message).toMatch(/invalid arguments/)
      expect(err?.message).not.toContain('yyyy')
      expect(err?.message).not.toContain('hunter22')
    }
    await expect(call('secret:update', 'not-a-uuid', { name: 'x' })).rejects.toThrow(/invalid arguments/)
    await expect(call('secret:update', DEFAULT_VAULT_ID, { vaultId: DEFAULT_VAULT_ID })).rejects.toThrow(
      /invalid arguments/,
    )
    await expect(call('secret:list', 42)).rejects.toThrow(/invalid arguments/)
  })

  it('maps each channel onto the store', async () => {
    const { f, call } = await wire()
    const meta = (await call('secret:create', { ...dbPass, name: ' DB_PASS ' })) as { id: string; name: string }
    expect(meta.name).toBe('DB_PASS')
    expect(await call('secret:list')).toHaveLength(1)
    expect(await call('secret:list', DEFAULT_VAULT_ID)).toHaveLength(1)
    expect(await call('secret:reveal', meta.id)).toEqual({ value: 'hunter22' })
    expect(await call('secret:copy', meta.id)).toEqual({ clearsInMs: 30000 })
    expect(f.clipboard.text).toBe('hunter22')
    expect(await call('secret:update', meta.id, { kind: 'password' })).toMatchObject({ kind: 'password' })
    await call('secret:delete', meta.id)
    expect(await call('secret:list')).toEqual([])
  })
})
