import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { HUB_API_VERSION, type HubMeta, type HubSession, type HubStatus, type HubUser } from '../../shared/hub'
import { HubClient, HubError } from './client'
import { OidcError, checkAuthority, discover, refreshTokens, signIn as oidcSignIn, type TokenSet } from './oidc'

export interface HubKeychain {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

export interface HubConnectionDeps {
  db: Db
  audit: Pick<AuditLog, 'append'>
  keychain: HubKeychain
  fetch: typeof fetch
  openBrowser: (url: string) => Promise<void>
  now: () => number
  emit: (status: HubStatus) => void
}

interface LinkRow {
  url: string
  hub_id: string
  hub_name: string
  user_oid: string | null
  user_upn: string | null
  user_name: string | null
  session_enc: Buffer | null
  session_expires_at: string | null
  refresh_enc: Buffer | null
}

const NO_KEYCHAIN = "Keychain unavailable: OpsDeck can't store a Hub sign-in safely"
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** https, or http to a loopback host (dev); no credentials, query or fragment. Returns the normalised base URL. */
export function normalizeHubUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    throw new HubError('bad_request', 'The Hub address is not a valid URL')
  }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))
  if (!ok) throw new HubError('bad_request', 'The Hub address must be https (http is allowed only for localhost)')
  if (u.username || u.password || u.search || u.hash) throw new HubError('bad_request', 'The Hub address must be a plain URL')
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/** One Hub link per desktop. Tokens are encrypted at rest and held decrypted in memory only while in use. */
export class HubConnection {
  private held: { session: string; refresh: string | null } | null = null
  private user: HubUser | null = null
  private online = true
  private abort: AbortController | null = null
  private meta: HubMeta | null = null
  private renewing: Promise<boolean> | null = null
  // Entra tokens between being received and being traded or stored: redactable, never kept.
  private readonly transient = new Set<string>()
  private readonly listeners: (() => void)[] = []

  constructor(private readonly d: HubConnectionDeps) {}

  /** Called after every status change, before the renderer is told. */
  onState(fn: () => void): void {
    this.listeners.push(fn)
  }

  private row(): LinkRow | undefined {
    return this.d.db.prepare('SELECT * FROM hub_link WHERE id = 1').get() as LinkRow | undefined
  }

  status(): HubStatus {
    const r = this.row()
    if (!r) return { linked: false }
    return {
      linked: true,
      url: r.url,
      hubId: r.hub_id,
      hubName: r.hub_name,
      signedIn: r.session_enc !== null,
      signingIn: this.abort !== null,
      online: this.online,
      user: r.session_enc !== null ? this.user : null,
      sessionExpiresAt: r.session_expires_at,
    }
  }

  private publish(): HubStatus {
    for (const l of this.listeners) l()
    const s = this.status()
    this.d.emit(s)
    return s
  }

  private iso(): string {
    return new Date(this.d.now()).toISOString()
  }

  private plain(over: Partial<ConstructorParameters<typeof HubClient>[0]> & { baseUrl: string }): HubClient {
    return new HubClient({
      fetch: this.d.fetch,
      token: () => null,
      renew: async () => false,
      knownSecrets: () => this.knownValues(),
      onReach: (o) => (this.online = o),
      ...over,
    })
  }

  private async fetchMeta(baseUrl: string): Promise<HubMeta> {
    const meta = await this.plain({ baseUrl }).get<HubMeta>('/api/v1/meta')
    if (!meta || meta.apiVersion !== HUB_API_VERSION || typeof meta.hubId !== 'string' || !meta.entra) {
      throw new HubError('incompatible', 'This Hub runs an incompatible version')
    }
    checkAuthority(meta.entra.authority)
    return meta
  }

