import type { FastifyInstance } from 'fastify'
import { HUB_API_VERSION, type HubMeta } from '../../../src/shared/hub'
import type { HubDeps } from '../app'

export function registerMeta(app: FastifyInstance, deps: HubDeps): void {
  const row = deps.db.prepare("SELECT value FROM hub_meta WHERE key = 'hub_id'").get() as { value: string }
  const { config } = deps
  const meta: HubMeta = {
    hubId: row.value,
    name: config.name,
    apiVersion: HUB_API_VERSION,
    entra: {
      authority: config.entra.authority,
      clientId: config.entra.clientId,
      scopes: ['openid', 'profile', 'offline_access', `api://${config.entra.clientId}/access_as_user`],
      redirectUri: config.entra.redirectUri,
    },
  }
  app.get('/api/v1/meta', async () => meta)
  app.get('/healthz', async () => ({ ok: true }))
}
