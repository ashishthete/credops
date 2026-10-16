import { AnimatePresence, motion } from 'framer-motion'
import { Fingerprint } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'
import { MAX_MASTER_PASSWORD, type VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SecretField } from '../ui/Field'
import { useMotionSafe } from '../ui/motion'
import { Padlock } from '../ui/Padlock'
import { toast } from '../ui/Toaster'
import { toneColor } from '../ui/tone'
import { SetupCard } from './SetupCard'
import { refreshVaultStatus, useVaultStatus, vaultStatusStore } from './status'
import { cancelUnlock, ensureUnlocked, resolveUnlock, takeUserLock, unlockRequestStore } from './unlock'

/** How long the open padlock stays on screen after a successful unlock. */
const CELEBRATE_MS = 360

/** Whole seconds until `deadline` (epoch ms), ticking while it is in the future. */
export function useSecondsLeft(deadline: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (deadline <= Date.now()) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= deadline) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [deadline])
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

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

/** The unlock (or first-run setup) prompt behind ensureUnlocked(). Mount once. */
export function UnlockDialog() {
  const requested = useSyncExternalStore(unlockRequestStore.subscribe, unlockRequestStore.get)
  const status = useVaultStatus()
  const motionSafe = useMotionSafe()
  const [celebrating, setCelebrating] = useState(false)
  const [shake, setShake] = useState(0)
  const [session, setSession] = useState(0)
  useLockWatcher(status)

  // A fresh form (and one automatic quick-unlock try) for every prompt.
  useEffect(() => {
    if (requested) {
      setSession((s) => s + 1)
      setShake(0)
    }
  }, [requested])

  useEffect(() => {
    if (!celebrating) return
    const timer = setTimeout(() => setCelebrating(false), motionSafe ? CELEBRATE_MS : 0)
    return () => clearTimeout(timer)
  }, [celebrating, motionSafe])

  const finish = async (announce: boolean) => {
    const fresh = await refreshVaultStatus().catch(() => {
      const s = vaultStatusStore.get()
      if (s) vaultStatusStore.set({ ...s, unlocked: true })
      return null
    })
    setCelebrating(true)
    resolveUnlock()
    if (announce) toast({ title: 'Vaults unlocked', tone: 'success' })
    announceCorrupt(fresh)
  }

  const setup = status !== null && !status.setUp
  const open = requested || celebrating
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!celebrating) cancelUnlock()
      }}
      title={setup ? 'Protect your vaults' : 'Unlock vaults'}
      description={
        setup
          ? "One master password opens every vault. It can't be recovered, so keep it somewhere safe."
          : 'Enter your master password to open your vaults.'
      }
      icon={<LockBadge open={celebrating} />}
      shake={shake}
      width={400}
    >
      {setup ? (
        <SetupCard key={session} onDone={() => void finish(false)} />
      ) : (
        <UnlockForm
          key={session}
          status={status}
          onUnlocked={() => void finish(true)}
          onWrong={() => setShake((n) => n + 1)}
        />
      )}
    </Dialog>
  )
}

