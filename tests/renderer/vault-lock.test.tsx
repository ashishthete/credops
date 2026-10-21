import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { AuthGate } from '../../src/renderer/src/vault/AuthGate'
import { SetupCard } from '../../src/renderer/src/vault/SetupCard'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { passwordStrength } from '../../src/renderer/src/vault/strength'
import { cancelUnlock, ensureUnlocked, withUnlock } from '../../src/renderer/src/vault/unlock'
import { closeVaultSettings, openVaultSettings, VaultSettingsDialog } from '../../src/renderer/src/vault/VaultSettingsDialog'
import type { SetupOptions, UnlockResult, VaultStatus } from '../../src/shared/vault'
import { emitBridgeEvent, mockBridge, vaultStatus } from './helpers'

const WRONG: UnlockResult = { ok: false, reason: 'wrong-password', retryAfterMs: 0 }

/**
 * A stateful main process: vault:status reflects unlock/lock. `results` queues per-channel
 * answers (one per call, the last one repeats); unqueued channels fall back to mockBridge.
 */
function fakeVault(start: Partial<VaultStatus> = {}, results: Record<string, unknown[]> = {}) {
  const state = vaultStatus(start)
  const invoke = mockBridge()
  const fallback = invoke.getMockImplementation()!
  const next = (channel: string) => {
    const queue = results[channel]
    return queue.length > 1 ? queue.shift() : queue[0]
  }
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'vault:status') return { ...state }
    if (channel === 'vault:lock') {
      state.unlocked = false
      // As in Electron: main's push reaches the renderer before the invoke's reply does.
      emitBridgeEvent('vault:locked', { reason: 'manual' })
      return undefined
    }
    if (channel in results) {
      const res = next(channel)
      if ((res as UnlockResult | undefined)?.ok) state.unlocked = true
      return res
    }
    if (channel === 'vault:setup') {
      const opts = args[0] as SetupOptions
      Object.assign(state, {
        setUp: true,
        unlocked: true,
        quickUnlock: opts.touchId ? 'touchId' : 'off',
        hasPassword: opts.password !== undefined,
        pin: { enabled: opts.pin !== undefined, attemptsLeft: 5 },
      })
      return { ...state }
    }
    return (fallback as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
  })
  return { invoke, state }
}

/** The real composition from App.tsx, in a MemoryRouter. */
function renderApp() {
  return render(
    <MemoryRouter>
      <AuthGate>
        <AppShell />
        <VaultSettingsDialog />
      </AuthGate>
      <Toaster />
    </MemoryRouter>,
  )
}

const gate = (name: string) => screen.findByRole('region', { name })
const shellNav = () => screen.queryByRole('navigation')

/** Lets pending promises and effects settle with real timers. */
const flushReal = () => act(() => new Promise((r) => setTimeout(r, 20)))

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0)
})

beforeEach(() => {
  vaultStatusStore.set(null)
})

// Fake only the timers, never requestAnimationFrame itself.
const useTimerClock = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })

afterEach(() => {
  act(() => {
    cancelUnlock()
    closeVaultSettings()
    clearToasts()
  })
  if (vi.isFakeTimers()) {
    // jsdom drives requestAnimationFrame from a setInterval, which is fake here. A frame still
    // pending when the clock switches back would never fire, and motion's frameloop, waiting on
    // it, would stall every later exit animation in the file. Unmount, then let it run dry.
    cleanup()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
  }
  vi.useRealTimers()
})

