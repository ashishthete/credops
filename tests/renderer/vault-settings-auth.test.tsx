import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetHub } from '../../src/renderer/src/hub/store'
import { ConnectCard } from '../../src/renderer/src/pages/hub/ConnectCard'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { useAccountCommands } from '../../src/renderer/src/vault/account'
import { SignInBanner } from '../../src/renderer/src/vault/SignInBanner'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { openVaultSettings, VaultSettingsDialog } from '../../src/renderer/src/vault/VaultSettingsDialog'
import type { HubStatus } from '../../src/shared/hub'
import type { SsoState } from '../../src/shared/sso'
import type { VaultStatus } from '../../src/shared/vault'
import { mockBridge, vaultStatus } from './helpers'

const UPN = 'alice@contoso.com'

function sso(over: Partial<Extract<SsoState, { required: true }>> = {}): SsoState {
  return {
    required: true,
    verdict: 'verified',
    checking: false,
    upn: UPN,
    hubName: 'Contoso Hub',
    lastVerifiedAt: '2026-10-21T09:00:00.000Z',
    graceEndsAt: null,
    ...over,
  }
}

/** A main process that knows vault:status and the channels queued in `results` (a function result is called with the args). */
function fakeVault(start: Partial<VaultStatus> = {}, results: Record<string, unknown> = {}) {
  const state = vaultStatus({ unlocked: true, ...start })
  const invoke = mockBridge()
  const fallback = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'vault:status') return { ...state }
    if (channel in results) {
      const res = results[channel]
      return typeof res === 'function' ? res(...args) : res
    }
    return (fallback as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
  })
  vaultStatusStore.set({ ...state })
  return { invoke, state }
}

const proven = (over: Partial<VaultStatus> = {}) => ({ ok: true, status: vaultStatus({ unlocked: true, ...over }) })

async function openSettings() {
  render(
    <>
      <VaultSettingsDialog />
      <Toaster />
    </>,
  )
  act(() => openVaultSettings())
  return screen.findByRole('dialog', { name: 'Vault settings' })
}

beforeEach(() => {
  vaultStatusStore.set(null)
  commandStore.set([])
  resetHub()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  act(() => clearToasts())
})

