import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetHub } from '../../src/renderer/src/hub/store'
import { ConnectCard } from '../../src/renderer/src/pages/hub/ConnectCard'
import { commandStore } from '../../src/renderer/src/ui/commands'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { signOutRequest, useAccountCommands } from '../../src/renderer/src/vault/account'
import { SignInBanner } from '../../src/renderer/src/vault/SignInBanner'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { cancelUnlock } from '../../src/renderer/src/vault/unlock'
import { openVaultSettings, VaultSettingsDialog } from '../../src/renderer/src/vault/VaultSettingsDialog'
import { encodeIpcError } from '../../src/shared/ipc-error'
import type { HubStatus } from '../../src/shared/hub'
import type { SsoState } from '../../src/shared/sso'
import { VAULT_LOCKED, type VaultStatus } from '../../src/shared/vault'
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
  signOutRequest.close()
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

  it('no nudge on a Mac with no Keychain', () => {
    fakeVault({ hasPassword: true, quickUnlock: 'off', quickUnlockAvailable: { touchId: false, login: false } })
    const { container } = render(<SignInBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('no nudge once there is a PIN or Touch ID', () => {
    fakeVault({ hasPassword: true, quickUnlock: 'touchId' })
    const { container } = render(<SignInBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('unlock methods', () => {
  // Main's keepsAWayIn: Touch ID or a PIN must stay; a master password never counts as one.
  it('remove PIN is disabled without Touch ID, even with a master password', async () => {
    fakeVault({ hasPassword: true, quickUnlock: 'off', pin: { enabled: true, attemptsLeft: 5 } })
    const dialog = await openSettings()
    expect(within(dialog).getByRole('button', { name: 'Remove PIN' })).toBeDisabled()
    expect(within(dialog).getByTitle('Add Touch ID first')).toBeInTheDocument()
    // With Touch ID also on, it can go.
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, hasPassword: true, quickUnlock: 'touchId', pin: { enabled: true, attemptsLeft: 5 } })))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Remove PIN' })).toBeEnabled())
  })

  it('Touch ID off is disabled without a PIN, even with a master password', async () => {
    fakeVault({ hasPassword: true, quickUnlock: 'touchId', pin: { enabled: false, attemptsLeft: 5 } })
    const dialog = await openSettings()
    const quick = within(dialog).getByLabelText('Quick unlock')
    await waitFor(() => expect(quick).toBeEnabled())
    expect(within(quick).getByRole('option', { name: 'Off' })).toBeDisabled()
    expect(within(dialog).getByTitle('Add a PIN first')).toBeInTheDocument()
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, hasPassword: true, quickUnlock: 'touchId', pin: { enabled: true, attemptsLeft: 5 } })))
    await waitFor(() => expect(within(quick).getByRole('option', { name: 'Off' })).toBeEnabled())
  })

  it('remove master password is disabled when it is the only way in', async () => {
    fakeVault({ hasPassword: true, quickUnlock: 'off', pin: { enabled: false, attemptsLeft: 5 } })
    const dialog = await openSettings()
    expect(within(dialog).getByRole('button', { name: 'Remove master password' })).toBeDisabled()
    expect(within(dialog).getByTitle('Add Touch ID or a PIN first')).toBeInTheDocument()
  })

  it('remove PIN clears it', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { hasPassword: true, quickUnlock: 'touchId', pin: { enabled: true, attemptsLeft: 5 } },
      { 'vault:clearPin': vaultStatus({ unlocked: true, hasPassword: true, quickUnlock: 'touchId' }) },
    )
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Remove PIN' }))
    expect(invoke).toHaveBeenCalledWith('vault:clearPin')
    expect(await within(dialog).findByRole('button', { name: 'Set PIN' })).toBeInTheDocument()
    expect(await screen.findByText('PIN removed')).toBeInTheDocument()
  })

  it('remove PIN shows no success when the re-unlock it needed is cancelled', async () => {
    const user = userEvent.setup()
    const { state } = fakeVault(
      { hasPassword: true, quickUnlock: 'touchId', pin: { enabled: true, attemptsLeft: 5 } },
      {
        'vault:clearPin': () => {
          state.unlocked = false
          return Promise.reject(new Error(encodeIpcError('VAULT_LOCKED', VAULT_LOCKED)))
        },
      },
    )
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Remove PIN' }))
    await waitFor(() => expect(vaultStatusStore.get()?.unlocked).toBe(false))
    act(() => cancelUnlock())
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText('PIN removed')).not.toBeInTheDocument()
    expect(screen.queryByText("Couldn't remove the PIN")).not.toBeInTheDocument()
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
    await user.type(within(proof).getByLabelText('PIN'), '123456')
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
    await user.type(within(proof).getByLabelText('PIN'), '123')
    await user.click(within(proof).getByRole('button', { name: 'Add password' }))
    expect(await within(proof).findByText('PIN must be 6-8 digits')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('vault:setPassword', expect.anything(), expect.anything())
  })

  it('a 4-digit PIN set before the 6-8 rule still proves the user', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ hasPassword: false, quickUnlock: 'off', pin: { enabled: true, attemptsLeft: 5 } })
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Add master password' }))
    const proof = await screen.findByRole('dialog', { name: 'Add a master password' })
    await user.type(within(proof).getByLabelText('New password'), 'battery staple!')
    await user.type(within(proof).getByLabelText('Confirm new password'), 'battery staple!')
    await user.type(within(proof).getByLabelText('PIN'), '2580')
    await user.click(within(proof).getByRole('button', { name: 'Add password' }))
    expect(invoke).toHaveBeenCalledWith('vault:setPassword', 'battery staple!', { method: 'pin', pin: '2580' })
  })

  it('a new PIN needs 6 digits', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ hasPassword: true })
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Set PIN' }))
    const proof = await screen.findByRole('dialog', { name: 'Set a PIN' })
    expect(within(proof).getByText('6 to 8 digits.')).toBeInTheDocument()
    await user.type(within(proof).getByLabelText('New PIN'), '24681')
    await user.type(within(proof).getByLabelText('Confirm new PIN'), '24681')
    await user.type(within(proof).getByLabelText('Master password'), 'correct horse')
    expect(within(proof).getByText('PIN must be 6-8 digits')).toBeInTheDocument()
    expect(within(proof).getByRole('button', { name: 'Set PIN' })).toBeDisabled()
    expect(invoke).not.toHaveBeenCalledWith('vault:setPin', expect.anything(), expect.anything())
  })

  it('a wrong proof reports it and keeps the dialog open', async () => {
    const user = userEvent.setup()
    fakeVault(
      { hasPassword: true },
      { 'vault:setPin': () => Promise.reject(new Error(encodeIpcError('VERIFICATION_FAILED', 'verification failed'))) },
    )
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Set PIN' }))
    const proof = await screen.findByRole('dialog', { name: 'Set a PIN' })
    await user.type(within(proof).getByLabelText('New PIN'), '246810')
    await user.type(within(proof).getByLabelText('Confirm new PIN'), '246810')
    await user.type(within(proof).getByLabelText('Master password'), 'nope')
    await user.click(within(proof).getByRole('button', { name: 'Set PIN' }))
    expect(await within(proof).findByText('Wrong password')).toBeInTheDocument()
    expect(within(proof).getByLabelText('Master password')).toHaveValue('')
  })
})

