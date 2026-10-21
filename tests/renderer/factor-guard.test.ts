import { describe, expect, it } from 'vitest'
import { factorGuard } from '../../src/renderer/src/vault/factorGuard'
import { vaultStatus } from './helpers'

const guard = (over: Parameters<typeof vaultStatus>[0]) => factorGuard(vaultStatus({ unlocked: true, ...over }))
const PIN = { enabled: true, attemptsLeft: 5 }
const NO_PIN = { enabled: false, attemptsLeft: 5 }
const KEYCHAIN = { touchId: true, login: true }

describe('factorGuard mirrors keepsAWayIn', () => {
  it.each([
    ['password only', { hasPassword: true, quickUnlock: 'off', pin: NO_PIN, quickUnlockAvailable: KEYCHAIN }, [false, false, false]],
    ['password + PIN', { hasPassword: true, quickUnlock: 'off', pin: PIN, quickUnlockAvailable: KEYCHAIN }, [false, true, true]],
    ['Touch ID + PIN', { hasPassword: false, quickUnlock: 'touchId', pin: PIN, quickUnlockAvailable: KEYCHAIN }, [true, true, true]],
    ['Touch ID only', { hasPassword: true, quickUnlock: 'touchId', pin: NO_PIN, quickUnlockAvailable: KEYCHAIN }, [true, false, true]],
    [
      'Touch ID needing re-enable, with a PIN',
      { hasPassword: true, quickUnlock: 'touchId', touchIdNeedsReenable: true, pin: PIN, quickUnlockAvailable: KEYCHAIN },
      [false, true, true],
    ],
    [
      'Touch ID needing re-enable, password and no PIN',
      { hasPassword: true, quickUnlock: 'touchId', touchIdNeedsReenable: true, pin: NO_PIN, quickUnlockAvailable: KEYCHAIN },
      [false, false, false],
    ],
    [
      'Touch ID unavailable, with a PIN (login Keychain still works)',
      { hasPassword: true, quickUnlock: 'touchId', pin: PIN, quickUnlockAvailable: { touchId: false, login: true } },
      [false, true, true],
    ],
    [
      'no Keychain, with a password',
      { hasPassword: true, quickUnlock: 'off', pin: PIN, quickUnlockAvailable: { touchId: false, login: false } },
      [true, true, false],
    ],
    [
      'no Keychain, no password',
      { hasPassword: false, quickUnlock: 'off', pin: PIN, quickUnlockAvailable: { touchId: false, login: false } },
      [false, false, false],
    ],
  ] as const)('%s', (_name, over, [pin, touch, password]) => {
    expect(guard(over as never)).toEqual({ canRemovePin: pin, canTurnOffTouchId: touch, canRemovePassword: password })
  })
})
