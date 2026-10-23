import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { HubCatalog } from '../../src/main/hub/catalog'
import { HubConnection } from '../../src/main/hub/connection'
import { LiveFeed, sleepUnlessAborted } from '../../src/main/hub/live'
import { HubRunner, RoutingReleases, type ReleaseApi } from '../../src/main/hub/runner'
import { backoffMs } from '../../src/main/tunnels/backoff'
import type { ReleaseSummary, RunEvent } from '../../src/shared/deploy'
import { DEFAULT_GROUP_ID } from '../../src/shared/hub'
import { FakeRunner } from './fake-runner'
import { hubManifest, testHub, type TestHub } from './hub-fixture'

const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }
const SVC_WEB = '71111111-1111-4111-8111-111111111111'
const SVC_API = '72222222-2222-4222-8222-222222222222'
const SENTINEL = 'sentinel-pw-e2e-4c9b7a10d3e84f62'
const SUDO_SENTINEL = 'sudo-sentinel-e2e-81aa5c0f9d2b4e37'
const OPTIONS = { backup: false, notify: false, qa: false }

const fakeKeychain = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).reverse().toString('base64')}`),
  decrypt: (blob: Buffer) => Buffer.from(blob.toString().slice(4), 'base64').reverse().toString(),
}
const fakeBrowser = async (url: string): Promise<void> => {
  const r = await fetch(url, { redirect: 'manual' })
  await fetch(r.headers.get('location')!)
}

/** The local release service must never be reached for a Hub environment. */
const noLocal = (): ReleaseApi => {
  const boom = (): never => {
    throw new Error('the local release service was used for a Hub release')
  }
  return {
    preflight: boom, preflightOperation: boom, previewPlaybook: boom, validateEdit: boom, start: boom, cancel: boom, rollback: boom, breakLock: boom, discard: boom, retryVersion: boom, setNotes: boom,
    list: () => [], listActive: () => [], detail: boom, events: boom, runMeta: boom, hasActive: () => false, onEvent: () => () => undefined,
  }
}

interface Desktop {
  dir: string
  db: Db
  audit: AuditLog
  conn: HubConnection
  catalog: HubCatalog
}

let hub: TestHub
let hubUrl: string
let fr: FakeRunner
const desktops: Desktop[] = []
let feeds: LiveFeed[] = []

function desktop(): Desktop {
  const dir = mkdtempSync(join(tmpdir(), 'credops-hube2e-'))
  const db = openDatabase(join(dir, 'opsdeck.db'))
  const audit = new AuditLog(db)
  const conn = new HubConnection({ db, audit, keychain: fakeKeychain, fetch, openBrowser: fakeBrowser, now: () => Date.now(), emit: () => undefined })
  const catalog = new HubCatalog({ client: () => conn.client() })
  const d = { dir, db, audit, conn, catalog }
  desktops.push(d)
  return d
}

beforeEach(async () => {
  fr = new FakeRunner()
  hub = await testHub({}, { runner: fr })
  await hub.app.listen({ host: '127.0.0.1', port: 0 })
  hubUrl = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`
})
afterEach(async () => {
  for (const f of feeds) f.stop()
  feeds = []
  await hub.close()
  for (const d of desktops.splice(0)) {
    try {
      d.db.close()
    } catch {
      /* closed by the test */
    }
    rmSync(d.dir, { recursive: true, force: true })
  }
})

