import type { Handlers } from '../../../shared/ipc'
import type { IdentityStore } from '../../vault/identity-store'

type IdentityChannel = 'identity:list' | 'identity:create' | 'identity:update' | 'identity:delete'

export function createIdentityHandlers(ids: IdentityStore): Pick<Handlers, IdentityChannel> {
  return {
    'identity:list': (vaultId) => ids.list(vaultId),
    'identity:create': (input) => ids.create(input),
    'identity:update': (id, patch) => ids.update(id, patch),
    'identity:delete': (id) => ids.delete(id),
  }
}
