import type { Handlers } from '../../../shared/ipc'
import type { VaultService } from '../../vault/vault-service'

type VaultChannel =
  | 'vault:status'
  | 'vault:setup'
  | 'vault:unlock'
  | 'vault:unlockQuick'
  | 'vault:lock'
  | 'vault:changePassword'
  | 'vault:list'
  | 'vault:create'
  | 'vault:update'
  | 'vault:delete'
  | 'vault:setQuickUnlock'
  | 'vault:setAutoLock'

export function createVaultHandlers(vault: VaultService): Pick<Handlers, VaultChannel> {
  return {
    'vault:status': () => vault.status(),
    'vault:setup': (password) => vault.setup(password),
    'vault:unlock': (password) => vault.unlock(password),
    'vault:unlockQuick': () => vault.unlockQuick(),
    'vault:lock': () => vault.lock('manual'),
    'vault:changePassword': (current, next) => vault.changePassword(current, next),
    'vault:list': () => vault.listVaults(),
    'vault:create': (input) => vault.createVault(input),
    'vault:update': (id, patch) => vault.updateVault(id, patch),
    'vault:delete': (id) => vault.deleteVault(id),
    'vault:setQuickUnlock': (mode) => vault.setQuickUnlock(mode),
    'vault:setAutoLock': (minutes) => vault.setAutoLock(minutes),
  }
}
