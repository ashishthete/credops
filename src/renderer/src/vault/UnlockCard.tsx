import { AnimatePresence, motion } from 'framer-motion'
import { Fingerprint, Hash, KeyRound } from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { MAX_MASTER_PASSWORD, PIN_ATTEMPTS, type UnlockMethod, type VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { SecretField } from '../ui/Field'
import { useMotionSafe } from '../ui/motion'
import { Padlock } from '../ui/Padlock'
import { Segmented } from '../ui/Segmented'
import { toneColor } from '../ui/tone'
import { PinField } from './PinField'
import { refreshVaultStatus } from './status'

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

const METHOD_TABS = [
  { id: 'touchId', label: 'Touch ID', icon: <Fingerprint aria-hidden className="size-3.5" /> },
  { id: 'pin', label: 'PIN', icon: <Hash aria-hidden className="size-3.5" /> },
  { id: 'password', label: 'Password', icon: <KeyRound aria-hidden className="size-3.5" /> },
] as const

// Only Touch ID: the prompt-less 'login' mode would let anyone at the Mac past the gate. Set up
// is enough for its tab: a Touch ID that is unavailable right now gets a retry, never the erase.
const touchIdSetUp = (status: VaultStatus | null) => status?.quickUnlock === 'touchId'

const TOUCH_ID_UNAVAILABLE = "Touch ID isn't available right now."

/**
 * What still opens the vaults once the PIN is wiped, read from the status the card had: the
 * password, else Touch ID, else nothing. The same order as main's wipe fallback, except that
 * Touch ID counts while it is set up, available or not, as main's resetRequired does.
 */
export function pinWipeFallback(status: VaultStatus | null): 'password' | 'touchId' | 'none' {
  if (status?.hasPassword) return 'password'
  return touchIdSetUp(status) ? 'touchId' : 'none'
}

/** Set up, but nothing left opens the vaults (status.resetRequired, say after a restart). */
const NOTHING_LEFT = 'Your vaults stay locked until you erase them.'

const WIPED_COPY = {
  password: 'Too many wrong PINs. Use your master password.',
  touchId: 'Too many wrong PINs. Use Touch ID.',
  none: 'Too many wrong PINs. Your vaults stay locked until you erase them.',
} as const

/**
 * The method chooser: a tab per method that is set up (Touch ID, PIN, master password), opening on
 * `lastMethod`. Touch ID is tried once on mount when its tab opens first, unless `autoQuick` is
 * false. Mount it fresh for every lock so that try happens again.
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
  const [quickGone, setQuickGone] = useState(false)
  const [pinWiped, setPinWiped] = useState(false)
  // Main's word after a wipe, before the next status poll brings it.
  const [resetAfterWipe, setResetAfterWipe] = useState(false)
  // The fixed line shown on the tab the user is sent to (Touch ID unavailable, PIN wiped).
  const [notice, setNotice] = useState<{ tab: UnlockMethod | 'none'; text: string } | null>(null)

  const has: Record<UnlockMethod, boolean> = {
    touchId: touchIdSetUp(status) && !quickGone,
    pin: !!status?.pin.enabled && !pinWiped,
    password: !!status?.hasPassword,
  }
  const touchIdAvailable = !!status?.quickUnlockAvailable.touchId
  const tabs = METHOD_TABS.filter((t) => has[t.id])
  const [picked, setPicked] = useState<UnlockMethod | null>(() => {
    // Open on a method that works now: Touch ID only while available, unless it is all there is.
    const usable = tabs.filter((t) => t.id !== 'touchId' || touchIdAvailable)
    const last = status?.lastMethod
    if (last && usable.some((t) => t.id === last)) return last
    return (usable[0] ?? tabs[0])?.id ?? null
  })
  // One automatic Touch ID try per mount, and only when its tab is the one the card opened on.
  const autoTouchId = useRef(autoQuick && picked === 'touchId' && touchIdAvailable)
  // Shared by Touch ID and the password: main's throttle covers both.
  const [deadline, setDeadline] = useState(() => (status?.retryAfterMs ? Date.now() + status.retryAfterMs : 0))
  // A tab that went away (Touch ID unavailable, PIN wiped) falls back to the first one left.
  const tab = picked && has[picked] ? picked : (tabs[0]?.id ?? null)

  const select = (next: UnlockMethod) => {
    setPicked(next)
    setNotice(null)
  }
  const sendTo = (next: UnlockMethod | 'none', text: string) => {
    if (next !== 'none') setPicked(next)
    setNotice({ tab: next, text })
  }
  const noticeFor = (t: UnlockMethod) => (notice?.tab === t ? notice.text : null)
  const resetRequired = !!status?.resetRequired || resetAfterWipe
  const panelId = useId()

  const onQuickGone = () => {
    if (has.password || has.pin) setQuickGone(true)
    if (has.password) sendTo('password', "Touch ID isn't available right now. Use your master password.")
    else if (has.pin) sendTo('pin', "Touch ID isn't available right now. Use your PIN.")
    // The only way in: keep the tab to retry, never send a passing failure to the erase screen.
    else sendTo('touchId', TOUCH_ID_UNAVAILABLE)
  }

  const onPinWiped = () => {
    const fallback = pinWipeFallback(status)
    setPinWiped(true)
    // Touch ID set aside as unavailable is the way in again: bring its tab back to retry.
    if (fallback === 'touchId') setQuickGone(false)
    sendTo(fallback, WIPED_COPY[fallback])
    // Only main says the reset is due; ask now rather than wait for the poll.
    if (fallback === 'none') {
      void refreshVaultStatus()
        .then((s) => setResetAfterWipe(s.resetRequired))
        .catch(() => {})
    }
  }

  if (!tab) {
    // Nothing set up opens the vaults any more. The reset is offered only once main says so.
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="text-[12.5px] leading-5 text-err">
          {notice?.text ?? NOTHING_LEFT}
        </p>
        {onForgot && resetRequired && <ForgotLink onClick={onForgot}>Erase vaults</ForgotLink>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {tabs.length > 1 && (
        <Segmented label="Unlock method" options={tabs} value={tab} onChange={select} controls={panelId} />
      )}
      <div id={panelId} className="contents">
        {tab === 'touchId' && (
          <TouchIdTab
            autoPrompt={autoTouchId}
            deadline={deadline}
            onThrottled={setDeadline}
            notice={noticeFor('touchId') ?? (touchIdAvailable ? null : TOUCH_ID_UNAVAILABLE)}
            onUnlocked={onUnlocked}
            onGone={onQuickGone}
          />
        )}
        {tab === 'pin' && (
          <PinTab
            attemptsLeft={status?.pin.attemptsLeft ?? PIN_ATTEMPTS}
            notice={noticeFor('pin')}
            onUnlocked={onUnlocked}
            onWrong={onWrong}
            onWiped={onPinWiped}
          />
        )}
        {tab === 'password' && (
          <PasswordTab
            deadline={deadline}
            onThrottled={setDeadline}
            notice={noticeFor('password')}
            onUnlocked={onUnlocked}
            onWrong={onWrong}
            onForgot={onForgot}
          />
        )}
      </div>
    </div>
  )
}

function ForgotLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mt-1 self-center rounded px-1 text-[12px] text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  )
}

/** One large Touch ID button, retryable; tried once on mount when `autoPrompt` still holds. */
function TouchIdTab({
  autoPrompt,
  deadline,
  onThrottled,
  notice,
  onUnlocked,
  onGone,
}: {
  autoPrompt: { current: boolean }
  deadline: number
  onThrottled: (deadline: number) => void
  notice: string | null
  onUnlocked: () => void
  onGone: () => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const secondsLeft = useSecondsLeft(deadline)

  const tryQuick = async () => {
    setBusy(true)
    try {
      const res = await api.invoke('vault:unlockQuick')
      if (res.ok) return onUnlocked()
      if (res.reason === 'unavailable') return onGone()
      if (res.reason === 'throttled') onThrottled(Date.now() + res.retryAfterMs)
      // 'cancelled': the user closed the prompt; the button is right there to try again.
    } catch {
      return onGone()
    } finally {
      setBusy(false)
    }
    buttonRef.current?.focus()
  }

  useEffect(() => {
    if (!autoPrompt.current) return
    autoPrompt.current = false
    void tryQuick()
  }, [])

  const throttled = secondsLeft > 0
  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <p aria-live="polite" className="text-[12px] leading-4 text-muted">
          {notice}
        </p>
      )}
      <Button
        ref={buttonRef}
        autoFocus
        loading={busy}
        disabled={throttled}
        icon={<Fingerprint aria-hidden className="size-4" />}
        onClick={() => void tryQuick()}
        className="h-11 w-full tabular-nums"
      >
        {throttled ? `Try again in ${secondsLeft} s` : 'Unlock with Touch ID'}
      </Button>
    </div>
  )
}

