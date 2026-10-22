import { useRef, useState, type FormEvent } from 'react'
import {
  MAX_MASTER_PASSWORD,
  MAX_PIN,
  MIN_MASTER_PASSWORD,
  MIN_PIN,
  PIN_ATTEMPTS,
  type VaultStatus,
} from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SecretField } from '../ui/Field'
import { toast } from '../ui/Toaster'
import { PinField } from './PinField'
import { PIN_LENGTH, PIN_SHAPE, ReverifyDialog } from './ReverifyDialog'
import { StrengthMeter } from './SetupCard'
import { refreshVaultStatus } from './status'
import { passwordStrength, type Strength } from './strength'
import { withUnlock } from './unlock'
import { useSecondsLeft } from './UnlockCard'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const PIN_ONLY_WARNING = `After ${PIN_ATTEMPTS} wrong PINs your vaults stay locked until you erase them.`

interface PanelProps {
  open: boolean
  status: VaultStatus | null
  onClose: () => void
}

export function TouchIdDialog({ open, status, onClose }: PanelProps) {
  return (
    <ReverifyDialog
      open={open}
      status={status}
      title="Turn on Touch ID"
      submitLabel="Turn on Touch ID"
      onProof={(proof) => api.invoke('vault:setQuickUnlock', 'touchId', proof)}
      onProven={() => toast({ title: 'Touch ID enabled', tone: 'success' })}
      onClose={onClose}
    />
  )
}

export function ChangeAccountDialog({ open, status, onClose }: PanelProps) {
  return (
    <ReverifyDialog
      open={open}
      status={status}
      title="Change Microsoft account"
      description="Confirm it is you, then sign in with the account to use from now on."
      submitLabel="Continue"
      onProof={(proof) => api.invoke('auth:changeAccount', proof)}
      onProven={() => toast({ title: 'Microsoft account changed', tone: 'success' })}
      onClose={onClose}
    />
  )
}

interface PinMeasure {
  digits: number
  confirmDigits: number
  match: boolean
}
const NO_PIN: PinMeasure = { digits: 0, confirmDigits: 0, match: false }

export function SetPinDialog({ open, status, onClose }: PanelProps) {
  const pinRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const [m, setM] = useState<PinMeasure>(NO_PIN)
  const measure = () => {
    const pin = pinRef.current?.value ?? ''
    const confirm = confirmRef.current?.value ?? ''
    setM({ digits: pin.length, confirmDigits: confirm.length, match: pin === confirm })
  }
  const lockout = !!status && !status.hasPassword && status.quickUnlock !== 'touchId'
  const short = m.digits > 0 && m.digits < MIN_PIN
  const mismatch = m.confirmDigits > 0 && !m.match
  const done = () => {
    setM(NO_PIN)
    onClose()
  }
  return (
    <ReverifyDialog
      open={open}
      status={status}
      title={status?.pin.enabled ? 'Change PIN' : 'Set a PIN'}
      description={`${MIN_PIN} to ${MAX_PIN} digits.`}
      submitLabel={status?.pin.enabled ? 'Change PIN' : 'Set PIN'}
      ready={m.digits >= MIN_PIN && m.digits <= MAX_PIN && m.confirmDigits > 0 && m.match}
      onProof={(proof) => {
        const pin = pinRef.current?.value ?? ''
        if (!PIN_SHAPE.test(pin) || pin !== confirmRef.current?.value) return Promise.reject(new Error(PIN_LENGTH))
        if (pinRef.current) pinRef.current.value = ''
        if (confirmRef.current) confirmRef.current.value = ''
        setM(NO_PIN)
        return api.invoke('vault:setPin', pin, proof)
      }}
      onProven={() => toast({ title: 'PIN saved', tone: 'success' })}
      onClose={done}
    >
      <PinField ref={pinRef} label="New PIN" autoFocus onDigits={measure} error={short ? PIN_LENGTH : undefined} />
      <PinField ref={confirmRef} label="Confirm new PIN" onDigits={measure} error={mismatch ? "PINs don't match" : undefined} />
      {lockout && <p className="text-[12px] leading-4 text-warn">{PIN_ONLY_WARNING}</p>}
    </ReverifyDialog>
  )
}

