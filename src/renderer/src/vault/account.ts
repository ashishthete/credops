import { useEffect } from 'react'
import { api } from '../lib/api'
import { registerCommand } from '../ui/commands'
import { createStore } from '../ui/store'
import { toast } from '../ui/Toaster'
import type { VaultStatus } from '../../../shared/vault'
import { useVaultStatus, vaultStatusStore } from './status'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Signs out of the Hub's Microsoft account and locks the vaults (main does both); the gate takes over. */
export async function signOutAccount(): Promise<void> {
  try {
    vaultStatusStore.set(await api.invoke('auth:signOut'))
  } catch (err) {
    toast({ title: "Couldn't sign out", description: errorText(err), tone: 'error' })
  }
}

/** Whether a Hub session is live, so signing out means something. Settings and the palette share this rule. */
export const isSignedInViaHub = (status: VaultStatus | null): boolean =>
  !!status?.sso.required && (status.sso.verdict === 'verified' || status.sso.verdict === 'grace')

const asking = createStore(false)
/** The "Sign out and lock your vaults?" confirmation, opened by Settings and by the palette. */
export const signOutRequest = { store: asking, ask: () => asking.set(true), close: () => asking.set(false) }

/** Palette: "Sign out", offered only while signed in through a Hub. */
export function useAccountCommands(): void {
  const status = useVaultStatus()
  const signedIn = isSignedInViaHub(status)
  useEffect(() => {
    if (!signedIn) return
    return registerCommand({
      id: 'account.signOut',
      title: 'Sign out',
      section: 'Account',
      keywords: ['microsoft', 'hub', 'log out', 'logout', 'lock'],
      run: signOutRequest.ask,
    })
  }, [signedIn])
}
