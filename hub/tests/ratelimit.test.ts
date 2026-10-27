import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { Coalescer, RateLimiter } from '../src/ratelimit'
import { testHub, type TestHub } from './helpers'

describe('RateLimiter', () => {
  it('allows `limit` hits per window per key and resets after the window', () => {
    const clock = { t: 0 }
    const rl = new RateLimiter(3, { windowMs: 1000, maxKeys: 10, now: () => new Date(clock.t) })
    expect([1, 2, 3].map(() => rl.hit('a').allowed)).toEqual([true, true, true])
    const over = rl.hit('a')
    expect(over.allowed).toBe(false)
    expect(over.retryAfterMs).toBe(1000)
    expect(rl.hit('b').allowed).toBe(true)
    clock.t = 1000
    expect(rl.hit('a').allowed).toBe(true)
  })

  it('never holds more than maxKeys, dropping expired windows first and then the oldest', () => {
    const clock = { t: 0 }
    const rl = new RateLimiter(1, { windowMs: 1000, maxKeys: 3, now: () => new Date(clock.t) })
    for (let i = 0; i < 100; i++) rl.hit(`k${i}`)
    expect(rl.size).toBe(3)
    clock.t = 5000
    rl.sweep()
    expect(rl.size).toBe(0)
  })
})

describe('Coalescer', () => {
  it('lets the first event per window through and summarises the rest when the window ends', () => {
    const clock = { t: 0 }
    const out: [string, number][] = []
    const c = new Coalescer({ windowMs: 1000, maxKeys: 10, now: () => new Date(clock.t) }, (k, n) => out.push([k, n]))
    expect(c.first('a')).toBe(true)
    expect(c.first('a')).toBe(false)
    expect(c.first('a')).toBe(false)
    expect(c.first('b')).toBe(true)
    expect(out).toEqual([])
    clock.t = 1000
    expect(c.first('a')).toBe(true)
    expect(out).toEqual([['a', 2]])
    // b had nothing held back, so its expiry says nothing.
    c.sweep()
    expect(out).toEqual([['a', 2]])
    c.first('a')
    c.flush()
    expect(out).toEqual([['a', 2], ['a', 1]])
    expect(c.size).toBe(0)
  })

  it('summarises a window evicted to make room', () => {
    const out: [string, number][] = []
    const c = new Coalescer({ windowMs: 1000, maxKeys: 1, now: () => new Date(0) }, (k, n) => out.push([k, n]))
    c.first('a')
    c.first('a')
    c.first('b')
    expect(out).toEqual([['a', 1]])
    expect(c.size).toBe(1)
  })
})

describe('sign-in rate limit', () => {
  let hub: TestHub
  afterEach(async () => hub.close())
  const post = (ip = '127.0.0.1') => hub.app.inject({ method: 'POST', url: '/api/v1/session', remoteAddress: ip })

  it('answers 429 in the Hub error shape once an address is over its limit', async () => {
    hub = await testHub({ sessionRateLimitPerMinute: 3 })
    for (let i = 0; i < 3; i++) expect((await post()).statusCode).toBe(401)
    const res = await post()
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'unavailable', message: expect.stringMatching(/too many/i) })
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    // Another address has its own budget, and the window ends.
    expect((await post('10.0.0.9')).statusCode).toBe(401)
    hub.clock.now = new Date(hub.clock.now.getTime() + 60_000)
    expect((await post()).statusCode).toBe(401)
  })

  it('ignores X-Forwarded-For, since the Hub does not trust a proxy', async () => {
    hub = await testHub({ sessionRateLimitPerMinute: 1 })
    expect((await post()).statusCode).toBe(401)
    const spoofed = await hub.app.inject({ method: 'POST', url: '/api/v1/session', headers: { 'x-forwarded-for': '10.9.9.9' } })
    expect(spoofed.statusCode).toBe(429)
  })

  it('defaults to 20 a minute', async () => {
    hub = await testHub()
    for (let i = 0; i < 20; i++) expect((await post()).statusCode).toBe(401)
    expect((await post()).statusCode).toBe(429)
  })

  it('writes one session.denied row per address per window and a summary of the rest', async () => {
    hub = await testHub({ sessionRateLimitPerMinute: 100 })
    for (let i = 0; i < 50; i++) await post()
    await post('10.0.0.9')
    let rows = hub.audit.list({ actions: ['session.denied'] })
    expect(rows.map((r) => r.details)).toEqual([
      { reason: 'missing', ip: '10.0.0.9' },
      { reason: 'missing', ip: '127.0.0.1' },
    ])
    hub.clock.now = new Date(hub.clock.now.getTime() + 60_000)
    await post()
    rows = hub.audit.list({ actions: ['session.denied'] })
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.details)).toContainEqual({ reason: 'repeated', ip: '127.0.0.1', suppressed: 49 })
    expect(hub.audit.verify().ok).toBe(true)
  })

  it('rate-limited calls write no audit rows', async () => {
    hub = await testHub({ sessionRateLimitPerMinute: 1 })
    for (let i = 0; i < 30; i++) await post()
    expect(hub.audit.list({ actions: ['session.denied'] })).toHaveLength(1)
  })
})

describe('sessionRateLimitPerMinute config', () => {
  const EXAMPLE = join(__dirname, '..', 'hub.config.example.json')
  const write = (cfg: unknown): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'hub-cfg-')), 'hub.json')
    writeFileSync(file, JSON.stringify(cfg))
    return file
  }

  it('is optional and must be a positive integer', () => {
    const base = JSON.parse(readFileSync(EXAMPLE, 'utf8'))
    expect(loadConfig(EXAMPLE).sessionRateLimitPerMinute).toBeUndefined()
    expect(loadConfig(write({ ...base, sessionRateLimitPerMinute: 5 })).sessionRateLimitPerMinute).toBe(5)
    expect(() => loadConfig(write({ ...base, sessionRateLimitPerMinute: 0 }))).toThrow(/sessionRateLimitPerMinute/)
    expect(() => loadConfig(write({ ...base, sessionRateLimitPerMinute: 'x' }))).toThrow(/sessionRateLimitPerMinute/)
  })
})
