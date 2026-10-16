import type { Handlers } from '../../../shared/ipc'
import type { SecretStore } from '../../vault/secret-store'

type SecretChannel = 'secret:list' | 'secret:create' | 'secret:update' | 'secret:delete' | 'secret:reveal' | 'secret:copy'

export function createSecretHandlers(secrets: SecretStore): Pick<Handlers, SecretChannel> {
  return {
    'secret:list': (vaultId) => secrets.list(vaultId),
    'secret:create': (input) => secrets.create(input),
    'secret:update': (id, patch) => secrets.update(id, patch),
    'secret:delete': (id) => secrets.delete(id),
    'secret:reveal': (id) => secrets.reveal(id),
    'secret:copy': (id) => secrets.copy(id),
  }
}
