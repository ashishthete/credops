import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { AuthGate } from '../../src/renderer/src/vault/AuthGate'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { cancelUnlock } from '../../src/renderer/src/vault/unlock'
import type { VaultStatus } from '../../src/shared/vault'
import { mockBridge, vaultStatus } from './helpers'

/** A locked, set-up main process whose vault:reset (with the right word) un-sets it up. */
function fakeVault(start: Partial<VaultStatus> = {}) {
  const state = vaultStatus({ quickUnlock: 'off', ...start })
  const invoke = mockBridge()
  const fallback = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'vault:status') return { ...state }
    if (channel === 'vault:reset') {
      if (args[0] !== 'RESET') throw new Error('type RESET to confirm')
      Object.assign(state, { setUp: false, unlocked: false, quickUnlock: 'off' })
      return { ...state }
    }
    if (channel === 'vault:setup') {
      Object.assign(state, { setUp: true, unlocked: true })
      return { ...state }
    }
    return (fallback as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
  })
  return { invoke, state }
}

function renderGate() {
  return render(
    <MemoryRouter>
      <AuthGate>
        <AppShell />
      </AuthGate>
      <Toaster />
    </MemoryRouter>,
  )
}

const gate = (name: string) => screen.findByRole('region', { name })

beforeEach(() => {
  vaultStatusStore.set(null)
})

afterEach(() => {
  act(() => {
    cancelUnlock()
    clearToasts()
  })
})

async function openReset(user: ReturnType<typeof userEvent.setup>) {
  const card = await gate('Unlock vaults')
  await user.click(within(card).getByRole('button', { name: 'Forgot password?' }))
  return screen.findByRole('dialog', { name: 'Reset vaults?' })
}

describe('forgot password', () => {
  it('the link opens the reset dialog, and Cancel closes it', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault()
    renderGate()
    const dialog = await openReset(user)
    expect(within(dialog).getByText("The master password can't be recovered.")).toBeInTheDocument()
    expect(within(dialog).getByText(/permanently erases every secret in every vault/)).toBeInTheDocument()
    expect(within(dialog).getByText(/turns off Touch ID quick unlock/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Products, environments, hosts, services, tunnels and other settings are kept/)).toBeInTheDocument()
    expect(within(dialog).getByText(/will need it added again/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(invoke).not.toHaveBeenCalledWith('vault:reset', expect.anything())
    expect(screen.getByRole('region', { name: 'Unlock vaults' })).toBeInTheDocument()
  })

  it('the erase button stays disabled until RESET is typed exactly', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault()
    renderGate()
    const dialog = await openReset(user)
    const erase = within(dialog).getByRole('button', { name: 'Erase secrets and reset' })
    const field = within(dialog).getByLabelText('Type RESET to confirm')
    expect(erase).toBeDisabled()
    await user.type(field, 'reset')
    expect(erase).toBeDisabled()
    await user.clear(field)
    await user.type(field, 'RESET ')
    expect(erase).toBeDisabled()
    // Enter does nothing while the word is wrong.
    await user.type(field, '{Enter}')
    expect(invoke).not.toHaveBeenCalledWith('vault:reset', expect.anything())
    await user.clear(field)
    await user.type(field, 'RESET')
    expect(erase).toBeEnabled()
  })

  it('confirming calls vault:reset and lands on setup, then the app opens', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault()
    renderGate()
    const dialog = await openReset(user)
    await user.type(within(dialog).getByLabelText('Type RESET to confirm'), 'RESET')
    await user.click(within(dialog).getByRole('button', { name: 'Erase secrets and reset' }))
    expect(invoke).toHaveBeenCalledWith('vault:reset', 'RESET')
    await gate('Protect your vaults')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Master password'), 'a brand new password')
    await user.type(screen.getByLabelText('Confirm password'), 'a brand new password')
    await user.click(screen.getByRole('button', { name: 'Create master password' }))
    expect(invoke).toHaveBeenCalledWith('vault:setup', 'a brand new password')
    await gate('Your vaults are ready')
    await user.click(screen.getByRole('button', { name: /Continue|Not now/ }))
    expect(await screen.findByRole('navigation')).toBeInTheDocument()
  })
})
