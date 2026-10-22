import type { Handlers } from '../../../shared/ipc'
import type { SsoGate } from '../../auth/sso-gate'
import type { HubConnection } from '../../hub/connection'
import type { VaultService } from '../../vault/vault-service'
import { withProof } from './vault'

type AuthChannel = 'auth:check' | 'auth:signIn' | 'auth:changeAccount' | 'auth:disconnect' | 'auth:signOut' | 'hub:signOut'

/**
 * Microsoft sign-in for the vault gate. Owns `hub:signOut` too (the Hub handlers leave it out), so
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
    'auth:changeAccount': (proof) => withProof(vault, proof, 'change the Microsoft account', () => gate.rebind()),
    'auth:disconnect': (proof) =>
      withProof(vault, proof, 'disconnect Microsoft sign-in', async () => {
        // Unbind first: if the unlink then throws, the vault is unbound but still linked, and a linked
        // Hub keeps sign-in required (it rebinds at the next unlock), so it fails closed; retry it.
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
