import { LogIn } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import type { VaultStatus } from '../../../shared/vault'
import { cancelSignIn, connectHub, unlinkHub } from '../hub/store'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { TextField } from '../ui/Field'
import { refreshVaultStatus, vaultStatusStore } from './status'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Which sign-in step the gate shows. Not linked (`sso.required` false) means the Hub address comes first. */
export type SignInView = 'hub' | 'microsoft' | 'mismatch' | 'blocked'

/**
 * Read from the vault status, not the Hub store: that store only syncs inside the unlocked shell
 * (preflight F8), while `sso.required` already says whether a Hub is linked.
 */
export function signInView(status: VaultStatus): SignInView {
  if (!status.sso.required) return 'hub'
  if (status.sso.verdict === 'mismatch') return 'mismatch'
  if (status.sso.verdict === 'blocked') return 'blocked'
  return 'microsoft'
}

/** The gate card's title and description for each sign-in step. */
export function signInCopy(status: VaultStatus): { title: string; description: string } {
  const sso = status.sso
  switch (signInView(status)) {
    case 'hub':
      return {
        title: "Connect to your team's Hub",
        description: 'CredOps opens with your Microsoft account once it knows your Hub. Ask your admin for its address.',
      }
    case 'mismatch':
      return { title: 'Sign in with Microsoft', description: `These vaults belong to ${(sso.required && sso.upn) || 'another account'}` }
    case 'blocked':
      return { title: 'Sign in with Microsoft', description: 'Your Hub account is disabled. Ask a Hub admin.' }
    case 'microsoft':
      return {
        title: 'Sign in with Microsoft',
        description: status.setUp
          ? 'Your Microsoft sign-in has expired'
          : `Sign in to ${(sso.required && sso.hubName) || 'your Hub'} to set up CredOps.`,
      }
  }
}

const linkClass =
  'self-center rounded px-1 text-[12px] text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent'

/**
 * The gate's sign-in steps: the Hub address on a fresh install, then Microsoft; or, for vaults bound
 * to another account (mismatch) or a disabled one (blocked), the way out through Reset.
 */
export function SignInCard({
  status,
  onSignedIn,
  onReset,
  onWithoutHub,
}: {
  status: VaultStatus
  onSignedIn: () => void
  /** Opens the gate's ResetVaultsDialog (preflight F27). */
  onReset: () => void
  /** "Use CredOps without a Hub": the gate goes straight to setup for this session. */
  onWithoutHub: () => void
}) {
  const view = signInView(status)
  if (view === 'hub') return <HubStep onWithoutHub={onWithoutHub} />
  return <MicrosoftStep status={status} view={view} onSignedIn={onSignedIn} onReset={onReset} />
}

function HubStep({ onWithoutHub }: { onWithoutHub: () => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const address = url.trim()
    if (!address || busy) return
    setBusy(true)
    setError(null)
    try {
      // Linking makes sign-in required; the fresh status moves the gate to the Microsoft step.
      if (await connectHub(address, setError)) await refreshVaultStatus().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      <TextField
        label="Hub URL"
        placeholder="https://hub.example.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        error={error ?? undefined}
        readOnly={busy}
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="url"
      />
      <Button type="submit" loading={busy} disabled={!url.trim()} className="w-full">
        Continue
      </Button>
      <button type="button" onClick={onWithoutHub} disabled={busy} className={`-mt-1 ${linkClass}`}>
        Use CredOps without a Hub
      </button>
    </form>
  )
}

function MicrosoftStep({
  status,
  view,
  onSignedIn,
  onReset,
}: {
  status: VaultStatus
  view: Exclude<SignInView, 'hub'>
  onSignedIn: () => void
  onReset: () => void
}) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // Set by Cancel, so the rejected sign-in it causes is not shown as an error.
  const cancelled = useRef(false)
  const hubName = status.sso.required ? status.sso.hubName : ''

  const signIn = async () => {
    cancelled.current = false
    setWaiting(true)
    setError(null)
    try {
      const next = await api.invoke('auth:signIn')
      vaultStatusStore.set(next)
      const verdict = next.sso.required ? next.sso.verdict : 'not-required'
      if (verdict === 'verified' || verdict === 'grace' || verdict === 'not-required') onSignedIn()
      else if (verdict === 'needs-signin') setError("The sign-in didn't finish. Try again.")
      // mismatch or blocked: the new status switches this card to that view.
    } catch (err) {
      if (!cancelled.current) setError(errorText(err))
    } finally {
      setWaiting(false)
    }
  }

  const cancel = () => {
    cancelled.current = true
    void cancelSignIn()
  }

  // A disabled account may be turned back on: check again rather than sign in again.
  const checkAgain = async () => {
    setChecking(true)
    setError(null)
    try {
      vaultStatusStore.set(await api.invoke('auth:check'))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setChecking(false)
    }
  }

  // Before setup nothing is bound yet: undo the link, so the gate offers the Hub step (and "without a Hub") again.
  const differentHub = async () => {
    setLeaving(true)
    setError(null)
    try {
      if (await unlinkHub()) await refreshVaultStatus().catch(() => undefined)
    } finally {
      setLeaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Before setup the description already names the Hub. */}
      {view === 'microsoft' && status.setUp && hubName && (
        <p className="-mt-2 text-[12.5px] leading-5 text-muted">Sign in to {hubName} to unlock your vaults.</p>
      )}
      {waiting ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="text-center text-[13px] text-muted">
            Waiting for your browser…
          </p>
          {/* Never disabled: this is the way out if the browser tab was closed. */}
          <Button variant="ghost" onClick={cancel} className="w-full">
            Cancel
          </Button>
        </div>
      ) : view === 'blocked' ? (
        <Button variant="ghost" loading={checking} onClick={() => void checkAgain()} className="w-full">
          Check again
        </Button>
      ) : (
        <Button autoFocus icon={<LogIn aria-hidden className="size-4" />} onClick={() => void signIn()} className="w-full">
          Sign in with Microsoft
        </Button>
      )}
      {error && (
        <p role="alert" className="text-center text-[12.5px] text-err">
          {error}
        </p>
      )}
      {(view === 'mismatch' || view === 'blocked') && (
        <button type="button" onClick={onReset} disabled={waiting} className={`-mt-1 ${linkClass}`}>
          Reset vaults
        </button>
      )}
      {!status.setUp && !waiting && (
        <button type="button" onClick={() => void differentHub()} disabled={leaving} className={`-mt-1 ${linkClass}`}>
          Use a different Hub
        </button>
      )}
    </div>
  )
}
