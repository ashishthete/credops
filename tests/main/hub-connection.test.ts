import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { HubClient, HubError } from '../../src/main/hub/client'
import { HubConnection } from '../../src/main/hub/connection'
import type { HubStatus } from '../../src/shared/hub'
import { testHub, type TestHub } from './hub-fixture'

const fakeKeychain = (available = true) => ({
  available: () => available,
  encrypt: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).reverse().toString('base64')}`),
  decrypt: (blob: Buffer) => Buffer.from(blob.toString().slice(4), 'base64').reverse().toString(),
})

const fakeBrowser = async (url: string): Promise<void> => {
  const r = await fetch(url, { redirect: 'manual' })
  await fetch(r.headers.get('location')!)
}

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }

let hub: TestHub
let hubUrl: string
let dir: string
let db: Db
let audit: AuditLog
let states: HubStatus[]
let opened: string[]

beforeEach(async () => {
  hub = await testHub()
  await hub.app.listen({ host: '127.0.0.1', port: 0 })
  const addr = hub.app.server.address() as { port: number }
  hubUrl = `http://127.0.0.1:${addr.port}`
  dir = mkdtempSync(join(tmpdir(), 'opsdeck-hubconn-'))
  db = openDatabase(join(dir, 'opsdeck.db'))
  audit = new AuditLog(db)
  states = []
  opened = []
  hub.entra.setUser(ADMIN)
})
afterEach(async () => {
  await hub.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const make = (over: Partial<ConstructorParameters<typeof HubConnection>[0]> = {}) =>
  new HubConnection({
    db,
    audit,
    keychain: fakeKeychain(),
    fetch,
    openBrowser: async (u) => {
      opened.push(u)
      await fakeBrowser(u)
    },
    now: () => Date.now(),
    emit: (s) => states.push(s),
    ...over,
  })

const actions = (): string[] => audit.list({}).map((e) => e.action).reverse()
const expireHubSessions = (): void => void hub.db.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z')

describe('hub connection', () => {
  it('connects, signs in, and reports pending', async () => {
    // The first user takes the admin bootstrap so the next one is pending.
    await hub.signIn(ADMIN)
    hub.entra.setUser(BOB)
    const conn = make()
    expect(conn.status()).toEqual({ linked: false })
    const linked = await conn.connect(hubUrl)
    expect(linked).toMatchObject({ linked: true, hubName: 'Test Hub', signedIn: false })
    const s = await conn.signIn()
    expect(s).toMatchObject({ linked: true, signedIn: true, signingIn: false, online: true })
    expect((s as { user: { status: string } }).user.status).toBe('pending')
    expect(opened).toHaveLength(1)
    expect(actions().filter((a) => a.startsWith('hub.'))).toEqual(['hub.link', 'hub.signin'])
    expect(states.at(-1)).toMatchObject({ signedIn: true })
  })

  it('refuses sign-in without keychain', async () => {
    const conn = make({ keychain: fakeKeychain(false) })
    await conn.connect(hubUrl)
    await expect(conn.signIn()).rejects.toThrow("Keychain unavailable: OpsDeck can't store a Hub sign-in safely")
    expect(opened).toEqual([])
    const row = db.prepare('SELECT session_enc, refresh_enc FROM hub_link').get()
    expect({ ...row }).toEqual({ session_enc: null, refresh_enc: null })
  })

  it('rejects an incompatible hub and a non-entra authority', async () => {
    const old = await stubHub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ hubId: 'h', name: 'n', apiVersion: 2, entra: {} }))
    })
    try {
      await expect(make().connect(old.url)).rejects.toMatchObject({ code: 'incompatible' })
    } finally {
      await old.close()
    }
    const bad = await stubHub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          hubId: 'h',
          name: 'n',
          apiVersion: 1,
          entra: { authority: 'https://evil.example.com/x', clientId: 'c', scopes: [], redirectUri: 'http://127.0.0.1/callback' },
        }),
      )
    })
    try {
      await expect(make().connect(bad.url)).rejects.toThrow(/not Microsoft Entra/)
      expect({ ...db.prepare('SELECT COUNT(*) AS n FROM hub_link').get() }).toEqual({ n: 0 })
    } finally {
      await bad.close()
    }
  })

  it('refuses http to a non-loopback host, other schemes and embedded credentials', async () => {
    const conn = make()
    await expect(conn.connect('ftp://127.0.0.1:1')).rejects.toThrow()
    await expect(conn.connect('http://10.0.0.5:8787')).rejects.toThrow()
    await expect(conn.connect('http://user:pw@127.0.0.1:8787')).rejects.toThrow()
  })

  it('renews an expired hub session with the refresh token', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    const read = () => db.prepare('SELECT session_enc, refresh_enc FROM hub_link').get() as { session_enc: Buffer; refresh_enc: Buffer }
    const before = read()
    expireHubSessions()
    const me = await conn.me()
    expect(me.upn).toBe('admin@example.com')
    expect(opened).toHaveLength(1)
    const after = read()
    expect(Buffer.from(after.session_enc).equals(Buffer.from(before.session_enc))).toBe(false)
    expect(Buffer.from(after.refresh_enc).equals(Buffer.from(before.refresh_enc))).toBe(false)
    expect(conn.status()).toMatchObject({ signedIn: true })
  })

  it('keeps the old refresh token when a refresh returns none', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    const old = db.prepare('SELECT refresh_enc FROM hub_link').get() as { refresh_enc: Buffer }
    const strip: typeof fetch = async (input, init) => {
      const res = await fetch(input, init)
      if (!String(input).includes('/token')) return res
      const body = (await res.json()) as Record<string, unknown>
      delete body.refresh_token
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } })
    }
    const conn2 = make({ fetch: strip })
    expireHubSessions()
    await conn2.me()
    const now = db.prepare('SELECT refresh_enc FROM hub_link').get() as { refresh_enc: Buffer }
    expect(Buffer.from(now.refresh_enc).equals(Buffer.from(old.refresh_enc))).toBe(true)
  })

  it('falls back to signed out when refresh is rejected', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    expireHubSessions()
    const refused: typeof fetch = async (input, init) => {
      if (String(input).includes('/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return fetch(input, init)
    }
    const c2 = make({ fetch: refused })
    await expect(c2.me()).rejects.toMatchObject({ code: 'unauthenticated', message: 'Sign in to the Hub again' })
    expect(c2.status()).toMatchObject({ linked: true, signedIn: false, user: null })
    expect(states.at(-1)).toMatchObject({ signedIn: false })
    const row = db.prepare('SELECT session_enc, refresh_enc, session_expires_at FROM hub_link').get()
    expect({ ...(row as object) }).toEqual({ session_enc: null, refresh_enc: null, session_expires_at: null })
  })

  it('a restart with a stored session restores the signed-in user from the Hub', async () => {
    await make().connect(hubUrl)
    const first = make()
    await first.signIn()
    // A new connection over the same database, as after an app restart: nothing in memory yet.
    const again = make()
    expect(again.status()).toMatchObject({ signedIn: true, user: null })
    await again.restore()
    expect(again.status()).toMatchObject({ signedIn: true, user: { oid: ADMIN.oid, role: 'admin', status: 'active' } })
    expect(states.at(-1)).toMatchObject({ user: { oid: ADMIN.oid } })
  })

  it('a restore while the Hub is unreachable keeps the session; a rejected session signs out', async () => {
    await make().connect(hubUrl)
    await make().signIn()
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const offline = make({ fetch: down })
    await offline.restore()
    expect(offline.status()).toMatchObject({ signedIn: true, user: null })
    const forbidden: typeof fetch = async () => new Response(JSON.stringify({ error: 'forbidden', message: 'no' }), { status: 403, headers: { 'content-type': 'application/json' } })
    const rejected = make({ fetch: forbidden })
    await rejected.restore()
    expect(rejected.status()).toMatchObject({ signedIn: false, user: null })
  })

  it('a restore that failed offline runs again once the Hub answers, and only once for quick answers', async () => {
    await make().connect(hubUrl)
    await make().signIn()
    let up = false
    let mes = 0
    const flaky: typeof fetch = async (input, init) => {
      if (!up) throw new TypeError('fetch failed')
      if (String(input).endsWith('/api/v1/me')) mes++
      return fetch(input, init)
    }
    const c = make({ fetch: flaky })
    await c.restore()
    expect(c.status()).toMatchObject({ signedIn: true, online: false, user: null })
    const before = states.length
    up = true
    // Two requests answer at about the same time.
    await Promise.all([c.client().get('/api/v1/catalog'), c.client().get('/api/v1/catalog')])
    await vi.waitFor(() => expect(c.status()).toMatchObject({ user: { oid: ADMIN.oid } }))
    expect(mes).toBe(1)
    expect(states.length).toBeGreaterThan(before)
    expect(states.at(-1)).toMatchObject({ user: { oid: ADMIN.oid } })
    // Known now: further answers do not ask again.
    await c.client().get('/api/v1/catalog')
    expect(mes).toBe(1)
  })

  it('a 503 during renew reports unavailable and keeps the session', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    expireHubSessions()
    const down: typeof fetch = async (input, init) => {
      if (String(input).includes('/token')) return new Response('down', { status: 503 })
      return fetch(input, init)
    }
    const c2 = make({ fetch: down })
    await expect(c2.renew()).rejects.toMatchObject({ code: expect.stringMatching(/network|unavailable/) })
    expect(c2.status()).toMatchObject({ signedIn: true })
    const row = db.prepare('SELECT session_enc, refresh_enc FROM hub_link').get() as { session_enc: Buffer | null; refresh_enc: Buffer | null }
    expect(row.refresh_enc).not.toBeNull()
  })

  it('a Hub 5xx on the session exchange during renew keeps the session', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    expireHubSessions()
    const down: typeof fetch = async (input, init) => {
      if (String(input).includes('/api/v1/session') && init?.method === 'POST') return new Response('down', { status: 502 })
      return fetch(input, init)
    }
    const c2 = make({ fetch: down })
    await expect(c2.renew()).rejects.toMatchObject({ code: 'unavailable' })
    expect(c2.status()).toMatchObject({ signedIn: true })
    const row = db.prepare('SELECT refresh_enc FROM hub_link').get() as { refresh_enc: Buffer | null }
    expect(row.refresh_enc).not.toBeNull()
  })

  it('an Entra discovery 5xx or a token 429 during renew keeps the session', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    for (const [match, status] of [['openid-configuration', 503], ['/token', 429]] as const) {
      expireHubSessions()
      const flaky: typeof fetch = async (input, init) => (String(input).includes(match) ? new Response('no', { status }) : fetch(input, init))
      const c2 = make({ fetch: flaky })
      await expect(c2.renew()).rejects.toMatchObject({ code: 'network' })
      expect(c2.status()).toMatchObject({ signedIn: true })
    }
  })

  it('a refresh that fails on the network reports unreachable and keeps the session', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    expireHubSessions()
    const offline: typeof fetch = async (input, init) => {
      if (String(input).includes('/token')) throw new TypeError('fetch failed')
      return fetch(input, init)
    }
    const c2 = make({ fetch: offline })
    await expect(c2.me()).rejects.toMatchObject({ code: 'network' })
    expect(c2.status()).toMatchObject({ signedIn: true })
    const row = db.prepare('SELECT session_enc, refresh_enc FROM hub_link').get() as { session_enc: Buffer | null; refresh_enc: Buffer | null }
    expect(row.session_enc).not.toBeNull()
    expect(row.refresh_enc).not.toBeNull()
  })

  it('connecting to a different hub signs the old session out in the audit and clears its env links', async () => {
    // The Hub mints its id once per process, so the second Hub's /meta is given its own id here.
    let rename = false
    const renaming: typeof fetch = async (input, init) => {
      const res = await fetch(input, init)
      if (!rename || !String(input).endsWith('/api/v1/meta')) return res
      const body = (await res.json()) as Record<string, unknown>
      return new Response(JSON.stringify({ ...body, hubId: '22222222-2222-4222-8222-222222222222' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const conn = make({ fetch: renaming })
    await conn.connect(hubUrl)
    await conn.signIn()
    db.exec("PRAGMA foreign_keys = OFF; INSERT INTO hub_env_links(environment_id, hub_id, published_at, manifest_hash) VALUES ('e1', 'old', 'x', 'y')")
    const other = await testHub()
    try {
      await other.app.listen({ host: '127.0.0.1', port: 0 })
      const url = `http://127.0.0.1:${(other.app.server.address() as { port: number }).port}`
      const before = actions().filter((a) => a === 'hub.signout').length
      rename = true
      const s = await conn.connect(url)
      expect(s).toMatchObject({ linked: true, signedIn: false })
      expect(actions().filter((a) => a === 'hub.signout')).toHaveLength(before + 1)
      expect({ ...(db.prepare('SELECT COUNT(*) AS n FROM hub_env_links').get() as object) }).toEqual({ n: 0 })
    } finally {
      await other.close()
    }
  })

  it('new Entra and refresh tokens are redactable before they are exchanged or stored', async () => {
    const seen: { access: string[]; refresh: string[] } = { access: [], refresh: [] }
    const missing: string[] = []
    let conn!: HubConnection
    const spy: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/api/v1/session') && init?.method === 'POST') {
        const known = conn.knownValues()
        for (const t of [...seen.access, ...seen.refresh]) if (!known.includes(t)) missing.push('token')
      }
      const res = await fetch(input, init)
      if (url.includes('/token')) {
        const body = (await res.clone().json()) as { access_token?: string; refresh_token?: string }
        if (body.access_token) seen.access.push(body.access_token)
        if (body.refresh_token) seen.refresh.push(body.refresh_token)
      }
      return res
    }
    conn = make({ fetch: spy })
    await conn.connect(hubUrl)
    await conn.signIn()
    expect(seen.access.length).toBeGreaterThan(0)
    expect(missing).toEqual([])
    seen.access.length = 0
    seen.refresh.length = 0
    expireHubSessions()
    await conn.me()
    expect(seen.access.length).toBeGreaterThan(0)
    expect(missing).toEqual([])
    // Nothing transient lingers after the exchange.
    expect(conn.knownValues()).toHaveLength(2)
  })

  it('status and errors never carry tokens', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    const s = await conn.signIn()
    const tokens = conn.knownValues()
    expect(tokens.length).toBe(2)
    for (const t of tokens) expect(JSON.stringify(s) + JSON.stringify(conn.status())).not.toContain(t)
    for (const e of audit.list({})) for (const t of tokens) expect(JSON.stringify(e)).not.toContain(t)
    // A Hub 500 whose message echoes the session token is redacted.
    const stub = await stubHub((_req, res) => {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'internal', message: `boom ${tokens[0]} and ${tokens[1]}` }))
    })
    try {
      const c = new HubClient({ baseUrl: stub.url, fetch, token: () => tokens[0]!, renew: async () => false, knownSecrets: () => tokens })
      const err = await c.get('/api/v1/me').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HubError)
      for (const t of tokens) expect((err as Error).message).not.toContain(t)
      expect((err as HubError).status).toBe(500)
    } finally {
      await stub.close()
    }
  })

  it('db file holds no token plaintext', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    const tokens = conn.knownValues()
    expect(tokens.length).toBe(2)
    const files = readdirSync(dir).filter((f) => f.startsWith('opsdeck.db'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const bytes = readFileSync(join(dir, f)).toString('latin1')
      for (const t of tokens) expect(bytes).not.toContain(t)
    }
  })

  it('sign-out clears tokens, revokes the session and audits', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    const s = await conn.signOut()
    expect(s).toMatchObject({ linked: true, signedIn: false })
    expect({ ...hub.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() }).toEqual({ n: 0 })
    expect(conn.knownValues()).toEqual([])
    expect(actions()).toContain('hub.signout')
  })

  it('unlink removes the link and env links', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare("INSERT INTO hub_env_links VALUES ('e','h','t','m')").run()
    expect(await conn.unlink()).toEqual({ linked: false })
    expect({ ...db.prepare('SELECT COUNT(*) AS n FROM hub_link').get() }).toEqual({ n: 0 })
    expect({ ...db.prepare('SELECT COUNT(*) AS n FROM hub_env_links').get() }).toEqual({ n: 0 })
    expect(actions().filter((a) => a.startsWith('hub.'))).toEqual(['hub.link', 'hub.signin', 'hub.signout', 'hub.unlink'])
  })

  it('cancelSignIn aborts a pending sign-in', async () => {
    const conn = make({ openBrowser: () => new Promise<void>(() => undefined) })
    await conn.connect(hubUrl)
    const p = conn.signIn()
    p.catch(() => undefined)
    await vi.waitFor(() => expect(conn.status()).toMatchObject({ signingIn: true }))
    conn.cancelSignIn()
    await expect(p).rejects.toThrow(/cancel/i)
    expect(conn.status()).toMatchObject({ signingIn: false, signedIn: false })
  })
})

