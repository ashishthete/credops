import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HubMeta } from '../../src/shared/hub'
import {
  OidcError,
  authorizeUrl,
  checkAuthority,
  discover,
  exchangeCode,
  pkce,
  refreshTokens,
  signIn,
  startLoopback,
} from '../../src/main/hub/oidc'
import { startFakeEntra, type FakeEntra } from './fake-entra'

let fake: FakeEntra
let cfg: HubMeta['entra']

beforeEach(async () => {
  fake = await startFakeEntra()
  cfg = {
    authority: fake.authority,
    clientId: fake.clientId,
    scopes: ['openid', 'profile', 'offline_access', `api://${fake.clientId}/access_as_user`],
    redirectUri: 'http://127.0.0.1/callback',
  }
})
afterEach(async () => fake.close())

const fakeBrowser = async (url: string): Promise<void> => {
  const r = await fetch(url, { redirect: 'manual' })
  await fetch(r.headers.get('location')!)
}

const deps = (over: Record<string, unknown> = {}) => ({
  fetch,
  now: () => 1_000_000,
  signal: new AbortController().signal,
  openBrowser: fakeBrowser,
  ...over,
})

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })
}

const secretsSeen = (): string[] =>
  fake.requests.flatMap((r) =>
    ['code', 'code_verifier', 'refresh_token', 'code_challenge'].map((k) => r.params[k]).filter((v): v is string => !!v),
  )

