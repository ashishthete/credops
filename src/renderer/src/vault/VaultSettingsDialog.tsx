import { useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { ReverifyProof } from '../../../shared/sso'
import {
  AUTO_LOCK_CHOICES,
  MAX_MASTER_PASSWORD,
  MAX_PIN,
  MIN_MASTER_PASSWORD,
  MIN_PIN,
  PIN_ATTEMPTS,
  PIN_INPUT_MAX,
  VERIFICATION_FAILED,
  type ProvenResult,
  type QuickUnlockMode,
  type VaultStatus,
} from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SecretField, SelectField } from '../ui/Field'
import { toast } from '../ui/Toaster'
import { signOutAccount } from './account'
import { PinField } from './PinField'
import { StrengthMeter } from './SetupCard'
import { refreshVaultStatus, useVaultStatus, vaultStatusStore } from './status'
import { passwordStrength, type Strength } from './strength'
import { withUnlock } from './unlock'
import { useSecondsLeft } from './UnlockCard'

type Listener = () => void
let open = false
const listeners = new Set<Listener>()
const openStore = {
  get: () => open,
  subscribe(l: Listener) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
}
function setOpen(next: boolean) {
  if (next === open) return
  open = next
  listeners.forEach((l) => l())
}
export const openVaultSettings = () => setOpen(true)
export const closeVaultSettings = () => setOpen(false)

const MODE_LABELS: Record<QuickUnlockMode, string> = { off: 'Off', touchId: 'Touch ID', login: 'Login keychain' }
const MODE_HINTS: Record<QuickUnlockMode, string> = {
  off: 'Your master password is asked for every unlock.',
  touchId: 'A fingerprint opens your vaults; the password still works.',
  login: 'Your Mac login opens your vaults without a prompt.',
}

function autoLockLabel(m: number | null): string {
  if (m === null) return 'Never'
  if (m === 60) return 'After 1 hour'
  return `After ${m} minute${m === 1 ? '' : 's'}`
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function fail(title: string, err: unknown) {
  toast({ title, description: errorText(err), tone: 'error' })
}

/** Unlock methods, auto-lock and the Microsoft account. Opened from the palette or the sidebar. */
export function VaultSettingsDialog() {
  const isOpen = useSyncExternalStore(openStore.subscribe, openStore.get)
  const status = useVaultStatus()
  const [shake, setShake] = useState(0)
  return (
    <Dialog
      open={isOpen}
      onClose={closeVaultSettings}
      title="Vault settings"
      description="How your vaults unlock, when they lock again, and your account."
      shake={shake}
      width={460}
    >
      <SettingsBody status={status} onWrong={() => setShake((n) => n + 1)} />
    </Dialog>
  )
}

type ProofMethod = 'password' | 'pin' | 'touchId'

const PIN_SHAPE = new RegExp(`^\\d{${MIN_PIN},${MAX_PIN}}$`)
const PIN_LENGTH = `PIN must be ${MIN_PIN}-${MAX_PIN} digits`
const PIN_ONLY_WARNING = `After ${PIN_ATTEMPTS} wrong PINs your vaults stay locked until you erase them.`
const LAST_FACTOR = 'Add Touch ID or a PIN first'

/** The ways this vault can re-prove the user, in the order they are offered. */
function proofMethods(status: VaultStatus): ProofMethod[] {
  const methods: ProofMethod[] = []
  if (status.hasPassword) methods.push('password')
  if (status.pin.enabled) methods.push('pin')
  if (status.quickUnlock === 'touchId' && status.quickUnlockAvailable.touchId) methods.push('touchId')
  return methods
}

const METHOD_SWITCH: Record<ProofMethod, string> = {
  password: 'Use your master password instead',
  pin: 'Use your PIN instead',
  touchId: 'Use Touch ID instead',
}

/** Wrong password or PIN: the cue every dialog here shares. */
const isWrongProof = (err: unknown) => err instanceof Error && err.message === VERIFICATION_FAILED

export interface ReverifyDialogProps {
  open: boolean
  status: VaultStatus | null
  title: string
  description?: string
  submitLabel?: string
  /** Fields for the change itself (a new PIN or password), shown above the proof. */
  children?: ReactNode
  /** False while `children` are incomplete; the submit button stays off. */
  ready?: boolean
  /**
   * Runs the change with the proof. Rejecting with VERIFICATION_FAILED means the proof missed; the
   * dialog reports it. The proof is never kept: its input is emptied before this is called.
   */
  onProof: (proof: ReverifyProof) => Promise<ProvenResult>
  /** After a proven change, before the dialog closes. */
  onProven?: () => void
  onClose: () => void
}

/**
 * Asks for any method that is set up (master password, PIN, Touch ID) and hands the proof to
 * `onProof`. Turning on a way in, or moving the Microsoft account, needs one (the T7 contract).
 */
export function ReverifyDialog(props: ReverifyDialogProps) {
  const [shake, setShake] = useState(0)
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description ?? 'Confirm it is you first.'}
      shake={shake}
      width={420}
    >
      {props.status && <ProofForm {...props} status={props.status} onWrong={() => setShake((n) => n + 1)} />}
    </Dialog>
  )
}

