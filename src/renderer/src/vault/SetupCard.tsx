import { motion } from 'framer-motion'
import { ChevronDown, Fingerprint } from 'lucide-react'
import { useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react'
import {
  MAX_MASTER_PASSWORD,
  MAX_PIN,
  MIN_MASTER_PASSWORD,
  MIN_PIN,
  PIN_ATTEMPTS,
  type SetupOptions,
  type VaultStatus,
} from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { SecretField } from '../ui/Field'
import { spring, staggerDelay, useMotionSafe } from '../ui/motion'
import { Switch } from '../ui/Switch'
import { toneColor } from '../ui/tone'
import { PinField } from './PinField'
import { useVaultStatus, vaultStatusStore } from './status'
import { passwordStrength, type Strength } from './strength'

const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const
const strengthTone = (s: Strength) => (s <= 1 ? toneColor.error : s === 2 ? toneColor.warn : toneColor.success)

/** Four segments that fill with a spring, tinted err → warn → ok. */
export function StrengthMeter({ strength, active }: { strength: Strength; active: boolean }) {
  const motionSafe = useMotionSafe()
  return (
    <div className="flex items-center gap-3" style={{ '--tone': strengthTone(strength) } as CSSProperties}>
      <div
        role="meter"
        aria-label="Password strength"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={strength}
        aria-valuetext={STRENGTH_LABELS[strength]}
        className="flex flex-1 gap-1"
      >
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-line">
            <motion.span
              className="block h-full origin-left rounded-full bg-(--tone)"
              initial={false}
              animate={{ scaleX: i < strength ? 1 : 0 }}
              transition={motionSafe ? { ...spring, delay: staggerDelay(i) } : { duration: 0 }}
            />
          </span>
        ))}
      </div>
      <span className="w-16 text-right text-[11.5px] font-medium text-(--tone) tabular-nums">
        {active ? STRENGTH_LABELS[strength] : ''}
      </span>
    </div>
  )
}

interface Measure {
  len: number
  strength: Strength
  confirmLen: number
  match: boolean
}
const EMPTY: Measure = { len: 0, strength: 0, confirmLen: 0, match: true }

/** Lengths and a match flag for a secret and its confirm field; never the values. */
function measureOf(a: RefObject<HTMLInputElement | null>, b: RefObject<HTMLInputElement | null>): Measure {
  const x = a.current?.value ?? ''
  const y = b.current?.value ?? ''
  return { len: x.length, strength: passwordStrength(x), confirmLen: y.length, match: x === y }
}

/** Empties every field given, so no secret outlives the submit. */
function clearFields(...refs: RefObject<HTMLInputElement | null>[]) {
  for (const r of refs) if (r.current) r.current.value = ''
}

