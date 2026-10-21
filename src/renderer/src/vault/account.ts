import { useEffect } from 'react'
import { api } from '../lib/api'
import { registerCommand } from '../ui/commands'
import { toast } from '../ui/Toaster'
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

/** Palette: "Sign out", offered only while signed in through a Hub. */
export function useAccountCommands(): void {
  const status = useVaultStatus()
  const signedIn = !!status?.sso.required && (status.sso.verdict === 'verified' || status.sso.verdict === 'grace')
  useEffect(() => {
    if (!signedIn) return
    return registerCommand({
      id: 'account.signOut',
      title: 'Sign out',
      section: 'Account',
      keywords: ['microsoft', 'hub', 'log out', 'logout', 'lock'],
      run: () => void signOutAccount(),
    })
  }, [signedIn])
}
