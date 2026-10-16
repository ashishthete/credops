import { AnimatePresence, motion } from 'framer-motion'
import { Fingerprint } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { closeCommandPalette } from '../ui/commands'
import { fast, spring, useMotionSafe, useShake } from '../ui/motion'
import { toast } from '../ui/Toaster'
import { SetupCard } from './SetupCard'
import { refreshVaultStatus, useVaultStatus, vaultStatusStore } from './status'
import { peekUserLock, resolveUnlock, takeUserLock } from './unlock'
import { LockBadge, UnlockCard } from './UnlockCard'
import { closeVaultSettings } from './VaultSettingsDialog'

/** How long the open padlock stays on screen before the shell is revealed. */
const CELEBRATE_MS = 360

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
  // Bumped on every lock, so the unlock card (and its one Touch ID try) starts fresh.
  const [session, setSession] = useState(0)
  const [lockedByUser, setLockedByUser] = useState(false)
  const [wasUnlocked, setWasUnlocked] = useState<boolean | null>(null)

  // Derived during render, not in an effect: the fresh unlock card's own mount effect (which may
  // fire Touch ID) runs before any effect here, so it must already see the right autoQuick.
  if (status && status.unlocked !== wasUnlocked) {
    setWasUnlocked(status.unlocked)
    if (!status.unlocked && wasUnlocked) {
      setHold('none')
      setSession((n) => n + 1)
      setLockedByUser(peekUserLock())
    }
  }

  useLockWatcher(status, () => {
    closeCommandPalette()
    closeVaultSettings()
  })

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
            session={session}
            autoQuick={!lockedByUser}
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
  const titleId = useId()
  const [shake, setShake] = useState(0)
  const shakeScope = useShake(shake)

  let title = ''
  let description = ''
  let body: ReactNode = null
  if (!status) {
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
    </motion.div>
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

/** Fires `onLock` when the vaults go from unlocked to locked, and announces locks the user didn't ask for. */
function useLockWatcher(status: VaultStatus | null, onLock: () => void) {
  const wasUnlocked = useRef<boolean | null>(null)
  const onLockRef = useRef(onLock)
  useEffect(() => {
    onLockRef.current = onLock
  })
  useEffect(() => {
    if (!status) return
    if (status.unlocked) {
      takeUserLock()
    } else if (wasUnlocked.current) {
      const byUser = takeUserLock()
      if (!byUser) toast({ title: 'Vaults locked', description: 'Locked automatically.', tone: 'info' })
      onLockRef.current()
    }
    wasUnlocked.current = status.unlocked
  }, [status])
}
