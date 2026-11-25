import { Fingerprint, Grid3x3, KeyRound, Moon, Timer } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { AUTO_LOCK_CHOICES, type VaultStatus } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { toast } from '../ui/Toaster'
import { factorGuard } from './factorGuard'
import { useVaultStatus, vaultStatusStore } from './status'
import { AddPasswordDialog, PIN_ONLY_WARNING, RemovePasswordDialog, SetPinDialog, TouchIdDialog } from './UnlockMethodDialogs'
import { withUnlock } from './unlock'
import { ChangePasswordForm } from './VaultSettingsDialog'

type Panel = 'touchId' | 'pin' | 'addPassword' | 'removePassword' | 'changePassword'

const AUTO_LOCK_OPTIONS = AUTO_LOCK_CHOICES.map((m) => ({
  id: String(m ?? 'never'),
  label: m === null ? 'Never' : m === 60 ? '1 hour' : `${m} min`,
}))

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The Settings page's Unlock card: each way in, on or off where it stands, and when the vaults lock again. */
export function UnlockSettings() {
  const status = useVaultStatus()
  if (!status?.setUp) return null
  return <UnlockCard status={status} />
}

function UnlockCard({ status }: { status: VaultStatus }) {
  const [panel, setPanel] = useState<Panel | null>(null)
  const [saving, setSaving] = useState(false)
  const [shake, setShake] = useState(0)
  const close = () => setPanel(null)
  const { canRemovePin, canTurnOffTouchId, canRemovePassword } = factorGuard(status)

  const touchIdAvailable = status.quickUnlockAvailable.touchId
  const touchIdOn = status.quickUnlock === 'touchId'
  const quick = touchIdOn || status.pin.enabled
  const pinOnly = status.pin.enabled && !status.hasPassword && !touchIdOn

  const setTouchId = async (on: boolean) => {
    // Turning a way in on needs a proof; turning it off does not.
    if (on) return setPanel('touchId')
    setSaving(true)
    try {
      const next = await withUnlock(() => api.invoke('vault:setQuickUnlock', 'off'))
      if (next) {
        vaultStatusStore.set(next.status)
        toast({ title: 'Touch ID turned off', tone: 'success' })
      }
    } catch (err) {
      toast({ title: "Couldn't turn off Touch ID", description: errorText(err), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const clearPin = async () => {
    try {
      const next = await withUnlock(() => api.invoke('vault:clearPin'))
      if (!next) return
      vaultStatusStore.set(next)
      toast({ title: 'PIN removed', tone: 'success' })
    } catch (err) {
      toast({ title: "Couldn't remove the PIN", description: errorText(err), tone: 'error' })
    }
  }

  const setAutoLock = async (id: string) => {
    try {
      vaultStatusStore.set(await api.invoke('vault:setAutoLock', id === 'never' ? null : Number(id)))
    } catch (err) {
      toast({ title: "Couldn't change auto-lock", description: errorText(err), tone: 'error' })
    }
  }

  const setLockOnSleep = async (on: boolean) => {
    try {
      vaultStatusStore.set(await api.invoke('vault:setLockOnSleep', on))
    } catch (err) {
      toast({ title: "Couldn't change the setting", description: errorText(err), tone: 'error' })
    }
  }

  const touchIdDetail = !touchIdAvailable
    ? 'Not available on this Mac.'
    : status.touchIdNeedsReenable
      ? 'Your fingerprints changed. Turn it off and on again to keep using it.'
      : 'Your fingerprint opens the vaults and confirms protected actions.'

  return (
    <section aria-labelledby="settings-unlock" className="mt-2 max-w-[880px] rounded-xl border border-line bg-surface">
      <header className="px-5 pt-5 pb-3">
        <h2 id="settings-unlock" className="text-[14px] font-semibold text-fg">
          Unlock
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          How your vaults open, and when they lock again. Touch ID is offered first, then your PIN, then the master password.
        </p>
        {!quick && (
          <p className="mt-3 rounded-lg border border-accent/30 bg-accent/8 px-3 py-2 text-[12.5px] text-fg">
            Only your master password is on. Turn on Touch ID or set a PIN to stop typing it every time.
          </p>
        )}
      </header>
      <ul className="divide-y divide-line border-t border-line">
        <Row icon={<Fingerprint className="size-4" />} title="Touch ID" detail={touchIdDetail} warn={status.touchIdNeedsReenable}>
          <span title={touchIdOn && !canTurnOffTouchId ? 'Set a PIN first' : undefined}>
            <Switch
              label="Touch ID"
              checked={touchIdOn}
              busy={saving}
              disabled={(!touchIdAvailable && !touchIdOn) || (touchIdOn && !canTurnOffTouchId)}
              onChange={(on) => void setTouchId(on)}
            />
          </span>
        </Row>
        <Row
          icon={<Grid3x3 className="size-4" />}
          title="PIN"
          state={status.pin.enabled}
          detail={pinOnly ? PIN_ONLY_WARNING : 'A short code for when Touch ID isn’t handy.'}
          warn={pinOnly}
        >
          {status.pin.enabled && (
            <span title={canRemovePin ? undefined : 'Turn on Touch ID first'}>
              <Button variant="ghost" size="sm" disabled={!canRemovePin} onClick={() => void clearPin()}>
                Remove
              </Button>
            </span>
          )}
          <Button variant={status.pin.enabled ? 'ghost' : 'primary'} size="sm" onClick={() => setPanel('pin')}>
            {status.pin.enabled ? 'Change PIN' : 'Set PIN'}
          </Button>
        </Row>
        <Row
          icon={<KeyRound className="size-4" />}
          title="Master password"
          state={status.hasPassword}
          detail={status.hasPassword ? 'Always works, and is asked for last.' : 'Off. Touch ID or your PIN is the only way in.'}
        >
          {status.hasPassword ? (
            <>
              <span title={canRemovePassword ? undefined : 'Add Touch ID or a PIN first'}>
                <Button variant="ghost" size="sm" disabled={!canRemovePassword} onClick={() => setPanel('removePassword')}>
                  Remove
                </Button>
              </span>
              <Button variant="ghost" size="sm" onClick={() => setPanel('changePassword')}>
                Change password
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setPanel('addPassword')}>
              Add password
            </Button>
          )}
        </Row>
        <Row
          icon={<Timer className="size-4" />}
          title="Auto-lock"
          detail={status.autoLockMinutes ? 'Locks the vaults after this long without use.' : 'The vaults stay open until you lock them.'}
        >
          <Segmented label="Auto-lock" size="sm" options={AUTO_LOCK_OPTIONS} value={String(status.autoLockMinutes ?? 'never')} onChange={(id) => void setAutoLock(id)} />
        </Row>
        <Row
          icon={<Moon className="size-4" />}
          title="Lock on sleep"
          detail={
            status.lockOnSleep
              ? 'Locks the vaults when the Mac sleeps or its screen locks.'
              : 'The vaults stay open through sleep and screen lock. Anyone who gets into this Mac can use them.'
          }
        >
          <Switch label="Lock on sleep" checked={status.lockOnSleep} onChange={(on) => void setLockOnSleep(on)} />
        </Row>
      </ul>
      <TouchIdDialog open={panel === 'touchId'} status={status} onClose={close} />
      <SetPinDialog open={panel === 'pin'} status={status} onClose={close} />
      <AddPasswordDialog open={panel === 'addPassword'} status={status} onClose={close} />
      <RemovePasswordDialog open={panel === 'removePassword'} status={status} onClose={close} />
      <Dialog open={panel === 'changePassword'} onClose={close} title="Change master password" shake={shake} width={420}>
        <ChangePasswordForm onWrong={() => setShake((n) => n + 1)} onDone={close} />
      </Dialog>
    </section>
  )
}

function Row({
  icon,
  title,
  detail,
  state,
  warn = false,
  children,
}: {
  icon: ReactNode
  title: string
  detail: string
  /** On/off, for rows whose control doesn't already say so. */
  state?: boolean
  warn?: boolean
  children: ReactNode
}) {
  return (
    <li className="flex items-center gap-3 px-5 py-3.5">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
          {title}
          {state !== undefined && (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-normal text-muted">
              <span aria-hidden className={`size-1.5 rounded-full ${state ? 'bg-ok' : 'bg-muted/50'}`} />
              {state ? 'On' : 'Off'}
            </span>
          )}
        </p>
        <p className={`mt-0.5 text-[12px] leading-4 ${warn ? 'text-warn' : 'text-muted'}`}>{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </li>
  )
}