  async connect(url: string): Promise<HubStatus> {
    const base = normalizeHubUrl(url)
    const meta = await this.fetchMeta(base)
    this.meta = meta
    const now = this.iso()
    const prev = this.row()
    const changed = prev !== undefined && prev.hub_id !== meta.hubId
    if (changed && prev) {
      const had = prev.session_enc !== null
      this.dropSession()
      // Env links point at the old hub; keeping them would route checks to the new one.
      this.d.db.exec('DELETE FROM hub_env_links')
      if (had) {
        this.d.audit.append({ action: 'hub.signout', outcome: 'success', targetType: 'hub', targetId: prev.hub_id, targetLabel: prev.hub_name })
      }
    }
    this.d.db
      .prepare(
        `INSERT INTO hub_link(id,url,hub_id,hub_name,linked_at,updated_at) VALUES (1,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET url=excluded.url, hub_id=excluded.hub_id, hub_name=excluded.hub_name, updated_at=excluded.updated_at`,
      )
      .run(base, meta.hubId, meta.name, now, now)
    this.d.audit.append({ action: 'hub.link', outcome: 'success', targetType: 'hub', targetId: meta.hubId, targetLabel: meta.name, details: { url: base } })
    return this.publish()
  }

  async signIn(): Promise<HubStatus> {
    const link = this.row()
    if (!link) throw new HubError('bad_request', 'Connect to a Hub first')
    if (!this.d.keychain.available()) throw new Error(NO_KEYCHAIN)
    if (this.abort) throw new HubError('conflict', 'A sign-in is already in progress')
    const ctl = new AbortController()
    this.abort = ctl
    this.publish()
    try {
      const meta = await this.fetchMeta(link.url)
      if (meta.hubId !== link.hub_id) throw new HubError('incompatible', 'This address now belongs to a different Hub')
      this.meta = meta
      const tokens = await oidcSignIn(meta.entra, {
        fetch: this.d.fetch,
        openBrowser: this.d.openBrowser,
        signal: ctl.signal,
        now: this.d.now,
      })
      const session = await this.exchange(link.url, tokens)
      this.store(session, tokens.refreshToken)
      this.d.audit.append({
        action: 'hub.signin',
        outcome: 'success',
        targetType: 'hub',
        targetId: link.hub_id,
        targetLabel: link.hub_name,
        details: { hubName: link.hub_name, role: session.user.role, pending: session.user.status === 'pending' },
      })
      this.abort = null
      return this.publish()
    } finally {
      if (this.abort) {
        this.abort = null
        this.publish()
      }
    }
  }

  cancelSignIn(): void {
    this.abort?.abort()
  }

  /** Trades an Entra access token for a Hub session. The Entra token is not kept. */
  private async exchange(baseUrl: string, tokens: TokenSet): Promise<HubSession> {
    // Redactable from the moment they exist, before any await or error path can echo them.
    const mine = [tokens.accessToken, ...(tokens.refreshToken ? [tokens.refreshToken] : [])]
    for (const t of mine) this.transient.add(t)
    try {
      return await this.plain({ baseUrl, token: () => tokens.accessToken }).post<HubSession>('/api/v1/session')
    } finally {
      for (const t of mine) this.transient.delete(t)
    }
  }

  private store(session: HubSession, refresh: string | null): void {
    const kc = this.d.keychain
    this.d.db
      .prepare(
        `UPDATE hub_link SET session_enc=?, session_expires_at=?, refresh_enc=?, user_oid=?, user_upn=?, user_name=?, updated_at=? WHERE id = 1`,
      )
      .run(
        kc.encrypt(session.token),
        session.expiresAt,
        refresh === null ? null : kc.encrypt(refresh),
        session.user.oid,
        session.user.upn,
        session.user.name,
        this.iso(),
      )
    this.held = { session: session.token, refresh }
    this.user = session.user
  }

  private dropSession(): void {
    this.held = null
    this.user = null
    if (!this.row()) return
    this.d.db
      .prepare(
        'UPDATE hub_link SET session_enc=NULL, session_expires_at=NULL, refresh_enc=NULL, user_oid=NULL, user_upn=NULL, user_name=NULL, updated_at=? WHERE id = 1',
      )
      .run(this.iso())
  }

