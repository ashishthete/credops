import { describe, expect, it } from 'vitest'
import { REDACTED, redact } from '../../src/main/security/redact'

describe('redact', () => {
  it('redacts sensitive keys at any depth', () => {
    const input = { ssh: { identity: { username: 'u', password: 'x' } }, list: [{ token: 't', ok: 1 }] }
    expect(redact(input)).toEqual({
      ssh: { identity: { username: 'u', password: REDACTED } },
      list: [{ token: REDACTED, ok: 1 }]
    })
  })

  it('matches key variants case-insensitively', () => {
    const out = redact({
      DB_PASSWORD: 'a',
      apiKey: 'b',
      api_key: 'c',
      'api-key': 'd',
      privateKey: 'e',
      Authorization: 'f',
      cookie: 'g',
      webhookUrl: 'h',
      passphrase: 'i',
      host: 'keep'
    })
    expect(out).toEqual({
      DB_PASSWORD: REDACTED,
      apiKey: REDACTED,
      api_key: REDACTED,
      'api-key': REDACTED,
      privateKey: REDACTED,
      Authorization: REDACTED,
      cookie: REDACTED,
      webhookUrl: REDACTED,
      passphrase: REDACTED,
      host: 'keep'
    })
  })

  it('masks known secret values inside strings', () => {
    expect(redact({ cmd: 'PGPASSWORD=hunter22 pg_dump' }, ['hunter22']).cmd).toBe(
      'PGPASSWORD=‹redacted› pg_dump'
    )
  })

  it('masks known secrets in top-level strings, arrays and every occurrence', () => {
    expect(redact('a hunter22 b hunter22', ['hunter22'])).toBe('a ‹redacted› b ‹redacted›')
    expect(redact({ args: ['x', 'p-hunter22'] }, ['hunter22'])).toEqual({ args: ['x', 'p-‹redacted›'] })
  })

  it('treats regex metacharacters in known secrets literally and replaces longest first', () => {
    expect(redact('pw=a.b*c+', ['a.b*c+'])).toBe('pw=‹redacted›')
    expect(redact('abcd1234', ['abcd', 'abcd1234'])).toBe('‹redacted›')
  })

  it('masks secrets under 8 characters only as whole tokens', () => {
    expect(redact('pin=1234; again 1234', ['1234'])).toBe('pin=‹redacted›; again ‹redacted›')
    expect(redact('1234', ['1234'])).toBe(REDACTED)
    // Inside a longer word or number it is left alone, so common substrings do not shred logs.
    expect(redact('port 51234 id a1234b 12345', ['1234'])).toBe('port 51234 id a1234b 12345')
    expect(redact('ünïcabcd abcd', ['abcd'])).toBe('ünïcabcd ‹redacted›')
    // 8 or more characters match anywhere.
    expect(redact('xhunter22x', ['hunter22'])).toBe('x‹redacted›x')
    // Longest first still wins over a short token inside it.
    expect(redact('k=abcd-wxyz', ['abcd', 'abcd-wxyz', 'wxyz'])).toBe('k=‹redacted›')
    expect(redact('wxyz-abcd wxyz', ['wxyz-abcd', 'wxyz'])).toBe('‹redacted› ‹redacted›')
  })

  it('ignores short known secrets', () => {
    expect(redact('abc', ['ab'])).toBe('abc')
  })

  it('strips PEM private keys', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      '-----END OPENSSH PRIVATE KEY-----'
    ].join('\n')
    const out = redact({ log: `before\n${pem}\nafter` }).log
    expect(out).not.toContain('BEGIN')
    expect(out).not.toContain('b3Blbn')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('strips an unterminated PEM block to the end of the string', () => {
    const out = redact('x -----BEGIN RSA PRIVATE KEY-----\nMIIE')
    expect(out).not.toContain('MIIE')
  })

  it('does not mutate input and survives cycles', () => {
    const a: Record<string, unknown> = { password: 'p' }
    a.self = a
    const out = redact(a) as Record<string, unknown>
    expect(out.self).toBe('[circular]')
    expect(out.password).toBe(REDACTED)
    expect(a.password).toBe('p')
    expect(a.self).toBe(a)
  })

  it('does not flag shared (non-cyclic) references as circular', () => {
    const shared = { n: 1 }
    expect(redact({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } })
  })

  it('stringifies non-plain objects', () => {
    const d = new Date('2026-01-02T03:04:05.000Z')
    expect(redact({ d })).toEqual({ d: '2026-01-02T03:04:05.000Z' })
    expect(redact({ b: Buffer.from('secretkey') })).toEqual({ b: '[buffer 9 bytes]' })
    expect(redact({ m: new Map([['k', 'v']]) })).toEqual({ m: '[object Map]' })
  })

  it('masks known secrets in stringified non-plain values', () => {
    expect(redact({ e: new Error('bad hunter22') }, ['hunter22'])).toEqual({
      e: 'Error: bad ‹redacted›'
    })
  })

  it('does not throw on invalid dates', () => {
    expect(redact({ d: new Date(NaN) })).toEqual({ d: '[invalid date]' })
  })

  it('never emits raw bytes from any typed array or DataView', () => {
    expect(
      redact({ a: new Uint16Array(3), b: new Int8Array([1, 2]), c: new DataView(new ArrayBuffer(5)) })
    ).toEqual({ a: '[buffer 6 bytes]', b: '[buffer 2 bytes]', c: '[buffer 5 bytes]' })
  })

  it('masks known secrets in object keys', () => {
    expect(redact({ 'user-hunter22': true }, ['hunter22'])).toEqual({ 'user-‹redacted›': true })
  })

  it('masks secrets too large for one regex', () => {
    const big = 'x'.repeat(65536)
    const secrets = [big, 'a\nb=c\r\n', '🔑ünïcødé', 'hunter22']
    expect(redact(`pre ${big} mid 🔑ünïcødé hunter22 a\nb=c\r\n`, secrets)).toBe(
      `pre ${REDACTED} mid ${REDACTED} ${REDACTED} ${REDACTED}`,
    )
  })

  it('passes primitives through', () => {
    expect(redact({ n: 1, b: true, z: null, u: undefined })).toEqual({ n: 1, b: true, z: null, u: undefined })
  })
})