function ProofForm({
  status,
  submitLabel = 'Continue',
  children,
  ready = true,
  onProof,
  onProven,
  onClose,
  onWrong,
}: ReverifyDialogProps & { status: VaultStatus; onWrong: () => void }) {
  const methods = proofMethods(status)
  const [method, setMethod] = useState<ProofMethod | null>(() =>
    status.lastMethod === 'pin' && status.pin.enabled ? 'pin' : (methods[0] ?? null),
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const [hasInput, setHasInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const others = methods.filter((m) => m !== method)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !ready || !method) return
    let proof: ReverifyProof
    if (method === 'touchId') {
      proof = { method }
    } else {
      const input = inputRef.current
      if (!input || !input.value) return
      // A malformed PIN never goes to main, where it would cost one of the tries.
      if (method === 'pin' && !PIN_SHAPE.test(input.value)) return setError(PIN_LENGTH)
      proof = method === 'pin' ? { method, pin: input.value } : { method, password: input.value }
      input.value = ''
      setHasInput(false)
    }
    setBusy(true)
    setError(null)
    try {
      const res = await onProof(proof)
      vaultStatusStore.set(res.status)
      if (res.ok) {
        onProven?.()
        return onClose()
      }
      // pin-wiped: the PIN is gone. Locked means the gate takes over; otherwise offer what remains.
      toast({
        title: 'Too many wrong PINs',
        description: res.status.unlocked ? 'Your PIN was turned off.' : 'Your vaults locked. Unlock another way, or erase them.',
        tone: 'error',
      })
      if (!res.status.unlocked || !res.status.hasPassword) return onClose()
      setMethod('password')
    } catch (err) {
      if (isWrongProof(err)) {
        onWrong()
        if (method === 'pin') {
          // The rejection carries no count: read it from a fresh status, so a wipe never comes unwarned.
          const left = await refreshVaultStatus()
            .then((fresh) => (fresh.pin.enabled ? fresh.pin.attemptsLeft : null))
            .catch(() => null)
          setError(left === null ? 'Wrong PIN' : `Wrong PIN · ${left} ${left === 1 ? 'try' : 'tries'} left`)
        } else {
          setError(method === 'touchId' ? 'Touch ID did not confirm it is you' : 'Wrong password')
        }
      } else {
        setError(errorText(err))
      }
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
      {children}
      {method && method !== 'touchId' && (
        <SecretField
          key={method}
          ref={inputRef}
          label={method === 'pin' ? 'Your PIN' : 'Your master password'}
          autoFocus={!children}
          readOnly={busy}
          inputMode={method === 'pin' ? 'numeric' : undefined}
          maxLength={method === 'pin' ? PIN_INPUT_MAX : MAX_MASTER_PASSWORD}
          onInput={(e) => setHasInput(e.currentTarget.value.length > 0)}
          error={error ?? undefined}
        />
      )}
      {method === 'touchId' && (
        <p role={error ? 'alert' : undefined} className={`text-[13px] ${error ? 'text-err' : 'text-muted'}`}>
          {error ?? 'Touch ID will ask you to confirm.'}
        </p>
      )}
      {others.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => {
            setMethod(m)
            setError(null)
            setHasInput(false)
          }}
          disabled={busy}
          className="-mt-1 self-start rounded px-1 text-[12px] text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          {METHOD_SWITCH[m]}
        </button>
      ))}
      {!method && <p className="text-[13px] text-err">No unlock method is set up to confirm with.</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!ready || !method || (method !== 'touchId' && !hasInput)}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

type Panel = 'touchId' | 'pin' | 'password' | 'removePassword' | 'account'

