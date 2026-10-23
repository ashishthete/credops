import { describe, expect, it } from 'vitest'
import { migrateFromOpsDeck, type MigrationDeps } from '../../src/main/rename-migration'

const OLD = '/data/opsdeck'
const NEW = '/data/credops'
const KEY = 'c2VjcmV0LWtleS1ieXRlcw=='

function fake(opts: { files?: string[]; oldKey?: string | null; newKey?: boolean; addFails?: boolean; addSilentlyFails?: boolean; readFails?: boolean } = {}) {
  const files = new Set(opts.files ?? [OLD, `${OLD}/opsdeck.db`, `${OLD}/opsdeck.db-wal`, `${OLD}/Local Storage`])
  const keys = new Map<string, string>()
  if (opts.oldKey !== null) keys.set('OpsDeck Safe Storage', opts.oldKey ?? KEY)
  if (opts.newKey) keys.set('CredOps Safe Storage', 'existing')
  const calls: string[] = []
  const d: MigrationDeps = {
    exists: (p) => files.has(p),
    copyDir: (from, to) => {
      calls.push(`copy ${from} ${to}`)
      for (const f of [...files]) if (f === from || f.startsWith(`${from}/`)) files.add(to + f.slice(from.length))
    },
    rename: (from, to) => {
      calls.push(`rename ${from} ${to}`)
      for (const f of [...files])
        if (f === from || f.startsWith(`${from}/`)) {
          files.delete(f)
          files.add(to + f.slice(from.length))
        }
    },
    remove: (p) => {
      calls.push(`remove ${p}`)
      for (const f of [...files]) if (f === p || f.startsWith(`${p}/`)) files.delete(f)
    },
    list: (dir) => [...files].filter((f) => f.startsWith(`${dir}/`)),
    now: () => 123,
    keychain: {
      has: (i) => keys.has(i.service),
      remove: (i) => {
        calls.push(`delete ${i.service}`)
        keys.delete(i.service)
      },
      read: (i) => {
        if (opts.readFails) throw new Error('denied')
        return keys.get(i.service) ?? null
      },
      add: (i, pw) => {
        calls.push(`add ${i.service} ${i.account}`)
        if (opts.addFails) throw new Error('denied')
        if (!opts.addSilentlyFails) keys.set(i.service, pw)
      },
    },
  }
  return { d, files, keys, calls }
}

describe('migrateFromOpsDeck', () => {
  it('copies the key, then the folder, renaming the database files', () => {
    const f = fake()
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toBe('migrated')
    expect(f.keys.get('CredOps Safe Storage')).toBe(KEY)
    expect(f.calls.indexOf('add CredOps Safe Storage CredOps Key')).toBeLessThan(f.calls.findIndex((c) => c.startsWith('copy')))
    expect([...f.files].filter((p) => p.startsWith(NEW)).sort()).toEqual([NEW, `${NEW}/Local Storage`, `${NEW}/credops.db`, `${NEW}/credops.db-wal`])
  })

  it('keeps the OpsDeck folder and Keychain item', () => {
    const f = fake()
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.files.has(`${OLD}/opsdeck.db`)).toBe(true)
    expect(f.keys.get('OpsDeck Safe Storage')).toBe(KEY)
    expect(f.calls.some((c) => c.startsWith(`remove ${OLD}`))).toBe(false)
  })

  it('does nothing once CredOps has its database, or when there was no OpsDeck', () => {
    const done = fake({ files: [OLD, `${OLD}/opsdeck.db`, NEW, `${NEW}/credops.db`] })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, done.d)).toBe('none')
    const fresh = fake({ files: [] })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, fresh.d)).toBe('none')
    expect([...done.calls, ...fresh.calls]).toEqual([])
  })

  it('replaces a key Electron made before the data moved', () => {
    const f = fake({ newKey: true })
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.calls).toContain('delete CredOps Safe Storage')
    expect(f.keys.get('CredOps Safe Storage')).toBe(KEY)
  })

  it('moves aside a folder Electron filled before the data moved', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, NEW, `${NEW}/Local State`] })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toBe('migrated')
    expect(f.files.has(`${NEW}.unused-123/Local State`)).toBe(true)
    expect(f.files.has(`${NEW}/credops.db`)).toBe(true)
    expect(f.files.has(`${NEW}/Local State`)).toBe(false)
  })

  it('removes the folder Electron made when it is still empty', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, NEW] })
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.calls).toContain(`remove ${NEW}`)
    expect(f.files.has(`${NEW}/credops.db`)).toBe(true)
  })

  it('still moves the data when OpsDeck never made a key', () => {
    const f = fake({ oldKey: null })
    expect(migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toBe('migrated')
    expect(f.keys.has('CredOps Safe Storage')).toBe(false)
  })

  it.each([
    ['the key cannot be read', { readFails: true }, "couldn't read"],
    ['the key cannot be saved', { addFails: true }, "couldn't save"],
    ['the save reports success but the key does not read back', { addSilentlyFails: true }, "couldn't save"],
    ['the save reports success but an old key stays', { addSilentlyFails: true, newKey: true }, "couldn't save"],
    ['the key has an unexpected shape', { oldKey: 'a" -A "b' }, 'expected format'],
  ])('moves no data when %s', (_why, opts, message) => {
    const f = fake(opts)
    expect(() => migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)).toThrow(message)
    expect([...f.files].some((p) => p.startsWith(NEW))).toBe(false)
  })

  it('never puts the key in an error message', () => {
    const f = fake({ oldKey: 'bad key with spaces' })
    try {
      migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    } catch (err) {
      expect((err as Error).message).not.toContain('bad key')
    }
  })

  it('restarts a copy a crash left half-done', () => {
    const f = fake({ files: [OLD, `${OLD}/opsdeck.db`, `${NEW}.migrating`, `${NEW}.migrating/junk`] })
    migrateFromOpsDeck({ oldDir: OLD, newDir: NEW }, f.d)
    expect(f.calls).toContain(`remove ${NEW}.migrating`)
    expect(f.files.has(`${NEW}/junk`)).toBe(false)
    expect(f.files.has(`${NEW}/credops.db`)).toBe(true)
  })
})
