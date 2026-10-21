import { AnimatePresence, motion } from 'framer-motion'
import { Fingerprint, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ReverifyProof } from '../../../shared/sso'
import { MAX_MASTER_PASSWORD, MAX_PIN, VERIFICATION_FAILED, type VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { SecretField } from '../ui/Field'
import { closeCommandPalette } from '../ui/commands'
import { fast, spring, useMotionSafe, useShake } from '../ui/motion'
import { toast } from '../ui/Toaster'
import { ResetVaultsDialog } from './ResetVaultsDialog'
import { SetupCard } from './SetupCard'
import { SignInCard, signInCopy } from './SignInCard'
import {
  peekLockReason,
  refreshVaultStatus,
  takeLockReason,
  useVaultStatus,
  useVaultStatusError,
  vaultStatusStore,
} from './status'
import { resolveUnlock } from './unlock'
import { LockBadge, UnlockCard } from './UnlockCard'
import { closeVaultSettings } from './VaultSettingsDialog'

/** How long the open padlock stays on screen before the shell is revealed. */
const CELEBRATE_MS = 360
/** How long the splash waits on a failing vault:status before offering Retry. */
const SPLASH_ERROR_MS = 3000

/** Remembers a dismissed "Connect your team's Hub" line on the gate. */
const HUB_NUDGE_KEY = 'opsdeck.gate.hubNudgeDismissed'

/**
 * 'ready': the post-setup step; 'celebrate': the open padlock after an unlock; 'reenable': the offer
 * to turn a broken Touch ID back on, after an unlock. All keep the gate up.
 */
type Hold = 'none' | 'ready' | 'celebrate' | 'reenable'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function announceCorrupt(status: VaultStatus | null) {
  const n = status?.corruptVaultIds.length ?? 0
  if (!n) return
  toast({
    title: `${n} vault${n === 1 ? '' : 's'} could not be opened`,
    description: 'Their keys failed to decrypt. Everything else is unlocked.',
    tone: 'warn',
  })
}

/**
 * Renders `children` (the whole app) only while the vaults are set up and unlocked. Otherwise
 * only the full-screen gate is mounted: setup on first run, then the unlock card. Any lock
 * unmounts the app at once and brings the gate back.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useVaultStatus()
  const motionSafe = useMotionSafe()
  const [hold, setHold] = useState<Hold>('none')
  const lock = useLockTransitions(status, () => setHold('none'))
  // Whether this install has made its Hub choice: "Use OpsDeck without a Hub" was picked this
  // session, or the vaults were already set up without one (so a reset keeps them local-only).
  const [localOnly, setLocalOnly] = useState(false)
  if (status?.setUp && !status.sso.required && !localOnly) setLocalOnly(true)
  // Asked once per session: "Not now" means not again until the next launch.
  const reenableAsked = useRef(false)

  useEffect(() => {
    if (hold !== 'celebrate') return
    const timer = setTimeout(() => setHold('none'), motionSafe ? CELEBRATE_MS : 0)
    return () => clearTimeout(timer)
  }, [hold, motionSafe])

  const onUnlocked = async () => {
    setHold('celebrate')
    const fresh = await refreshVaultStatus().catch(() => {
      const s = vaultStatusStore.get()
      if (s) vaultStatusStore.set({ ...s, unlocked: true })
      return null
    })
    resolveUnlock()
    toast({ title: 'Vaults unlocked', tone: 'success' })
    announceCorrupt(fresh)
    if (fresh?.touchIdNeedsReenable && !reenableAsked.current) {
      reenableAsked.current = true
      setHold('reenable')
    }
  }

  const open = !!status?.setUp && status.unlocked && hold === 'none'
  return (
    <>
      {open && (
        <motion.div
          className="h-screen"
          initial={motionSafe ? { opacity: 0, scale: 0.985 } : { opacity: 0 }}
          animate={motionSafe ? { opacity: 1, scale: 1 } : { opacity: 1 }}
          transition={motionSafe ? spring : fast}
        >
          {children}
        </motion.div>
      )}
      <AnimatePresence>
        {!open && (
          <GateScreen
            key="gate"
            status={status}
            hold={hold}
            session={lock.session}
            autoQuick={!lock.byUser}
            localOnly={localOnly}
            onWithoutHub={() => setLocalOnly(true)}
            onSetUp={() => {
              setHold('ready')
              resolveUnlock()
            }}
            onUnlocked={() => void onUnlocked()}
            onContinue={() => setHold('none')}
          />
        )}
      </AnimatePresence>
    </>
  )
}

interface GateScreenProps {
  status: VaultStatus | null
  hold: Hold
  session: number
  autoQuick: boolean
  localOnly: boolean
  onWithoutHub: () => void
  onSetUp: () => void
  onUnlocked: () => void
  onContinue: () => void
}

function GateScreen({ status, hold, session, autoQuick, localOnly, onWithoutHub, onSetUp, onUnlocked, onContinue }: GateScreenProps) {
  const motionSafe = useMotionSafe()
  const statusError = useSplashError(status)
  const checking = useSignInCheck(status)
  const titleId = useId()
  const [shake, setShake] = useState(0)
  const shakeScope = useShake(shake)
  // Here, not in the unlock card: the card's form and transformed section must not contain the dialog.
  const [resetOpen, setResetOpen] = useState(false)

  let title = ''
  let description = ''
  let body: ReactNode = null
  if (!status && statusError) {
    title = "Couldn't open your vaults"
    description = statusError
    body = <RetryButton />
  } else if (!status) {
    // First status fetch in flight: just the closed padlock.
  } else if (hold === 'ready') {
    title = 'Your vaults are ready'
    description = 'Every vault is set up and unlocked.'
    body = <ReadyStep onContinue={onContinue} />
  } else if (hold === 'reenable') {
    title = 'Turn Touch ID on again'
    description = "Touch ID couldn't open your vaults this time. Confirm it's you to turn it back on."
    body = <ReenableStep status={status} onWrong={() => setShake((n) => n + 1)} onContinue={onContinue} />
  } else if (hold === 'none' && checking) {
    // The verdict is unknown: no unlock attempt (Touch ID included) until it is in.
    body = (
      <p role="status" className="text-[13px] leading-5 text-muted">
        Checking your Microsoft sign-in…
      </p>
    )
  } else if (hold === 'none' && needsSignIn(status, localOnly)) {
    ;({ title, description } = signInCopy(status))
    body = (
      <SignInCard
        status={status}
        onSignedIn={() => undefined}
        onReset={() => setResetOpen(true)}
        onWithoutHub={onWithoutHub}
      />
    )
  } else if (!status.setUp) {
    title = 'Protect your vaults'
    description = 'Choose how you unlock OpsDeck'
    body = <SetupCard onDone={onSetUp} />
  } else {
    title = 'Unlock vaults'
    description = unlockDescription(status)
    body = (
      <>
        <UnlockCard
          key={session}
          status={status}
          autoQuick={autoQuick}
          onUnlocked={onUnlocked}
          onWrong={() => setShake((n) => n + 1)}
          onForgot={() => setResetOpen(true)}
        />
        {!status.sso.required && <HubNudge />}
      </>
    )
  }

  return (
    <motion.div
      className="fixed inset-0 z-[55] flex flex-col bg-canvas text-fg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: motionSafe ? 0.28 : 0.15 } }}
      transition={fast}
    >
      <div aria-hidden className="app-drag h-[52px] shrink-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_45%_at_50%_38%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent)]"
      />
      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-4 pb-[52px]">
        <div ref={shakeScope} className="w-full max-w-[400px]">
          <motion.section
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : checking ? 'Checking your Microsoft sign-in' : 'Opening OpsDeck'}
            aria-busy={!status || checking || undefined}
            className="rounded-[14px] border border-line bg-surface p-6 shadow-pop"
            initial={motionSafe ? { opacity: 0, y: 12, scale: 0.98 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1 }}
            exit={motionSafe ? { opacity: 0, scale: 1.04, filter: 'blur(6px)', transition: { duration: 0.28 } } : undefined}
            transition={motionSafe ? spring : fast}
          >
            <LockBadge open={hold !== 'none'} />
            {title && (
              <>
                <h1 id={titleId} className="text-[17px] font-semibold tracking-tight text-fg">
                  {title}
                </h1>
                <p className="mt-1 mb-5 text-[12.5px] leading-5 text-muted">{description}</p>
              </>
            )}
            {body}
          </motion.section>
        </div>
      </div>
      <ResetVaultsDialog open={resetOpen} onClose={() => setResetOpen(false)} />
    </motion.div>
  )
}

/** The vault:status error, but only once it has kept failing for SPLASH_ERROR_MS with no status. */
function useSplashError(status: VaultStatus | null): string | null {
  const error = useVaultStatusError()
  const [waited, setWaited] = useState(false)
  const failing = !status && !!error
  useEffect(() => {
    if (!failing) return
    const timer = setTimeout(() => setWaited(true), SPLASH_ERROR_MS)
    return () => {
      clearTimeout(timer)
      setWaited(false)
    }
  }, [failing])
  return failing && waited ? error : null
}

function RetryButton() {
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    await refreshVaultStatus().catch(() => undefined)
    setBusy(false)
  }
  return (
    <Button autoFocus loading={busy} onClick={() => void retry()} className="w-full">
      Retry
    </Button>
  )
}

