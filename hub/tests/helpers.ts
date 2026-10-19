import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { HubAudit } from '../src/audit'
import { buildApp } from '../src/app'
import type { HubConfig } from '../src/config'
import { openHubDb, type HubDb } from '../src/db'

export const TENANT = '11111111-1111-4111-8111-111111111111'
export const CLIENT = '22222222-2222-4222-8222-222222222222'

export interface TestHub {
  app: FastifyInstance
  db: HubDb
  audit: HubAudit
  config: HubConfig
  logs: string[]
  close: () => Promise<void>
}

export async function testHub(overrides: Partial<HubConfig> = {}): Promise<TestHub> {
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
      authority: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
    },
    firstAdmin: { upn: 'admin@example.com' },
    sessionTtlHours: 12,
    ...overrides,
  }
  const db = openHubDb(join(dataDir, 'hub.db'))
  const logs: string[] = []
  const audit = new HubAudit(db)
  const app = buildApp({ config, db, audit, now: () => new Date(), ids: randomUUID, log: { write: (m) => void logs.push(m) } })
  await app.ready()
  return {
    app,
    db,
    audit,
    config,
    logs,
    close: async () => {
      await app.close()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