describe('checkSession', () => {
  const json = (status: number, body: object): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const signedIn = async (over: Partial<ConstructorParameters<typeof HubConnection>[0]> = {}): Promise<HubConnection> => {
    await make().connect(hubUrl)
    await make().signIn()
    return make(over)
  }

  it('ok after sign-in', async () => {
    const conn = make()
    await conn.connect(hubUrl)
    await conn.signIn()
    const r = await conn.checkSession()
    expect(r).toMatchObject({ kind: 'ok', user: { oid: ADMIN.oid } })
  })

  it('expired with no session', async () => {
    const conn = make()
    expect(await conn.checkSession()).toEqual({ kind: 'expired' })
    await conn.connect(hubUrl)
    expect(await conn.checkSession()).toEqual({ kind: 'expired' })
  })

  it('renews an expired Hub session silently', async () => {
    const conn = await signedIn()
    expireHubSessions()
    const before = opened.length
    expect(await conn.checkSession()).toMatchObject({ kind: 'ok', user: { oid: ADMIN.oid } })
    expect(opened).toHaveLength(before)
  })

  it('expired when the refresh is rejected', async () => {
    await signedIn()
    expireHubSessions()
    const refused: typeof fetch = async (input, init) =>
      String(input).includes('/token') ? json(400, { error: 'invalid_grant' }) : fetch(input, init)
    const conn = make({ fetch: refused })
    expect(await conn.checkSession()).toEqual({ kind: 'expired' })
    expect(conn.status()).toMatchObject({ signedIn: false })
  })

  it('disabled when the Hub says 403', async () => {
    hub.entra.setUser(BOB)
    await make().connect(hubUrl)
    await make().signIn()
    const conn = make()
    hub.db.prepare('UPDATE users SET disabled = 1 WHERE oid = ?').run(BOB.oid)
    expect(await conn.checkSession()).toEqual({ kind: 'disabled' })
    expect(conn.status()).toMatchObject({ signedIn: false })
  })

  it('offline when the Hub is down, keeping the session', async () => {
    const conn = await signedIn()
    await hub.close()
    expect(await conn.checkSession()).toEqual({ kind: 'offline' })
    expect(conn.status()).toMatchObject({ signedIn: true })
    hub = await testHub()
  })

  it('offline on 502 and 429 from me, keeping the session', async () => {
    for (const status of [502, 429]) {
      const conn = await signedIn({ fetch: async () => json(status, { error: 'internal' }) })
      expect(await conn.checkSession()).toEqual({ kind: 'offline' })
      expect(conn.status()).toMatchObject({ signedIn: true })
    }
  })

  it('offline when the renew POST /session gets a 429, keeping the session', async () => {
    await signedIn()
    expireHubSessions()
    const limited: typeof fetch = async (input, init) =>
      String(input).endsWith('/api/v1/session') && init?.method === 'POST' ? json(429, { error: 'internal' }) : fetch(input, init)
    const conn = make({ fetch: limited })
    expect(await conn.checkSession()).toEqual({ kind: 'offline' })
    expect(conn.status()).toMatchObject({ signedIn: true })
  })

  it('offline when the renew POST /session gets a 502, keeping the session', async () => {
    await signedIn()
    expireHubSessions()
    const bad: typeof fetch = async (input, init) =>
      String(input).endsWith('/api/v1/session') && init?.method === 'POST' ? json(502, { error: 'internal' }) : fetch(input, init)
    const conn = make({ fetch: bad })
    expect(await conn.checkSession()).toEqual({ kind: 'offline' })
    expect(conn.status()).toMatchObject({ signedIn: true })
  })
})

