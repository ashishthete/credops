import { motion } from 'framer-motion'
import { useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { MAX_MASTER_PASSWORD, MIN_MASTER_PASSWORD, type VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { SecretField } from '../ui/Field'
import { spring, staggerDelay, useMotionSafe } from '../ui/motion'
import { toneColor } from '../ui/tone'
import { vaultStatusStore } from './status'
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

/**
 * First-run form: choose and confirm the master password. Only lengths and a match flag live in
 * state; the password itself is read from the input at submit and the fields are cleared.
 */
export function SetupCard({ onDone }: { onDone?: (status: VaultStatus) => void }) {
  const pwRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const [m, setM] = useState<Measure>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const measure = () => {
    const a = pwRef.current?.value ?? ''
    const b = confirmRef.current?.value ?? ''
    setM({ len: a.length, strength: passwordStrength(a), confirmLen: b.length, match: a === b })
  }

  const short = m.len > 0 && m.len < MIN_MASTER_PASSWORD
  const mismatch = m.confirmLen > 0 && !m.match
  const valid = m.len >= MIN_MASTER_PASSWORD && m.confirmLen > 0 && m.match

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy || !pwRef.current || !confirmRef.current) return
    const password = pwRef.current.value
    pwRef.current.value = ''
    confirmRef.current.value = ''
    setM(EMPTY)
    setBusy(true)
    setError(null)
    try {
      const status = await api.invoke('vault:setup', password)
      // onDone runs first so the gate can hold its success step before the status opens it.
      onDone?.(status)
      vaultStatusStore.set(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      pwRef.current?.focus()
    } finally {
      setBusy(false)
    }
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
          error={short ? 'At least 10 characters' : (error ?? undefined)}
          hint="At least 10 characters"
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
