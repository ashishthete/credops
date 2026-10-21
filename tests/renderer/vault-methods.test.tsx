import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToasts } from '../../src/renderer/src/ui/Toaster'
import { SetupCard } from '../../src/renderer/src/vault/SetupCard'
import { vaultStatusStore } from '../../src/renderer/src/vault/status'
import { UnlockCard } from '../../src/renderer/src/vault/UnlockCard'
import type { UnlockResult, VaultStatus } from '../../src/shared/vault'
import { mockBridge, vaultStatus } from './helpers'

const NO_RECOVERY =
  "Without a master password, your secrets can't be recovered if this Mac's Keychain is lost. The only way back is to erase them."
const PIN_ONLY = 'After 5 wrong PINs your vaults stay locked until you erase them.'
const ADD_PASSWORD = 'Add a master password (recommended for recovery)'
const WRONG_PIN: UnlockResult = { ok: false, reason: 'wrong-pin', retryAfterMs: 0 }
const WIPED: UnlockResult = { ok: false, reason: 'pin-wiped', retryAfterMs: 0 }
const SIGNIN: UnlockResult = { ok: false, reason: 'signin-required', retryAfterMs: 0 }

/**
 * A main process that only knows vault:status and the channels queued in `results` (one answer
 * per call, the last repeats). vault:unlockPin misses count down `pin.attemptsLeft`, and a wipe
 * drops the PIN and sets resetRequired when nothing else is left, as main does.
 */
