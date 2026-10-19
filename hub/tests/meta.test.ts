import { afterEach, describe, expect, it } from 'vitest'
import { CLIENT, testHub, type TestHub } from './helpers'

let hub: TestHub
afterEach(async () => hub.close())

describe('meta', () => {
  it('GET /api/v1/meta returns hub identity and entra settings', async () => {
    hub = await testHub()
    const res = await hub.app.inject({ method: 'GET', url: '/api/v1/meta' })
    expect(res.statusCode).toBe(200)
    const row = hub.db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get() as { value: string }
    const body = res.json()
    expect(body.hubId).toBe(row.value)
    expect(body.name).toBe('Test Hub')
    expect(body.apiVersion).toBe(1)
    expect(body.entra.scopes).toEqual(['openid', 'profile', 'offline_access', `api://${CLIENT}/access_as_user`])
    expect(body.entra.clientId).toBe(CLIENT)
  })

  it('GET /healthz returns ok', async () => {
    hub = await testHub()
    const res = await hub.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.json()).toEqual({ ok: true })
  })

  it('unknown route is a 404 json body', async () => {
    hub = await testHub()
    const res = await hub.app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found', message: 'Not found' })
  })

  it('oversized body is 413 with no echo', async () => {
    hub = await testHub()
    const payload = JSON.stringify({ x: 'SECRETMARKER'.repeat(100_000) })
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/meta',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    expect(res.statusCode).toBe(413)
    expect(res.body).not.toContain('SECRETMARKER')
    expect(hub.logs.join('')).not.toContain('SECRETMARKER')
  })
})
