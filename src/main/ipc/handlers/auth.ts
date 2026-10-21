import type { Handlers } from '../../../shared/ipc'
import type { SsoGate } from '../../auth/sso-gate'
import type { HubConnection } from '../../hub/connection'
import type { VaultService } from '../../vault/vault-service'
import { withProof } from './vault'

type AuthChannel = 'auth:check' | 'auth:signIn' | 'auth:changeAccount' | 'auth:disconnect' | 'auth:signOut' | 'hub:signOut'

/**
 * Microsoft sign-in for the vault gate. Spread after the Hub handlers: it replaces `hub:signOut`, so
 * every sign-out, from either button, makes the gate forget its verification.
 */
export function createAuthHandlers(d: {
  vault: Pick<VaultService, 'status' | 'reverify' | 'lock' | 'assertUnlocked'>
  gate: Pick<SsoGate, 'check' | 'signIn' | 'rebind' | 'unbind' | 'signOut' | 'sessionDropped'>
  hub: Pick<HubConnection, 'signOut' | 'unlink'>
}): Pick<Handlers, AuthChannel> {
  const { vault, gate, hub } = d
  return {
    'auth:check': async () => {
      await gate.check({ force: true })
      return vault.status()
    },
    'auth:signIn': async () => {
      await gate.signIn()
      return vault.status()
    },
    'auth:changeAccount': (proof) => withProof(vault, proof, () => gate.rebind()),
    'auth:disconnect': (proof) =>
      withProof(vault, proof, async () => {
        gate.unbind()
        await hub.unlink()
      }),
    'auth:signOut': async () => {
      try {
        await gate.signOut()
      } finally {
        vault.lock('manual')
      }
      return vault.status()
    },
    'hub:signOut': async () => {
      vault.assertUnlocked()
      try {
        return await hub.signOut()
      } finally {
        gate.sessionDropped()
      }
    },
  }
}