/** After setup: a confirmation. Touch ID is chosen on the setup card itself now. */
function ReadyStep({ onContinue }: { onContinue: () => void }) {
  return (
    <Button autoFocus onClick={onContinue} className="w-full">
      Continue
    </Button>
  )
}

/** Sign-in comes first while it is required and not passed, or on a fresh install that has not chosen a Hub yet. */
function needsSignIn(status: VaultStatus, localOnly: boolean): boolean {
  const sso = status.sso
  if (sso.required) return sso.verdict !== 'verified' && sso.verdict !== 'grace'
  return !status.setUp && !localOnly
}

function unlockDescription(status: VaultStatus): string {
  const sso = status.sso
  if (sso.required && sso.verdict === 'grace' && sso.lastVerifiedAt) {
    const hours = Math.max(1, Math.floor((Date.now() - Date.parse(sso.lastVerifiedAt)) / 3_600_000))
    return `Working offline · sign-in checked ${hours} h ago`
  }
  if (sso.required && sso.upn) return `Signed in as ${sso.upn}`
  return status.quickUnlock === 'touchId' && status.quickUnlockAvailable.touchId
    ? 'Use Touch ID or your master password to open OpsDeck.'
    : 'Enter your master password to open OpsDeck.'
}

/**
 * Forces one `auth:check` when the gate first sees a locked vault that needs sign-in (spec: every
 * launch checks; stricter than the 1 h skip, preflight F30), and again after a reset, whose old
 * verdict main keeps until the next check. True while that check, or main's own, is in flight.
 */
