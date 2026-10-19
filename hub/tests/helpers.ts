import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { startFakeEntra, type FakeEntra } from '../../tests/main/fake-entra'
import { EntraVerifier } from '../src/auth/entra'
import { HubAudit } from '../src/audit'
import { buildApp, type HubDeps } from '../src/app'
import type { HubConfig } from '../src/config'
import { openHubDb, type HubDb } from '../src/db'

export const TENANT = '11111111-1111-4111-8111-111111111111'
export const CLIENT = '22222222-2222-4222-8222-222222222222'

export interface TestHub {
  app: FastifyInstance
  db: HubDb
  audit: HubAudit
  config: HubConfig
  masterKey: Buffer
  logs: string[]
  entra: FakeEntra
  /** Mutable clock used by the app. */
  clock: { now: Date }
  /** Signs the fake user in through POST /api/v1/session. */
  signIn: (user?: { oid: string; upn: string; name: string }) => Promise<{ status: number; token: string; body: any }>
  close: () => Promise<void>
}

export async function testHub(overrides: Partial<HubConfig> = {}, appDeps: Partial<HubDeps> = {}): Promise<TestHub> {
  const entra = await startFakeEntra({ tenantId: TENANT, clientId: CLIENT })
  const dataDir = mkdtempSync(join(tmpdir(), 'opsdeck-hub-'))
  const config: HubConfig = {
    name: 'Test Hub',
    listen: { host: '127.0.0.1', port: 0 },
    tls: null,
    publicUrl: 'http://127.0.0.1:8787',
    dataDir,
    entra: {
      tenantId: TENANT,
      clientId: CLIENT,
      redirectUri: 'http://127.0.0.1/callback',
      authority: entra.issuer,
      jwksUri: `${entra.issuer.replace('/v2.0', '')}/discovery/v2.0/keys`,
    },
    firstAdmin: { upn: 'admin@example.com' },
    sessionTtlHours: 12,
    ...overrides,
  }
  const db = openHubDb(join(dataDir, 'hub.db'))
  const logs: string[] = []
  const audit = new HubAudit(db)
  const masterKey = randomBytes(32)
  const clock = { now: new Date() }
  const verifier = new EntraVerifier(config.entra, { now: () => clock.now, jwksCooldownMs: 0 })
  const app = buildApp({ config, db, audit, masterKey, verifier, now: () => clock.now, ids: randomUUID, log: { write: (m) => void logs.push(m) }, ...appDeps })
  await app.ready()
  const signIn: TestHub['signIn'] = async (user) => {
    if (user) entra.setUser(user)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { authorization: `Bearer ${entra.mintAccessToken()}` },
    })
    const body = res.json()
    return { status: res.statusCode, token: body.token ?? '', body }
  }
  return {
    entra,
    clock,
    signIn,
    app,
    db,
    audit,
    config,
    masterKey,
    logs,
    close: async () => {
      await app.close()
      db.close()
      await entra.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
