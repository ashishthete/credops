import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { AuthGate } from '../../src/renderer/src/vault/AuthGate'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { cancelUnlock } from '../../src/renderer/src/vault/unlock'
import { encodeIpcError } from '../../src/shared/ipc-error'
import type { HubStatus } from '../../src/shared/hub'
import type { SsoState } from '../../src/shared/sso'
import type { UnlockResult, VaultStatus } from '../../src/shared/vault'
import { emitBridgeEvent, mockBridge, vaultStatus } from './helpers'

const HOUR = 3_600_000
const UPN = 'alice@contoso.com'

/** A required sign-in state; verified by default. */
function sso(over: Partial<Extract<SsoState, { required: true }>> = {}): SsoState {
  return {
    required: true,
    verdict: 'verified',
    checking: false,
    upn: UPN,
    hubName: 'Contoso Hub',
    lastVerifiedAt: new Date().toISOString(),
    graceEndsAt: null,
    ...over,
  }
}

const linked: HubStatus = {
  linked: true,
  url: 'https://hub.contoso.com',
  hubId: 'hub-1',
  hubName: 'Contoso Hub',
  signedIn: false,
  signingIn: false,
  online: true,
  user: null,
  sessionExpiresAt: null,
}

/** A promise settled from the test, for a call held in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A stateful main process (copied from vault-lock.test.tsx, plus sign-in): vault:status reflects
 * unlock, lock, Hub connect and sign-in. `results` queues per-channel answers (one per call, the
 * last one repeats; a promise is awaited, a function called); a VaultStatus answer also becomes the state.
 */
function fakeVault(start: Partial<VaultStatus> = {}, results: Record<string, unknown[]> = {}) {
  const state = vaultStatus(start)
  const invoke = mockBridge()
  const fallback = invoke.getMockImplementation()!
  const next = (channel: string) => {
    const queue = results[channel]
    const res = queue.length > 1 ? queue.shift() : queue[0]
    return typeof res === 'function' ? (res as () => unknown)() : res
  }
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'vault:status') return { ...state }
    if (channel === 'vault:lock') {
      state.unlocked = false
      emitBridgeEvent('vault:locked', { reason: 'manual' })
      return undefined
    }
    if (channel in results) {
      const res = await next(channel)
      if ((res as UnlockResult | undefined)?.ok) state.unlocked = true
      if (res && typeof res === 'object' && 'sso' in res) Object.assign(state, res)
      const proven = res as { status?: VaultStatus } | undefined
      if (proven?.status) Object.assign(state, proven.status)
      return res
    }
    if (channel === 'auth:check') return { ...state }
    if (channel === 'hub:connect') {
      state.sso = sso({ verdict: 'needs-signin', upn: null, lastVerifiedAt: null })
      return linked
    }
    if (channel === 'hub:unlink') {
      state.sso = { required: false }
      return { ...linked, linked: false, url: null, hubId: null, hubName: null }
    }
    if (channel === 'vault:setup') {
      Object.assign(state, { setUp: true, unlocked: true })
      return { ...state }
    }
    if (channel === 'vault:reset') {
      Object.assign(state, { setUp: false, unlocked: false, quickUnlock: 'off' })
      return { ...state }
    }
    return (fallback as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
  })
  const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)
  return { invoke, state, calls }
}

function renderApp() {
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
  try {
    localStorage.clear()
  } catch {
    // No storage: the nudge just shows again.
  }
})

afterEach(() => {
  act(() => {
    cancelUnlock()
    clearToasts()
  })
})

