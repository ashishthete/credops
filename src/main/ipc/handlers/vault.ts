import type { Handlers } from '../../../shared/ipc'
import type { ReverifyProof } from '../../../shared/sso'
import { PIN_WIPED, verificationFailedError, type ProvenResult } from '../../../shared/vault'
import type { VaultService } from '../../vault/vault-service'

type VaultChannel =
  | 'vault:status'
  | 'vault:setup'
  | 'vault:unlock'
  | 'vault:unlockPin'
  | 'vault:unlockQuick'
  | 'vault:lock'
  | 'vault:changePassword'
  | 'vault:list'
  | 'vault:create'
  | 'vault:update'
  | 'vault:delete'
  | 'vault:setQuickUnlock'
  | 'vault:setAutoLock'
  | 'vault:reset'
  | 'vault:setPin'
  | 'vault:clearPin'
  | 'vault:setPassword'
  | 'vault:removePassword'

/**
 * Runs `change` only once `proof` re-proves the user, so someone at an unlocked Mac cannot add a way
 * in of their own. A miss rejects with VERIFICATION_FAILED. A miss that wiped the PIN comes back as
 * a coded result instead (Electron rewraps error messages); the vault may already be locked by then.
 */
export async function withProof(
  vault: Pick<VaultService, 'reverify' | 'status'>,
  proof: ReverifyProof | undefined,
  /** Named in the Touch ID prompt ("CredOps is trying to …"), so the user sees what they approve. */
  action: string,
  change: () => unknown,
): Promise<ProvenResult> {
  if (!proof) throw verificationFailedError()
  let proven: boolean
  try {
    proven = await vault.reverify(proof, action)
  } catch (err) {
    if (err instanceof Error && err.message === PIN_WIPED) return { ok: false, reason: 'pin-wiped', status: vault.status() }
    throw err
  }
  if (!proven) throw verificationFailedError()
  await change()
  return { ok: true, status: vault.status() }
}

export function createVaultHandlers(vault: VaultService): Pick<Handlers, VaultChannel> {
  return {
    'vault:status': () => vault.status(),
    'vault:setup': (opts) => vault.setup(opts),
    'vault:unlock': (password) => vault.unlock(password),
    'vault:unlockPin': (pin) => vault.unlockPin(pin),
    'vault:unlockQuick': () => vault.unlockQuick(),
    'vault:lock': () => vault.lock('manual'),
    'vault:changePassword': (current, next) => vault.changePassword(current, next),
    'vault:list': () => vault.listVaults(),
    'vault:create': (input) => vault.createVault(input),
    'vault:update': (id, patch) => vault.updateVault(id, patch),
    'vault:delete': (id) => vault.deleteVault(id),
    // Turning quick unlock off needs no proof (the service keeps a way in); turning it on does.
    'vault:setQuickUnlock': async (mode, proof) =>
      mode === 'off'
        ? { ok: true, status: vault.setQuickUnlock('off') }
        : withProof(vault, proof, mode === 'touchId' ? 'turn on Touch ID' : 'turn on quick unlock', () =>
            vault.setQuickUnlock(mode),
          ),
    'vault:setAutoLock': (minutes) => vault.setAutoLock(minutes),
    'vault:reset': (confirm) => vault.reset(confirm),
    'vault:setPin': (pin, proof) => withProof(vault, proof, 'set a PIN', () => vault.setPin(pin)),
    'vault:clearPin': () => vault.clearPin(),
    'vault:setPassword': (next, proof) => withProof(vault, proof, 'set a master password', () => vault.setPassword(next)),
    'vault:removePassword': (current) => vault.removePassword(current),
  }
}
