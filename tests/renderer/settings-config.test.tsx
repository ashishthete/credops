import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsPage } from '../../src/renderer/src/pages/settings/SettingsPage'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { VaultSettingsDialog } from '../../src/renderer/src/vault/VaultSettingsDialog'
import { mockBridge, vaultStatus } from './helpers'
import { renderShell } from './shell-helpers'

const counts = { products: 1, identities: 2, hosts: 3, environments: 2, tunnels: 1, deployments: 1, services: 2 }

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
      <Toaster />
    </MemoryRouter>,
  )
}

afterEach(() => {
  act(() => clearToasts())
})

describe('settings page', () => {
  it('Unlock says what unlocks the vaults and opens the unlock settings', async () => {
    mockBridge({ 'vault:status': vaultStatus({ unlocked: true, hasPassword: true, autoLockMinutes: 15 }) })
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, hasPassword: true, autoLockMinutes: 15 })))
    render(<MemoryRouter><SettingsPage /><VaultSettingsDialog /></MemoryRouter>)
    const section = screen.getByRole('region', { name: 'Unlock' })
    expect(section).toHaveTextContent('Unlocks with master password and locks after 15 minutes idle. Add Touch ID or a PIN to stop typing the master password.')
    fireEvent.click(screen.getByRole('button', { name: 'Unlock methods and auto-lock' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('Export config… calls config:export and toasts the count', async () => {
    const invoke = mockBridge({ 'config:export': { path: '/Users/me/Desktop/credops-config.json', counts, omitted: 0 } })
    renderPage()
    expect(screen.getByRole('heading', { name: 'Configuration' })).toBeInTheDocument()
    expect(screen.getByText(/Secrets are never exported; references to vault items are kept by name\./)).toBeInTheDocument()
    expect(screen.getByText(/Free-text fields \(notes, hooks, descriptions, env values and URLs\) are exported as written/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Export config…' }))
    expect(invoke).toHaveBeenCalledWith('config:export')
    expect(await screen.findByText('Exported 12 items to credops-config.json')).toBeInTheDocument()
    expect(screen.queryByText(/left out/)).not.toBeInTheDocument()
    // The renderer never sends a path, and the toast shows only the file's name.
    expect(screen.queryByText(/Desktop/)).not.toBeInTheDocument()
  })

  it('the toast says how many secret values were left out', async () => {
    mockBridge({ 'config:export': { path: '/tmp/credops-config.json', counts, omitted: 3 } })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Export config…' }))
    expect(await screen.findByText('Exported 12 items to credops-config.json')).toBeInTheDocument()
    expect(screen.getByText('3 secret values were left out')).toBeInTheDocument()
  })

  it('one value left out reads in the singular, none says nothing', async () => {
    mockBridge({ 'config:export': { path: '/tmp/credops-config.json', counts, omitted: 1 } })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Export config…' }))
    expect(await screen.findByText('1 secret value was left out')).toBeInTheDocument()
  })

  it('a cancelled save shows nothing', async () => {
    const invoke = mockBridge({ 'config:export': null })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Export config…' }))
    expect(invoke).toHaveBeenCalledWith('config:export')
    await act(async () => {})
    expect(screen.queryByText(/Exported/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Couldn't/)).not.toBeInTheDocument()
  })

  it('a failed export shows the error without the file contents', async () => {
    const invoke = mockBridge()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'config:export') throw new Error("Error invoking remote method 'config:export': Error: Couldn't write the config file")
      return null
    })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Export config…' }))
    expect(await screen.findByText("Couldn't export the config")).toBeInTheDocument()
    expect(screen.getByText("Couldn't write the config file")).toBeInTheDocument()
  })

  it('mod+, opens Settings', async () => {
    mockBridge()
    renderShell('/hosts')
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    act(() => {
      fireEvent.keyDown(window, { key: ',', metaKey: true })
    })
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(commandStore.get().find((c) => c.id === 'settings.open')).toMatchObject({ title: 'Settings', shortcut: 'mod+,' })
  })
})

describe('settings support', () => {
  it('Copy diagnostics asks main for the bundle and toasts', async () => {
    const invoke = mockBridge({ 'app:copyDiagnostics': { chars: 1200 } })
    renderPage()
    expect(screen.getByRole('heading', { name: 'Support' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    expect(invoke).toHaveBeenCalledWith('app:copyDiagnostics')
    expect(await screen.findByText('Diagnostics copied')).toBeInTheDocument()
  })

  it('says so when copying fails, and Show log file reveals the log', async () => {
    const invoke = mockBridge()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'app:copyDiagnostics') throw new Error('no clipboard')
      return null
    })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    expect(await screen.findByText("Couldn't copy diagnostics")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show log file' }))
    expect(invoke).toHaveBeenCalledWith('app:revealLog')
  })
})