/** Sends vault:setup and publishes the result; the error text is main's fixed message. */
function useSetup(onDone?: (status: VaultStatus) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (opts: SetupOptions): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const status = await api.invoke('vault:setup', opts)
      // onDone runs first so the gate can hold its success step before the status opens it.
      onDone?.(status)
      vaultStatusStore.set(status)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

/**
 * First run. With the Keychain, Touch ID or a PIN is mandatory and the master password optional
 * (spec, product-owner answers); without it, neither can exist, so the master password is required.
 */
export function SetupCard({ onDone }: { onDone?: (status: VaultStatus) => void }) {
  const status = useVaultStatus()
  if (!status) return null
  const { touchId, login } = status.quickUnlockAvailable
  return touchId || login ? <FactorSetup touchIdAvailable={touchId} onDone={onDone} /> : <PasswordSetup onDone={onDone} />
}

/**
 * Touch ID (on by default where it works), a PIN (required when Touch ID is off), and an optional
 * master password behind a disclosure. Secrets stay in the inputs until submit, then are cleared.
 */
function FactorSetup({ touchIdAvailable, onDone }: { touchIdAvailable: boolean; onDone?: (status: VaultStatus) => void }) {
  const pinRef = useRef<HTMLInputElement>(null)
  const pinConfirmRef = useRef<HTMLInputElement>(null)
  const pwRef = useRef<HTMLInputElement>(null)
  const pwConfirmRef = useRef<HTMLInputElement>(null)
  const [touchIdChoice, setTouchIdChoice] = useState(true)
  const [pin, setPin] = useState<Measure>(EMPTY)
  const [pw, setPw] = useState<Measure>(EMPTY)
  const [pwOpen, setPwOpen] = useState(false)
  const { busy, error, setError, run } = useSetup(onDone)

  const touchId = touchIdAvailable && touchIdChoice
  const measurePin = () => {
    setPin(measureOf(pinRef, pinConfirmRef))
    setError(null)
  }
  const measurePw = () => {
    setPw(measureOf(pwRef, pwConfirmRef))
    setError(null)
  }

  const pinEntered = pin.len > 0 || pin.confirmLen > 0
  const pinValid = pin.len >= MIN_PIN && pin.len <= MAX_PIN && pin.confirmLen > 0 && pin.match
  const pinMismatch = pin.confirmLen > 0 && !pin.match
  const hasPassword = pwOpen && pw.len > 0
  const pwEntered = pwOpen && (pw.len > 0 || pw.confirmLen > 0)
  const pwValid = pw.len >= MIN_MASTER_PASSWORD && pw.confirmLen > 0 && pw.match
  // Touch ID or a valid PIN; a half-typed PIN or password holds Continue back either way.
  const valid = (touchId || pinValid) && (!pinEntered || pinValid) && (!pwEntered || pwValid)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    const opts: SetupOptions = {
      touchId,
      pin: pinEntered ? pinRef.current?.value : undefined,
      password: pwEntered ? pwRef.current?.value : undefined,
    }
    clearFields(pinRef, pinConfirmRef, pwRef, pwConfirmRef)
    setPin(EMPTY)
    setPw(EMPTY)
    if (!(await run(opts))) pinRef.current?.focus()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {touchIdAvailable && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface/60 px-3 py-2.5">
          <Fingerprint aria-hidden className="size-4 shrink-0 text-accent" />
          <div className="flex-1">
            <p className="text-[13px] font-medium text-fg">Touch ID</p>
            <p className="text-[12px] leading-4 text-muted">Unlock with your fingerprint</p>
          </div>
          <Switch checked={touchIdChoice} onChange={setTouchIdChoice} label="Touch ID" disabled={busy} />
        </div>
      )}
      <PinField
        ref={pinRef}
        autoFocus={!touchIdAvailable}
        onDigits={measurePin}
        hint={touchId ? `Optional · ${MIN_PIN}-${MAX_PIN} digits` : `${MIN_PIN}-${MAX_PIN} digits`}
      />
      <PinField
        ref={pinConfirmRef}
        label="Confirm PIN"
        onDigits={measurePin}
        error={pinMismatch ? "PINs don't match" : undefined}
      />
      {!touchId && !hasPassword && (
        <p className="text-[12px] leading-4 text-warn">
          After {PIN_ATTEMPTS} wrong PINs your vaults stay locked until you erase them.
        </p>
      )}
      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          aria-expanded={pwOpen}
          onClick={() => setPwOpen((o) => !o)}
          className="flex items-center gap-1.5 self-start rounded px-1 text-[12.5px] font-medium text-fg/90 transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ChevronDown aria-hidden className={`size-3.5 transition-transform ${pwOpen ? '' : '-rotate-90'}`} />
          Add a master password (recommended for recovery)
        </button>
        {pwOpen && (
          <>
            <SecretField
              ref={pwRef}
              label="Master password"
              autoFocus
              maxLength={MAX_MASTER_PASSWORD}
              onInput={measurePw}
              error={pw.len > 0 && pw.len < MIN_MASTER_PASSWORD ? `At least ${MIN_MASTER_PASSWORD} characters` : undefined}
              hint={`At least ${MIN_MASTER_PASSWORD} characters`}
            />
            <StrengthMeter strength={pw.strength} active={pw.len > 0} />
            <SecretField
              ref={pwConfirmRef}
              label="Confirm password"
              maxLength={MAX_MASTER_PASSWORD}
              onInput={measurePw}
              error={pw.confirmLen > 0 && !pw.match ? "Passwords don't match" : undefined}
            />
          </>
        )}
        {!hasPassword && (
          <p className="text-[12px] leading-4 text-muted">
            Without a master password, your secrets can't be recovered if this Mac's Keychain is lost. The only way back
            is to erase them.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[12px] leading-4 text-err">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!valid} loading={busy} className="mt-1 w-full">
        Continue
      </Button>
    </form>
  )
}

/** Without the Keychain: choose and confirm the master password, as before Touch ID and PIN. */
function PasswordSetup({ onDone }: { onDone?: (status: VaultStatus) => void }) {
  const pwRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const [m, setM] = useState<Measure>(EMPTY)
  const { busy, error, run } = useSetup(onDone)

  const measure = () => setM(measureOf(pwRef, confirmRef))

  const short = m.len > 0 && m.len < MIN_MASTER_PASSWORD
  const mismatch = m.confirmLen > 0 && !m.match
  const valid = m.len >= MIN_MASTER_PASSWORD && m.confirmLen > 0 && m.match

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy || !pwRef.current || !confirmRef.current) return
    const password = pwRef.current.value
    clearFields(pwRef, confirmRef)
    setM(EMPTY)
    if (!(await run({ password }))) pwRef.current?.focus()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2.5">
        <SecretField
          ref={pwRef}
          label="Master password"
          autoFocus
          maxLength={MAX_MASTER_PASSWORD}
          onInput={measure}
          error={short ? `At least ${MIN_MASTER_PASSWORD} characters` : (error ?? undefined)}
          hint={`At least ${MIN_MASTER_PASSWORD} characters`}
        />
        <StrengthMeter strength={m.strength} active={m.len > 0} />
      </div>
      <SecretField
        ref={confirmRef}
        label="Confirm password"
        maxLength={MAX_MASTER_PASSWORD}
        onInput={measure}
        error={mismatch ? "Passwords don't match" : undefined}
      />
      <Button type="submit" disabled={!valid} loading={busy} className="mt-1 w-full">
        Create master password
      </Button>
    </form>
  )
}
