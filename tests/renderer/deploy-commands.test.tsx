import './flow-stubs'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetReleases } from '../../src/renderer/src/deploy/releases'
import { resetDeploy } from '../../src/renderer/src/deploy/store'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { resetSessions } from '../../src/renderer/src/terminal/sessions'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { ReleaseSummary } from '../../src/shared/deploy'
import { releaseDetail } from './fixtures/release-events'
import { appService, dbService, defaultVault, deploymentMeta, emitBridgeEvent, environment, host, mockBridge, product } from './helpers'

const flush = () => act(async () => {})
const titles = () =>
  commandStore
    .get()
    .filter((c) => c.section === 'Deployments')
    .map((c) => c.title)
    .sort()
const command = (title: string) => commandStore.get().find((c) => c.title === title)!

const at = { path: '', search: '' }
function LocationProbe() {
  const l = useLocation()
  at.path = l.pathname
  at.search = l.search
  return null
}

function running(id: string, envId: string, envName: string, version: string): ReleaseSummary {
  const { options: _o, releaseNotes: _n, playbook: _p, runs: _r, preflight: _f, lastSeq: _l, ...rest } = releaseDetail()
  return { ...rest, id, environmentId: envId, environmentName: envName, version, status: 'running', startedAt: '2026-10-19T10:00:00.000Z' }
}

async function renderShell(path: string, active: ReleaseSummary[] = []) {
  mockBridge({
    'product:list': [product({ id: 'p1', name: 'Platform' })],
    'env:list': [
      environment({ id: 'e1', name: 'staging', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] }),
      environment({ id: 'e2', name: 'prod', productIds: ['p1'], hosts: [{ hostId: 'h1', role: 'app' }] }),
    ],
    'host:list': [host({ id: 'h1', label: 'app1' })],
    'identity:list': [],
    'vault:list': [defaultVault],
    'tunnel:list': [],
    'tunnel:status': [],
    'deploy:list': [deploymentMeta({ id: 'd1', name: 'core', environmentId: 'e1', hostId: 'h1' })],
    'service:list': [
      appService({ id: 's1', name: 'api', environmentId: 'e1', deploymentId: 'd1', position: 0 }),
      appService({ id: 's9', name: 'loose', environmentId: 'e1', deploymentId: null, position: 1 }),
      dbService({ id: 'b1', name: 'main-db', environmentId: 'e1', position: 2 }),
    ],
    'release:active': active,
    'release:get': releaseDetail({ status: 'running' }),
  })
  const out = render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
  await flush()
  await flush()
  await flush()
  return out
}

async function run(title: string) {
  await act(async () => {
    command(title).run()
  })
  await flush()
  await flush()
}

beforeEach(() => {
  inventoryStore.set(null)
  resetTunnels()
  resetSessions()
})

afterEach(() => {
  cleanup()
  resetReleases()
  resetDeploy()
  resetTunnels()
  resetSessions()
  clearToasts()
})

describe('deploy commands', () => {
  it('registers per environment with checkouts, per running release and per checkout service', async () => {
    const { unmount } = await renderShell('/products', [running('rel-1', 'e1', 'staging', 'v1.4.0')])
    // prod has no checkouts; loose has none either, and a database has no logs to tail.
    expect(titles()).toEqual(['Deploy services in staging…', 'Deployment history: staging', 'Logs: api (staging)', 'Open running release'])
    unmount()
    expect(titles()).toEqual([])
  })

  it('two running releases are told apart by environment and version', async () => {
    await renderShell('/products', [running('rel-1', 'e1', 'staging', 'v1.4.0'), running('rel-2', 'e2', 'prod', 'v2.0.0')])
    expect(titles().filter((t) => t.startsWith('Open running'))).toEqual(['Open running release: prod v2.0.0', 'Open running release: staging v1.4.0'])
  })

  it('deploy opens the wizard for that environment', async () => {
    await renderShell('/products')
    await run('Deploy services in staging…')
    expect(at.path).toBe('/deployments')
    // The one-shot action param is dropped once the wizard opens.
    expect(at.search).toBe('?env=e1')
    expect(screen.getByRole('dialog', { name: 'Deploy to staging' })).toBeInTheDocument()
  })

  it('history opens the history tab of that environment', async () => {
    await renderShell('/products')
    await run('Deployment history: staging')
    expect(at.path).toBe('/deployments')
    expect(at.search).toBe('?env=e1&tab=history')
    expect(screen.getByText('No releases yet')).toBeInTheDocument()
  })

  it('open running release shows its pipeline', async () => {
    await renderShell('/products', [running('rel-1', 'e1', 'staging', 'v1.4.0')])
    await run('Open running release')
    expect(at.path).toBe('/deployments/release/rel-1')
    expect(screen.getByRole('heading', { name: 'Release' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Pipeline' })).toBeInTheDocument()
  })

  it('logs opens the service logs drawer wherever you are', async () => {
    await renderShell('/hosts')
    await run('Logs: api (staging)')
    expect(at.path).toBe('/hosts')
    expect(screen.getByRole('dialog', { name: 'api logs on app1' })).toBeInTheDocument()
  })
})

describe('sidebar badge', () => {
  it('sidebar badge shows the active release count', async () => {
    await renderShell('/products', [running('rel-1', 'e1', 'staging', 'v1.4.0'), running('rel-2', 'e2', 'prod', 'v2.0.0')])
    const nav = screen.getByRole('navigation')
    const badge = within(nav).getByLabelText('2 releases running')
    expect(badge).toHaveTextContent('2')

    // A finished release leaves the count.
    act(() => emitBridgeEvent('release:state', { ...running('rel-2', 'e2', 'prod', 'v2.0.0'), status: 'succeeded', finishedAt: '2026-10-19T10:03:00.000Z' }))
    await flush()
    expect(within(nav).getByLabelText('1 release running')).toHaveTextContent('1')
    act(() => emitBridgeEvent('release:state', { ...running('rel-1', 'e1', 'staging', 'v1.4.0'), status: 'failed', finishedAt: '2026-10-19T10:03:00.000Z' }))
    await flush()
    expect(nav.querySelector('[data-badge]')).toBeNull()
  })
})
