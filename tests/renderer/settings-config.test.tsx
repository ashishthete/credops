import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsPage } from '../../src/renderer/src/pages/settings/SettingsPage'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { Toaster, clearToasts } from '../../src/renderer/src/ui/Toaster'
import { mockBridge } from './helpers'
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
  it('Export config… calls config:export and toasts the count', async () => {
    const invoke = mockBridge({ 'config:export': { path: '/Users/me/Desktop/opsdeck-config.json', counts } })
    renderPage()
    expect(screen.getByRole('heading', { name: 'Configuration' })).toBeInTheDocument()
    expect(screen.getByText(/Secrets are never exported; references to vault items are kept by name\./)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Export config…' }))
    expect(invoke).toHaveBeenCalledWith('config:export')
    expect(await screen.findByText('Exported 12 items to opsdeck-config.json')).toBeInTheDocument()
    // The renderer never sends a path, and the toast shows only the file's name.
    expect(screen.queryByText(/Desktop/)).not.toBeInTheDocument()
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
