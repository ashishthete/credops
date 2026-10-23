import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { ConfigTransferMenu } from '../../src/renderer/src/pages/settings/ConfigTransfer'
import { ImportConfigDialog } from '../../src/renderer/src/pages/settings/ImportConfigDialog'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import type { ImportPreview } from '../../src/shared/config-file'
import { mockBridge } from './helpers'

const TOKEN = '0123456789abcdef0123456789abcdef'
const counts = { regions: 1, products: 1, identities: 2, hosts: 2, environments: 1, tunnels: 1, deployments: 0, services: 0, runbooks: 0 }

const preview: ImportPreview = {
  token: TOKEN,
  items: [
    { kind: 'tunnels', id: 't1', name: 'pg', action: 'add' },
    { kind: 'hosts', id: 'h1', name: 'bastion', action: 'add', notes: ['added as a dependency'] },
    { kind: 'hosts', id: 'h2', name: 'app1', action: 'unchanged', notes: ['already here, not changed'] },
    { kind: 'tunnels', id: 't2', name: 'redis', action: 'skip', reason: "its host isn't in that environment here" },
  ],
  counts: { add: 2, update: 0, unchanged: 1, skip: 1 },
  needsSecret: [],
  protectedEnvironments: [],
  needsRegion: false,
  ignored: 5,
}

function renderMenu() {
  render(
    <MemoryRouter>
      <ConfigTransferMenu segment="tunnels" />
      <Toaster />
    </MemoryRouter>,
  )
  return userEvent.setup()
}

afterEach(() => {
  act(() => clearToasts())
  inventoryStore.set(null)
})

describe('page config import and export', () => {
  it('the menu offers Import tunnels… and Export tunnels…', async () => {
    mockBridge()
    const user = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
    const menu = screen.getByRole('menu', { name: 'Import or export tunnels' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Import tunnels…', 'Export tunnels…'])
  })

  it('a second click while a file dialog is open opens no other', async () => {
    const invoke = mockBridge({ 'config:export': new Promise(() => {}), 'config:importOpen': new Promise(() => {}) })
    const user = renderMenu()
    for (const action of ['Export tunnels…', 'Export tunnels…', 'Import tunnels…']) {
      await user.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
      await user.click(screen.getByRole('menuitem', { name: action }))
    }
    expect(invoke.mock.calls.filter(([c]) => c === 'config:export' || c === 'config:importOpen')).toEqual([['config:export', 'tunnels']])
  })

  it('Export tunnels… exports the segment and toasts the file name only', async () => {
    const invoke = mockBridge({ 'config:export': { path: '/Users/me/Desktop/credops-tunnels.json', counts, omitted: 1 } })
    const user = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
    await user.click(screen.getByRole('menuitem', { name: 'Export tunnels…' }))
    expect(invoke).toHaveBeenCalledWith('config:export', 'tunnels')
    expect(await screen.findByText('Exported 8 items to credops-tunnels.json')).toBeInTheDocument()
    expect(screen.getByText('1 secret value was left out')).toBeInTheDocument()
    expect(screen.queryByText(/Desktop/)).not.toBeInTheDocument()
  })

  it('Import tunnels… previews the segment: dependency notes, skip reasons and the ignored count', async () => {
    const invoke = mockBridge({ 'config:importOpen': preview })
    const user = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
    await user.click(screen.getByRole('menuitem', { name: 'Import tunnels…' }))
    expect(invoke).toHaveBeenCalledWith('config:importOpen', 'tunnels')
    const dialog = await screen.findByRole('dialog', { name: 'Import tunnels' })
    expect(within(dialog).getByText(/Only tunnels are imported, with what they need that isn't here yet\./)).toBeInTheDocument()
    expect(within(dialog).getByText('Ignored 5: not tunnels and not needed by them')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: /^Add 2/ }))
    expect(within(dialog).getByText('bastion')).toBeInTheDocument()
    expect(within(dialog).getByText('added as a dependency')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^Unchanged 1/ }))
    expect(within(dialog).getByText('already here, not changed')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^Skip 1/ }))
    expect(within(dialog).getByText("its host isn't in that environment here")).toBeInTheDocument()
  })

  it('applies and discards with the segment', async () => {
    const invoke = mockBridge({ 'config:importOpen': preview, 'config:importApply': { counts: preview.counts, needsSecret: [] } })
    const user = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
    await user.click(screen.getByRole('menuitem', { name: 'Import tunnels…' }))
    await user.click(await screen.findByRole('button', { name: 'Import' }))
    expect(invoke).toHaveBeenCalledWith('config:importApply', TOKEN, { typedNames: [] }, 'tunnels')
    expect(await screen.findByText('Imported: 2 added, 0 updated')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Import or export tunnels' }))
    await user.click(screen.getByRole('menuitem', { name: 'Import tunnels…' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(invoke).toHaveBeenCalledWith('config:importDiscard', TOKEN, 'tunnels')
  })

  it('without a segment the dialog is the Settings one, as before', () => {
    mockBridge()
    render(
      <MemoryRouter>
        <ImportConfigDialog preview={{ ...preview, ignored: undefined }} onClose={() => {}} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('dialog', { name: 'Import config' })).toBeInTheDocument()
    expect(screen.getByText('Nothing is deleted. Objects that are not in the file stay as they are.')).toBeInTheDocument()
    expect(screen.queryByText(/^Ignored/)).not.toBeInTheDocument()
  })
})
