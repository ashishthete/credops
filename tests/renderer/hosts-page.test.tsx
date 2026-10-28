import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { sessionsLoaded, sessionStore } from '../../src/renderer/src/terminal/sessions'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { closeCommandPalette, commandStore } from '../../src/renderer/src/ui/commands'
import { CommandPalette } from '../../src/renderer/src/ui/CommandPalette'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { AuthGate } from '../../src/renderer/src/vault/AuthGate'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { cancelUnlock } from '../../src/renderer/src/vault/unlock'
import type {
  EnvironmentMeta,
  HostMeta,
  ProductMeta,
  RegionMeta,
  ResolvedHost,
  SshImportCandidate,
  SshImportPreview,
  SshImportRequest,
} from '../../src/shared/inventory'
import type { SessionMeta } from '../../src/shared/ssh'
import { DEFAULT_VAULT_ID, VAULT_LOCKED, type VaultMeta } from '../../src/shared/vault'
import { REGION, defaultVault, environment, host, mockBridge, product, vaultStatus } from './helpers'
import { resetFakeXterm } from './terminal-fakes'

// framer-motion caches matchMedia, so reduced motion is driven through useMotionSafe (F18).
const motion = vi.hoisted(() => ({ safe: true }))
vi.mock('../../src/renderer/src/ui/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/ui/motion')>()),
  useMotionSafe: () => motion.safe,
}))


vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./terminal-fakes')).FakeTerminal }))
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./terminal-fakes')).FakeFit }))
vi.mock('@xterm/addon-search', async () => ({ SearchAddon: (await import('./terminal-fakes')).FakeSearch }))
vi.mock('@xterm/addon-web-links', async () => ({ WebLinksAddon: (await import('./terminal-fakes')).FakeWebLinks }))

// Opening a session is the terminal store's job; these tests only care what it is asked for.
const sessions = vi.hoisted(() => ({ openSsh: vi.fn(), openLocal: vi.fn() }))
vi.mock('../../src/renderer/src/terminal/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/terminal/sessions')>()),
  openSsh: sessions.openSsh,
  openLocal: sessions.openLocal,
}))

interface World {
  products: ProductMeta[]
  environments: EnvironmentMeta[]
  hosts: HostMeta[]
  preview: SshImportPreview
  /** Rejections `sshconfig:import` throws before it succeeds. */
  importFailures: Error[]
  /** Rejections `sshconfig:preview` throws before it succeeds. */
  previewFailures: Error[]
  unlocked: boolean
  vaults: VaultMeta[]
  corruptVaultIds: string[]
  regions: RegionMeta[]
}

function candidate(over: Partial<SshImportCandidate> & { alias: string }): SshImportCandidate {
  return {
    hostName: `${over.alias}.example.com`,
    port: null,
    user: null,
    identityFile: null,
    proxyJump: null,
    forwards: [],
    warnings: [],
    existingHostId: null,
    valid: true,
    jumpResolvable: false,
    ...over,
  }
}

/** api-1 and edge are tagged api, db-1 is tagged db; api-1 and db-1 share the 10.0.0.x network. */
function world(over: Partial<World> = {}): World {
  return {
    products: [product({ id: 'acme', name: 'Acme', environmentIds: ['prod'] })],
    environments: [environment({ id: 'prod', name: 'prod', color: '#ef5b5b', productId: 'acme', hosts: [{ hostId: 'api1', role: 'app' }] })],
    hosts: [
      host({ id: 'api1', label: 'api-1', address: '10.0.0.5', tags: ['api'], environments: [{ environmentId: 'prod', role: 'app' }] }),
      host({ id: 'db1', label: 'db-1', address: '10.0.0.9', tags: ['db'] }),
      host({ id: 'edge', label: 'edge', address: 'edge.example.com', tags: ['api'] }),
    ],
    preview: {
      path: '/home/tester/.ssh/config',
      found: true,
      candidates: [
        candidate({ alias: 'web-1', hostName: '10.0.1.7', user: 'deploy', port: 2222, identityFile: '/home/tester/.ssh/id_web', proxyJump: 'bastion', jumpResolvable: true, forwards: [{ type: 'L', spec: '5433 localhost:5432' }, { type: 'R', spec: '9000 localhost:3000' }, { type: 'D', spec: '1080' }] }),
        candidate({ alias: 'bastion', existingHostId: 'bastion' }),
        candidate({ alias: 'evil', hostName: '-oProxyCommand=x', valid: false, warnings: ["HostName isn't a usable address; skipped"] }),
      ],
      warnings: ['Include ../outside points outside ~/.ssh; skipped'],
    },
    importFailures: [],
    previewFailures: [],
    unlocked: true,
    vaults: [defaultVault],
    corruptVaultIds: [],
    regions: [REGION],
    ...over,
  }
}