describe('first launch', () => {
  it('first launch asks for the Hub URL, then Microsoft', async () => {
    const user = userEvent.setup()
    const { invoke, calls } = fakeVault({ setUp: false })
    renderApp()
    const card = await gate("Connect to your team's Hub")
    const continueBtn = within(card).getByRole('button', { name: 'Continue' })
    expect(continueBtn).toBeDisabled()
    await user.type(within(card).getByLabelText('Hub URL'), ' https://hub.contoso.com ')
    await user.click(continueBtn)
    expect(invoke).toHaveBeenCalledWith('hub:connect', 'https://hub.contoso.com')
    expect(await screen.findByRole('heading', { name: 'Sign in with Microsoft' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeEnabled()
    expect(screen.getByText(/Contoso Hub/)).toBeInTheDocument()
    // A fresh link has no session to check: no forced check on top of the sign-in.
    expect(calls('auth:check')).toHaveLength(0)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('a linked Hub that will not do can be swapped, or left, before setup', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ setUp: false })
    renderApp()
    await user.type(within(await gate("Connect to your team's Hub")).getByLabelText('Hub URL'), 'https://hub.contoso.com{Enter}')
    const ms = await gate('Sign in with Microsoft')
    await user.click(within(ms).getByRole('button', { name: 'Use a different Hub' }))
    expect(invoke).toHaveBeenCalledWith('hub:unlink')
    const hub = await gate("Connect to your team's Hub")
    await user.click(within(hub).getByRole('button', { name: 'Use CredOps without a Hub' }))
    expect(await gate('Protect your vaults')).toBeInTheDocument()
  })

  it('set-up vaults offer no way to drop the Hub from the sign-in step', async () => {
    fakeVault({ sso: sso({ verdict: 'needs-signin' }) })
    renderApp()
    const card = await gate('Sign in with Microsoft')
    expect(within(card).queryByRole('button', { name: 'Use a different Hub' })).not.toBeInTheDocument()
  })

  it('shows a refused Hub address under the field', async () => {
    const user = userEvent.setup()
    fakeVault({ setUp: false }, { 'hub:connect': [() => Promise.reject(new Error('That is not a CredOps Hub'))] })
    renderApp()
    const card = await gate("Connect to your team's Hub")
    await user.type(within(card).getByLabelText('Hub URL'), 'https://nope.example.com{Enter}')
    expect(await within(card).findByText('That is not a CredOps Hub')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: "Connect to your team's Hub" })).toBeInTheDocument()
  })

  it('without a Hub goes to setup', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ setUp: false })
    renderApp()
    const card = await gate("Connect to your team's Hub")
    await user.click(within(card).getByRole('button', { name: 'Use CredOps without a Hub' }))
    const setup = await gate('Protect your vaults')
    expect(within(setup).getByText('Choose how you unlock CredOps')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('hub:connect', expect.anything())
  })
})

