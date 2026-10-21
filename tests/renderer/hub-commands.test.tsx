import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useHubCommands } from '../../src/renderer/src/hub/commands'
import { resetHub, startHubSync } from '../../src/renderer/src/hub/store'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { DEFAULT_GROUP_ID, type HubCatalogEnv, type HubStatus } from '../../src/shared/hub'
import { mockBridge } from './helpers'

const STAMP = '2026-10-16T09:00:00.000Z'
const status: HubStatus = {
  linked: true,
  url: 'https://hub.corp.example',
  hubId: 'hub-1',
  hubName: 'Corp Hub',
  signedIn: true,
  signingIn: false,
  online: true,
  user: { oid: 'o-me', upn: 'me@corp.example', name: 'Me', role: 'maintainer', status: 'active', groupIds: [DEFAULT_GROUP_ID], createdAt: STAMP, lastSeenAt: null },
  sessionExpiresAt: null,
}
const env = (id: string, name: string): HubCatalogEnv => ({
  environment: { id, name, protected: false, versioned: false, autoRollback: false, currentVersion: null },
  hosts: [],
  services: [],
  deployments: [],
  missingSecrets: 0,
  deployKey: null,
  lock: null,
  publishedAt: STAMP,
  publishedBy: 'ada@corp.example',
})

const at = { path: '', search: '' }
function Probe() {
  useHubCommands()
  useEffect(() => startHubSync(), [])
  const l = useLocation()
  at.path = l.pathname
  at.search = l.search
  return null
}

describe('hub palette commands', () => {
  beforeEach(() => resetHub())
  afterEach(cleanup)

  it('registers Team deployments and one Deploy to each team environment, and navigates', async () => {
    mockBridge({ 'hub:status': status, 'hub:catalog': [env('hub-prod', 'prod-eu'), env('hub-stg', 'stg eu')], 'hub:locks': [] })
    render(
      <MemoryRouter initialEntries={['/hub']}>
        <Probe />
      </MemoryRouter>,
    )
    await act(async () => {})
    await act(async () => {})
    const hub = commandStore.get().filter((c) => c.section === 'Hub').map((c) => c.title)
    expect(hub).toEqual(expect.arrayContaining(['Hub: Team deployments', 'Deploy to prod-eu (Hub)', 'Deploy to stg eu (Hub)']))
    act(() => commandStore.get().find((c) => c.title === 'Deploy to stg eu (Hub)')!.run())
    expect(at.path).toBe('/deployments')
    expect(at.search).toBe('?env=hub-stg&action=deploy')
    act(() => commandStore.get().find((c) => c.title === 'Hub: Team deployments')!.run())
    expect(at.search).toBe('')
  })
})