describe('setup', () => {
  it('without the Keychain, setup validates and submits a master password', async () => {
    const user = userEvent.setup()
    const { invoke, state } = fakeVault({ setUp: false, quickUnlockAvailable: { touchId: false, login: false } })
    // As on the gate, which has the status before it shows the card.
    vaultStatusStore.set({ ...state })
    render(<SetupCard />)
    const create = screen.getByRole('button', { name: 'Create master password' })
    const pw = screen.getByLabelText('Master password')
    const confirm = screen.getByLabelText('Confirm password')

    await user.type(pw, 'short')
    expect(screen.getByText('At least 8 characters')).toBeInTheDocument()
    expect(pw).toHaveAttribute('aria-invalid', 'true')
    expect(create).toBeDisabled()

    await user.clear(pw)
    await user.type(pw, 'correct horse')
    await user.type(confirm, 'correct horsf')
    expect(screen.getByText("Passwords don't match")).toBeInTheDocument()
    expect(create).toBeDisabled()

    await user.clear(confirm)
    await user.type(confirm, 'correct horse')
    await waitFor(() => expect(screen.queryByText("Passwords don't match")).not.toBeInTheDocument())
    await user.click(create)
    expect(invoke).toHaveBeenCalledWith('vault:setup', { password: 'correct horse' })
    // The fields are emptied once the password is handed off.
    await waitFor(() => expect(pw).toHaveValue(''))
    expect(confirm).toHaveValue('')
  })

  it('strength meter', () => {
    expect(passwordStrength('short')).toBe(0)
    expect(passwordStrength('correct horse')).toBeLessThanOrEqual(2)
    expect(passwordStrength('c0rrect-Horse-battery-staple')).toBe(4)
  })

  it('first run shows only the setup gate, then sets up Touch ID', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ setUp: false })
    renderApp()
    // With T8's gate order, a fresh install starts on the Hub step; skip it for local-only setup.
    const skipHub = await waitFor(() => {
      const skip = screen.queryByRole('button', { name: 'Use OpsDeck without a Hub' })
      expect(skip ?? screen.queryByRole('switch', { name: 'Touch ID' })).toBeInTheDocument()
      return skip
    })
    if (skipHub) await user.click(skipHub)
    expect(await screen.findByRole('switch', { name: 'Touch ID' })).toHaveAttribute('aria-checked', 'true')
    expect(shellNav()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(invoke).toHaveBeenCalledWith('vault:setup', { touchId: true, pin: undefined, password: undefined })
    await gate('Your vaults are ready')
    // Still gated until the user moves on: nothing behind it has mounted.
    expect(shellNav()).not.toBeInTheDocument()
    // Touch ID came with setup, so it is not offered again.
    expect(screen.queryByRole('button', { name: 'Enable Touch ID' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('navigation')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('vault:setQuickUnlock', expect.anything())
  })
})

describe('auth gate', () => {
  it('shell is not mounted while locked', async () => {
    const { invoke } = fakeVault()
    renderApp()
    await gate('Unlock vaults')
    expect(shellNav()).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lock vaults' })).not.toBeInTheDocument()
    // No page loaded any data behind the gate.
    const channels = invoke.mock.calls.map(([c]) => c)
    expect(channels.every((c) => c === 'vault:status')).toBe(true)
  })

  it('unlock', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({}, { 'vault:unlock': [WRONG, { ok: true }] })
    renderApp()
    const card = await gate('Unlock vaults')
    const input = within(card).getByLabelText('Master password')
    await waitFor(() => expect(input).toHaveFocus())

    await user.type(input, 'not the one!')
    await user.click(within(card).getByRole('button', { name: 'Unlock' }))
    expect(await within(card).findByText('Wrong password')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()

    await user.type(input, 'correct horse{Enter}')
    expect(invoke).toHaveBeenCalledWith('vault:unlock', 'correct horse')
    expect(await screen.findByText('Vaults unlocked')).toBeInTheDocument()
    expect(await screen.findByRole('navigation')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unlock vaults' })).not.toBeInTheDocument())
    // Never echoed anywhere in the UI.
    expect(document.body.textContent).not.toContain('correct horse')
  })

  it('ensureUnlocked resolves once the gate is passed', async () => {
    const user = userEvent.setup()
    fakeVault({}, { 'vault:unlock': [{ ok: true }] })
    renderApp()
    let done!: Promise<boolean>
    act(() => {
      done = ensureUnlocked()
    })
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    await expect(done).resolves.toBe(true)
  })

  it('resolves at once when already unlocked', async () => {
    fakeVault({ unlocked: true })
    renderApp()
    await expect(ensureUnlocked()).resolves.toBe(true)
    expect(screen.queryByRole('region', { name: 'Unlock vaults' })).not.toBeInTheDocument()
  })

  it('warns about vaults that could not be opened', async () => {
    const user = userEvent.setup()
    const { state } = fakeVault({}, { 'vault:unlock': [{ ok: true }] })
    renderApp()
    state.corruptVaultIds = ['a', 'b']
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    expect(await screen.findByText('2 vaults could not be opened')).toBeInTheDocument()
  })

  it('throttle countdown', async () => {
    useTimerClock()
    fakeVault({ retryAfterMs: 3000 })
    renderApp()
    await flush()
    const submit = screen.getByRole('button', { name: 'Try again in 3 s' })
    expect(submit).toBeDisabled()
    // Type so the only thing holding the button back is the throttle.
    fireEvent.input(screen.getByLabelText('Master password'), { target: { value: 'correct horse' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(screen.getByRole('button', { name: 'Try again in 2 s' })).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled()
  })

  it('throttled result starts a countdown', async () => {
    const user = userEvent.setup()
    fakeVault({}, { 'vault:unlock': [{ ok: false, reason: 'throttled', retryAfterMs: 4000 }] })
    renderApp()
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    expect(await screen.findByRole('button', { name: /^Try again in [34] s$/ })).toBeDisabled()
  })
})

describe('touch id', () => {
  it('touch id', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { quickUnlock: 'touchId' },
      { 'vault:unlockQuick': [{ ok: false, reason: 'cancelled', retryAfterMs: 0 }, { ok: true }] },
    )
    renderApp()
    const button = await screen.findByRole('button', { name: 'Unlock with Touch ID' })
    await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === 'vault:unlockQuick')).toHaveLength(1))
    // A cancelled prompt is not an error.
    expect(screen.queryByText('Wrong password')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(button)
    expect(await screen.findByRole('navigation')).toBeInTheDocument()
    expect(invoke.mock.calls.filter(([c]) => c === 'vault:unlockQuick')).toHaveLength(2)
  })

  it('unavailable falls back to the password with a hint', async () => {
    fakeVault({ quickUnlock: 'touchId' }, { 'vault:unlockQuick': [{ ok: false, reason: 'unavailable', retryAfterMs: 0 }] })
    renderApp()
    expect(await screen.findByText(/Touch ID isn't available/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlock with Touch ID' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Master password')).toHaveFocus())
  })

  it('is not called when the mode is off, or for the login keychain', async () => {
    const { invoke } = fakeVault({ quickUnlock: 'login', quickUnlockAvailable: { touchId: true, login: true } })
    renderApp()
    await gate('Unlock vaults')
    expect(screen.queryByRole('button', { name: 'Unlock with Touch ID' })).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('vault:unlockQuick')
  })
})

describe('withUnlock', () => {
  it('withUnlock retries once', async () => {
    const user = userEvent.setup()
    fakeVault({}, { 'vault:unlock': [{ ok: true }] })
    renderApp()
    const fn = vi.fn<() => Promise<string>>()
    fn.mockRejectedValueOnce(new Error('vault locked')).mockResolvedValueOnce('ok')
    // The cached status still says unlocked; withUnlock must refresh before asking.
    vaultStatusStore.set(vaultStatus({ unlocked: true }))
    let done!: Promise<string | undefined>
    act(() => {
      done = withUnlock(fn)
    })
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    await expect(done).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('resolves undefined when the wait is cancelled and rethrows other errors', async () => {
    fakeVault()
    renderApp()
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('vault locked'))
    let done!: Promise<string | undefined>
    act(() => {
      done = withUnlock(fn)
    })
    await gate('Unlock vaults')
    act(() => cancelUnlock())
    await expect(done).resolves.toBeUndefined()
    expect(fn).toHaveBeenCalledOnce()
    await expect(withUnlock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })
})

describe('sidebar lock button', () => {
  it('locking unmounts the shell', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ unlocked: true })
    renderApp()
    await user.click(await screen.findByRole('button', { name: 'Lock vaults' }))
    expect(invoke).toHaveBeenCalledWith('vault:lock')
    expect(await screen.findByText('Vaults locked')).toBeInTheDocument()
    await gate('Unlock vaults')
    await waitFor(() => expect(shellNav()).not.toBeInTheDocument())
    // Exactly one announcement, and not the automatic one.
    expect(screen.getAllByText('Vaults locked')).toHaveLength(1)
    expect(screen.queryByText('Locked automatically.')).not.toBeInTheDocument()
  })

  it('a manual lock does not pop Touch ID', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ unlocked: true, quickUnlock: 'touchId' })
    renderApp()
    await user.click(await screen.findByRole('button', { name: 'Lock vaults' }))
    expect(await screen.findByRole('button', { name: 'Unlock with Touch ID' })).toBeInTheDocument()
    await flushReal()
    expect(invoke).not.toHaveBeenCalledWith('vault:unlockQuick')
    expect(screen.getAllByText('Vaults locked')).toHaveLength(1)
    expect(screen.queryByText('Locked automatically.')).not.toBeInTheDocument()
  })

  it('an automatic lock auto-prompts Touch ID and says so', async () => {
    const { invoke, state } = fakeVault(
      { unlocked: true, quickUnlock: 'touchId' },
      { 'vault:unlockQuick': [{ ok: false, reason: 'cancelled', retryAfterMs: 0 }] },
    )
    renderApp()
    await screen.findByRole('button', { name: 'Lock vaults' })
    state.unlocked = false
    act(() => emitBridgeEvent('vault:locked', { reason: 'idle' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('vault:unlockQuick'))
    expect(screen.getAllByText('Vaults locked')).toHaveLength(1)
    expect(screen.getByText('Locked automatically.')).toBeInTheDocument()
  })

  it('Meta+L locks', async () => {
    const { invoke } = fakeVault({ unlocked: true })
    renderApp()
    await screen.findByRole('button', { name: 'Lock vaults' })
    act(() => {
      fireEvent.keyDown(window, { key: 'l', metaKey: true })
    })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('vault:lock'))
    expect(await screen.findByText('Vaults locked')).toBeInTheDocument()
    await gate('Unlock vaults')
    expect(screen.getAllByText('Vaults locked')).toHaveLength(1)
    expect(screen.queryByText('Locked automatically.')).not.toBeInTheDocument()
  })

  it('auto-lock (status polling) returns to the gate', async () => {
    useTimerClock()
    const { state } = fakeVault({ unlocked: true })
    renderApp()
    await flush()
    expect(screen.getByRole('button', { name: 'Lock vaults' })).toBeInTheDocument()
    state.unlocked = false // e.g. auto-locked by the main process
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByRole('region', { name: 'Unlock vaults' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lock vaults' })).not.toBeInTheDocument()
    // A lock the user did not ask for is announced too.
    expect(screen.getByText('Vaults locked')).toBeInTheDocument()
  })

  it('a pushed lock event unmounts the shell at once', async () => {
    const { state } = fakeVault({ unlocked: true })
    renderApp()
    await screen.findByRole('button', { name: 'Lock vaults' })
    state.unlocked = false // main locked on screen lock; no poll or focus needed
    act(() => emitBridgeEvent('vault:locked', { reason: 'screen' }))
    expect(screen.getByRole('region', { name: 'Unlock vaults' })).toBeInTheDocument()
    await waitFor(() => expect(shellNav()).not.toBeInTheDocument())
    expect(screen.getByText('Vaults locked')).toBeInTheDocument()
  })

  it('refreshes on window focus', async () => {
    const { state } = fakeVault({ unlocked: true })
    renderApp()
    await screen.findByRole('button', { name: 'Lock vaults' })
    state.unlocked = false
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await gate('Unlock vaults')
  })
})

describe('settings', () => {
  it('settings', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { unlocked: true },
      { 'vault:changePassword': [WRONG, { ok: true }] },
    )
    render(
      <>
        <VaultSettingsDialog />
        <Toaster />
      </>,
    )
    act(() => openVaultSettings())
    const dialog = await screen.findByRole('dialog', { name: 'Vault settings' })

    const quick = within(dialog).getByLabelText('Quick unlock')
    await waitFor(() => expect(quick).toBeEnabled())
    expect(within(quick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Off', 'Touch ID'])

    await user.selectOptions(within(dialog).getByLabelText('Auto-lock'), 'Never')
    expect(invoke).toHaveBeenCalledWith('vault:setAutoLock', null)

    const current = within(dialog).getByLabelText('Current password')
    await user.type(current, 'correct horse')
    await user.type(within(dialog).getByLabelText('New password'), 'battery staple!')
    await user.type(within(dialog).getByLabelText('Confirm new password'), 'battery staple!')
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }))
    expect(invoke).toHaveBeenCalledWith('vault:changePassword', 'correct horse', 'battery staple!')
    expect(await within(dialog).findByText('Wrong password')).toBeInTheDocument()
    expect(current).toHaveValue('')
  })

  it('quick unlock change goes through the main process', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault(
      { unlocked: true },
      { 'vault:setQuickUnlock': [{ ok: true, status: vaultStatus({ unlocked: true, quickUnlock: 'touchId' }) }] },
    )
    render(<VaultSettingsDialog />)
    act(() => openVaultSettings())
    const quick = await screen.findByLabelText('Quick unlock')
    await waitFor(() => expect(quick).toBeEnabled())
    await user.selectOptions(quick, 'Touch ID')
    expect(invoke).toHaveBeenCalledWith('vault:setQuickUnlock', 'touchId')
    await waitFor(() => expect(quick).toHaveValue('touchId'))
  })

  it('never offers the login keychain', async () => {
    fakeVault({ unlocked: true, quickUnlockAvailable: { touchId: true, login: true } })
    render(<VaultSettingsDialog />)
    act(() => openVaultSettings())
    const quick = await screen.findByLabelText('Quick unlock')
    await waitFor(() => expect(quick).toBeEnabled())
    expect(within(quick).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['off', 'touchId'])
  })
})
