import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ReverifyProof } from '../../../shared/sso'
import {
  MAX_MASTER_PASSWORD,
  MAX_PIN,
  MAX_PIN_ATTEMPT,
  MIN_PIN,
  MIN_PIN_ATTEMPT,
  PIN_FORMAT_ERROR,
  PIN_INPUT_MAX,
  VERIFICATION_FAILED,
  type ProvenResult,
  type VaultStatus,
} from '../../../shared/vault'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SecretField } from '../ui/Field'
import { toast } from '../ui/Toaster'
import { refreshVaultStatus, vaultStatusStore } from './status'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export type ProofMethod = 'password' | 'pin' | 'touchId'

/** A new PIN. */
export const PIN_SHAPE = new RegExp(`^\\d{${MIN_PIN},${MAX_PIN}}$`)
/** A PIN being proved: one set before the current rule can be MIN_PIN_ATTEMPT to MAX_PIN_ATTEMPT digits. */
const PIN_ATTEMPT_SHAPE = new RegExp(`^\\d{${MIN_PIN_ATTEMPT},${MAX_PIN_ATTEMPT}}$`)
export const PIN_LENGTH = PIN_FORMAT_ERROR

/** The ways this vault can re-prove the user, in the order they are offered. */
export function proofMethods(status: VaultStatus): ProofMethod[] {
  const methods: ProofMethod[] = []
  if (status.hasPassword) methods.push('password')
  if (status.pin.enabled) methods.push('pin')
  // Not while its Keychain copy is unreadable: main would refuse the prompt's result.
  if (status.quickUnlock === 'touchId' && status.quickUnlockAvailable.touchId && !status.touchIdNeedsReenable) methods.push('touchId')
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
  cancelLabel?: string
  /** Offer only these methods (default: everything set up). */
  methods?: ProofMethod[]
  /** Stack full-width buttons, as on the gate card. */
  wide?: boolean
  /** Shown on the submit button. */
  icon?: ReactNode
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

export function ProofForm({
  status,
  submitLabel = 'Continue',
  cancelLabel = 'Cancel',
  methods: offered,
  wide = false,
  icon,
  children,
  ready = true,
  onProof,
  onProven,
  onClose,
  onWrong,
}: Omit<ReverifyDialogProps, 'open' | 'title' | 'description' | 'status'> & { status: VaultStatus; onWrong: () => void }) {
  const methods = offered ?? proofMethods(status)
  const [method, setMethod] = useState<ProofMethod | null>(() =>
    status.lastMethod === 'pin' && methods.includes('pin') ? 'pin' : (methods[0] ?? null),
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const [hasInput, setHasInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const others = methods.filter((m) => m !== method)

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !ready || !method) return
    let proof: ReverifyProof
    if (method === 'touchId') {
      proof = { method }
    } else {
      const input = inputRef.current
      if (!input || !input.value) return
      // A malformed PIN never goes to main, where it would cost one of the tries.
      if (method === 'pin' && !PIN_ATTEMPT_SHAPE.test(input.value)) return setError(PIN_LENGTH)
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

  const submit = (
    <Button
      type="submit"
      loading={busy}
      icon={icon}
      disabled={!ready || !method || (method !== 'touchId' && !hasInput)}
      className={wide ? 'w-full' : ''}
    >
      {submitLabel}
    </Button>
  )

  return (
    <form onSubmit={(e) => void send(e)} className="flex flex-col gap-3" noValidate>
      {children}
      {method && method !== 'touchId' && (
        <SecretField
          key={method}
          ref={inputRef}
          label={method === 'pin' ? 'PIN' : 'Master password'}
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
      <div className={wide ? 'flex flex-col gap-3' : 'flex justify-end gap-2 pt-1'}>
        {/* The gate card lists the primary action on top; dialogs put it last. */}
        {wide && submit}
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className={wide ? 'w-full' : ''}>
          {cancelLabel}
        </Button>
        {!wide && submit}
      </div>
    </form>
  )
}