function SettingsBody({ status, onWrong }: { status: VaultStatus | null; onWrong: () => void }) {
  const [saving, setSaving] = useState(false)
  const [panel, setPanel] = useState<Panel | null>(null)
  const close = () => setPanel(null)
  const modes = status
    ? (Object.keys(MODE_LABELS) as QuickUnlockMode[]).filter(
        // 'login' opens without any prompt, which would defeat the app's auth gate: never offered,
        // only shown if it is somehow already the current mode.
        (m) => m === 'off' || m === status.quickUnlock || (m === 'touchId' && status.quickUnlockAvailable.touchId),
      )
    : []
  // Never remove the last way in; main refuses too.
  const factors = status ? Number(status.quickUnlock === 'touchId') + Number(status.pin.enabled) + Number(status.hasPassword) : 0
  const canRemove = factors > 1

  const setQuick = async (mode: QuickUnlockMode) => {
    // Turning a way in on needs a proof; turning it off does not.
    if (mode === 'touchId') return setPanel('touchId')
    setSaving(true)
    try {
      const next = await withUnlock(() => api.invoke('vault:setQuickUnlock', mode))
      if (next) {
        vaultStatusStore.set(next.status)
        toast({ title: mode === 'off' ? 'Quick unlock turned off' : `${MODE_LABELS[mode]} enabled`, tone: 'success' })
      }
    } catch (err) {
      fail("Couldn't change quick unlock", err)
    } finally {
      setSaving(false)
    }
  }

  const setAutoLock = async (minutes: number | null) => {
    try {
      vaultStatusStore.set(await api.invoke('vault:setAutoLock', minutes))
    } catch (err) {
      fail("Couldn't change auto-lock", err)
    }
  }

  const clearPin = async () => {
    try {
      const next = await withUnlock(() => api.invoke('vault:clearPin'))
      if (next) vaultStatusStore.set(next)
      toast({ title: 'PIN removed', tone: 'success' })
    } catch (err) {
      fail("Couldn't remove the PIN", err)
    }
  }

  const pinOnly = !!status?.pin.enabled && !status.hasPassword && status.quickUnlock !== 'touchId'
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Unlock methods" className="flex flex-col gap-3">
        <h3 className="text-[13px] font-semibold text-fg">Unlock methods</h3>
        <div className="grid grid-cols-2 gap-3">
          <div title={status?.quickUnlock === 'touchId' && !canRemove ? LAST_FACTOR : undefined}>
            <SelectField
              label="Quick unlock"
              disabled={!status || saving}
              value={status?.quickUnlock ?? 'off'}
              onChange={(e) => void setQuick(e.target.value as QuickUnlockMode)}
            >
              {modes.map((m) => (
                <option key={m} value={m} disabled={m === 'off' && status?.quickUnlock === 'touchId' && !canRemove}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </SelectField>
          </div>
          <SelectField
            label="Auto-lock"
            disabled={!status}
            value={String(status?.autoLockMinutes ?? 'never')}
            onChange={(e) => void setAutoLock(e.target.value === 'never' ? null : Number(e.target.value))}
          >
            {AUTO_LOCK_CHOICES.map((m) => (
              <option key={String(m)} value={String(m ?? 'never')}>
                {autoLockLabel(m)}
              </option>
            ))}
          </SelectField>
        </div>
        {status && <p className="-mt-1 text-[12px] leading-4 text-muted">{MODE_HINTS[status.quickUnlock]}</p>}
        {status && (
          <>
            <MethodRow label="PIN" detail={status.pin.enabled ? 'On' : 'Off'}>
              <Button variant="ghost" size="sm" onClick={() => setPanel('pin')}>
                {status.pin.enabled ? 'Change PIN' : 'Set PIN'}
              </Button>
              {status.pin.enabled && (
                <span title={canRemove ? undefined : LAST_FACTOR}>
                  <Button variant="ghost" size="sm" disabled={!canRemove} onClick={() => void clearPin()}>
                    Remove PIN
                  </Button>
                </span>
              )}
            </MethodRow>
            {pinOnly && <p className="-mt-1 text-[12px] leading-4 text-warn">{PIN_ONLY_WARNING}</p>}
            <MethodRow label="Master password" detail={status.hasPassword ? 'On' : 'Off'}>
              {status.hasPassword ? (
                <span title={canRemove ? undefined : LAST_FACTOR}>
                  <Button variant="ghost" size="sm" disabled={!canRemove} onClick={() => setPanel('removePassword')}>
                    Remove master password
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setPanel('password')}>
                  Add master password
                </Button>
              )}
            </MethodRow>
          </>
        )}
      </section>
      {status?.hasPassword !== false && (
        <>
          <div className="h-px bg-line" />
          <ChangePasswordForm onWrong={onWrong} />
        </>
      )}
      {status?.sso.required && (
        <>
          <div className="h-px bg-line" />
          <section aria-label="Account" className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold text-fg">Account</h3>
            <p className="text-[13px] text-muted">
              {status.sso.upn ? `Signed in as ${status.sso.upn}` : 'Not signed in'}
              {status.sso.hubName ? ` · ${status.sso.hubName}` : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPanel('account')}>
                Change Microsoft account
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void signOutAccount()}>
                Sign out
              </Button>
            </div>
          </section>
        </>
      )}
      <TouchIdDialog open={panel === 'touchId'} status={status} onClose={close} />
      <SetPinDialog open={panel === 'pin'} status={status} onClose={close} />
      <AddPasswordDialog open={panel === 'password'} status={status} onClose={close} />
      <RemovePasswordDialog open={panel === 'removePassword'} status={status} onClose={close} />
      <ChangeAccountDialog open={panel === 'account'} status={status} onClose={close} />
    </div>
  )
}