interface PasswordMeasure {
  len: number
  strength: Strength
  confirmLen: number
  match: boolean
}
const NO_PASSWORD: PasswordMeasure = { len: 0, strength: 0, confirmLen: 0, match: false }

export function AddPasswordDialog({ open, status, onClose }: PanelProps) {
  const nextRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const [m, setM] = useState<PasswordMeasure>(NO_PASSWORD)
  const measure = () => {
    const next = nextRef.current?.value ?? ''
    const confirm = confirmRef.current?.value ?? ''
    setM({ len: next.length, strength: passwordStrength(next), confirmLen: confirm.length, match: next === confirm })
  }
  const done = () => {
    setM(NO_PASSWORD)
    onClose()
  }
  return (
    <ReverifyDialog
      open={open}
      status={status}
      title="Add a master password"
      description="It recovers your vaults if this Mac's Keychain is lost."
      submitLabel="Add password"
      ready={m.len >= MIN_MASTER_PASSWORD && m.confirmLen > 0 && m.match}
      onProof={(proof) => {
        const next = nextRef.current?.value ?? ''
        if (next.length < MIN_MASTER_PASSWORD || next !== confirmRef.current?.value) {
          return Promise.reject(new Error(`At least ${MIN_MASTER_PASSWORD} characters, and both must match`))
        }
        if (nextRef.current) nextRef.current.value = ''
        if (confirmRef.current) confirmRef.current.value = ''
        setM(NO_PASSWORD)
        return api.invoke('vault:setPassword', next, proof)
      }}
      onProven={() => toast({ title: 'Master password added', tone: 'success' })}
      onClose={done}
    >
      <div className="flex flex-col gap-2.5">
        <SecretField
          ref={nextRef}
          label="New password"
          autoFocus
          maxLength={MAX_MASTER_PASSWORD}
          onInput={measure}
          error={m.len > 0 && m.len < MIN_MASTER_PASSWORD ? `At least ${MIN_MASTER_PASSWORD} characters` : undefined}
        />
        <StrengthMeter strength={m.strength} active={m.len > 0} />
      </div>
      <SecretField
        ref={confirmRef}
        label="Confirm new password"
        maxLength={MAX_MASTER_PASSWORD}
        onInput={measure}
        error={m.confirmLen > 0 && !m.match ? "Passwords don't match" : undefined}
      />
    </ReverifyDialog>
  )
}

export function RemovePasswordDialog({ open, status, onClose }: PanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [hasInput, setHasInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deadline, setDeadline] = useState(0)
  const [shake, setShake] = useState(0)
  const secondsLeft = useSecondsLeft(deadline)
  const throttled = secondsLeft > 0
  const pinOnly = !!status?.pin.enabled && status.quickUnlock !== 'touchId'

  const close = () => {
    setHasInput(false)
    setError(null)
    onClose()
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const input = inputRef.current
    if (!input || !input.value || busy || throttled) return
    const current = input.value
    input.value = ''
    setHasInput(false)
    setBusy(true)
    setError(null)
    try {
      const res = await withUnlock(() => api.invoke('vault:removePassword', current))
      if (!res) return
      if (res.ok) {
        await refreshVaultStatus().catch(() => undefined)
        toast({ title: 'Master password removed', tone: 'success' })
        return close()
      }
      if (res.reason === 'wrong-password') {
        setError('Wrong password')
        setShake((n) => n + 1)
      } else {
        setError("Couldn't remove the master password")
      }
      if (res.retryAfterMs > 0) setDeadline(Date.now() + res.retryAfterMs)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Remove master password"
      description="Your vaults will open only with the methods that remain."
      shake={shake}
      width={420}
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
        <SecretField
          ref={inputRef}
          label="Master password"
          autoFocus
          readOnly={busy}
          maxLength={MAX_MASTER_PASSWORD}
          onInput={(e) => setHasInput(e.currentTarget.value.length > 0)}
          error={error ?? undefined}
        />
        {pinOnly && <p className="text-[12px] leading-4 text-warn">{PIN_ONLY_WARNING}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!hasInput || throttled} className="tabular-nums">
            {throttled ? `Try again in ${secondsLeft} s` : 'Remove password'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