describe('oidc sign-in', () => {
  it('signs in end to end with pkce', async () => {
    const ts = await signIn(cfg, deps())
    expect(ts.accessToken.split('.')).toHaveLength(3)
    expect(ts.refreshToken).toBeTruthy()
    expect(ts.expiresAt).toBe(1_000_000 + 3600_000 - 60_000)
    const auth = fake.requests.find((r) => r.path.endsWith('/authorize'))!
    const tok = fake.requests.find((r) => r.path.endsWith('/token'))!
    expect(createHash('sha256').update(tok.params.code_verifier).digest('base64url')).toBe(auth.params.code_challenge)
    expect(auth.params.prompt).toBe('select_account')
    expect(auth.params.scope).toBe(cfg.scopes.join(' '))
    expect(tok.params.client_secret).toBeUndefined()
    expect(tok.params.client_id).toBe(cfg.clientId)
  })

  it('rejects a non-entra authority before the browser opens', async () => {
    let opened = false
    const bad = { ...cfg, authority: `https://evil.example/${fake.tenantId}/v2.0` }
    await expect(signIn(bad, deps({ openBrowser: async () => void (opened = true) }))).rejects.toMatchObject({ code: 'config' })
    expect(opened).toBe(false)
    expect(() => checkAuthority('https://login.microsoftonline.com/not-a-guid/v2.0')).toThrow(OidcError)
    expect(() => checkAuthority(`https://login.microsoftonline.com/${fake.tenantId}/v2.0`)).not.toThrow()
    expect(() => checkAuthority(`http://login.microsoftonline.com/${fake.tenantId}/v2.0`)).toThrow(OidcError)
    expect(() => checkAuthority(`http://localhost:9/${fake.tenantId}/v2.0`)).not.toThrow()
  })

  it('discovery requires the issuer to equal the authority', async () => {
    const ep = await discover(fake.authority, { fetch })
    expect(ep.tokenEndpoint).toContain('/oauth2/v2.0/token')
    const other = fake.authority.replace(fake.tenantId, '99999999-9999-4999-8999-999999999999')
    await expect(discover(other, { fetch })).rejects.toMatchObject({ code: 'discovery' })
  })

  it('loopback rejects bad state, other paths and late hits', async () => {
    const lb = await startLoopback({ path: '/callback', state: 'good', timeoutMs: 5000, signal: new AbortController().signal })
    const port = Number(new URL(lb.redirectUri).port)
    expect(lb.redirectUri).toBe(`http://127.0.0.1:${port}/callback`)
    expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST' })).status).toBe(404)
    const ok = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=good`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('content-type')).toContain('text/html')
    expect(await ok.text()).toContain('Signed in to CredOps. You can close this tab.')
    await expect(lb.code).resolves.toBe('abc')
    expect(await portOpen(port)).toBe(false)

    const lb2 = await startLoopback({ path: '/callback', state: 'good', timeoutMs: 5000, signal: new AbortController().signal })
    const port2 = Number(new URL(lb2.redirectUri).port)
    const assertion = expect(lb2.code).rejects.toMatchObject({ code: 'state_mismatch' })
    await fetch(`http://127.0.0.1:${port2}/callback?code=abc&state=evil`)
    await assertion
    expect(await portOpen(port2)).toBe(false)
  })

  it('denied redirect maps to denied without the description', async () => {
    fake.deny(true)
    const err = await signIn(cfg, deps()).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(OidcError)
    expect((err as OidcError).code).toBe('denied')

    const lb = await startLoopback({ path: '/callback', state: 's', timeoutMs: 5000, signal: new AbortController().signal })
    const port = Number(new URL(lb.redirectUri).port)
    const a = expect(lb.code).rejects.toSatisfy((e: OidcError) => e.code === 'denied' && !e.message.includes('SECRETDESC'))
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=SECRETDESC&state=s`)
    await a
  })

  it('cancel and timeout close the port', async () => {
    const ac = new AbortController()
    const lb = await startLoopback({ path: '/callback', state: 's', timeoutMs: 5000, signal: ac.signal })
    const port = Number(new URL(lb.redirectUri).port)
    expect(await portOpen(port)).toBe(true)
    const a = expect(lb.code).rejects.toMatchObject({ code: 'cancelled' })
    ac.abort()
    await a
    expect(await portOpen(port)).toBe(false)

    const lb2 = await startLoopback({ path: '/callback', state: 's', timeoutMs: 50, signal: new AbortController().signal })
    const port2 = Number(new URL(lb2.redirectUri).port)
    await expect(lb2.code).rejects.toMatchObject({ code: 'timeout' })
    expect(await portOpen(port2)).toBe(false)
  })

  it('an already aborted signal cancels before the browser opens', async () => {
    const ac = new AbortController()
    ac.abort()
    let opened = false
    await expect(signIn(cfg, deps({ signal: ac.signal, openBrowser: async () => void (opened = true) }))).rejects.toMatchObject({ code: 'cancelled' })
    expect(opened).toBe(false)
  })

  it('refresh rotates and an invalid refresh token is refresh_expired', async () => {
    const first = await signIn(cfg, deps())
    const ep = await discover(fake.authority, { fetch })
    const second = await refreshTokens(ep, cfg, first.refreshToken!, deps())
    expect(second.refreshToken).not.toBe(first.refreshToken)
    await expect(refreshTokens(ep, cfg, first.refreshToken!, deps())).rejects.toMatchObject({ code: 'refresh_expired' })
  })

  it('exchange with a wrong verifier is exchange', async () => {
    const ep = await discover(fake.authority, { fetch })
    await expect(exchangeCode(ep, cfg, { code: 'nope', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' }, deps())).rejects.toMatchObject({ code: 'exchange' })
  })

  it('network failures map to network', async () => {
    const dead = { ...cfg, authority: `http://127.0.0.1:9/${fake.tenantId}/v2.0` }
    await expect(signIn(dead, deps())).rejects.toMatchObject({ code: 'network' })
  })

  it('pkce and the authorize url are well formed', () => {
    const p = pkce()
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createHash('sha256').update(p.verifier).digest('base64url')).toBe(p.challenge)
    const u = new URL(authorizeUrl({ issuer: 'i', authorizationEndpoint: 'http://h/a', tokenEndpoint: 't' }, cfg, { redirectUri: 'http://127.0.0.1:1/callback', state: 's', challenge: p.challenge }))
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('response_type')).toBe('code')
  })

  it('errors never contain code, verifier or tokens', async () => {
    const messages: string[] = []
    const collect = async (p: Promise<unknown>): Promise<void> => {
      await p.then(() => undefined, (e: unknown) => void messages.push(`${(e as Error).message}\n${(e as Error).stack ?? ''}`))
    }
    const first = await signIn(cfg, deps())
    const ep = await discover(fake.authority, { fetch })
    await collect(refreshTokens(ep, cfg, 'stale-refresh-token', deps()))
    await collect(exchangeCode(ep, cfg, { code: 'stale-code', verifier: 'stale-verifier', redirectUri: 'http://127.0.0.1:1/callback' }, deps()))
    fake.deny(true)
    await collect(signIn(cfg, deps()))
    fake.deny(false)
    await collect(signIn({ ...cfg, authority: 'https://evil.example/x/v2.0' }, deps()))
    expect(messages.length).toBe(4) // refresh, exchange, denied, non-entra
    for (const m of messages) {
      for (const s of [...secretsSeen(), 'stale-refresh-token', 'stale-code', 'stale-verifier', first.accessToken, first.refreshToken!]) {
        expect(m).not.toContain(s)
      }
    }
  })

  it('abort during the token request is cancelled and returns no tokens', async () => {
    const ac = new AbortController()
    const f = ((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/token')) ac.abort()
      return fetch(url, init)
    }) as typeof fetch
    await expect(signIn(cfg, deps({ fetch: f, signal: ac.signal }))).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('abort after the token response still returns no tokens', async () => {
    const ac = new AbortController()
    const f = (async (url: string, init?: RequestInit) => {
      const r = await fetch(url, init)
      if (String(url).endsWith('/token')) ac.abort()
      return r
    }) as typeof fetch
    await expect(signIn(cfg, deps({ fetch: f, signal: ac.signal }))).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('abort cancels a hung discovery and a hung browser launch', async () => {
    const ac = new AbortController()
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))))) as unknown as typeof fetch
    const p = signIn(cfg, deps({ fetch: hang, signal: ac.signal }))
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })

    const ac2 = new AbortController()
    const p2 = signIn(cfg, deps({ signal: ac2.signal, openBrowser: () => new Promise<void>(() => undefined) }))
    setTimeout(() => ac2.abort(), 50)
    await expect(p2).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('a throwing browser launch is cancelled', async () => {
    await expect(signIn(cfg, deps({ openBrowser: async () => { throw new Error('nope') } }))).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('a callback with a valid state but no code is exchange, and a bad state through signIn is state_mismatch', async () => {
    const hit = (mut: (u: URL) => void) => async (url: string) => {
      const r = await fetch(url, { redirect: 'manual' })
      const back = new URL(r.headers.get('location')!)
      mut(back)
      await fetch(back)
    }
    await expect(signIn(cfg, deps({ openBrowser: hit((u) => u.searchParams.delete('code')) }))).rejects.toMatchObject({ code: 'exchange' })
    await expect(signIn(cfg, deps({ openBrowser: hit((u) => u.searchParams.set('state', 'x')) }))).rejects.toMatchObject({ code: 'state_mismatch' })
  })

  it('times out through signIn when nobody answers', async () => {
    await expect(signIn(cfg, deps({ openBrowser: async () => undefined, timeoutMs: 50 }))).rejects.toMatchObject({ code: 'timeout' })
  })

  it('a non-loopback redirect template is config', async () => {
    for (const redirectUri of ['https://127.0.0.1/callback', 'http://evil.example/callback', 'not a url']) {
      await expect(signIn({ ...cfg, redirectUri }, deps())).rejects.toMatchObject({ code: 'config' })
    }
  })

  it('discovery endpoints on another origin are refused', async () => {
    const tamper = (async (url: string, init?: RequestInit) => {
      const r = await fetch(url, init)
      if (!String(url).endsWith('openid-configuration')) return r
      const doc = (await r.json()) as Record<string, string>
      doc.token_endpoint = 'https://evil.example/token'
      return new Response(JSON.stringify(doc), { status: 200 })
    }) as typeof fetch
    await expect(discover(fake.authority, { fetch: tamper })).rejects.toMatchObject({ code: 'discovery' })
  })
})