describe('hub end to end', () => {
  it('a maintainer runs a protected release through the Hub; events arrive in order and no secret reaches the client', async () => {
    const m = await hubManifest()
    // ---- Admin: signs in (first admin), publishes the environment, uploads the secrets.
    const admin = desktop()
    hub.entra.setUser(ADMIN)
    await admin.conn.connect(hubUrl)
    await admin.conn.signIn()
    const ac = admin.conn.client()
    const manifest = m.manifest()
    manifest.environment = { ...manifest.environment, protected: true, autoRollback: false }
    manifest.deployments[0] = m.deployment(m.DEP_WEB, 'web', { envTemplate: `DB_PASSWORD=\${secret:${m.SECRET_DB}}\n`, becomeSecretId: m.SECRET_SUDO, managedEnv: true })
    manifest.services = [
      { id: SVC_WEB, name: 'web-svc', kind: 'service', composeService: 'web', deploymentId: m.DEP_WEB, hostId: m.HOST_ID, viaHostId: null },
      { id: SVC_API, name: 'api-svc', kind: 'service', composeService: 'api', deploymentId: m.DEP_API, hostId: m.HOST_ID, viaHostId: null },
    ]
    await ac.put(`/api/v1/admin/environments/${m.ENV_ID}`, manifest)
    await ac.post(`/api/v1/admin/environments/${m.ENV_ID}/deploy-key`)
    await ac.put(`/api/v1/admin/secrets/${m.SECRET_DB}`, { environmentId: m.ENV_ID, name: 'DB_PASSWORD', kind: 'env', value: SENTINEL })
    await ac.put(`/api/v1/admin/secrets/${m.SECRET_SUDO}`, { environmentId: m.ENV_ID, name: 'sudo', kind: 'become', value: SUDO_SENTINEL })

    // ---- Maintainer: signs in and is pending until the admin adds them to a group.
    const bob = desktop()
    hub.entra.setUser(BOB)
    await bob.conn.connect(hubUrl)
    const signedIn = await bob.conn.signIn()
    expect((signedIn as { user: { status: string } }).user.status).toBe('pending')
    await ac.post(`/api/v1/admin/groups/${DEFAULT_GROUP_ID}/members`, { oids: [BOB.oid] })
    await bob.catalog.refresh()
    expect(bob.catalog.isHubEnv(m.ENV_ID)).toBe(true)

    // ---- The client stack, as index.ts builds it.
    const hubReleaseIds = new Set<string>()
    const pushed = { events: [] as RunEvent[], states: [] as ReleaseSummary[] }
    const shown: unknown[] = []
    const feed = new LiveFeed({
      client: () => bob.conn.client(),
      renew: () => bob.conn.renew(),
      backoff: backoffMs,
      sleep: sleepUnlessAborted,
      push: { events: (b) => void pushed.events.push(...b), state: (s) => void pushed.states.push(s), locks: () => undefined, catalog: () => void bob.catalog.refresh() },
      isMine: (s) => {
        const st = bob.conn.status()
        return st.linked && st.user !== null && s.triggeredBy === `${st.user.upn}@${st.hubName}`
      },
      notifier: { show: (facts, route) => void shown.push({ facts, route }) },
      track: (id) => void hubReleaseIds.add(id),
      now: () => new Date(),
    })
    feeds.push(feed)
    const releases = new RoutingReleases({
      local: noLocal(),
      hub: new HubRunner({ client: () => bob.conn.client(), audit: bob.audit, ids: hubReleaseIds, envName: (id) => bob.catalog.get(id)?.environment.name, feed }),
      isHubEnv: (id) => bob.catalog.isHubEnv(id),
      hubReleaseIds,
      hubActive: () => true,
      notice: () => undefined,
    })
    feed.start()
    await vi.waitFor(() => expect(hub.app.live.size()).toBe(1))

    fr.on.release = (_p, _s, emit) => {
      emit({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: 'hello from the run' })
      emit({ type: 'log', stepId: null, hostId: null, stream: 'ansible', line: 'second line' })
    }

    // ---- preflight -> start with the typed name.
    const results: unknown[] = []
    const { releaseId } = await releases.preflight({ environmentId: m.ENV_ID, serviceIds: [SVC_WEB, SVC_API], bump: 'none', options: OPTIONS })
    results.push({ releaseId })
    await hub.app.releases.whenIdle()
    const ready = await releases.detail(releaseId)
    results.push(ready)
    expect(ready.status).toBe('ready')
    await expect(releases.start(releaseId, {})).rejects.toMatchObject({
      code: 'confirm_required',
      message: 'Type the environment name "prod" to deploy to a protected environment',
    })
    await releases.start(releaseId, { typedName: 'prod' })
    await hub.app.releases.whenIdle()
    await vi.waitFor(() => expect(pushed.states.at(-1)).toMatchObject({ id: releaseId, status: 'succeeded' }))
    await feed.idle()

    // Live events reached the maintainer's deploy:event push complete and in order.
    const seqs = pushed.events.filter((e) => e.runId === releaseId).map((e) => e.seq)
    expect(seqs.length).toBeGreaterThan(2)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
    const lines = pushed.events.filter((e) => e.type === 'log').map((e) => (e as { line: string }).line)
    expect(lines).toEqual(expect.arrayContaining(['hello from the run', 'second line']))
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ route: `/deployments/release/${releaseId}`, facts: { status: 'succeeded' } })

    // Reads through the router come back from the Hub.
    const log = await releases.events(releaseId, 0, 5000)
    results.push(log, await releases.list({ environmentId: m.ENV_ID }), await releases.listActive(), await releases.runMeta(releaseId))
    expect(log.map((e) => e.seq)).toEqual(seqs)
    expect((await releases.detail(releaseId)).status).toBe('succeeded')
    expect(fr.kinds).toContain('release')

    // Mutating calls were audited on this desktop, with the environment name and no values.
    const local = bob.audit.list({}).filter((e) => e.action === 'hub.release')
    expect(local.map((e) => (e.details as { op: string }).op).sort()).toEqual(['preflight', 'start', 'start'])
    expect(local.find((e) => e.outcome === 'failure')).toMatchObject({ details: { op: 'start', reason: 'confirm_required', environmentName: 'prod' } })
    expect(local.find((e) => (e.details as { op: string }).op === 'preflight')).toMatchObject({ outcome: 'success', targetId: releaseId, details: { environmentName: 'prod' } })

    // The Hub's own audit chain is intact, and the Hub named the maintainer.
    expect(hub.audit.verify().ok).toBe(true)

    // ---- No secret anywhere on the client: results, pushes, notifications, audit and database bytes.
    const everything = JSON.stringify([results, pushed, shown, bob.audit.list({}), admin.audit.list({})])
    for (const secret of [SENTINEL, SUDO_SENTINEL]) {
      expect(everything).not.toContain(secret)
      for (const d of [bob, admin]) {
        try {
          d.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } catch {
          /* not WAL */
        }
        for (const f of ['opsdeck.db', 'opsdeck.db-wal']) {
          const file = join(d.dir, f)
          if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret)), `${secret} in ${f}`).toBe(false)
        }
      }
    }
  })
})
