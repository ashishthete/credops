import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { HUB_BODY_LIMIT } from '../../src/shared/hub'
import { Directory } from './access/directory'
import type { EntraVerifier } from './auth/entra'
import { SessionStore } from './auth/sessions'
import type { HubAudit } from './audit'
import type { HubConfig } from './config'
import type { HubDb } from './db'
import { installErrorHandler } from './errors'
import { makeAuth } from './auth/plugin'
import { registerAccess } from './routes/access'
import { registerAdmin } from './routes/admin'
import { EnvLocks } from './locks'
import { Registry } from './registry'
import { registerLocks } from './routes/locks'
import { registerReleases } from './routes/releases'
import { HubReleases } from './releases/service'
import { createHubNotify } from './notify/finalize'
import type { AnthropicLike, ClientFactoryOptions } from '../../src/main/ai/claude'
import type { Fetch } from '../../src/main/notify/http'
import type { DeployRunner } from '../../src/main/deploy/runner'
import { registerRegistry } from './routes/registry'
import { registerSecrets } from './routes/secrets'
import { DeployKeys } from './secrets/deploykeys'
import { KeyRing } from './secrets/keyring'
import { SecretStore } from './secrets/store'
import { LiveBus } from './live/bus'
import { registerLive } from './routes/live'
import { registerMeta } from './routes/meta'
import { registerSession } from './routes/session'

export interface HubDeps {
  config: HubConfig
  db: HubDb
  audit: HubAudit
  /** The 32-byte master key; boot fails when it is not the one this database was sealed with. */
  masterKey: Buffer
  verifier: Pick<EntraVerifier, 'verify'>
  now: () => Date
  ids: () => string
  /** Extra values the live stream must mask (tests; the Hub also masks secrets in flight). */
  liveKnownSecrets?: () => readonly string[]
  /** Tests inject a scripted runner; production runs ansible through Phase 8's LocalRunner. */
  runner?: DeployRunner
  /** Tests stub the network and the Anthropic client; production uses fetch, timers and the SDK. */
  notify?: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; claudeFactory?: (o: ClientFactoryOptions) => AnthropicLike }
  /** pino destination; defaults to stdout */
  log?: { write(msg: string): void }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The live SSE bus; the release service publishes deploy events and release state here. */
    live: LiveBus
    /** Server-side releases; boot recovery calls `releases.recover()`. */
    releases: HubReleases
  }
}

export function buildApp(deps: HubDeps): FastifyInstance {
  const ring = new KeyRing(deps.db, deps.masterKey)
  const secrets = new SecretStore(deps.db, ring, { audit: deps.audit, now: deps.now, ids: deps.ids })
  const deployKeys = new DeployKeys(deps.db, ring, { now: deps.now })
  const app = Fastify({
    bodyLimit: HUB_BODY_LIMIT,
    ...(deps.config.tls
      ? { https: { cert: readFileSync(deps.config.tls.certFile), key: readFileSync(deps.config.tls.keyFile) } }
      : {}),
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req: (req: { method: string; url: string; socket?: { remoteAddress?: string } }) => ({
          method: req.method,
          url: req.url.split('?')[0],
          remoteAddress: req.socket?.remoteAddress,
        }),
      },
      ...(deps.log ? { stream: deps.log } : {}),
    },
  })
  // Bound once the release service exists; until then there is nothing to mask beyond secrets in flight.
  let releases: HubReleases | null = null
  const releaseSecrets = (): string[] => releases?.knownSecrets() ?? []
  installErrorHandler(app, () => [...secrets.inflight, ...releaseSecrets()])
  app.addHook('onClose', async () => {
    deps.audit.append({ action: 'hub.stop', outcome: 'info', actor: null })
  })
  registerMeta(app, deps)
  const sessions = new SessionStore(deps.db, { now: deps.now, ttlHours: deps.config.sessionTtlHours })
  const directory = new Directory(deps.db, { firstAdmin: deps.config.firstAdmin, now: deps.now, ids: deps.ids, audit: deps.audit, sessions })
  const live = new LiveBus({ directory, now: deps.now, knownSecrets: () => [...secrets.inflight, ...releaseSecrets(), ...(deps.liveKnownSecrets?.() ?? [])] })
  app.decorate('live', live)
  // Streams must end before the server can close.
  app.addHook('preClose', async () => live.closeAll())
  sessions.onRevoke((r) => ('oid' in r ? live.closeUser(r.oid) : live.closeSession(r.tokenHash)))
  directory.onAccessChange(() => live.publish({ type: 'access.changed' }))
  const auth = makeAuth({ sessions, directory, now: deps.now })
  registerSession(app, { audit: deps.audit, verifier: deps.verifier, sessions, directory, now: deps.now }, auth)
  registerAdmin(app, { directory, audit: deps.audit, auth })
  registerAccess(app, { directory, auth })
  const locks = new EnvLocks(deps.db, { now: deps.now })
  // A restart ends every release, so their locks go; live freezes stay.
  locks.clearReleaseLocks()
  const sweep = setInterval(() => {
    try {
      locks.sweepExpired()
      releases?.expireReady()
    } catch (err) {
      // A timer must never take the Hub down. Only the error's name is logged.
      app.log.error({ errName: err instanceof Error ? err.name : 'Error' }, 'lock sweep failed')
    }
  }, 60_000)
  sweep.unref()
  app.addHook('onClose', async () => clearInterval(sweep))
  const registry = new Registry(deps.db, { audit: deps.audit, directory, locks, now: deps.now })
  registry.onChange(() => live.publish({ type: 'catalog.updated' }))
  locks.onChange((environmentId) => live.publish({ type: 'lock.updated', environmentId, lock: locks.get(environmentId) }))
  registerLive(app, { live, auth, now: deps.now })
  registerRegistry(app, { registry, directory, auth })
  registerLocks(app, { locks, directory, audit: deps.audit, auth })
  registerSecrets(app, { secrets, deployKeys, registry, locks, directory, audit: deps.audit, auth })
  const notify = createHubNotify({
    db: deps.db,
    secrets,
    registry,
    audit: deps.audit,
    runMeta: (id, status) => (releases as HubReleases).service.runMeta(id, status),
    displayName: (upn) => directory.list().find((u) => u.upn === upn)?.name,
    fetch: deps.notify?.fetch ?? globalThis.fetch,
    sleep: deps.notify?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    ...(deps.config.sendgridFrom ? { sendgridFrom: deps.config.sendgridFrom } : {}),
    ...(deps.notify?.claudeFactory ? { claudeFactory: deps.notify.claudeFactory } : {}),
    knownSecrets: () => releases?.runKnownSecrets() ?? [],
    now: deps.now,
  })
  releases = new HubReleases({ config: deps.config, db: deps.db, audit: deps.audit, directory, registry, locks, secrets, deployKeys, live, now: deps.now, ids: deps.ids, finalize: notify.finalize, heldSecrets: notify.held, log: (m) => app.log.error(m), ...(deps.runner ? { runner: deps.runner } : {}) })
  // Started, failed and rolled-back notices ride the run's own events; success goes out from finalize, with notes.
  releases.service.onEvent((batch) => {
    for (const e of batch) void notify.dispatcher.onRunEvent(e)
  })
  deps.audit.setKnownSecrets(() => (releases as HubReleases).knownSecrets())
  app.decorate('releases', releases)
  app.addHook('onClose', async () => releases?.close())
  registerReleases(app, { releases, auth })
  return app
}
