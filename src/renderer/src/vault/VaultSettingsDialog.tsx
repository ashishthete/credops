import { useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { AUTO_LOCK_CHOICES, MAX_MASTER_PASSWORD, MIN_MASTER_PASSWORD, type QuickUnlockMode, type VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/common'
import { Dialog } from '../ui/Dialog'
import { SecretField, SelectField } from '../ui/Field'
import { toast } from '../ui/Toaster'
import { isSignedInViaHub, signOutAccount, signOutRequest } from './account'
import { StrengthMeter } from './SetupCard'
import { useVaultStatus, vaultStatusStore } from './status'
import { passwordStrength, type Strength } from './strength'
import {
  AddPasswordDialog,
  ChangeAccountDialog,
  PIN_ONLY_WARNING,
  RemovePasswordDialog,
  SetPinDialog,
  TouchIdDialog,
} from './UnlockMethodDialogs'
import { factorGuard } from './factorGuard'
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

const NEED_PIN = 'Add a PIN first'
const NEED_TOUCH_ID = 'Add Touch ID first'
const NEED_TOUCH_ID_OR_PIN = 'Add Touch ID or a PIN first'

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
    <>
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
      <SignOutConfirm />
    </>
  )
}

type Panel = 'touchId' | 'pin' | 'password' | 'removePassword' | 'account'

/** Sign out asks first, from Settings and from the palette alike. */
function SignOutConfirm() {
  const asking = useSyncExternalStore(signOutRequest.store.subscribe, signOutRequest.store.get)
  return (
    <ConfirmDialog
      request={
        asking
          ? {
              title: 'Sign out and lock your vaults?',
              description: "Your vaults stay on this Mac; you'll sign in with Microsoft next time.",
              confirmLabel: 'Sign out',
              gentle: { cancelLabel: 'Cancel' },
              run: signOutAccount,
            }
          : null
      }
      onClose={signOutRequest.close}
    />
  )
}

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
  // Mirrors main's keepsAWayIn: Touch ID or a PIN must stay, and a master password never counts as
  // one. Main still refuses anything that slips past.
  const touchId = status?.quickUnlock === 'touchId'
  const { canRemovePin, canTurnOffTouchId, canRemovePassword } = factorGuard(status)

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
      if (!next) return
      vaultStatusStore.set(next)
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
          <div title={touchId && !canTurnOffTouchId ? NEED_PIN : undefined}>
            <SelectField
              label="Quick unlock"
              disabled={!status || saving}
              value={status?.quickUnlock ?? 'off'}
              onChange={(e) => void setQuick(e.target.value as QuickUnlockMode)}
            >
              {modes.map((m) => (
                <option key={m} value={m} disabled={m === 'off' && touchId && !canTurnOffTouchId}>
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
                <span title={canRemovePin ? undefined : NEED_TOUCH_ID}>
                  <Button variant="ghost" size="sm" disabled={!canRemovePin} onClick={() => void clearPin()}>
                    Remove PIN
                  </Button>
                </span>
              )}
            </MethodRow>
            {pinOnly && <p className="-mt-1 text-[12px] leading-4 text-warn">{PIN_ONLY_WARNING}</p>}
            <MethodRow label="Master password" detail={status.hasPassword ? 'On' : 'Off'}>
              {status.hasPassword ? (
                <span title={canRemovePassword ? undefined : NEED_TOUCH_ID_OR_PIN}>
                  <Button variant="ghost" size="sm" disabled={!canRemovePassword} onClick={() => setPanel('removePassword')}>
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
              {isSignedInViaHub(status) && (
                <Button variant="ghost" size="sm" onClick={signOutRequest.ask}>
                  Sign out
                </Button>
              )}
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
