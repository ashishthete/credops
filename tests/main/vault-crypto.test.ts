import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KDF,
  deriveKek,
  newKdfParams,
  openSealed,
  randomKey,
  seal,
} from '../../src/main/vault/crypto'

describe('vault crypto', () => {
  it('seals and opens', () => {
    const k = randomKey()
    const a = seal(k, 'héllo 🔑', 'a')
    const b = seal(k, 'héllo 🔑', 'a')
    expect(openSealed(k, a, 'a').toString()).toBe('héllo 🔑')
    expect(a).not.toBe(b)
    for (const s of [a, b]) expect(s).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('aad binds rows', () => {
    const k = randomKey()
    const s = seal(k, 'x', 'secret:A:value')
    expect(() => openSealed(k, s, 'secret:B:value')).toThrow(/decrypt failed/)
  })

  it('detects tampering', () => {
    const k = randomKey()
    const s = seal(k, 'some secret text', 'a')
    const parts = s.split('.')
    parts[2] = (parts[2]![0] === 'A' ? 'B' : 'A') + parts[2]!.slice(1)
    expect(() => openSealed(k, parts.join('.'), 'a')).toThrow(/decrypt failed/)
    expect(() => openSealed(randomKey(), s, 'a')).toThrow(/decrypt failed/)
    expect(() => openSealed(k, 'garbage', 'a')).toThrow(/decrypt failed/)
  })

  it('derives deterministically', async () => {
    const base = { alg: 'scrypt' as const, N: 2 ** 10, r: 8, p: 1 }
    const params = newKdfParams(base)
    const k1 = await deriveKek('Pässword1!', params)
    expect(k1).toHaveLength(32)
    expect(await deriveKek('Pässword1!', params)).toEqual(k1)
    expect(await deriveKek('Pässword1!', newKdfParams(base))).not.toEqual(k1)
    expect(await deriveKek('Pässword1!'.normalize('NFD'), params)).toEqual(k1)
  })

  it('rejects unusable kdf params', async () => {
    const good = newKdfParams({ alg: 'scrypt', N: 2 ** 10, r: 8, p: 1 })
    const bad = [
      { ...good, alg: 'pbkdf2' },
      { ...good, N: 2 ** 9 },
      { ...good, salt: Buffer.alloc(8).toString('base64') },
      { ...good, salt: Buffer.alloc(17).toString('base64') },
    ] as (typeof good)[]
    for (const params of bad) {
      const err = await deriveKek('Pässword1!', params).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('invalid kdf params')
    }
    await expect(deriveKek('Pässword1!', good)).resolves.toHaveLength(32)
  })

  it('default params', () => {
    expect(DEFAULT_KDF).toEqual({ alg: 'scrypt', N: 131072, r: 8, p: 1 })
  })
})
