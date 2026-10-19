import { AnimatePresence, motion } from 'framer-motion'
import { Fingerprint } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { closeCommandPalette } from '../ui/commands'
import { fast, spring, useMotionSafe, useShake } from '../ui/motion'
import { toast } from '../ui/Toaster'
import { ResetVaultsDialog } from './ResetVaultsDialog'
import { SetupCard } from './SetupCard'
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

/** 'ready': the post-setup step; 'celebrate': the open padlock after an unlock. Both keep the gate up. */
type Hold = 'none' | 'ready' | 'celebrate'

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
  onSetUp: () => void
  onUnlocked: () => void
  onContinue: () => void
}

function GateScreen({ status, hold, session, autoQuick, onSetUp, onUnlocked, onContinue }: GateScreenProps) {
  const motionSafe = useMotionSafe()
  const statusError = useSplashError(status)
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
    description = 'Your master password is set and every vault is unlocked.'
    body = <ReadyStep status={status} onContinue={onContinue} />
  } else if (!status.setUp) {
    title = 'Protect your vaults'
    description = "One master password opens every vault. It can't be recovered, so keep it somewhere safe."
    body = <SetupCard onDone={onSetUp} />
  } else {
    title = 'Unlock vaults'
    description =
      status.quickUnlock === 'touchId' && status.quickUnlockAvailable.touchId
        ? 'Use Touch ID or your master password to open OpsDeck.'
        : 'Enter your master password to open OpsDeck.'
    body = (
      <UnlockCard
        key={session}
        status={status}
        autoQuick={autoQuick}
        onUnlocked={onUnlocked}
        onWrong={() => setShake((n) => n + 1)}
        onForgot={() => setResetOpen(true)}
      />
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
            aria-label={title ? undefined : 'Opening OpsDeck'}
            aria-busy={!status || undefined}
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

/** After setup: offer Touch ID (the passkey path) once, then into the app. */
function ReadyStep({ status, onContinue }: { status: VaultStatus; onContinue: () => void }) {
  const [busy, setBusy] = useState(false)
  const offerTouchId = status.quickUnlockAvailable.touchId && status.quickUnlock === 'off'

  const enableTouchId = async () => {
    setBusy(true)
    try {
      vaultStatusStore.set(await api.invoke('vault:setQuickUnlock', 'touchId'))
      toast({ title: 'Touch ID enabled', tone: 'success' })
      onContinue()
    } catch (err) {
      toast({ title: "Couldn't enable Touch ID", description: errorText(err), tone: 'error' })
      setBusy(false)
    }
  }

  if (!offerTouchId) {
    return (
      <Button autoFocus onClick={onContinue} className="w-full">
        Continue
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        autoFocus
        loading={busy}
        icon={<Fingerprint aria-hidden className="size-4" />}
        onClick={() => void enableTouchId()}
        className="w-full"
      >
        Enable Touch ID
      </Button>
      <Button variant="ghost" disabled={busy} onClick={onContinue} className="w-full">
        Not now
      </Button>
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