describe('later launches', () => {
  it('shows checking while auth:check is in flight', async () => {
    const check = deferred<VaultStatus>()
    const { calls } = fakeVault(
      { quickUnlock: 'touchId', sso: sso({ verdict: 'needs-signin' }) },
      { 'auth:check': [check.promise] },
    )
    renderApp()
    expect(await screen.findByText('Checking your Microsoft sign-in…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Master password')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with Microsoft' })).not.toBeInTheDocument()
    // No unlock attempt (Touch ID) while the verdict is unknown.
    expect(calls('vault:unlockQuick')).toHaveLength(0)
    expect(calls('auth:check')).toHaveLength(1)

    await act(async () => check.resolve(vaultStatus({ quickUnlock: 'off', sso: sso() })))
    const card = await gate('Unlock vaults')
    expect(within(card).getByText(`Signed in as ${UPN}`)).toBeInTheDocument()
    expect(calls('auth:check')).toHaveLength(1)
  })

  it("waits on main's own check too", async () => {
    fakeVault({ sso: sso({ checking: true }) })
    renderApp()
    expect(await screen.findByText('Checking your Microsoft sign-in…')).toBeInTheDocument()
    // Our forced check has answered, but main still reports one in flight.
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(screen.getByText('Checking your Microsoft sign-in…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Master password')).not.toBeInTheDocument()
  })

  it('needs-signin shows the expired copy and signs in', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { sso: sso({ verdict: 'needs-signin' }) },
      { 'auth:signIn': [vaultStatus({ sso: sso() })] },
    )
    renderApp()
    const card = await gate('Sign in with Microsoft')
    expect(within(card).getByText('Your Microsoft sign-in has expired')).toBeInTheDocument()
    expect(within(card).queryByLabelText('Master password')).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Sign in with Microsoft' }))
    expect(invoke).toHaveBeenCalledWith('auth:signIn')
    const unlock = await gate('Unlock vaults')
    expect(within(unlock).getByText(`Signed in as ${UPN}`)).toBeInTheDocument()
  })

  it('cancelled sign-in returns to the button; Cancel stays enabled while waiting', async () => {
    const user = userEvent.setup()
    const signIn = deferred<VaultStatus>()
    const { invoke } = fakeVault({ sso: sso({ verdict: 'needs-signin' }) }, { 'auth:signIn': [signIn.promise] })
    renderApp()
    const card = await gate('Sign in with Microsoft')
    await user.click(within(card).getByRole('button', { name: 'Sign in with Microsoft' }))
    expect(await within(card).findByText('Waiting for your browser…')).toBeInTheDocument()
    const cancel = within(card).getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    expect(within(card).queryByRole('button', { name: 'Sign in with Microsoft' })).not.toBeInTheDocument()
    await user.click(cancel)
    expect(invoke).toHaveBeenCalledWith('hub:cancelSignIn')
    expect(cancel).toBeEnabled()
    await act(async () => signIn.reject(new Error('Sign-in was cancelled')))
    expect(await within(card).findByRole('button', { name: 'Sign in with Microsoft' })).toBeEnabled()
    expect(within(card).queryByText('Waiting for your browser…')).not.toBeInTheDocument()
    // The user's own cancel is not an error.
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a failed sign-in shows why and stays on the step', async () => {
    const user = userEvent.setup()
    fakeVault({ sso: sso({ verdict: 'needs-signin' }) }, { 'auth:signIn': [() => Promise.reject(new Error('The Hub is not reachable'))] })
    renderApp()
    const card = await gate('Sign in with Microsoft')
    await user.click(within(card).getByRole('button', { name: 'Sign in with Microsoft' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('The Hub is not reachable')
  })

  it('mismatch and blocked show the fixed copy and Reset, with no unlock form', async () => {
    const user = userEvent.setup()
    fakeVault({ sso: sso({ verdict: 'mismatch' }) })
    const { unmount } = renderApp()
    let card = await gate('Sign in with Microsoft')
    expect(within(card).getByText(`These vaults belong to ${UPN}`)).toBeInTheDocument()
    expect(within(card).queryByLabelText('Master password')).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Reset vaults' }))
    expect(await screen.findByRole('dialog', { name: 'Reset vaults?' })).toBeInTheDocument()
    unmount()

    vaultStatusStore.set(null)
    fakeVault({ sso: sso({ verdict: 'blocked' }) })
    renderApp()
    card = await gate('Sign in with Microsoft')
    expect(within(card).getByText('Your Hub account is disabled. Ask a Hub admin.')).toBeInTheDocument()
    expect(within(card).queryByLabelText('Master password')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Sign in with Microsoft' })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Reset vaults' }))
    expect(await screen.findByRole('dialog', { name: 'Reset vaults?' })).toBeInTheDocument()
  })

  it('grace shows the offline line', async () => {
    const lastVerifiedAt = new Date(Date.now() - 5 * HOUR - 60_000).toISOString()
    fakeVault({ sso: sso({ verdict: 'grace', lastVerifiedAt, graceEndsAt: new Date(Date.now() + 60 * HOUR).toISOString() }) })
    renderApp()
    const card = await gate('Unlock vaults')
    expect(within(card).getByText('Working offline · sign-in checked 5 h ago')).toBeInTheDocument()
  })

  it('a reset forces a fresh check, so the old verdict clears', async () => {
    const user = userEvent.setup()
    const { calls } = fakeVault(
      { sso: sso({ verdict: 'mismatch' }) },
      { 'auth:check': [vaultStatus({ sso: sso({ verdict: 'mismatch' }) }), vaultStatus({ setUp: false, sso: sso({ verdict: 'needs-signin', upn: null }) })] },
    )
    renderApp()
    const card = await gate('Sign in with Microsoft')
    await waitFor(() => expect(calls('auth:check')).toHaveLength(1))
    await user.click(within(card).getByRole('button', { name: 'Reset vaults' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reset vaults?' })
    await user.type(within(dialog).getByLabelText('Type RESET to confirm'), 'RESET')
    await user.click(within(dialog).getByRole('button', { name: 'Erase secrets and reset' }))
    await waitFor(() => expect(calls('auth:check')).toHaveLength(2))
    // Still linked: the next step is the Microsoft sign-in, not the mismatch.
    expect(await screen.findByRole('button', { name: 'Sign in with Microsoft' })).toBeInTheDocument()
    expect(screen.queryByText(/These vaults belong to/)).not.toBeInTheDocument()
  })

  it('an install without a Hub offers the Hub line, which can be dismissed', async () => {
    const user = userEvent.setup()
    const { calls } = fakeVault()
    renderApp()
    const card = await gate('Unlock vaults')
    expect(within(card).getByText("Connect your team's Hub to sign in with Microsoft")).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }))
    expect(within(card).queryByText("Connect your team's Hub to sign in with Microsoft")).not.toBeInTheDocument()
    expect(calls('auth:check')).toHaveLength(0)
  })
})