/** The padlock tile at the top of the prompt: springs open and flashes green on success. */
function LockBadge({ open }: { open: boolean }) {
  const motionSafe = useMotionSafe()
  return (
    <div
      className="relative mb-4 grid size-11 place-items-center"
      style={{ '--tone': open ? toneColor.success : toneColor.info } as CSSProperties}
    >
      <AnimatePresence>
        {open && motionSafe && (
          <motion.span
            key="ring"
            aria-hidden
            className="absolute inset-0 rounded-xl border-2 border-(--tone)"
            initial={{ opacity: 0.7, scale: 1 }}
            animate={{ opacity: 0, scale: 1.7 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          />
        )}
      </AnimatePresence>
      <span className="tone-soft grid size-11 place-items-center rounded-xl transition-[color,background-color,box-shadow] duration-200">
        <Padlock open={open} className="size-5" />
      </span>
    </div>
  )
}

function UnlockForm({
  status,
  onUnlocked,
  onWrong,
}: {
  status: VaultStatus | null
  onUnlocked: () => void
  onWrong: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // The password stays in the input until submit; state only knows whether it is empty.
  const [hasInput, setHasInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [deadline, setDeadline] = useState(() => (status?.retryAfterMs ? Date.now() + status.retryAfterMs : 0))
  const secondsLeft = useSecondsLeft(deadline)

  const mode = status?.quickUnlock ?? 'off'
  const quickReady = mode !== 'off' && !!status?.quickUnlockAvailable[mode]
  const [quickGone, setQuickGone] = useState(false)
  const [quickBusy, setQuickBusy] = useState(false)
  const showTouchId = mode === 'touchId' && quickReady && !quickGone

  const tryQuick = async () => {
    setQuickBusy(true)
    try {
      const res = await api.invoke('vault:unlockQuick')
      if (res.ok) return onUnlocked()
      if (res.reason === 'unavailable') {
        setQuickGone(true)
        setHint(
          mode === 'touchId'
            ? "Touch ID isn't available right now. Use your master password."
            : "Keychain unlock isn't available right now. Use your master password.",
        )
      } else if (res.reason === 'throttled') {
        setDeadline(Date.now() + res.retryAfterMs)
      }
      // 'cancelled': the user closed the prompt; the password field is right there.
    } catch {
      setQuickGone(true)
    } finally {
      setQuickBusy(false)
      inputRef.current?.focus()
    }
  }

  // One automatic attempt when the prompt opens; the form is re-keyed per prompt.
  const triedQuick = useRef(false)
  useEffect(() => {
    if (quickReady && !triedQuick.current) {
      triedQuick.current = true
      void tryQuick()
    }
  }, [quickReady])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const input = inputRef.current
    if (!input || busy || secondsLeft > 0 || !input.value) return
    const password = input.value
    input.value = ''
    setHasInput(false)
    setBusy(true)
    setError(null)
    setHint(null)
    try {
      const res = await api.invoke('vault:unlock', password)
      if (res.ok) return onUnlocked()
      if (res.reason === 'wrong-password') {
        setError('Wrong password')
        onWrong()
      }
      if (res.retryAfterMs > 0) setDeadline(Date.now() + res.retryAfterMs)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
      input.focus()
    }
  }

  const throttled = secondsLeft > 0
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <SecretField
        ref={inputRef}
        label="Master password"
        autoFocus
        readOnly={busy}
        maxLength={MAX_MASTER_PASSWORD}
        onInput={(e) => setHasInput(e.currentTarget.value.length > 0)}
        error={error ?? undefined}
        hint={hint ?? undefined}
      />
      <Button
        type="submit"
        loading={busy}
        disabled={!hasInput || throttled}
        className="relative w-full overflow-hidden tabular-nums"
      >
        {throttled ? `Try again in ${secondsLeft} s` : 'Unlock'}
        {throttled && (
          <span
            key={deadline}
            aria-hidden
            className="toast-drain absolute inset-x-0 bottom-0 h-0.5 bg-white/50"
            style={{ animationDuration: `${Math.max(0, deadline - Date.now())}ms` }}
          />
        )}
      </Button>
      {showTouchId && (
        <>
          <div aria-hidden className="flex items-center gap-3 text-[11px] text-muted">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <Button
            variant="ghost"
            loading={quickBusy}
            icon={<Fingerprint aria-hidden className="size-4" />}
            onClick={() => void tryQuick()}
            className="w-full"
          >
            Unlock with Touch ID
          </Button>
        </>
      )}
    </form>
  )
}

/** Announces a lock the user did not ask for (idle, screen lock, sleep), seen via polling. */
function useLockWatcher(status: VaultStatus | null) {
  const wasUnlocked = useRef<boolean | null>(null)
  useEffect(() => {
    if (!status) return
    if (status.unlocked) {
      takeUserLock()
    } else if (wasUnlocked.current && !takeUserLock()) {
      toast({
        title: 'Vaults locked',
        description: 'Locked automatically. Unlock to use secrets again.',
        tone: 'info',
        action: { label: 'Unlock', run: () => void ensureUnlocked() },
      })
    }
    wasUnlocked.current = status.unlocked
  }, [status])
}