function fakeVault(start: Partial<VaultStatus> = {}, results: Record<string, unknown[]> = {}) {
  const state = vaultStatus(start)
  const invoke = mockBridge()
  const fallback = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'vault:status' || channel === 'auth:check') return { ...state }
    if (channel in results) {
      const queue = results[channel]
      const res = queue.length > 1 ? queue.shift() : queue[0]
      if (channel === 'vault:unlockPin' && (res as UnlockResult).ok === false) {
        state.pin = { ...state.pin, attemptsLeft: state.pin.attemptsLeft - 1 }
      }
      if ((res as UnlockResult).ok === false && (res as { reason: string }).reason === 'pin-wiped') {
        state.pin = { enabled: false, attemptsLeft: 5 }
        state.resetRequired = !state.hasPassword && state.quickUnlock !== 'touchId'
      }
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

/** Setup with the store primed, as the gate has it by the time the card shows. */
function renderSetup(start: Partial<VaultStatus> = {}, onDone = vi.fn()) {
  const fake = fakeVault({ setUp: false, quickUnlockAvailable: { touchId: true, login: true }, ...start })
  vaultStatusStore.set({ ...fake.state })
  render(<SetupCard onDone={onDone} />)
  return { ...fake, onDone }
}

function renderUnlock(start: Partial<VaultStatus>, results: Record<string, unknown[]> = {}, autoQuick = true) {
  const fake = fakeVault(start, results)
  const props = { onUnlocked: vi.fn(), onWrong: vi.fn(), onForgot: vi.fn() }
  render(<UnlockCard status={fake.state} autoQuick={autoQuick} {...props} />)
  return { ...fake, ...props }
}

const continueButton = () => screen.getByRole('button', { name: 'Continue' })
const NO_TOUCH_ID = { quickUnlockAvailable: { touchId: false, login: true } }
const ALL_METHODS: Partial<VaultStatus> = {
  quickUnlock: 'touchId',
  hasPassword: true,
  pin: { enabled: true, attemptsLeft: 5 },
}

beforeEach(() => {
  vaultStatusStore.set(null)
})

afterEach(() => {
  act(() => clearToasts())
})

describe('setup', () => {
  it('setup requires Touch ID or a PIN', async () => {
    const user = userEvent.setup()
    renderSetup()
    const touchId = screen.getByRole('switch', { name: 'Touch ID' })
    expect(touchId).toHaveAttribute('aria-checked', 'true')
    expect(continueButton()).toBeEnabled()
    await user.click(touchId)
    expect(continueButton()).toBeDisabled()
    await user.click(touchId)
    expect(continueButton()).toBeEnabled()
  })

  it('setup without Touch ID requires a confirmed PIN', async () => {
    const user = userEvent.setup()
    const { invoke } = renderSetup(NO_TOUCH_ID)
    expect(screen.queryByRole('switch', { name: 'Touch ID' })).not.toBeInTheDocument()
    expect(continueButton()).toBeDisabled()
    const pin = screen.getByLabelText('PIN')
    const confirm = screen.getByLabelText('Confirm PIN')

    // Digits only.
    await user.type(pin, '1a3b5-792')
    expect(pin).toHaveValue('135792')
    await user.type(confirm, '135793')
    expect(screen.getByText("PINs don't match")).toBeInTheDocument()
    expect(continueButton()).toBeDisabled()

    await user.clear(confirm)
    await user.type(confirm, '135792')
    await waitFor(() => expect(screen.queryByText("PINs don't match")).not.toBeInTheDocument())
    await user.click(continueButton())
    expect(invoke).toHaveBeenCalledWith('vault:setup', { touchId: false, pin: '135792', password: undefined })
    await waitFor(() => expect(pin).toHaveValue(''))
    expect(confirm).toHaveValue('')
    expect(document.body.textContent).not.toContain('135792')
  })

  it('a pasted PIN over 12 digits gets the format message', async () => {
    const user = userEvent.setup()
    renderSetup(NO_TOUCH_ID)
    await user.click(screen.getByLabelText('PIN'))
    await user.paste('1357924680135')
    expect(screen.getByText('PIN must be 6-12 digits')).toBeInTheDocument()
    expect(continueButton()).toBeDisabled()
  })

  it("shows main's refusal of a weak PIN", async () => {
    const user = userEvent.setup()
    const { invoke } = renderSetup(NO_TOUCH_ID)
    const answer = invoke.getMockImplementation() as (c: string, ...a: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:setup') throw new Error('PIN is too easy to guess')
      return answer(channel, ...args)
    })
    await user.type(screen.getByLabelText('PIN'), '123456')
    await user.type(screen.getByLabelText('Confirm PIN'), '123456')
    await user.click(continueButton())
    expect(await screen.findByText('PIN is too easy to guess')).toBeInTheDocument()
  })

  it('shows the no-recovery copy until a master password is added', async () => {
    const user = userEvent.setup()
    const { invoke } = renderSetup()
    expect(screen.getByText(NO_RECOVERY)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: ADD_PASSWORD }))
    expect(screen.getByText(NO_RECOVERY)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Master password'), 'correct horse')
    expect(screen.queryByText(NO_RECOVERY)).not.toBeInTheDocument()
    // A password that is still being typed holds Continue back.
    expect(continueButton()).toBeDisabled()
    await user.type(screen.getByLabelText('Confirm password'), 'correct horse')
    await user.click(continueButton())
    expect(invoke).toHaveBeenCalledWith('vault:setup', { touchId: true, pin: undefined, password: 'correct horse' })
    await waitFor(() => expect(screen.getByLabelText('Master password')).toHaveValue(''))
  })

  it('shows the PIN-only lockout warning', async () => {
    const user = userEvent.setup()
    renderSetup()
    expect(screen.queryByText(PIN_ONLY)).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Touch ID' }))
    expect(screen.getByText(PIN_ONLY)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: ADD_PASSWORD }))
    await user.type(screen.getByLabelText('Master password'), 'correct horse')
    expect(screen.queryByText(PIN_ONLY)).not.toBeInTheDocument()
  })

  it('collapsing the master password drops what was typed there', async () => {
    const user = userEvent.setup()
    const { invoke } = renderSetup()
    await user.click(screen.getByRole('switch', { name: 'Touch ID' }))
    await user.type(screen.getByLabelText('PIN'), '135792')
    await user.type(screen.getByLabelText('Confirm PIN'), '135792')
    const disclosure = screen.getByRole('button', { name: ADD_PASSWORD })
    await user.click(disclosure)
    await user.type(screen.getByLabelText('Master password'), 'correct horse')
    expect(screen.queryByText(NO_RECOVERY)).not.toBeInTheDocument()
    expect(screen.queryByText(PIN_ONLY)).not.toBeInTheDocument()
    // Half typed: no confirmation yet.
    expect(continueButton()).toBeDisabled()

    await user.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(NO_RECOVERY)).toBeInTheDocument()
    expect(screen.getByText(PIN_ONLY)).toBeInTheDocument()
    expect(continueButton()).toBeEnabled()

    await user.click(disclosure)
    expect(screen.getByLabelText('Master password')).toHaveValue('')
    expect(screen.getByText(NO_RECOVERY)).toBeInTheDocument()
    expect(screen.getByText(PIN_ONLY)).toBeInTheDocument()
    expect(continueButton()).toBeEnabled()

    await user.click(continueButton())
    expect(invoke).toHaveBeenCalledWith('vault:setup', { touchId: false, pin: '135792', password: undefined })
  })

  it('sends SetupOptions', async () => {
    const user = userEvent.setup()
    const { invoke, onDone } = renderSetup()
    await user.click(continueButton())
    expect(invoke).toHaveBeenCalledWith('vault:setup', { touchId: true, pin: undefined, password: undefined })
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ setUp: true })))
  })

  it('without the Keychain, keeps the password-only card', async () => {
    const user = userEvent.setup()
    const { invoke } = renderSetup({ quickUnlockAvailable: { touchId: false, login: false } })
    expect(screen.queryByRole('switch', { name: 'Touch ID' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Master password'), 'correct horse')
    await user.type(screen.getByLabelText('Confirm password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Create master password' }))
    expect(invoke).toHaveBeenCalledWith('vault:setup', { password: 'correct horse' })
  })
})