describe('sign-in banner', () => {
  it('banner shows on needs-signin while unlocked and signs in', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ hasPassword: true, quickUnlock: 'touchId', sso: sso({ verdict: 'needs-signin' }) }, {
      'auth:signIn': vaultStatus({ unlocked: true, quickUnlock: 'touchId', sso: sso() }),
    })
    render(<SignInBanner />)
    expect(await screen.findByText('Microsoft sign-in expired')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(invoke).toHaveBeenCalledWith('auth:signIn')
    await waitFor(() => expect(screen.queryByText('Microsoft sign-in expired')).not.toBeInTheDocument())
  })

  it('stays away while locked or verified', () => {
    fakeVault({ unlocked: false, sso: sso({ verdict: 'needs-signin' }) })
    const { container } = render(<SignInBanner />)
    expect(container).toBeEmptyDOMElement()
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, quickUnlock: 'touchId', sso: sso() })))
    expect(container).toBeEmptyDOMElement()
  })

  it('legacy nudge shows once and dismisses', async () => {
    const user = userEvent.setup()
    fakeVault({ hasPassword: true, quickUnlock: 'off', pin: { enabled: false, attemptsLeft: 5 } })
    const first = render(<SignInBanner />)
    expect(await screen.findByText('Add Touch ID or a PIN for faster, safer unlocks')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Add Touch ID or a PIN for faster, safer unlocks')).not.toBeInTheDocument()
    first.unmount()
    render(<SignInBanner />)
    expect(screen.queryByText('Add Touch ID or a PIN for faster, safer unlocks')).not.toBeInTheDocument()
  })

  it('no nudge once there is a PIN or Touch ID', () => {
    fakeVault({ hasPassword: true, quickUnlock: 'touchId' })
    const { container } = render(<SignInBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('unlock methods', () => {
  it('remove PIN is disabled when it is the last factor', async () => {
    fakeVault({ hasPassword: false, quickUnlock: 'off', pin: { enabled: true, attemptsLeft: 5 } })
    const dialog = await openSettings()
    const remove = within(dialog).getByRole('button', { name: 'Remove PIN' })
    expect(remove).toBeDisabled()
    expect(within(dialog).getByTitle('Add Touch ID or a PIN first')).toBeInTheDocument()
    // With the password also set, it can go.
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, hasPassword: true, pin: { enabled: true, attemptsLeft: 5 } })))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Remove PIN' })).toBeEnabled())
  })

  it('remove PIN clears it', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { hasPassword: true, pin: { enabled: true, attemptsLeft: 5 } },
      { 'vault:clearPin': vaultStatus({ unlocked: true, hasPassword: true }) },
    )
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Remove PIN' }))
    expect(invoke).toHaveBeenCalledWith('vault:clearPin')
    expect(await within(dialog).findByRole('button', { name: 'Set PIN' })).toBeInTheDocument()
  })

  it('add master password calls vault:setPassword', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { hasPassword: false, quickUnlock: 'off', pin: { enabled: true, attemptsLeft: 5 } },
      { 'vault:setPassword': proven({ hasPassword: true, pin: { enabled: true, attemptsLeft: 5 } }) },
    )
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Add master password' }))
    const proof = await screen.findByRole('dialog', { name: 'Add a master password' })
    await user.type(within(proof).getByLabelText('New password'), 'battery staple!')
    await user.type(within(proof).getByLabelText('Confirm new password'), 'battery staple!')
    await user.type(within(proof).getByLabelText('Your PIN'), '123456')
    await user.click(within(proof).getByRole('button', { name: 'Add password' }))
    expect(invoke).toHaveBeenCalledWith('vault:setPassword', 'battery staple!', { method: 'pin', pin: '123456' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a master password' })).not.toBeInTheDocument())
    expect(within(dialog).getByRole('button', { name: 'Remove master password' })).toBeInTheDocument()
  })

  it('a malformed PIN proof never reaches main', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ hasPassword: false, quickUnlock: 'off', pin: { enabled: true, attemptsLeft: 5 } })
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Add master password' }))
    const proof = await screen.findByRole('dialog', { name: 'Add a master password' })
    await user.type(within(proof).getByLabelText('New password'), 'battery staple!')
    await user.type(within(proof).getByLabelText('Confirm new password'), 'battery staple!')
    await user.type(within(proof).getByLabelText('Your PIN'), '123')
    await user.click(within(proof).getByRole('button', { name: 'Add password' }))
    expect(await within(proof).findByText('PIN must be 6-12 digits')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('vault:setPassword', expect.anything(), expect.anything())
  })

  it('a wrong proof reports it and keeps the dialog open', async () => {
    const user = userEvent.setup()
    fakeVault(
      { hasPassword: true },
      { 'vault:setPin': () => Promise.reject(new Error('verification failed')) },
    )
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Set PIN' }))
    const proof = await screen.findByRole('dialog', { name: 'Set a PIN' })
    await user.type(within(proof).getByLabelText('New PIN'), '246810')
    await user.type(within(proof).getByLabelText('Confirm new PIN'), '246810')
    await user.type(within(proof).getByLabelText('Your master password'), 'nope')
    await user.click(within(proof).getByRole('button', { name: 'Set PIN' }))
    expect(await within(proof).findByText('Wrong password')).toBeInTheDocument()
    expect(within(proof).getByLabelText('Your master password')).toHaveValue('')
  })
})