/** The PIN, sent on Enter (main doesn't say how long it is). Misses count down to the wipe. */
function PinTab({
  attemptsLeft,
  notice,
  onUnlocked,
  onWrong,
  onWiped,
}: {
  attemptsLeft: number
  notice: string | null
  onUnlocked: () => void
  onWrong: () => void
  onWiped: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Counted here as well, so the line is right before the next status poll brings main's count.
  const [misses, setMisses] = useState(0)
  const left = Math.min(attemptsLeft, PIN_ATTEMPTS - misses)

  const submit = async (pin: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.invoke('vault:unlockPin', pin)
      if (res.ok) return onUnlocked()
      if (res.reason === 'pin-wiped') return onWiped()
      if (res.reason === 'wrong-pin') {
        setError('Wrong PIN')
        setMisses((n) => n + 1)
        onWrong()
      } else if (res.reason === 'unavailable') {
        setError("The PIN isn't available right now.")
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col gap-2">
      <PinField
        ref={inputRef}
        autoFocus
        disabled={busy}
        onComplete={(pin) => void submit(pin)}
        error={error ?? undefined}
        hint={notice ?? undefined}
      />
      {left < PIN_ATTEMPTS && (
        <p aria-live="polite" className="text-[12px] leading-4 text-warn tabular-nums">
          {left === 1 ? '1 try left' : `${left} tries left`}
        </p>
      )}
    </div>
  )
}

/** Today's master-password form, with the throttle countdown and "Forgot password?". */
function PasswordTab({
  deadline,
  onThrottled,
  notice,
  onUnlocked,
  onWrong,
  onForgot,
}: {
  deadline: number
  onThrottled: (deadline: number) => void
  notice: string | null
  onUnlocked: () => void
  onWrong: () => void
  onForgot?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // The password stays in the input until submit; state only knows whether it is empty.
  const [hasInput, setHasInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState(notice)
  const secondsLeft = useSecondsLeft(deadline)

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
      if (res.retryAfterMs > 0) onThrottled(Date.now() + res.retryAfterMs)
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
      {onForgot && <ForgotLink onClick={onForgot}>Forgot password?</ForgotLink>}
    </form>
  )
}
