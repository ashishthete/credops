import { AnimatePresence, motion } from 'framer-motion'
import { Fingerprint } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { MAX_MASTER_PASSWORD, type VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { SecretField } from '../ui/Field'
import { useMotionSafe } from '../ui/motion'
import { Padlock } from '../ui/Padlock'
import { toneColor } from '../ui/tone'

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

/** The padlock tile at the top of the prompt: springs open and flashes green on success. */
export function LockBadge({ open }: { open: boolean }) {
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

/**
 * The master-password form, with Touch ID (the platform passkey) offered and, unless `autoQuick`
 * is false, tried once on mount when that is the quick-unlock mode. Mount it fresh for every lock so that try happens again.
 */
export function UnlockCard({
  status,
  autoQuick = true,
  onUnlocked,
  onWrong,
  onForgot,
}: {
  status: VaultStatus | null
  /** False after the user's own lock: they are walking away, so don't pop a Touch ID prompt. */
  autoQuick?: boolean
  onUnlocked: () => void
  onWrong: () => void
  /** Shows the "Forgot password?" link, which offers the reset. */
  onForgot?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // The password stays in the input until submit; state only knows whether it is empty.
  const [hasInput, setHasInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [deadline, setDeadline] = useState(() => (status?.retryAfterMs ? Date.now() + status.retryAfterMs : 0))
  const secondsLeft = useSecondsLeft(deadline)

  // Only Touch ID: the prompt-less 'login' mode would let anyone at the Mac past the gate.
  const quickReady = status?.quickUnlock === 'touchId' && status.quickUnlockAvailable.touchId
  const [quickGone, setQuickGone] = useState(false)
  const [quickBusy, setQuickBusy] = useState(false)
  const showTouchId = quickReady && !quickGone

  const tryQuick = async () => {
    setQuickBusy(true)
    try {
      const res = await api.invoke('vault:unlockQuick')
      if (res.ok) return onUnlocked()
      if (res.reason === 'unavailable') {
        setQuickGone(true)
        setHint("Touch ID isn't available right now. Use your master password.")
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

  // One automatic attempt per mount.
  const triedQuick = useRef(false)
  useEffect(() => {
    if (autoQuick && quickReady && !triedQuick.current) {
      triedQuick.current = true
      void tryQuick()
    }
  }, [autoQuick, quickReady])

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
      {onForgot && (
        <button
          type="button"
          onClick={onForgot}
          className="-mt-1 self-center rounded px-1 text-[12px] text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          Forgot password?
        </button>
      )}
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