function useSignInCheck(status: VaultStatus | null): boolean {
  const [inflight, setInflight] = useState(false)
  const seen = useRef(false)
  const wasSetUp = useRef<boolean | null>(null)
  const checkedFor = useRef<VaultStatus | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  // Only the first status (a launch or a lock) or a reset: a Hub linked from this gate has no session to check.
  const due =
    !!status &&
    !status.unlocked &&
    status.sso.required &&
    (!seen.current || (wasSetUp.current === true && !status.setUp))
  useEffect(() => {
    if (!status) return
    seen.current = true
    wasSetUp.current = status.setUp
    if (!due || checkedFor.current === status) return
    checkedFor.current = status
    setInflight(true)
    api
      .invoke('auth:check')
      .then((fresh) => vaultStatusStore.set(fresh))
      .catch(() => refreshVaultStatus().catch(() => undefined))
      .finally(() => {
        if (mounted.current) setInflight(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `due` is derived from `status`
  }, [status])
  // `due` covers the render before the effect runs, so the sign-in card never flashes first.
  return due || inflight || (!!status && status.sso.required && status.sso.checking && !status.unlocked)
}

type ProofMethod = 'password' | 'pin'

/**
 * Touch ID is on but its Keychain copy could not be read (status.touchIdNeedsReenable): offer to
 * write it again. Turning a factor on needs a reverify proof (the T7 contract); the secret stays in
 * the input until it is sent and is never kept in state.
 */
function ReenableStep({ status, onWrong, onContinue }: { status: VaultStatus; onWrong: () => void; onContinue: () => void }) {
  const methods: ProofMethod[] = []
  if (status.hasPassword) methods.push('password')
  if (status.pin.enabled) methods.push('pin')
  const [method, setMethod] = useState<ProofMethod | null>(() =>
    status.lastMethod === 'pin' && status.pin.enabled ? 'pin' : (methods[0] ?? null),
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const [hasInput, setHasInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const other = methods.find((m) => m !== method)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const input = inputRef.current
    if (!input || !method || busy || !input.value) return
    const proof: ReverifyProof = method === 'pin' ? { method, pin: input.value } : { method, password: input.value }
    input.value = ''
    setHasInput(false)
    setBusy(true)
    setError(null)
    try {
      const res = await api.invoke('vault:setQuickUnlock', 'touchId', proof)
      vaultStatusStore.set(res.status)
      if (res.ok) {
        toast({ title: 'Touch ID is on again', tone: 'success' })
        return onContinue()
      }
      // pin-wiped: the PIN is gone. Locked means nothing else was left open; the gate offers what remains, or reset.
      toast({
        title: 'Too many wrong PINs',
        description: res.status.unlocked ? 'Your PIN was turned off.' : 'Your vaults locked. Unlock another way, or erase them.',
        tone: 'error',
      })
      if (!res.status.unlocked || !res.status.hasPassword) return onContinue()
      setMethod('password')
    } catch (err) {
      if (err instanceof Error && err.message === VERIFICATION_FAILED) {
        onWrong()
        if (method === 'pin') {
          // The rejection carries no count: read it from a fresh status, so a wipe never comes unwarned.
          const left = await refreshVaultStatus()
            .then((fresh) => (fresh.pin.enabled ? fresh.pin.attemptsLeft : null))
            .catch(() => null)
          setError(left === null ? 'Wrong PIN' : `Wrong PIN · ${left} ${left === 1 ? 'try' : 'tries'} left`)
        } else {
          setError('Wrong password')
        }
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  if (!method) {
    return (
      <Button autoFocus onClick={onContinue} className="w-full">
        Continue
      </Button>
    )
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
      <SecretField
        key={method}
        ref={inputRef}
        label={method === 'pin' ? 'PIN' : 'Master password'}
        autoFocus
        readOnly={busy}
        inputMode={method === 'pin' ? 'numeric' : undefined}
        maxLength={method === 'pin' ? MAX_PIN : MAX_MASTER_PASSWORD}
        onInput={(e) => setHasInput(e.currentTarget.value.length > 0)}
        error={error ?? undefined}
      />
      {other && (
        <button
          type="button"
          onClick={() => {
            setMethod(other)
            setError(null)
            setHasInput(false)
          }}
          disabled={busy}
          className="-mt-1 self-start rounded px-1 text-[12px] text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          {other === 'pin' ? 'Use your PIN instead' : 'Use your master password instead'}
        </button>
      )}
      <Button type="submit" loading={busy} disabled={!hasInput} icon={<Fingerprint aria-hidden className="size-4" />} className="w-full">
        Turn on Touch ID
      </Button>
      <Button variant="ghost" disabled={busy} onClick={onContinue} className="w-full">
        Not now
      </Button>
    </form>
  )
}

function readNudgeDismissed(): boolean {
  try {
    return localStorage.getItem(HUB_NUDGE_KEY) === '1'
  } catch {
    return false
  }
}

/** For installs without a Hub (spec §4, preflight F22): a dismissible pointer to Settings → Hub. */
function HubNudge() {
  const [dismissed, setDismissed] = useState(readNudgeDismissed)
  if (dismissed) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(HUB_NUDGE_KEY, '1')
    } catch {
      // Not remembered: it shows again next launch.
    }
  }
  return (
    <div className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-[12px] text-muted">
      <p className="flex-1">Connect your team's Hub to sign in with Microsoft</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="grid size-6 place-items-center rounded transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}

interface LockTransitions {
  /** Bumped on every unlocked -> locked change, so the unlock card (and its Touch ID try) starts fresh. */
  session: number
  /** Whether that lock was the user's own (reason 'manual'). */
  byUser: boolean
  wasUnlocked: boolean | null
}

/**
 * Tracks unlocked -> locked changes. The change is derived during render, not in an effect: the
 * fresh unlock card's mount effect (which may fire Touch ID) runs before any effect here, so it
 * must already see `byUser`. The side effects (one "Vaults locked" toast, closing overlays) run
 * once per lock in an effect.
 */
function useLockTransitions(status: VaultStatus | null, onLock: () => void): LockTransitions {
  const [t, setT] = useState<LockTransitions>({ session: 0, byUser: false, wasUnlocked: null })
  if (status && status.unlocked !== t.wasUnlocked) {
    const locked = !status.unlocked && t.wasUnlocked === true
    setT({
      session: locked ? t.session + 1 : t.session,
      byUser: locked ? peekLockReason() === 'manual' : t.byUser,
      wasUnlocked: status.unlocked,
    })
    if (locked) onLock()
  }

  useEffect(() => {
    if (!t.session) return
    takeLockReason()
    toast(
      t.byUser
        ? { title: 'Vaults locked', tone: 'info' }
        : { title: 'Vaults locked', description: 'Locked automatically.', tone: 'info' },
    )
    closeCommandPalette()
    closeVaultSettings()
  }, [t.session, t.byUser])

  useEffect(() => {
    // A reason noted while already locked (nothing changed) must not leak into the next lock.
    if (t.wasUnlocked) takeLockReason()
  }, [t.wasUnlocked])

  return t
}