describe('method chooser', () => {
  it('chooser shows only set-up methods and preselects lastMethod', async () => {
    renderUnlock({ quickUnlock: 'touchId', hasPassword: false, pin: { enabled: true, attemptsLeft: 5 }, lastMethod: 'pin' })
    const methods = screen.getByRole('radiogroup', { name: 'Unlock method' })
    expect(within(methods).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Touch ID', 'PIN'])
    expect(within(methods).getByRole('radio', { name: 'PIN' })).toHaveAttribute('aria-checked', 'true')
    const panel = document.getElementById(within(methods).getByRole('radio', { name: 'PIN' }).getAttribute('aria-controls')!)
    expect(panel).toContainElement(screen.getByLabelText('PIN'))
    cleanup()

    renderUnlock({ ...ALL_METHODS, lastMethod: 'password' }, {}, false)
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Touch ID', 'PIN', 'Password'])
    expect(screen.getByRole('radio', { name: 'Password' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Master password')).toBeInTheDocument()
  })

  it('a single method needs no chooser', () => {
    renderUnlock({})
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Master password')).toBeInTheDocument()
  })

  it('PIN unlock calls vault:unlockPin; wrong PIN shows tries left', async () => {
    const user = userEvent.setup()
    const { invoke, onUnlocked, onWrong } = renderUnlock(
      { ...ALL_METHODS, lastMethod: 'pin' },
      { 'vault:unlockPin': [WRONG_PIN, { ok: true }] },
    )
    const pin = screen.getByLabelText('PIN')
    expect(pin).toHaveAttribute('inputMode', 'numeric')
    expect(pin).toHaveAttribute('type', 'password')
    expect(screen.queryByText(/tries left/)).not.toBeInTheDocument()

    await user.type(pin, '246810{Enter}')
    expect(invoke).toHaveBeenCalledWith('vault:unlockPin', '246810')
    expect(await screen.findByText('Wrong PIN')).toBeInTheDocument()
    expect(await screen.findByText('4 tries left')).toBeInTheDocument()
    expect(onWrong).toHaveBeenCalledOnce()
    expect(pin).toHaveValue('')

    await user.type(pin, '135792{Enter}')
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce())
    expect(document.body.textContent).not.toContain('135792')
  })

  it('a pasted PIN over 12 digits is not sent', async () => {
    const user = userEvent.setup()
    const { invoke } = renderUnlock({ ...ALL_METHODS, lastMethod: 'pin' })
    await user.click(screen.getByLabelText('PIN'))
    await user.paste('1357924680135')
    expect(screen.getByText('PIN must be 6-12 digits')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(invoke).not.toHaveBeenCalledWith('vault:unlockPin', expect.anything())
  })

  it.each([
    ['password', { hasPassword: true, quickUnlock: 'off' }, 'Too many wrong PINs. Use your master password.', 'Password'],
    ['touchId', { hasPassword: false, quickUnlock: 'touchId' }, 'Too many wrong PINs. Use Touch ID.', 'Touch ID'],
    ['none', { hasPassword: false, quickUnlock: 'off' }, 'Too many wrong PINs. Your vaults stay locked until you erase them.', null],
  ] as const)('pin-wiped falls back to %s with the fixed copy', async (_, start, copy, tab) => {
    const user = userEvent.setup()
    const { invoke, state, onForgot } = renderUnlock(
      { ...start, pin: { enabled: true, attemptsLeft: 1 }, lastMethod: 'pin' },
      { 'vault:unlockPin': [WIPED] },
      false,
    )
    await user.type(screen.getByLabelText('PIN'), '246810{Enter}')
    expect(await screen.findByText(copy)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('vault:unlockPin', '246810')
    expect(state.pin.enabled).toBe(false)
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument()
    if (tab === 'Password') {
      expect(screen.getByLabelText('Master password')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Forgot password?' })).toBeInTheDocument()
    } else if (tab === 'Touch ID') {
      expect(screen.getByRole('button', { name: 'Unlock with Touch ID' })).toBeInTheDocument()
      // The user asks for the prompt; it does not pop on its own.
      expect(invoke).not.toHaveBeenCalledWith('vault:unlockQuick')
    } else {
      expect(screen.queryByRole('button', { name: 'Forgot password?' })).not.toBeInTheDocument()
      // Offered once main confirms the reset is due.
      await user.click(await screen.findByRole('button', { name: 'Erase vaults' }))
      expect(onForgot).toHaveBeenCalledOnce()
    }
    if (tab !== null) expect(screen.queryByRole('button', { name: 'Erase vaults' })).not.toBeInTheDocument()
  })

  it.each([
    ['PIN', 'vault:unlockPin', { lastMethod: 'pin' }],
    ['password', 'vault:unlock', { lastMethod: 'password' }],
    ['Touch ID', 'vault:unlockQuick', { lastMethod: 'touchId' }],
  ] as const)('signin-required on the %s tab goes back to sign-in, not counted as a try', async (_, channel, start) => {
    const user = userEvent.setup()
    const onSigninRequired = vi.fn()
    const fake = fakeVault({ ...ALL_METHODS, ...start }, { [channel]: [SIGNIN] })
    const onWrong = vi.fn()
    render(<UnlockCard status={fake.state} onUnlocked={vi.fn()} onWrong={onWrong} onSigninRequired={onSigninRequired} />)
    if (channel === 'vault:unlockPin') await user.type(screen.getByLabelText('PIN'), '246810{Enter}')
    if (channel === 'vault:unlock') await user.type(screen.getByLabelText('Master password'), 'correct horse{Enter}')
    await waitFor(() => expect(onSigninRequired).toHaveBeenCalledOnce())
    expect(fake.invoke).toHaveBeenCalledWith(channel, ...(channel === 'vault:unlockQuick' ? [] : [expect.any(String)]))
    expect(onWrong).not.toHaveBeenCalled()
    expect(screen.queryByText(/Wrong|tries left|try left/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    for (const input of document.querySelectorAll('input')) expect(input).toHaveValue('')
  })

  it('signin-required with no callback forces auth:check and publishes its status', async () => {
    const user = userEvent.setup()
    const { invoke, state } = renderUnlock({ ...ALL_METHODS, lastMethod: 'pin' }, { 'vault:unlockPin': [SIGNIN] })
    state.sso = { ...state.sso, required: true, verdict: 'needs-signin' } as VaultStatus['sso']
    await user.type(screen.getByLabelText('PIN'), '246810{Enter}')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('auth:check'))
    await waitFor(() => expect(vaultStatusStore.get()?.sso).toEqual(state.sso))
    expect(screen.queryByText(/tries left/)).not.toBeInTheDocument()
  })

  it("offers the erase only when main's status says the reset is due", () => {
    const nothing = { hasPassword: false, quickUnlock: 'off', pin: { enabled: false, attemptsLeft: 5 } } as const
    renderUnlock({ ...nothing, resetRequired: false })
    expect(screen.getByRole('alert')).toHaveTextContent('Your vaults stay locked until you erase them.')
    expect(screen.queryByRole('button', { name: 'Erase vaults' })).not.toBeInTheDocument()
    cleanup()

    renderUnlock({ ...nothing, resetRequired: true })
    expect(screen.getByRole('button', { name: 'Erase vaults' })).toBeInTheDocument()
  })

  it('a Touch ID-only vault whose Touch ID is unavailable at mount keeps a retry, never the erase', async () => {
    const user = userEvent.setup()
    const { invoke } = renderUnlock(
      { quickUnlock: 'touchId', hasPassword: false, ...NO_TOUCH_ID },
      { 'vault:unlockQuick': [{ ok: false, reason: 'unavailable', retryAfterMs: 0 }, { ok: true }] },
    )
    expect(screen.getByText("Touch ID isn't available right now.")).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Unlock with Touch ID' })
    expect(screen.queryByRole('button', { name: 'Erase vaults' })).not.toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(invoke).not.toHaveBeenCalledWith('vault:unlockQuick')

    await user.click(retry)
    expect(invoke).toHaveBeenCalledWith('vault:unlockQuick')
    expect(await screen.findByRole('button', { name: 'Unlock with Touch ID' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Erase vaults' })).not.toBeInTheDocument()
  })

  it('a PIN wipe while Touch ID is unavailable falls back to Touch ID, not the erase', async () => {
    const user = userEvent.setup()
    renderUnlock(
      { quickUnlock: 'touchId', hasPassword: false, pin: { enabled: true, attemptsLeft: 1 }, lastMethod: 'touchId', ...NO_TOUCH_ID },
      { 'vault:unlockPin': [WIPED] },
    )
    // Touch ID can't be used right now, so the card opens on the PIN.
    expect(screen.getByRole('radio', { name: 'PIN' })).toHaveAttribute('aria-checked', 'true')
    await user.type(screen.getByLabelText('PIN'), '246810{Enter}')
    expect(await screen.findByText('Too many wrong PINs. Use Touch ID.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlock with Touch ID' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Erase vaults' })).not.toBeInTheDocument()
  })

  it('Touch ID unavailable, then a PIN wipe: the copy matches the Touch ID tab it offers', async () => {
    const user = userEvent.setup()
    renderUnlock(
      { quickUnlock: 'touchId', hasPassword: false, pin: { enabled: true, attemptsLeft: 1 }, lastMethod: 'touchId' },
      { 'vault:unlockQuick': [{ ok: false, reason: 'unavailable', retryAfterMs: 0 }], 'vault:unlockPin': [WIPED] },
    )
    expect(await screen.findByText("Touch ID isn't available right now. Use your PIN.")).toBeInTheDocument()
    await user.type(screen.getByLabelText('PIN'), '246810{Enter}')
    expect(await screen.findByText('Too many wrong PINs. Use Touch ID.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlock with Touch ID' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Erase vaults' })).not.toBeInTheDocument()
  })

  it('Touch ID unavailable sends a PIN user to the PIN, and keeps a Touch ID-only user on it', async () => {
    const gone = { 'vault:unlockQuick': [{ ok: false, reason: 'unavailable', retryAfterMs: 0 }] }
    renderUnlock({ quickUnlock: 'touchId', hasPassword: false, pin: { enabled: true, attemptsLeft: 5 } }, gone)
    expect(await screen.findByText("Touch ID isn't available right now. Use your PIN.")).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('PIN')).toHaveFocus())
    cleanup()

    renderUnlock({ quickUnlock: 'touchId', hasPassword: false }, gone)
    expect(await screen.findByText("Touch ID isn't available right now.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlock with Touch ID' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Erase vaults' })).not.toBeInTheDocument()
  })

  it('Touch ID does not auto-prompt when the PIN tab is selected', async () => {
    const { invoke } = renderUnlock({ ...ALL_METHODS, lastMethod: 'pin' })
    expect(screen.getByLabelText('PIN')).toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(invoke).not.toHaveBeenCalledWith('vault:unlockQuick')
  })

  it('Touch ID auto-prompts when its tab is selected', async () => {
    const { invoke } = renderUnlock(
      { ...ALL_METHODS, lastMethod: 'touchId' },
      { 'vault:unlockQuick': [{ ok: false, reason: 'cancelled', retryAfterMs: 0 }] },
    )
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('vault:unlockQuick'))
    expect(screen.getByRole('radio', { name: 'Touch ID' })).toHaveAttribute('aria-checked', 'true')
  })
})