const outside = (hostId: string, address: string): ResolvedHost => ({
  hostId,
  environmentId: null,
  address,
  addressSource: 'host',
  port: { value: 22, source: 'global' },
  identity: { source: 'global', username: 'tester', auth: 'default' },
  jump: { hostId: null, source: null },
  chain: [],
  conflicts: [],
})

let where = ''
function Location() {
  const loc = useLocation()
  where = loc.pathname + loc.search
  return null
}

/** The real composition from App.tsx over a stateful fake main process. */
function renderApp(w: World, path = '/hosts', { strict = false } = {}) {
  const invoke = mockBridge()
  const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'vault:status':
        return vaultStatus({ unlocked: w.unlocked, corruptVaultIds: w.corruptVaultIds })
      case 'vault:list':
        return w.vaults
      case 'vault:unlock':
        w.unlocked = true
        return { ok: true }
      case 'product:list':
        return w.products
      case 'env:list':
        return w.environments
      case 'host:list':
        return w.hosts
      case 'region:list':
        return w.regions.map((r) => ({ ...r, hostCount: w.hosts.filter((h) => h.regionId === r.id).length }))
      case 'region:create': {
        const input = args[0] as Pick<RegionMeta, 'code' | 'displayName' | 'provider'>
        if (w.regions.some((r) => r.code === input.code)) throw new Error('a region with that code already exists')
        const r = { ...REGION, ...input, id: `region-${input.code}`, hostCount: 0 }
        w.regions = [...w.regions, r]
        return r
      }
      case 'region:update': {
        const [id, patch] = args as [string, Partial<RegionMeta>]
        w.regions = w.regions.map((r) => (r.id === id ? { ...r, ...patch } : r))
        return w.regions.find((r) => r.id === id)
      }
      case 'region:delete': {
        const r = w.regions.find((x) => x.id === args[0])!
        const n = w.hosts.filter((h) => h.regionId === r.id).length
        if (n) throw new Error(`${r.code} still has ${n === 1 ? 'a host' : `${n} hosts`}: move ${n === 1 ? 'it' : 'them'} to another region first`)
        w.regions = w.regions.filter((x) => x !== r)
        return null
      }
      case 'host:create': {
        const created = host({ id: `new-${w.hosts.length}`, ...(args[0] as Partial<HostMeta> & { label: string }) })
        w.hosts = [...w.hosts, created]
        return created
      }
      case 'host:resolve': {
        const h = w.hosts.find((x) => x.id === args[0])
        return h ? outside(h.id, h.address) : null
      }
      case 'host:delete':
        w.hosts = w.hosts.filter((h) => h.id !== args[0])
        w.environments = w.environments.map((e) => ({ ...e, hosts: e.hosts.filter((m) => m.hostId !== args[0]) }))
        return null
      case 'sshconfig:preview': {
        const failure = w.previewFailures.shift()
        if (failure) throw failure
        return w.preview
      }
      case 'sshconfig:import': {
        const failure = w.importFailures.shift()
        if (failure) {
          if (failure.message === VAULT_LOCKED) w.unlocked = false
          throw failure
        }
        const req = args[0] as SshImportRequest
        const created = req.aliases.map((alias) =>
          host({
            id: `imported-${alias}`,
            label: alias,
            address: w.preview.candidates.find((c) => c.alias === alias)!.hostName,
            regionId: req.regionId,
            environments: req.environmentId ? [{ environmentId: req.environmentId, role: req.role ?? 'other' }] : [],
          }),
        )
        w.hosts = [...w.hosts, ...created]
        w.environments = w.environments.map((e) =>
          e.id === req.environmentId ? { ...e, hosts: [...e.hosts, ...created.map((h) => ({ hostId: h.id, role: req.role ?? 'other' }))] } : e,
        )
        return { created, skipped: [], keysLinked: 1, identitiesCreated: 1, tunnelsCreated: req.forwards === false ? 0 : 3, warnings: ['3 port forwards will become tunnels'] }
      }
    }
    return base(channel, ...args)
  })
  vaultStatusStore.set(vaultStatus({ unlocked: w.unlocked, corruptVaultIds: w.corruptVaultIds }))
  const app = (
    <MemoryRouter initialEntries={[path]}>
      <AuthGate>
        <AppShell />
        <CommandPalette />
      </AuthGate>
      <Location />
      <Toaster />
    </MemoryRouter>
  )
  const view = render(strict ? <StrictMode>{app}</StrictMode> : app)
  return { invoke, ...view }
}

