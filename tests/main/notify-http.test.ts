import { describe, expect, it, vi } from 'vitest'
import { IntegrationError, getJson, postJson, type Fetch } from '../../src/main/notify/http'

const URL_ = 'https://x.webhook.office.com/abc/SECRETPATH'
const res = (status: number, body = '', headers: Record<string, string> = {}): Response => new Response(status === 204 ? null : body, { status, headers })
const seq = (...items: (Response | Error)[]) => {
  const f = vi.fn(async () => {
    const next = items.shift()
    if (!next) throw new Error('no more responses')
    if (next instanceof Error) throw next
    return next
  })
  return f as unknown as Fetch & typeof f
}
const opts = (fetch: Fetch, sleeps: number[] = []) => ({
  service: 'teams' as const,
  fetch,
  sleep: async (ms: number) => void sleeps.push(ms),
  knownSecrets: [URL_, 'SECRETBODY'],
})

const caught = async (p: Promise<unknown>): Promise<IntegrationError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(IntegrationError)
    return e as IntegrationError
  }
  throw new Error('expected a rejection')
}

describe('postJson', () => {
  it('refuses non-https', async () => {
    const fetch = seq(res(200))
    const err = await caught(postJson('http://x.example/hook', {}, opts(fetch)))
    expect(err).toMatchObject({ service: 'teams', code: 'config', message: 'Teams webhook URL must use https' })
    expect(fetch).not.toHaveBeenCalled()
    expect((await caught(postJson('not a url', {}, opts(fetch)))).code).toBe('config')
  })

  it('posts JSON and returns the response on 2xx', async () => {
    const fetch = seq(res(202))
    const r = await postJson(URL_, { a: 1 }, { ...opts(fetch), headers: { 'x-k': 'v' } })
    expect(r.status).toBe(202)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(URL_)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-k': 'v' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.redirect).toBe('error')
  })

  it('retries 5xx twice then fails with status', async () => {
    const sleeps: number[] = []
    const fetch = seq(res(500), res(502), res(500))
    const err = await caught(postJson(URL_, {}, opts(fetch, sleeps)))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([1000, 4000])
    expect(err).toMatchObject({ code: 'http', status: 500, message: 'Teams webhook failed (HTTP 500)' })
  })

  it('retries network errors and succeeds', async () => {
    const sleeps: number[] = []
    const fetch = seq(new TypeError('fetch failed'), res(200))
    expect((await postJson(URL_, {}, opts(fetch, sleeps))).status).toBe(200)
    expect(sleeps).toEqual([1000])
    const err = await caught(postJson(URL_, {}, opts(seq(new TypeError('x'), new TypeError('x'), new TypeError('x')))))
    expect(err).toMatchObject({ code: 'network', message: 'Teams webhook could not be reached' })
  })

  it('honours Retry-After on 429', async () => {
    const sleeps: number[] = []
    const fetch = seq(res(429, '', { 'retry-after': '7' }), res(429, '', { 'retry-after': '120' }), res(200))
    await postJson(URL_, {}, opts(fetch, sleeps))
    expect(sleeps).toEqual([7000, 4000])
  })

  it('does not retry 4xx', async () => {
    const fetch = seq(res(400, 'SECRETBODY'))
    const err = await caught(postJson(URL_, {}, opts(fetch)))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ code: 'http', status: 400 })
    const auth = await caught(postJson(URL_, {}, { ...opts(seq(res(401))), service: 'sendgrid' }))
    expect(auth).toMatchObject({ code: 'auth', status: 401, message: 'SendGrid rejected the API key (HTTP 401)' })
  })

  it('timeout maps to code timeout', async () => {
    const fetch = seq(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const err = await caught(postJson(URL_, {}, { ...opts(fetch), timeoutMs: 5 }))
    expect(err).toMatchObject({ code: 'timeout', message: 'Teams webhook timed out' })
    // A timed-out post may have been delivered: never retried, so no double post.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('errors never contain the URL, headers or body', async () => {
    const cases = [
      seq(res(500, 'SECRETBODY'), res(500, 'SECRETBODY'), res(500, 'SECRETBODY')),
      seq(res(403, 'SECRETBODY')),
      seq(new TypeError(`connect failed ${URL_} SECRETBODY`), new TypeError(URL_), new TypeError(URL_)),
    ]
    for (const fetch of cases) {
      const err = await caught(postJson(URL_, { text: 'SECRETBODY' }, { ...opts(fetch), headers: { authorization: 'Bearer SECRETHEADER' } }))
      for (const s of [err.message, String(err), JSON.stringify(err), String(err.stack)]) {
        expect(s).not.toContain('SECRETPATH')
        expect(s).not.toContain('SECRETBODY')
        expect(s).not.toContain('SECRETHEADER')
      }
      expect(err.cause).toBeUndefined()
    }
  })
})

describe('getJson', () => {
  it('reads a small JSON body', async () => {
    const fetch = seq(res(200, '{"ok":true}'))
    expect(await getJson<{ ok: boolean }>('https://api.github.com/x', { ...opts(fetch), service: 'github' })).toEqual({ ok: true })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('GET')
  })

  it('refuses a body over maxBytes and an unreadable one', async () => {
    const big = await caught(getJson('https://api.github.com/x', { ...opts(seq(res(200, `{"a":"${'x'.repeat(5000)}"}`))), service: 'github' }))
    expect(big).toMatchObject({ code: 'http', message: 'GitHub returned a response CredOps could not read' })
    const bad = await caught(getJson('https://api.github.com/x', { ...opts(seq(res(200, 'nope'))), service: 'github' }))
    expect(bad.code).toBe('http')
    expect(await getJson('https://api.github.com/x', { ...opts(seq(res(200, '{"a":1}'))), service: 'github', maxBytes: 10 })).toEqual({ a: 1 })
  })

  it('maps GitHub 401 to auth', async () => {
    const err = await caught(getJson('https://api.github.com/x', { ...opts(seq(res(401))), service: 'github' }))
    expect(err).toMatchObject({ code: 'auth', message: 'GitHub rejected the token (HTTP 401)' })
  })
})