describe('proof methods', () => {
  const WIPED = (over: Partial<VaultStatus> = {}) => ({
    ok: false,
    reason: 'pin-wiped',
    status: vaultStatus({ unlocked: true, hasPassword: true, quickUnlock: 'touchId', pin: { enabled: false, attemptsLeft: 5 }, ...over }),
  })

  async function startSetPin() {
    const user = userEvent.setup()
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: /^(Set|Change) PIN$/ }))
    const proof = await screen.findByRole('dialog', { name: /^(Set a PIN|Change PIN)$/ })
    await user.type(within(proof).getByLabelText('New PIN'), '246810')
    await user.type(within(proof).getByLabelText('Confirm new PIN'), '246810')
    return { user, dialog, proof }
  }

  it('the proof opens on Touch ID, then the PIN, with the master password last', async () => {
    fakeVault({ hasPassword: true, quickUnlock: 'touchId', pin: { enabled: true, attemptsLeft: 5 }, lastMethod: 'password' })
    let { proof } = await startSetPin()
    expect(within(proof).queryByLabelText('Master password')).not.toBeInTheDocument()
    expect(within(proof).queryByLabelText('PIN')).not.toBeInTheDocument()
    expect(within(proof).getByRole('button', { name: 'Use your PIN instead' })).toBeInTheDocument()
    cleanup()

    fakeVault({ hasPassword: true, quickUnlock: 'off', pin: { enabled: true, attemptsLeft: 5 }, lastMethod: 'password' })
    ;({ proof } = await startSetPin())
    expect(within(proof).getByLabelText('PIN')).toBeInTheDocument()
    expect(within(proof).getByRole('button', { name: 'Use your master password instead' })).toBeInTheDocument()
  })

  it('Touch ID proves it with no secret typed', async () => {
    const { invoke } = fakeVault(
      { hasPassword: false, quickUnlock: 'touchId' },
      { 'vault:setPin': proven({ hasPassword: false, quickUnlock: 'touchId', pin: { enabled: true, attemptsLeft: 5 } }) },
    )
    const { user, proof } = await startSetPin()
    expect(within(proof).getByText('Touch ID will ask you to confirm.')).toBeInTheDocument()
    await user.click(within(proof).getByRole('button', { name: 'Set PIN' }))
    expect(invoke).toHaveBeenCalledWith('vault:setPin', '246810', { method: 'touchId' })
  })

  it('a missed Touch ID says so', async () => {
    fakeVault({ hasPassword: false, quickUnlock: 'touchId' }, { 'vault:setPin': () => Promise.reject(new Error(encodeIpcError('VERIFICATION_FAILED', 'verification failed'))) })
    const { user, proof } = await startSetPin()
    await user.click(within(proof).getByRole('button', { name: 'Set PIN' }))
    expect(await within(proof).findByText('Touch ID did not confirm it is you')).toBeInTheDocument()
  })

  it('does not offer Touch ID while its Keychain copy needs re-enabling', async () => {
    fakeVault({ hasPassword: true, quickUnlock: 'touchId', touchIdNeedsReenable: true })
    const { proof } = await startSetPin()
    expect(within(proof).getByLabelText('Master password')).toBeInTheDocument()
    expect(within(proof).queryByText('Use Touch ID instead')).not.toBeInTheDocument()
  })

  it('a wipe in the proof form tells the user and offers the password', async () => {
    const { invoke } = fakeVault(
      { hasPassword: true, quickUnlock: 'touchId', pin: { enabled: true, attemptsLeft: 1 } },
      { 'vault:setPin': WIPED() },
    )
    const { user, proof } = await startSetPin()
    await user.click(within(proof).getByRole('button', { name: 'Use your PIN instead' }))
    await user.type(within(proof).getByLabelText('PIN'), '000000')
    await user.click(within(proof).getByRole('button', { name: 'Change PIN' }))
    expect(invoke).toHaveBeenCalledWith('vault:setPin', '246810', { method: 'pin', pin: '000000' })
    expect(await screen.findByText('Too many wrong PINs')).toBeInTheDocument()
    expect(screen.getByText('Your PIN was turned off.')).toBeInTheDocument()
    expect(await within(proof).findByLabelText('Master password')).toBeInTheDocument()
  })
})