/** Labelled by the host's label, as the real open does. */
const openedSession = (hostId: string, environmentId?: string): SessionMeta => ({
  id: 's1',
  kind: 'ssh',
  hostId,
  environmentId: environmentId ?? null,
  label: world().hosts.find((h) => h.id === hostId)?.label ?? hostId,
  color: null,
  state: 'ready',
  hops: [],
  error: null,
  openedAt: '2026-01-01T00:00:00.000Z',
  readyAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  attempt: 1,
  container: null,
})

/** The session list has landed, so a Terminals page with no tab would send you straight back: the case the flake hit. */
const sessionsLanded = () => waitFor(() => expect(sessionsLoaded.get()).toBe(true))

/** On Terminals with the new tab showing: not just passing through on the way back. */
async function onTerminals(label: string): Promise<void> {
  expect(await screen.findByRole('tab', { name: new RegExp(`^${label},`) })).toBeVisible()
  expect(where).toBe('/terminals')
}

const hostList = () => screen.getByRole('listbox', { name: 'Hosts' })
const rowNames = () => within(hostList()).queryAllByRole('option').map((o) => o.getAttribute('aria-label'))

beforeEach(() => {
  motion.safe = true
  resetFakeXterm()
  // The opened tab mounts a (fake) terminal, which watches its size.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  // Like the real open, the session's tab exists once it resolves. Without one the deck sends
  // Terminals straight back where it came from, once the session list has landed (a race).
  sessions.openSsh.mockReset().mockImplementation(async (hostId: string, environmentId?: string) => {
    sessionStore.set({ sessions: [openedSession(hostId, environmentId)], order: ['s1'], activeId: 's1' })
    return 's1'
  })
  inventoryStore.set(null)
  vaultStatusStore.set(null)
})

afterEach(() => {
  act(() => {
    cancelUnlock()
    closeCommandPalette()
    clearToasts()
  })
  cleanup()
  vi.unstubAllGlobals()
})

