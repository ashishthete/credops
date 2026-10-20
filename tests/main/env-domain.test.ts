import { describe, expect, it } from 'vitest'
import { domainHost, domainOpenUrl, isBareName, parseEnvDomain } from '../../src/shared/inventory'

const GENERIC = 'Enter a domain like staging.example.com or an http(s) URL'
const label63 = 'a'.repeat(63)
// 63 + 1 + 63 + 1 + 63 + 1 + 61 = 253
const host253 = [label63, label63, label63, 'a'.repeat(61)].join('.')

const REJECTED: [string, string][] = [
  ['ftp://files.example.com', 'Use an http:// or https:// URL'],
  ['file:///etc/passwd', 'Use an http:// or https:// URL'],
  ['ssh://staging.example.com', 'Use an http:// or https:// URL'],
  ['https://user:pass@staging.example.com', 'Leave the login out of the URL'],
  ['https://user@staging.example.com', 'Leave the login out of the URL'],
  ['http://:pw@staging.example.com', 'Leave the login out of the URL'],
  [host253 + 'b', 'A domain is at most 253 characters'],
  ['https://' + host253 + 'b', 'A domain is at most 253 characters'],
  ['https://x.example.com/' + 'p'.repeat(2048), 'A URL is at most 2048 characters'],
  ['staging example.com', GENERIC],
  ['-x.example.com', GENERIC],
  ['x-.example.com', GENERIC],
  ['staging.example.com/app', GENERIC],
  ['staging.example.com:8443', GENERIC],
  ['javascript:alert(1)', GENERIC],
  ['https://', GENERIC],
  ['https://exa\tmple.com', GENERIC],
  ['https://exa\nmple.com', GENERIC],
  ['staging.exa\u202Emple.com', GENERIC],
  ['a'.repeat(64) + '.com', GENERIC],
  ['a..b', GENERIC],
]

describe('parseEnvDomain', () => {
  it('accepts hostnames and http(s) URLs', () => {
    const kinds: [string, 'host' | 'url', string?][] = [
      ['staging.example.com', 'host'],
      ['Staging.Example.COM.', 'host'],
      ['intranet', 'host'],
      ['https://staging.example.com/app', 'url', 'staging.example.com'],
      ['http://staging.example.com:8080', 'url'],
      ['HTTPS://staging.example.com', 'url'],
      ['https://10.0.0.5/', 'url'],
      ['https://[::1]:8443/', 'url'],
      ['  staging.example.com  ', 'host', 'staging.example.com'],
    ]
    for (const [raw, kind, host] of kinds) {
      const r = parseEnvDomain(raw)
      expect(r.ok, raw).toBe(true)
      if (r.ok) {
        expect(r.value.kind).toBe(kind)
        if (host) expect(r.value.host).toBe(host)
      }
    }
    expect(parseEnvDomain(host253).ok).toBe(true)
  })

  it('rejects with the rule that failed', () => {
    for (const [raw, message] of REJECTED) {
      expect(parseEnvDomain(raw), raw.slice(0, 30)).toEqual({ ok: false, error: message })
    }
  })

  it('messages never echo the input', () => {
    for (const [raw] of REJECTED) {
      const r = parseEnvDomain(raw)
      if (r.ok) throw new Error('expected a rejection')
      for (const bit of [raw, 'user', 'pass', 'ftp']) expect(r.error).not.toContain(bit)
    }
  })

  it('domainHost lowercases, drops one trailing dot, and refuses IP literals', () => {
    const host = (raw: string) => {
      const r = parseEnvDomain(raw)
      if (!r.ok) throw new Error(r.error)
      return domainHost(r.value)
    }
    expect(host('Staging.Example.COM.')).toBe('staging.example.com')
    expect(host('https://Staging.Example.com:8443/app')).toBe('staging.example.com')
    expect(host('https://10.0.0.5/')).toBeNull()
    expect(host('https://[::1]/')).toBeNull()
  })

  it('domainOpenUrl', () => {
    const open = (raw: string) => {
      const r = parseEnvDomain(raw)
      if (!r.ok) throw new Error(r.error)
      return domainOpenUrl(r.value, raw)
    }
    expect(open('staging.example.com')).toBe('https://staging.example.com')
    expect(open('https://staging.example.com/app?x=1')).toBe('https://staging.example.com/app?x=1')
    expect(open('HTTP://Staging.Example.com')).toBe('http://staging.example.com/')
  })
})

describe('bare names', () => {
  it('isBareName', () => {
    for (const a of ['db', 'db-1', 'db_1']) expect(isBareName(a), a).toBe(true)
    for (const a of ['db.internal', '10.0.0.5', '10', '::1', 'fe80::1%en0', 'LOCALHOST', 'localhost']) expect(isBareName(a), a).toBe(false)
  })
})
