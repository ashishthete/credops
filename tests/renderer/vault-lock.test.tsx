import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/renderer/src/shell/AppShell'
import { clearToasts, Toaster } from '../../src/renderer/src/ui/Toaster'
import { SetupCard } from '../../src/renderer/src/vault/SetupCard'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { passwordStrength } from '../../src/renderer/src/vault/strength'
import { cancelUnlock, ensureUnlocked, withUnlock } from '../../src/renderer/src/vault/unlock'
import { UnlockDialog } from '../../src/renderer/src/vault/UnlockDialog'
import { closeVaultSettings, openVaultSettings, VaultSettingsDialog } from '../../src/renderer/src/vault/VaultSettingsDialog'
import type { UnlockResult, VaultStatus } from '../../src/shared/vault'
import { mockBridge, vaultStatus } from './helpers'

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
      return undefined
    }
    if (channel in results) {
      const res = next(channel)
      if ((res as UnlockResult | undefined)?.ok) state.unlocked = true
      return res
    }
    if (channel === 'vault:setup') {
      Object.assign(state, { setUp: true, unlocked: true })
      return { ...state }
    }
    return (fallback as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
  })
  return { invoke, state }
}

function renderApp() {
  return render(
    <MemoryRouter>
      <AppShell />
      <VaultSettingsDialog />
      <UnlockDialog />
      <Toaster />
    </MemoryRouter>,
  )
}

function renderDialog() {
  return render(
    <>
      <UnlockDialog />
      <Toaster />
    </>,
  )
}

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0)
})

beforeEach(() => {
  vaultStatusStore.set(null)
})

afterEach(() => {
  act(() => {
    cancelUnlock()
    closeVaultSettings()
    clearToasts()
  })
  vi.useRealTimers()
})

describe('setup', () => {
  it('setup validates and submits', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ setUp: false })
    render(<SetupCard />)
    const create = screen.getByRole('button', { name: 'Create master password' })
    const pw = screen.getByLabelText('Master password')
    const confirm = screen.getByLabelText('Confirm password')

    await user.type(pw, 'short')
    expect(screen.getByText('At least 10 characters')).toBeInTheDocument()
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
    expect(invoke).toHaveBeenCalledWith('vault:setup', 'correct horse')
    // The fields are emptied once the password is handed off.
    await waitFor(() => expect(pw).toHaveValue(''))
    expect(confirm).toHaveValue('')
  })

  it('strength meter', () => {
    expect(passwordStrength('short')).toBe(0)
    expect(passwordStrength('correct horse')).toBeLessThanOrEqual(2)
    expect(passwordStrength('c0rrect-Horse-battery-staple')).toBe(4)
  })

  it('setup toast offers Touch ID when available', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ setUp: false })
    render(
      <>
        <SetupCard />
        <Toaster />
      </>,
    )
    await user.type(screen.getByLabelText('Master password'), 'correct horse')
    await user.type(screen.getByLabelText('Confirm password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Create master password' }))
    await user.click(await screen.findByRole('button', { name: 'Enable Touch ID' }))
    expect(invoke).toHaveBeenCalledWith('vault:setQuickUnlock', 'touchId')
  })
})

