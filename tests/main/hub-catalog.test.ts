import { describe, expect, it, vi } from 'vitest'
import { HubCatalog } from '../../src/main/hub/catalog'
import type { HubCatalogEnv, HubStatus } from '../../src/shared/hub'

const env = (id: string): HubCatalogEnv => ({
  environment: { id, name: 'prod', protected: false, versioned: false, autoRollback: false, currentVersion: null },
  hosts: [],
  apps: [],
  deployments: [],
  missingSecrets: 0,
  deployKey: null,
  publishedAt: 't',
  publishedBy: 'a',
})
const status = (over: Partial<Extract<HubStatus, { linked: true }>> = {}): HubStatus =>
  ({ linked: true, url: 'u', hubId: 'h', hubName: 'H', signedIn: true, signingIn: false, online: true, user: null, sessionExpiresAt: null, ...over }) as HubStatus

describe('HubCatalog', () => {
  it('shares concurrent refreshes, answers isHubEnv and notifies on change only', async () => {
    const get = vi.fn(async () => [env('e1')])
    const c = new HubCatalog({ client: () => ({ get: get as never }) })
    const changed = vi.fn()
    c.onChange(changed)
    await Promise.all([c.refresh(), c.refresh()])
    expect(get).toHaveBeenCalledTimes(1)
    expect(c.isHubEnv('e1')).toBe(true)
    expect(c.isHubEnv('e2')).toBe(false)
    await c.refresh()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('loads on sign-in and empties on sign-out; a failed refresh keeps the last catalog', async () => {
    let fail = false
    const get = vi.fn(async () => {
      if (fail) throw new Error('down')
      return [env('e1')]
    })
    const c = new HubCatalog({ client: () => ({ get: get as never }) })
    c.onStatus(status())
    await vi.waitFor(() => expect(c.isHubEnv('e1')).toBe(true))
    fail = true
    await expect(c.refresh()).rejects.toThrow('down')
    expect(c.isHubEnv('e1')).toBe(true)
    c.onStatus(status({ signedIn: false }))
    expect(c.list()).toEqual([])
  })
})