describe('hub client', () => {
  it("reports an unreachable hub as Can't reach the Hub", async () => {
    const c = new HubClient({ baseUrl: 'http://127.0.0.1:1', fetch, token: () => null, renew: async () => false, knownSecrets: () => [] })
    await expect(c.get('/api/v1/meta')).rejects.toMatchObject({ code: 'network', message: "Can't reach the Hub" })
  })

  it('renews once on session_expired and retries', async () => {
    let n = 0
    const stub = await stubHub((req, res) => {
      res.setHeader('content-type', 'application/json')
      n++
      if (req.headers.authorization === 'Bearer old') {
        res.statusCode = 401
        return void res.end(JSON.stringify({ error: 'session_expired', message: 'x' }))
      }
      res.end(JSON.stringify({ ok: true }))
    })
    try {
      let tok = 'old'
      const renew = vi.fn(async () => ((tok = 'new'), true))
      const c = new HubClient({ baseUrl: stub.url, fetch, token: () => tok, renew, knownSecrets: () => [] })
      await expect(c.get('/x')).resolves.toEqual({ ok: true })
      expect(renew).toHaveBeenCalledTimes(1)
      expect(n).toBe(2)
    } finally {
      await stub.close()
    }
  })

  it('times out', async () => {
    const stub = await stubHub(() => undefined)
    try {
      const c = new HubClient({ baseUrl: stub.url, fetch, token: () => null, renew: async () => false, knownSecrets: () => [], timeoutMs: 50 })
      await expect(c.get('/x')).rejects.toMatchObject({ code: 'timeout' })
    } finally {
      await stub.close()
    }
  })

  it('sends repeated query params', async () => {
    let seen = ''
    const stub = await stubHub((req, res) => {
      seen = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.end('{}')
    })
    try {
      const c = new HubClient({ baseUrl: stub.url, fetch, token: () => null, renew: async () => false, knownSecrets: () => [] })
      await c.get('/a', { deploymentIds: ['x', 'y'], action: 'deploy.view' })
      expect(seen).toBe('/a?deploymentIds=x&deploymentIds=y&action=deploy.view')
    } finally {
      await stub.close()
    }
  })
})

async function stubHub(handler: Parameters<typeof createServer>[1] & object): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