describe('unlock dialog', () => {
  it('unlock dialog', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({}, { 'vault:unlock': [WRONG, { ok: true }] })
    renderDialog()

    let done!: Promise<boolean>
    act(() => {
      done = ensureUnlocked()
    })
    const dialog = await screen.findByRole('dialog', { name: 'Unlock vaults' })
    const input = within(dialog).getByLabelText('Master password')
    await waitFor(() => expect(input).toHaveFocus())

    await user.type(input, 'not the one!')
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    expect(await within(dialog).findByText('Wrong password')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()

    await user.type(input, 'correct horse{Enter}')
    await expect(done).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('vault:unlock', 'correct horse')
    expect(await screen.findByText('Vaults unlocked')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Never echoed anywhere in the UI.
    expect(document.body.textContent).not.toContain('correct horse')
  })

  it('Esc resolves to false', async () => {
    const user = userEvent.setup()
    fakeVault()
    renderDialog()
    let done!: Promise<boolean>
    act(() => {
      done = ensureUnlocked()
    })
    await screen.findByRole('dialog', { name: 'Unlock vaults' })
    await user.keyboard('{Escape}')
    await expect(done).resolves.toBe(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('resolves at once when already unlocked', async () => {
    fakeVault({ unlocked: true })
    renderDialog()
    await expect(ensureUnlocked()).resolves.toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('warns about vaults that could not be opened', async () => {
    const user = userEvent.setup()
    const { state } = fakeVault({}, { 'vault:unlock': [{ ok: true }] })
    renderDialog()
    act(() => {
      void ensureUnlocked()
    })
    state.corruptVaultIds = ['a', 'b']
    await user.type(await screen.findByLabelText('Master password'), 'correct horse{Enter}')
    expect(await screen.findByText('2 vaults could not be opened')).toBeInTheDocument()
  })

  it('throttle countdown', async () => {
    vi.useFakeTimers()
    fakeVault({ retryAfterMs: 3000 })
    renderDialog()
    act(() => {
      void ensureUnlocked()
    })
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
    renderDialog()
    act(() => {
      void ensureUnlocked()
    })
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
    renderDialog()
    let done!: Promise<boolean>
    act(() => {
      done = ensureUnlocked()
    })
    const button = await screen.findByRole('button', { name: 'Unlock with Touch ID' })
    await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === 'vault:unlockQuick')).toHaveLength(1))
    // A cancelled prompt is not an error.
    expect(screen.queryByText('Wrong password')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(button)
    await expect(done).resolves.toBe(true)
    expect(invoke.mock.calls.filter(([c]) => c === 'vault:unlockQuick')).toHaveLength(2)
  })

  it('unavailable falls back to the password with a hint', async () => {
    fakeVault({ quickUnlock: 'touchId' }, { 'vault:unlockQuick': [{ ok: false, reason: 'unavailable', retryAfterMs: 0 }] })
    renderDialog()
    act(() => {
      void ensureUnlocked()
    })
    expect(await screen.findByText(/Touch ID isn't available/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlock with Touch ID' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Master password')).toHaveFocus())
  })

  it('is not called when the mode is off', async () => {
    const { invoke } = fakeVault()
    renderDialog()
    act(() => {
      void ensureUnlocked()
    })
    await screen.findByRole('dialog', { name: 'Unlock vaults' })
    expect(screen.queryByRole('button', { name: 'Unlock with Touch ID' })).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('vault:unlockQuick')
  })
})

describe('withUnlock', () => {
  it('withUnlock retries once', async () => {
    const user = userEvent.setup()
    fakeVault({}, { 'vault:unlock': [{ ok: true }] })
    renderDialog()
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

  it('resolves undefined when the unlock is dismissed and rethrows other errors', async () => {
    const user = userEvent.setup()
    fakeVault()
    renderDialog()
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('vault locked'))
    let done!: Promise<string | undefined>
    act(() => {
      done = withUnlock(fn)
    })
    await screen.findByRole('dialog', { name: 'Unlock vaults' })
    await user.keyboard('{Escape}')
    await expect(done).resolves.toBeUndefined()
    expect(fn).toHaveBeenCalledOnce()
    await expect(withUnlock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })
})

describe('sidebar lock button', () => {
  it('sidebar lock button', async () => {
    const user = userEvent.setup()
    const { invoke } = fakeVault({ unlocked: true })
    renderApp()
    await user.click(await screen.findByRole('button', { name: 'Lock vaults' }))
    expect(invoke).toHaveBeenCalledWith('vault:lock')
    expect(await screen.findByText('Vaults locked')).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Unlock vaults' }))
    expect(await screen.findByRole('dialog', { name: 'Unlock vaults' })).toBeInTheDocument()
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
    expect(await screen.findByRole('button', { name: 'Unlock vaults' })).toBeInTheDocument()
  })

  it('status polling flips the lock', async () => {
    vi.useFakeTimers()
    const { state } = fakeVault({ unlocked: true })
    renderApp()
    await flush()
    expect(screen.getByRole('button', { name: 'Lock vaults' })).toBeInTheDocument()
    state.unlocked = false // e.g. auto-locked by the main process
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByRole('button', { name: 'Unlock vaults' })).toBeInTheDocument()
    // A lock the user did not ask for is announced too.
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
    expect(await screen.findByRole('button', { name: 'Unlock vaults' })).toBeInTheDocument()
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
        <UnlockDialog />
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
      { 'vault:setQuickUnlock': [vaultStatus({ unlocked: true, quickUnlock: 'touchId' })] },
    )
    render(<VaultSettingsDialog />)
    act(() => openVaultSettings())
    const quick = await screen.findByLabelText('Quick unlock')
    await waitFor(() => expect(quick).toBeEnabled())
    await user.selectOptions(quick, 'Touch ID')
    expect(invoke).toHaveBeenCalledWith('vault:setQuickUnlock', 'touchId')
    await waitFor(() => expect(quick).toHaveValue('touchId'))
    await waitFor(() => expect(quick).toHaveValue('touchId'))
  })
})