describe('remove master password', () => {
  const TOUCH_ID = { hasPassword: true, quickUnlock: 'touchId' as const }

  async function openRemove() {
    const user = userEvent.setup()
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Remove master password' }))
    const ask = await screen.findByRole('dialog', { name: 'Remove master password' })
    return { user, dialog, ask }
  }

  it('removes it with the current password', async () => {
    const { invoke } = fakeVault(TOUCH_ID, { 'vault:removePassword': { ok: true } })
    const { user, ask, dialog } = await openRemove()
    await user.type(within(ask).getByLabelText('Master password'), 'correct horse')
    await user.click(within(ask).getByRole('button', { name: 'Remove password' }))
    expect(invoke).toHaveBeenCalledWith('vault:removePassword', 'correct horse')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove master password' })).not.toBeInTheDocument())
    expect(await screen.findByText('Master password removed')).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  it('a wrong password is reported and the field is emptied', async () => {
    fakeVault(TOUCH_ID, { 'vault:removePassword': { ok: false, reason: 'wrong-password', retryAfterMs: 0 } })
    const { user, ask } = await openRemove()
    const field = within(ask).getByLabelText('Master password')
    await user.type(field, 'nope')
    await user.click(within(ask).getByRole('button', { name: 'Remove password' }))
    expect(await within(ask).findByText('Wrong password')).toBeInTheDocument()
    expect(field).toHaveValue('')
  })

  it('a throttled miss counts down before another try', async () => {
    fakeVault(TOUCH_ID, { 'vault:removePassword': { ok: false, reason: 'wrong-password', retryAfterMs: 30_000 } })
    const { user, ask } = await openRemove()
    await user.type(within(ask).getByLabelText('Master password'), 'nope')
    await user.click(within(ask).getByRole('button', { name: 'Remove password' }))
    expect(await within(ask).findByRole('button', { name: /Try again in \d+ s/ })).toBeDisabled()
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
    await user.type(within(proof).getByLabelText('Master password'), 'correct horse')
    await user.click(within(proof).getByRole('button', { name: 'Continue' }))
    expect(invoke).toHaveBeenCalledWith('auth:changeAccount', { method: 'password', password: 'correct horse' })
    expect(await within(dialog).findByText(/Signed in as bob@contoso\.com/)).toBeInTheDocument()
  })

  it('sign out asks first, then calls auth:signOut', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ sso: sso() }, { 'auth:signOut': vaultStatus({ unlocked: false, sso: sso() }) })
    const dialog = await openSettings()
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    const ask = await screen.findByRole('dialog', { name: 'Sign out and lock your vaults?' })
    expect(within(ask).getByText("Your vaults stay on this Mac; you'll sign in with Microsoft next time.")).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('auth:signOut')
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(invoke).not.toHaveBeenCalledWith('auth:signOut')
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Sign out and lock your vaults?' })).getByRole('button', { name: 'Sign out' }))
    expect(invoke).toHaveBeenCalledWith('auth:signOut')
    await waitFor(() => expect(vaultStatusStore.get()?.unlocked).toBe(false))
  })

  it('offers Sign out only while signed in, as the palette does', async () => {
    fakeVault({ sso: sso({ verdict: 'needs-signin' }) })
    const dialog = await openSettings()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Change Microsoft account' })).toBeInTheDocument())
    expect(within(dialog).queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
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
    const { invoke } = fakeVault({ sso: { required: false } })
    render(<Harness />)
    expect(ids()).not.toContain('account.signOut')
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, sso: sso() })))
    await waitFor(() => expect(ids()).toContain('account.signOut'))
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, sso: sso({ verdict: 'needs-signin' }) })))
    await waitFor(() => expect(ids()).not.toContain('account.signOut'))
    act(() => vaultStatusStore.set(vaultStatus({ unlocked: true, sso: sso() })))
    await waitFor(() => expect(ids()).toContain('account.signOut'))
    // The palette asks first too.
    act(() => commandStore.get().find((c) => c.id === 'account.signOut')!.run())
    expect(signOutRequest.store.get()).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('auth:signOut')
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
    await user.type(within(proof).getByLabelText('Master password'), 'correct horse')
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
