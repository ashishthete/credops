import { X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toaster'
import { useVaultStatus, vaultStatusStore } from './status'
import { openVaultSettings } from './VaultSettingsDialog'

/** Remembers a dismissed "Add Touch ID or a PIN" nudge. */
const LEGACY_NUDGE_KEY = 'opsdeck.banner.legacyNudgeDismissed'

function readDismissed(): boolean {
  try {
    return localStorage.getItem(LEGACY_NUDGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Above the app while unlocked: the Microsoft session expired (sign in again), and, once, a pointer
 * for installs that only have a master password (preflight F22).
 */
export function SignInBanner() {
  const status = useVaultStatus()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [busy, setBusy] = useState(false)
  if (!status?.unlocked) return null

  const expired = status.sso.required && status.sso.verdict === 'needs-signin'
  const legacy = !dismissed && status.hasPassword && !status.pin.enabled && status.quickUnlock === 'off'
  if (!expired && !legacy) return null

  const signIn = async () => {
    setBusy(true)
    try {
      vaultStatusStore.set(await api.invoke('auth:signIn'))
    } catch (err) {
      toast({ title: "Couldn't sign in", description: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(LEGACY_NUDGE_KEY, '1')
    } catch {
      // Not remembered: it shows again next launch.
    }
  }

  return (
    <div className="flex flex-col">
      {expired && (
        <div role="alert" className="flex items-center gap-3 border-b border-line bg-warn/10 px-4 py-2 text-[13px] text-fg">
          <p className="flex-1">Microsoft sign-in expired</p>
          <Button size="sm" loading={busy} onClick={() => void signIn()}>
            Sign in
          </Button>
        </div>
      )}
      {legacy && (
        <div role="status" className="flex items-center gap-3 border-b border-line bg-surface/70 px-4 py-2 text-[13px] text-muted">
          <p className="flex-1">Add Touch ID or a PIN for faster, safer unlocks</p>
          <Button variant="ghost" size="sm" onClick={openVaultSettings}>
            Vault settings
          </Button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            className="grid size-6 place-items-center rounded transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
