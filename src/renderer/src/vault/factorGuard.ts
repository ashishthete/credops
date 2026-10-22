import type { VaultStatus } from '../../../shared/vault'

export interface FactorGuard {
  canRemovePin: boolean
  canTurnOffTouchId: boolean
  canRemovePassword: boolean
}

/**
 * Mirrors main's keepsAWayIn: once a factor is gone, Touch ID or a PIN must still open the vaults.
 * A factor counts only when it works now. Without the Keychain neither can, and a master password
 * is the fallback for removing a dead factor (never for removing itself). Main still refuses.
 */
export function factorGuard(status: VaultStatus | null): FactorGuard {
  if (!status) return { canRemovePin: false, canTurnOffTouchId: false, canRemovePassword: false }
  const { touchId, login } = status.quickUnlockAvailable
  const keychain = touchId || login
  const touchIdWorks = status.quickUnlock === 'touchId' && touchId && !status.touchIdNeedsReenable
  const pinWorks = status.pin.enabled && keychain
  const fallback = !keychain && status.hasPassword
  return {
    canRemovePin: touchIdWorks || fallback,
    canTurnOffTouchId: pinWorks || fallback,
    canRemovePassword: pinWorks || touchIdWorks,
  }
}