describe('hosts page', () => {
  it('lists and filters', async () => {
    const user = userEvent.setup()
    renderApp(world())
    expect(await screen.findByRole('heading', { name: 'Hosts', level: 1 })).toBeInTheDocument()
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    const api1 = within(hostList()).getByRole('option', { name: 'api-1' })
    expect(within(api1).getByText('10.0.0.5')).toBeInTheDocument()
    expect(within(api1).getByText('prod')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search hosts' }), '10.0.0')
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1']))

    await user.click(within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'db' }))
    expect(within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'db' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(rowNames()).toEqual(['db-1']))
  })

  it('search, tags and the selected host survive a trip to a terminal and back', async () => {
    const user = userEvent.setup()
    renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    await sessionsLanded()
    await user.type(screen.getByRole('searchbox', { name: 'Search hosts' }), 'ed')
    await user.click(within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'api' }))
    await waitFor(() => expect(rowNames()).toEqual(['edge']))
    await user.click(within(hostList()).getByRole('option', { name: 'edge' }))

    await user.click(within(hostList()).getByRole('button', { name: 'Connect to edge' }))
    await onTerminals('edge')
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: /Hosts/ }))

    await waitFor(() => expect(rowNames()).toEqual(['edge']))
    expect(where).toBe('/hosts')
    expect(screen.getByRole('searchbox', { name: 'Search hosts' })).toHaveValue('ed')
    expect(within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'api' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('option', { name: 'edge' })).toHaveAttribute('aria-selected', 'true')
  })

  it('a lock forgets the filters', async () => {
    const user = userEvent.setup()
    const { unmount } = renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    await user.type(screen.getByRole('searchbox', { name: 'Search hosts' }), 'edge')
    await waitFor(() => expect(rowNames()).toEqual(['edge']))
    // A lock unmounts the shell; the next unlock mounts a fresh one.
    unmount()
    renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    expect(screen.getByRole('searchbox', { name: 'Search hosts' })).toHaveValue('')
  })

  it('selects a host into the side pane', async () => {
    const user = userEvent.setup()
    renderApp(world())
    await user.click(await screen.findByRole('option', { name: 'edge' }))
    expect(where).toBe('/hosts?host=edge')
    expect(await screen.findByRole('heading', { name: 'edge', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'edge' })).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowUp}')
    expect(where).toBe('/hosts?host=db1')
    expect(screen.getByRole('option', { name: 'db-1' })).toHaveFocus()
  })

  it('empty state offers both actions', async () => {
    renderApp(world({ hosts: [], environments: [] }))
    expect(await screen.findByText('No hosts yet')).toBeInTheDocument()
    const empty = screen.getByTestId('hosts-empty')
    expect(within(empty).getByRole('button', { name: 'New host' })).toBeInTheDocument()
    expect(within(empty).getByRole('button', { name: 'Import from ~/.ssh/config' })).toBeInTheDocument()
  })

  it('offers Import hosts… and Export hosts… for the hosts segment', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(world())
    await user.click(await screen.findByRole('button', { name: 'Export hosts…' }))
    expect(invoke).toHaveBeenCalledWith('config:export', 'hosts')
    await user.click(screen.getByRole('button', { name: 'Import hosts…' }))
    expect(invoke).toHaveBeenCalledWith('config:importOpen', 'hosts')
  })

  it('Import hosts… and Export hosts… are busy while a file dialog is open', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(world())
    const base = invoke.getMockImplementation()! as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'config:export' || channel === 'config:importOpen' ? new Promise(() => {}) : base(channel, ...args),
    )
    const exportButton = await screen.findByRole('button', { name: 'Export hosts…' })
    await user.dblClick(exportButton)
    expect(exportButton).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Import hosts…' })).toBeDisabled()
    expect(invoke.mock.calls.filter(([c]) => c === 'config:export' || c === 'config:importOpen')).toEqual([['config:export', 'hosts']])
  })

  it('the empty state offers Import hosts…', async () => {
    renderApp(world({ hosts: [], environments: [] }))
    expect(await screen.findByText('No hosts yet')).toBeInTheDocument()
    expect(within(screen.getByTestId('hosts-empty')).getByRole('button', { name: 'Import hosts…' })).toBeInTheDocument()
  })

  it('import wizard', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(world())
    await screen.findByRole('option', { name: 'api-1' })
    await user.click(screen.getByRole('button', { name: 'Import from ~/.ssh/config' }))

    const dialog = await screen.findByRole('dialog')
    const web = await within(dialog).findByRole('checkbox', { name: 'web-1' })
    const bastion = within(dialog).getByRole('checkbox', { name: 'bastion' })
    const evil = within(dialog).getByRole('checkbox', { name: 'evil' })
    expect(within(dialog).getByText('deploy@10.0.1.7:2222')).toBeInTheDocument()
    expect(within(dialog).getByText('Already added')).toBeInTheDocument()
    expect(within(dialog).getByText('Skipped')).toBeInTheDocument()
    expect(bastion).toBeDisabled()
    expect(evil).toBeDisabled()
    // Both warning lists: the file's own, and the entry's.
    expect(within(dialog).getByText('Include ../outside points outside ~/.ssh; skipped')).toBeInTheDocument()
    expect(within(dialog).getByText("HostName isn't a usable address; skipped")).toBeInTheDocument()
    // Paths only ever show as a badge; no key material reaches the page.
    expect(dialog.textContent).not.toContain('id_web')

    await user.click(within(dialog).getByRole('checkbox', { name: 'Select all' }))
    expect(web).toBeChecked()
    expect(bastion).not.toBeChecked()
    expect(evil).not.toBeChecked()

    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    expect(within(dialog).getByLabelText('Vault')).toHaveValue(DEFAULT_VAULT_ID)
    await user.selectOptions(within(dialog).getByLabelText('Environment'), 'prod')
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'app')
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))

    expect(invoke).toHaveBeenCalledWith('sshconfig:import', { regionId: REGION.id, vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'], environmentId: 'prod', role: 'app' })
    expect(await within(dialog).findByText('Imported 1 host')).toBeInTheDocument()
    expect(within(dialog).getByText('3 port forwards will become tunnels')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(rowNames()).toContain('web-1'))
  })

  it('import dialog offers forwards and reports tunnels', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(world())
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    const box = within(dialog).getByRole('checkbox', { name: 'Also create tunnels for 3 port forwards' })
    expect(box).toBeChecked()
    await user.click(box)
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))
    expect(invoke).toHaveBeenCalledWith('sshconfig:import', { regionId: REGION.id, vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'], forwards: false })
    expect(await within(dialog).findByText('Imported 1 host')).toBeInTheDocument()
  })

  it('import dialog reports the tunnels it created', async () => {
    const user = userEvent.setup()
    renderApp(world())
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))
    expect(await within(dialog).findByText(/, 3 tunnels/)).toBeInTheDocument()
  })

  it('import reloads tunnels', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(world())
    const lists = () => invoke.mock.calls.filter(([c]) => c === 'tunnel:list').length
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lists()).toBeGreaterThan(0))
    const before = lists()
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))
    await within(dialog).findByText(/, 3 tunnels/)
    await waitFor(() => expect(lists()).toBe(before + 1))
  })

  it('import wizard reaches its summary under StrictMode', async () => {
    const user = userEvent.setup()
    renderApp(world(), '/hosts', { strict: true })
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))
    expect(await within(dialog).findByText('Imported 1 host')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('a failed preview offers a retry', async () => {
    const user = userEvent.setup()
    renderApp(world({ previewFailures: [new Error('EACCES: permission denied')] }))
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText("Couldn't read ~/.ssh/config")).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
    expect(await within(dialog).findByRole('checkbox', { name: 'web-1' })).toBeInTheDocument()
    expect(within(dialog).queryByText("Couldn't read ~/.ssh/config")).not.toBeInTheDocument()
  })

  it('a failed import keeps the choices and lets the user try again', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(world({ importFailures: [new Error('disk full')] }))
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))

    expect(await screen.findByText("Couldn't import from ~/.ssh/config")).toBeInTheDocument()
    const again = within(dialog).getByRole('button', { name: 'Import 1 host' })
    await waitFor(() => expect(again).toBeEnabled())
    expect(within(dialog).getByLabelText('Vault')).toBeInTheDocument()
    expect(within(dialog).queryByText('Imported 1 host')).not.toBeInTheDocument()

    await user.click(again)
    expect(await within(dialog).findByText('Imported 1 host')).toBeInTheDocument()
    expect(invoke.mock.calls.filter(([c]) => c === 'sshconfig:import')).toHaveLength(2)
  })

  it('reopening resets the vault choice', async () => {
    const user = userEvent.setup()
    const team: VaultMeta = { ...defaultVault, id: 'team', name: 'Team', isDefault: false }
    renderApp(world({ vaults: [defaultVault, team] }))
    const toWhere = async () => {
      const dialog = await screen.findByRole('dialog')
      await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
      await user.click(within(dialog).getByRole('button', { name: 'Next' }))
      return dialog
    }
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    let dialog = await toWhere()
    await user.selectOptions(within(dialog).getByLabelText('Vault'), 'team')
    await user.click(within(dialog).getByRole('button', { name: 'Back' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Import from ~/.ssh/config' }))
    dialog = await toWhere()
    expect(within(dialog).getByLabelText('Vault')).toHaveValue(DEFAULT_VAULT_ID)
  })

  it('no config', async () => {
    const user = userEvent.setup()
    renderApp(world({ preview: { path: '/home/tester/.ssh/config', found: false, candidates: [], warnings: [] } }))
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    expect(await within(screen.getByRole('dialog')).findByText('No ~/.ssh/config found')).toBeInTheDocument()
  })

  it('import vault picker leaves out corrupt vaults', async () => {
    const user = userEvent.setup()
    const broken: VaultMeta = { ...defaultVault, id: 'broken', name: 'Broken', isDefault: false }
    const team: VaultMeta = { ...defaultVault, id: 'team', name: 'Team', isDefault: false }
    renderApp(world({ vaults: [team, broken, defaultVault], corruptVaultIds: ['broken'] }))
    await user.click(await screen.findByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    const vaults = within(within(dialog).getByLabelText('Vault')).getAllByRole('option')
    expect(vaults.map((o) => o.textContent)).toEqual(['Default', 'Team'])
  })

  it('locked import unlocks first', async () => {
    motion.safe = false
    const user = userEvent.setup()
    const w = world({ importFailures: [new Error(VAULT_LOCKED)] })
    const { invoke } = renderApp(w)
    await screen.findByRole('option', { name: 'api-1' })
    await user.click(screen.getByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Select all' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))

    // The lock brings the gate up; the import runs again once the user is back through it.
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    const imports = () => invoke.mock.calls.filter(([c]) => c === 'sshconfig:import')
    await waitFor(() => expect(imports()).toHaveLength(2))
    expect(imports()[1]).toEqual(['sshconfig:import', { regionId: REGION.id, vaultId: DEFAULT_VAULT_ID, aliases: ['web-1'] }])
    expect(await screen.findByText('Imported 1 host, 3 tunnels')).toBeInTheDocument()
    await waitFor(() => expect(rowNames()).toContain('web-1'))
  })

  it('HostsPage double-click connects without environment', async () => {
    const user = userEvent.setup()
    renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    await sessionsLanded()
    // api-1 is in prod, yet the Hosts page has no environment context.
    await user.dblClick(within(hostList()).getByRole('option', { name: 'api-1' }))
    await onTerminals('api-1')
    expect(sessions.openSsh).toHaveBeenCalledWith('api1', undefined)
  })

  it('the row Connect button connects without selecting the row', async () => {
    const user = userEvent.setup()
    renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    await sessionsLanded()
    await user.click(within(hostList()).getByRole('button', { name: 'Connect to edge' }))
    await onTerminals('edge')
    expect(sessions.openSsh).toHaveBeenCalledTimes(1)
    expect(sessions.openSsh).toHaveBeenCalledWith('edge', undefined)
  })

  it('Enter on a focused row connects, and the row button is keyboard reachable', async () => {
    const user = userEvent.setup()
    renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    await sessionsLanded()
    expect(within(hostList()).getByRole('button', { name: 'Connect to edge' })).not.toHaveAttribute('tabindex', '-1')
    act(() => within(hostList()).getByRole('option', { name: 'api-1' }).focus())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sessions.openSsh).toHaveBeenCalledWith('api1', undefined))
  })

  it('palette navigates', async () => {
    const user = userEvent.setup()
    const w = world()
    w.hosts = [...w.hosts, host({ id: 'web1', label: 'web-1', address: '10.0.1.7' })]
    renderApp(w, '/audit')
    await waitFor(() => expect(commandStore.get().some((c) => c.title === 'Go to web-1')).toBe(true))
    expect(commandStore.get().find((c) => c.title === 'Go to prod · Acme')).toBeDefined()

    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
    })
    await user.type(await screen.findByRole('combobox', { name: 'Search commands' }), 'web')
    await user.click(screen.getByRole('option', { name: /Go to web-1/ }))

    expect(where).toBe('/hosts?host=web1')
    expect(await screen.findByRole('heading', { name: 'web-1', level: 2 })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'web-1 options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete host' }))
    await waitFor(() => expect(commandStore.get().some((c) => c.title === 'Go to web-1')).toBe(false))
    expect(commandStore.get().some((c) => c.title === 'Go to api-1')).toBe(true)
  })

  it('deleting a host reloads tunnels', async () => {
    const user = userEvent.setup()
    const w = world()
    w.hosts = [...w.hosts, host({ id: 'web1', label: 'web-1', address: '10.0.1.7' })]
    const { invoke } = renderApp(w, '/hosts?host=web1')
    const lists = () => invoke.mock.calls.filter(([c]) => c === 'tunnel:list').length
    await user.click(await screen.findByRole('button', { name: 'web-1 options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(lists()).toBeGreaterThan(0))
    const before = lists()
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete host' }))
    await waitFor(() => expect(lists()).toBe(before + 1))
  })

  it('palette environment command opens the products tree there', async () => {
    renderApp(world(), '/hosts')
    await waitFor(() => expect(commandStore.get().some((c) => c.title === 'Go to prod · Acme')).toBe(true))
    act(() => commandStore.get().find((c) => c.title === 'Go to prod · Acme')!.run())
    expect(where).toBe('/products?node=p%3Aacme%2Fe%3Aprod')
    expect(await screen.findByRole('treeitem', { name: 'prod' })).toHaveAttribute('aria-selected', 'true')
  })

  it('palette opens the import dialog from anywhere', async () => {
    renderApp(world(), '/audit')
    await waitFor(() => expect(commandStore.get().some((c) => c.title === 'Import from ~/.ssh/config')).toBe(true))
    act(() => commandStore.get().find((c) => c.title === 'Import from ~/.ssh/config')!.run())
    expect(await within(await screen.findByRole('dialog')).findByRole('checkbox', { name: 'web-1' })).toBeInTheDocument()
    expect(where).toBe('/hosts')
  })

  it('reduced motion renders rows without transforms', async () => {
    motion.safe = false
    renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    for (const row of within(hostList()).getAllByRole('option')) expect(row.closest('li')?.style.transform ?? '').toBe('')
  })
})

describe('hosts page regions', () => {
  const EU: RegionMeta = { ...REGION, id: 'region-eu', code: 'eu-west-1', displayName: 'Ireland', provider: 'aws' }
  /** api-1 and edge in test-1, db-1 in eu-west-1. */
  const twoRegions = (over: Partial<World> = {}) => {
    const w = world({ regions: [REGION, EU], ...over })
    w.hosts = w.hosts.map((h) => (h.id === 'db1' ? { ...h, regionId: EU.id } : h))
    return w
  }
  const group = (code: string) => within(hostList()).getByRole('group', { name: code })
  const groupNames = () => within(hostList()).queryAllByRole('group').map((g) => g.getAttribute('aria-label'))

  it('groups hosts under their region, by code, with counts, and folds a group away', async () => {
    const user = userEvent.setup()
    renderApp(twoRegions())
    await waitFor(() => expect(groupNames()).toEqual(['eu-west-1', 'test-1']))
    expect(rowNames()).toEqual(['db-1', 'api-1', 'edge'])
    expect(within(group('test-1')).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['api-1', 'edge'])
    const header = within(group('test-1')).getByRole('button', { name: 'test-1, 2 hosts' })
    expect(header).toHaveAttribute('aria-expanded', 'true')

    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(rowNames()).toEqual(['db-1'])
    await user.click(header)
    await waitFor(() => expect(rowNames()).toEqual(['db-1', 'api-1', 'edge']))
  })

  it('arrow keys follow the grouped order', async () => {
    const user = userEvent.setup()
    renderApp(twoRegions())
    await user.click(await screen.findByRole('option', { name: 'db-1' }))
    await user.keyboard('{ArrowDown}')
    expect(where).toBe('/hosts?host=api1')
    expect(screen.getByRole('option', { name: 'api-1' })).toHaveFocus()
  })

  it('filters by region, and search matches region code and name', async () => {
    const user = userEvent.setup()
    renderApp(twoRegions())
    await waitFor(() => expect(rowNames()).toEqual(['db-1', 'api-1', 'edge']))
    const filter = screen.getByRole('combobox', { name: 'Region' })
    await user.selectOptions(filter, EU.id)
    await waitFor(() => expect(rowNames()).toEqual(['db-1']))
    expect(groupNames()).toEqual(['eu-west-1'])
    await user.selectOptions(filter, '')

    const search = screen.getByRole('searchbox', { name: 'Search hosts' })
    await user.type(search, 'ireland')
    await waitFor(() => expect(rowNames()).toEqual(['db-1']))
    await user.clear(search)
    await user.type(search, 'test-1')
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'edge']))
  })

  it('the region filter only shows once there is more than one region', async () => {
    renderApp(world())
    await waitFor(() => expect(rowNames()).toEqual(['api-1', 'db-1', 'edge']))
    expect(screen.queryByRole('combobox', { name: 'Region' })).not.toBeInTheDocument()
  })

  it("a new host from a region group's + starts in that region", async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(twoRegions())
    await screen.findByRole('option', { name: 'db-1' })
    await user.click(within(group('eu-west-1')).getByRole('button', { name: 'New host in eu-west-1' }))
    const dialog = await screen.findByRole('dialog', { name: 'New host' })
    expect(within(dialog).getByLabelText('Region')).toHaveValue(EU.id)
    await user.type(within(dialog).getByLabelText('Label'), 'db-2')
    await user.type(within(dialog).getByLabelText('Address'), '10.0.0.10')
    await user.click(within(dialog).getByRole('button', { name: 'Create host' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('host:create', expect.objectContaining({ label: 'db-2', regionId: EU.id })))
  })

  it('a new host with no region in view waits for one to be picked', async () => {
    const user = userEvent.setup()
    renderApp(twoRegions(), '/hosts?action=new')
    const dialog = await screen.findByRole('dialog', { name: 'New host' })
    await user.type(within(dialog).getByLabelText('Label'), 'web-9')
    await user.type(within(dialog).getByLabelText('Address'), '10.0.0.11')
    // The first row is selected, so its region is the guess.
    await waitFor(() => expect(within(dialog).getByLabelText('Region')).toHaveValue(EU.id))
  })

  it('Regions… lists every region with its provider and host count', async () => {
    const user = userEvent.setup()
    renderApp(twoRegions())
    await screen.findByRole('option', { name: 'db-1' })
    await user.click(screen.getByRole('button', { name: 'Regions…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Regions' })
    const rows = within(within(dialog).getByRole('list', { name: 'Regions' })).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['eu-west-1', 'test-1'])
    expect(rows[0]).toHaveTextContent('Ireland')
    expect(rows[0]).toHaveTextContent('aws')
    expect(rows[0]).toHaveTextContent('1 host')
    expect(rows[1]).toHaveTextContent('2 hosts')
  })

  it('creates and edits a region, and shows main refusing a duplicate code', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(twoRegions())
    await screen.findByRole('option', { name: 'db-1' })
    await user.click(screen.getByRole('button', { name: 'Regions…' }))
    const list = await screen.findByRole('dialog', { name: 'Regions' })

    await user.click(within(list).getByRole('button', { name: 'New region' }))
    let form = await screen.findByRole('dialog', { name: 'New region' })
    await user.type(within(form).getByLabelText('Code'), 'EU-WEST-1')
    await user.type(within(form).getByLabelText('Display name'), 'Dublin')
    await user.click(within(form).getByRole('button', { name: 'Create region' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('a region with that code already exists')

    await user.clear(within(form).getByLabelText('Code'))
    await user.type(within(form).getByLabelText('Code'), 'us-east-1')
    await user.type(within(form).getByLabelText('Provider'), 'aws')
    await user.click(within(form).getByRole('button', { name: 'Create region' }))
    expect(invoke).toHaveBeenCalledWith('region:create', { code: 'us-east-1', displayName: 'Dublin', provider: 'aws' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New region' })).not.toBeInTheDocument())
    expect(await within(list).findByRole('listitem', { name: 'us-east-1' })).toHaveTextContent('0 hosts')

    await user.click(within(list).getByRole('button', { name: 'Edit us-east-1' }))
    form = await screen.findByRole('dialog', { name: 'Edit us-east-1' })
    expect(within(form).getByLabelText('Display name')).toHaveValue('Dublin')
    await user.clear(within(form).getByLabelText('Display name'))
    await user.type(within(form).getByLabelText('Display name'), 'N. Virginia')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(invoke).toHaveBeenCalledWith('region:update', 'region-us-east-1', { code: 'us-east-1', displayName: 'N. Virginia', provider: 'aws' })
    expect(await within(list).findByText('N. Virginia')).toBeInTheDocument()
  })

  it("refuses to delete a region a host is in, with main's reason, and deletes an empty one", async () => {
    const user = userEvent.setup()
    const w = twoRegions()
    w.regions = [...w.regions, { ...REGION, id: 'region-empty', code: 'ap-south-1', displayName: 'Mumbai' }]
    renderApp(w)
    await screen.findByRole('option', { name: 'db-1' })
    await user.click(screen.getByRole('button', { name: 'Regions…' }))
    const list = await screen.findByRole('dialog', { name: 'Regions' })

    await user.click(within(list).getByRole('button', { name: 'Delete test-1' }))
    let confirm = await screen.findByRole('dialog', { name: 'Delete test-1?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete region' }))
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('test-1 still has 2 hosts: move them to another region first')
    expect(within(list).getByRole('listitem', { name: 'test-1' })).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))

    await user.click(within(list).getByRole('button', { name: 'Delete ap-south-1' }))
    confirm = await screen.findByRole('dialog', { name: 'Delete ap-south-1?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete region' }))
    await waitFor(() => expect(within(list).queryByRole('listitem', { name: 'ap-south-1' })).not.toBeInTheDocument())
  })

  it('the palette opens Manage regions from anywhere', async () => {
    renderApp(world(), '/audit')
    await waitFor(() => expect(commandStore.get().some((c) => c.title === 'Manage regions')).toBe(true))
    act(() => commandStore.get().find((c) => c.title === 'Manage regions')!.run())
    expect(await screen.findByRole('dialog', { name: 'Regions' })).toBeInTheDocument()
    expect(where).toBe('/hosts')
  })

  it("the palette's Connect names the host's region", async () => {
    renderApp(twoRegions())
    await waitFor(() => expect(commandStore.get().some((c) => c.title === 'Connect to db-1 · eu-west-1')).toBe(true))
  })

  it('ssh import with several regions waits for one, and New region… makes one without leaving', async () => {
    const user = userEvent.setup()
    const { invoke } = renderApp(twoRegions())
    await screen.findByRole('option', { name: 'api-1' })
    await user.click(screen.getByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import from ~/.ssh/config' })
    await user.click(await within(dialog).findByRole('checkbox', { name: 'web-1' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    const region = within(dialog).getByLabelText('Region')
    expect(region).toHaveValue('')
    expect(within(dialog).getByRole('button', { name: 'Import 1 host' })).toBeDisabled()

    await user.selectOptions(region, 'New region…')
    const form = await screen.findByRole('dialog', { name: 'New region' })
    await user.type(within(form).getByLabelText('Code'), 'us-east-1')
    await user.type(within(form).getByLabelText('Display name'), 'Virginia')
    await user.click(within(form).getByRole('button', { name: 'Create region' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New region' })).not.toBeInTheDocument())
    // Still on the import's second step, with the new region picked.
    await waitFor(() => expect(within(dialog).getByLabelText('Region')).toHaveValue('region-us-east-1'))
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 host' }))
    expect(invoke).toHaveBeenCalledWith('sshconfig:import', expect.objectContaining({ regionId: 'region-us-east-1', aliases: ['web-1'] }))
  })

  it('cancelling New region… keeps the choice as it was', async () => {
    const user = userEvent.setup()
    renderApp(twoRegions())
    await screen.findByRole('option', { name: 'api-1' })
    await user.click(screen.getByRole('button', { name: 'Import from ~/.ssh/config' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import from ~/.ssh/config' })
    await user.click(await within(dialog).findByRole('checkbox', { name: 'web-1' }))
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await user.selectOptions(within(dialog).getByLabelText('Region'), EU.id)
    await user.selectOptions(within(dialog).getByLabelText('Region'), 'New region…')
    const form = await screen.findByRole('dialog', { name: 'New region' })
    await user.click(within(form).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New region' })).not.toBeInTheDocument())
    expect(within(dialog).getByLabelText('Region')).toHaveValue(EU.id)
    expect(screen.getByRole('dialog', { name: 'Import from ~/.ssh/config' })).toBeInTheDocument()
  })
})