describe('account', () => {
  it('change account reverifies then calls auth:changeAccount with the proof', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ hasPassword: true, sso: sso() }, { 'auth:changeAccount': proven({ sso: sso({ upn: 'bob@contoso.com' }) }) })
    const dialog = await openSettings()
    expect(within(dialog).getByText(/Signed in as alice@contoso\.com/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Change Microsoft account' }))
    expect(invoke).not.toHaveBeenCalledWith('auth:changeAccount', expect.anything())
    const proof = await screen.findByRole('dialog', { name: 'Change Microsoft account' })
    await user.type(within(proof).getByLabelText('Your master password'), 'correct horse')
    await user.click(within(proof).getByRole('button', { name: 'Continue' }))
    expect(invoke).toHaveBeenCalledWith('auth:changeAccount', { method: 'password', password: 'correct horse' })
    expect(await within(dialog).findByText(/Signed in as bob@contoso\.com/)).toBeInTheDocument()
  })

  it('sign out calls auth:signOut', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ sso: sso() }, { 'auth:signOut': vaultStatus({ unlocked: false, sso: sso() }) })
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    expect(invoke).toHaveBeenCalledWith('auth:signOut')
    await waitFor(() => expect(vaultStatusStore.get()?.unlocked).toBe(false))
  })

  it('has no account section without a Hub', async () => {
    fakeVault({ sso: { required: false } })
    const dialog = await openSettings()
    expect(within(dialog).queryByText('Account')).not.toBeInTheDocument()
  })

  it('palette offers Sign out only while signed in through a Hub', async () => {
    function Harness() {
      useAccountCommands()
      return null
    }
    const ids = () => commandStore.get().map((c) => c.id)
    const { invoke } = fakeVault({ sso: { required: false } }, { 'auth:signOut': vaultStatus({ unlocked: false }) })
    render(<Harness />)
    expect(ids()).not.toContain('account.signOut')
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, sso: sso() })))
    await waitFor(() => expect(ids()).toContain('account.signOut'))
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, sso: sso({ verdict: 'needs-signin' }) })))
    await waitFor(() => expect(ids()).not.toContain('account.signOut'))
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, sso: sso() })))
    await waitFor(() => expect(ids()).toContain('account.signOut'))
    await act(async () => commandStore.get().find((c) => c.id === 'account.signOut')!.run())
    expect(invoke).toHaveBeenCalledWith('auth:signOut')
  })
})

describe('hub disconnect', () => {
  const linked: HubStatus = {
    linked: true,
    url: 'https://hub.contoso.com',
    hubId: 'hub-1',
    hubName: 'Contoso Hub',
    signedIn: true,
    signingIn: false,
    online: true,
    user: { oid: 'o1', upn: UPN, name: 'Alice', role: 'maintainer', status: 'active', groupIds: [], createdAt: '', lastSeenAt: null },
    sessionExpiresAt: null,
  }

  it('disconnect while bound requires reverify', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { hasPassword: true, sso: sso() },
      { 'hub:status': linked, 'auth:disconnect': proven({ sso: { required: false } }) },
    )
    const { hubStore } = await import('../../src/renderer/src/hub/store')
    act(() => hubStore.set({ ...hubStore.get(), status: linked, statusLoaded: true }))
    render(
      <>
        <ConnectCard />
        <Toaster />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    const proof = await screen.findByRole('dialog', { name: 'Disconnect from Contoso Hub?' })
    expect(invoke).not.toHaveBeenCalledWith('auth:disconnect', expect.anything())
    await user.type(within(proof).getByLabelText('Your master password'), 'correct horse')
    await user.click(within(proof).getByRole('button', { name: 'Disconnect' }))
    expect(invoke).toHaveBeenCalledWith('auth:disconnect', { method: 'password', password: 'correct horse' })
    expect(invoke).not.toHaveBeenCalledWith('hub:unlink')
  })

  it('disconnect without a binding keeps the plain confirmation', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ sso: { required: false } }, { 'hub:unlink': { linked: false } })
    const { hubStore } = await import('../../src/renderer/src/hub/store')
    act(() => hubStore.set({ ...hubStore.get(), status: linked, statusLoaded: true }))
    render(<ConnectCard />)
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    const ask = await screen.findByRole('dialog', { name: 'Disconnect from Contoso Hub?' })
    await user.click(within(ask).getByRole('button', { name: 'Disconnect' }))
    expect(invoke).toHaveBeenCalledWith('hub:unlink')
    expect(invoke).not.toHaveBeenCalledWith('auth:disconnect', expect.anything())
  })
})