  /** Decrypts the stored tokens once and keeps them in memory. */
  private load(): { session: string; refresh: string | null } | null {
    if (this.held) return this.held
    const r = this.row()
    if (!r?.session_enc) return null
    try {
      this.held = {
        session: this.d.keychain.decrypt(Buffer.from(r.session_enc)),
        refresh: r.refresh_enc ? this.d.keychain.decrypt(Buffer.from(r.refresh_enc)) : null,
      }
    } catch {
      // Undecryptable (keychain reset): treat as signed out.
      this.dropSession()
      return null
    }
    return this.held
  }

  async signOut(): Promise<HubStatus> {
    const link = this.row()
    if (!link) return { linked: false }
    const had = link.session_enc !== null
    if (had) {
      try {
        await this.plain({ baseUrl: link.url, token: () => this.load()?.session ?? null }).del('/api/v1/session')
      } catch {
        // Best effort: the local sign-out stands either way.
      }
    }
    this.dropSession()
    if (had) {
      this.d.audit.append({ action: 'hub.signout', outcome: 'success', targetType: 'hub', targetId: link.hub_id, targetLabel: link.hub_name })
    }
    return this.publish()
  }

  async unlink(): Promise<HubStatus> {
    this.cancelSignIn()
    const link = this.row()
    if (!link) return { linked: false }
    await this.signOut()
    this.d.db.exec('DELETE FROM hub_env_links; DELETE FROM hub_link')
    this.meta = null
    this.d.audit.append({ action: 'hub.unlink', outcome: 'success', targetType: 'hub', targetId: link.hub_id, targetLabel: link.hub_name })
    return this.publish()
  }

  client(): HubClient {
    const link = this.row()
    if (!link) throw new HubError('bad_request', 'Connect to a Hub first')
    return this.plain({
      baseUrl: link.url,
      token: () => this.load()?.session ?? null,
      renew: () => this.renew(),
    })
  }

  /** Uses the stored refresh token for a new Entra token, then a new Hub session. Never opens a browser. */
  renew(): Promise<boolean> {
    this.renewing ??= this.doRenew().finally(() => (this.renewing = null))
    return this.renewing
  }

  private async doRenew(): Promise<boolean> {
    const link = this.row()
    const held = this.load()
    if (!link || !held?.refresh) return this.signedOut()
    try {
      const meta = this.meta ?? (await this.fetchMeta(link.url))
      this.meta = meta
      const deps = { fetch: this.d.fetch, now: this.d.now }
      const ep = await discover(meta.entra.authority, deps)
      const tokens = await refreshTokens(ep, meta.entra, held.refresh, deps)
      const session = await this.exchange(link.url, tokens)
      // A refresh that returns no new refresh token leaves the old one valid.
      this.store(session, tokens.refreshToken ?? held.refresh)
      this.publish()
      return true
    } catch (err) {
      if (err instanceof OidcError && err.code === 'refresh_expired') return this.signedOut()
      // Only a refresh the Hub or Entra rejects as invalid ends the sign-in.
      if (err instanceof HubError && (err.status === 401 || err.status === 400 || err.status === 403)) return this.signedOut()
      // Unreachable or failing is not rejected: keep the session and say so, so callers back off instead of signing out.
      if (err instanceof HubError && (err.code === 'network' || err.code === 'timeout' || err.code === 'unavailable')) throw err
      if (err instanceof HubError && err.status !== undefined && err.status >= 500) throw new HubError('unavailable', 'The Hub is unavailable', err.status)
      if (err instanceof OidcError && (err.code === 'network' || err.code === 'timeout')) throw new HubError('network', "Can't reach the Hub")
      return false
    }
  }

  private signedOut(): false {
    this.dropSession()
    this.publish()
    return false
  }

  async me(): Promise<HubUser> {
    const user = await this.client().get<HubUser>('/api/v1/me')
    this.user = user
    this.publish()
    return user
  }

  /** The decrypted tokens while held, for redaction. Never leaves the main process. */
  knownValues(): string[] {
    const h = this.load()
    return [...(h ? [h.session, ...(h.refresh ? [h.refresh] : [])] : []), ...this.transient]
  }
}