describe('Touch ID needs turning on again', () => {
  it('asks for a proof after the unlock and sends it', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { quickUnlock: 'touchId', lastMethod: 'password', touchIdNeedsReenable: true },
      {
        'vault:unlock': [{ ok: true }],
        'vault:setQuickUnlock': [{ ok: true, status: vaultStatus({ unlocked: true, quickUnlock: 'touchId' }) }],
      },
    )
    renderApp()
    const unlock = await gate('Unlock vaults')
    await user.type(within(unlock).getByLabelText('Master password'), 'correct horse{Enter}')
    const card = await gate('Turn Touch ID on again')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    await user.type(within(card).getByLabelText('Master password'), 'correct horse')
    await user.click(within(card).getByRole('button', { name: 'Turn on Touch ID' }))
    expect(invoke).toHaveBeenCalledWith('vault:setQuickUnlock', 'touchId', { method: 'password', password: 'correct horse' })
    expect(await screen.findByRole('navigation')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('correct horse')
  })

  it('Not now goes straight in', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { quickUnlock: 'touchId', lastMethod: 'password', touchIdNeedsReenable: true },
      { 'vault:unlock': [{ ok: true }] },
    )
    renderApp()
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    const card = await gate('Turn Touch ID on again')
    await user.click(within(card).getByRole('button', { name: 'Not now' }))
    expect(await screen.findByRole('navigation')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('vault:setQuickUnlock', expect.anything(), expect.anything())
  })

  it('a wrong proof says so and stays', async () => {
    const user = userEvent.setup()
    fakeVault(
      { quickUnlock: 'touchId', lastMethod: 'password', touchIdNeedsReenable: true },
      { 'vault:unlock': [{ ok: true }], 'vault:setQuickUnlock': [() => Promise.reject(new Error(encodeIpcError('VERIFICATION_FAILED', 'verification failed')))] },
    )
    renderApp()
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    const card = await gate('Turn Touch ID on again')
    await user.type(within(card).getByLabelText('Master password'), 'wrong one')
    await user.click(within(card).getByRole('button', { name: 'Turn on Touch ID' }))
    expect(await within(card).findByText('Wrong password')).toBeInTheDocument()
    expect(within(card).getByLabelText('Master password')).toHaveValue('')
  })

  it('a wrong PIN says how many tries are left', async () => {
    const user = userEvent.setup()
    const vault = fakeVault(
      { quickUnlock: 'touchId', lastMethod: 'password', pin: { enabled: true, attemptsLeft: 5 }, touchIdNeedsReenable: true },
      {
        'vault:unlock': [{ ok: true }],
        'vault:setQuickUnlock': [
          () => {
            vault.state.pin = { enabled: true, attemptsLeft: 2 }
            return Promise.reject(new Error(encodeIpcError('VERIFICATION_FAILED', 'verification failed')))
          },
        ],
      },
    )
    renderApp()
    const unlock = await gate('Unlock vaults')
    await user.type(within(unlock).getByLabelText('Master password'), 'correct horse{Enter}')
    const card = await gate('Turn Touch ID on again')
    // The PIN comes before the password, so the card opens on it.
    expect(within(card).getByRole('button', { name: 'Use your master password instead' })).toBeInTheDocument()
    await user.type(within(card).getByLabelText('PIN'), '000000')
    await user.click(within(card).getByRole('button', { name: 'Turn on Touch ID' }))
    expect(await within(card).findByText('Wrong PIN · 2 tries left')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('000000')
  })

  it('a pasted 13-digit PIN gets the length error, not a try', async () => {
    const user = userEvent.setup()
    const { calls } = fakeVault(
      { quickUnlock: 'touchId', lastMethod: 'password', pin: { enabled: true, attemptsLeft: 5 }, touchIdNeedsReenable: true },
      { 'vault:unlock': [{ ok: true }] },
    )
    renderApp()
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    const card = await gate('Turn Touch ID on again')
    // The PIN comes before the password, so the card opens on it.
    expect(within(card).getByRole('button', { name: 'Use your master password instead' })).toBeInTheDocument()
    const field = within(card).getByLabelText('PIN')
    await user.click(field)
    await user.paste('1234567890123')
    expect(field).toHaveValue('1234567890123')
    await user.click(within(card).getByRole('button', { name: 'Turn on Touch ID' }))
    expect(await within(card).findByText('PIN must be 6-8 digits')).toBeInTheDocument()
    expect(calls('vault:setQuickUnlock')).toHaveLength(0)
  })

  it('a wiped PIN with the vaults still open switches to the password', async () => {
    const user = userEvent.setup()
    const open = vaultStatus({ unlocked: true, quickUnlock: 'touchId', pin: { enabled: false, attemptsLeft: 0 }, touchIdNeedsReenable: true })
    fakeVault(
      { quickUnlock: 'touchId', lastMethod: 'password', pin: { enabled: true, attemptsLeft: 1 }, touchIdNeedsReenable: true },
      {
        'vault:unlock': [{ ok: true }],
        'vault:setQuickUnlock': [{ ok: false, reason: 'pin-wiped', status: open }],
      },
    )
    renderApp()
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    const card = await gate('Turn Touch ID on again')
    // The PIN comes before the password, so the card opens on it.
    expect(within(card).getByRole('button', { name: 'Use your master password instead' })).toBeInTheDocument()
    await user.type(within(card).getByLabelText('PIN'), '000000')
    await user.click(within(card).getByRole('button', { name: 'Turn on Touch ID' }))
    expect(await screen.findByText('Too many wrong PINs')).toBeInTheDocument()
    expect(await within(card).findByLabelText('Master password')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Use your PIN instead' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Turn Touch ID on again' })).toBeInTheDocument()
  })

  it('no step when Touch ID is fine', async () => {
    const user = userEvent.setup()
    fakeVault({ quickUnlock: 'touchId', lastMethod: 'password', touchIdNeedsReenable: false }, { 'vault:unlock': [{ ok: true }] })
    renderApp()
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    expect(await screen.findByRole('navigation')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Turn Touch ID on again' })).not.toBeInTheDocument()
  })

  it('a PIN proof that wipes the PIN says so and goes back to the lock screen', async () => {
    const user = userEvent.setup()
    const locked = vaultStatus({ unlocked: false, quickUnlock: 'touchId', lastMethod: 'password' })
    fakeVault(
      { quickUnlock: 'touchId', lastMethod: 'password', pin: { enabled: true, attemptsLeft: 1 }, touchIdNeedsReenable: true },
      {
        'vault:unlock': [{ ok: true }],
        'vault:setQuickUnlock': [{ ok: false, reason: 'pin-wiped', status: locked }],
      },
    )
    renderApp()
    // Unlock with the password, then prove with the (last-try) PIN.
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    const card = await gate('Turn Touch ID on again')
    // The PIN comes before the password, so the card opens on it.
    expect(within(card).getByRole('button', { name: 'Use your master password instead' })).toBeInTheDocument()
    await user.type(within(card).getByLabelText('PIN'), '000000')
    await user.click(within(card).getByRole('button', { name: 'Turn on Touch ID' }))
    expect(await screen.findByText('Too many wrong PINs')).toBeInTheDocument()
    expect(await gate('Unlock vaults')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})