function MethodRow({ label, detail, children }: { label: string; detail: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[13px] text-fg">
        {label} <span className="text-muted">· {detail}</span>
      </p>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  )
}

interface PanelProps {
  open: boolean
  status: VaultStatus | null
  onClose: () => void
}

function TouchIdDialog({ open, status, onClose }: PanelProps) {
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

function ChangeAccountDialog({ open, status, onClose }: PanelProps) {
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

function SetPinDialog({ open, status, onClose }: PanelProps) {
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

function AddPasswordDialog({ open, status, onClose }: PanelProps) {
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

function RemovePasswordDialog({ open, status, onClose }: PanelProps) {
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

interface Measure {
  nextLen: number
  strength: Strength
  confirmLen: number
  match: boolean
  currentLen: number
}
const EMPTY: Measure = { nextLen: 0, strength: 0, confirmLen: 0, match: true, currentLen: 0 }

function ChangePasswordForm({ onWrong }: { onWrong: () => void }) {
  const currentRef = useRef<HTMLInputElement>(null)
  const nextRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const [m, setM] = useState<Measure>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deadline, setDeadline] = useState(0)
  const secondsLeft = useSecondsLeft(deadline)

  const measure = () => {
    const next = nextRef.current?.value ?? ''
    const confirm = confirmRef.current?.value ?? ''
    setM({
      currentLen: currentRef.current?.value.length ?? 0,
      nextLen: next.length,
      strength: passwordStrength(next),
      confirmLen: confirm.length,
      match: next === confirm,
    })
  }

  const short = m.nextLen > 0 && m.nextLen < MIN_MASTER_PASSWORD
  const mismatch = m.confirmLen > 0 && !m.match
  const valid = m.currentLen > 0 && m.nextLen >= MIN_MASTER_PASSWORD && m.confirmLen > 0 && m.match
  const throttled = secondsLeft > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const fields = [currentRef.current, nextRef.current, confirmRef.current]
    if (!valid || busy || throttled || fields.some((f) => !f)) return
    const [current, next] = fields.map((f) => f!.value)
    fields.forEach((f) => (f!.value = ''))
    setM(EMPTY)
    setBusy(true)
    setError(null)
    try {
      // This closure holds both passwords until the retry (or a dismissed gate) lets it go; it is never stored.
      const res = await withUnlock(() => api.invoke('vault:changePassword', current, next))
      if (!res) return
      if (res.ok) {
        toast({ title: 'Master password changed', tone: 'success' })
        return
      }
      if (res.reason === 'wrong-password') {
        setError('Wrong password')
        onWrong()
      }
      if (res.retryAfterMs > 0) setDeadline(Date.now() + res.retryAfterMs)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
      currentRef.current?.focus()
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <h3 className="text-[13px] font-semibold text-fg">Change master password</h3>
      <SecretField
        ref={currentRef}
        label="Current password"
        maxLength={MAX_MASTER_PASSWORD}
        onInput={measure}
        error={error ?? undefined}
      />
      <div className="flex flex-col gap-2.5">
        <SecretField
          ref={nextRef}
          label="New password"
          maxLength={MAX_MASTER_PASSWORD}
          onInput={measure}
          error={short ? `At least ${MIN_MASTER_PASSWORD} characters` : undefined}
        />
        <StrengthMeter strength={m.strength} active={m.nextLen > 0} />
      </div>
      <SecretField
        ref={confirmRef}
        label="Confirm new password"
        maxLength={MAX_MASTER_PASSWORD}
        onInput={measure}
        error={mismatch ? "Passwords don't match" : undefined}
      />
      <div className="flex justify-end pt-1">
        <Button type="submit" disabled={!valid || throttled} loading={busy} className="tabular-nums">
          {throttled ? `Try again in ${secondsLeft} s` : 'Change password'}
        </Button>
      </div>
    </form>
  )
}
