import { Lock, Snowflake } from 'lucide-react'
import { useState } from 'react'
import { FREEZE_DEFAULT_HOURS, FREEZE_MAX_HOURS, MAX_FREEZE_REASON } from '../../../../shared/hub'
import { freezeEnvironment, unfreezeEnvironment, useHub } from '../../hub/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ConfirmDialog, type ConfirmRequest } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { TextField } from '../../ui/Field'

const time = (iso: string): string => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** A Hub environment's lock: who is releasing or who froze it, with Freeze and Lift freeze. */
export function HubLockBadge({ environmentId, name, guarded }: { environmentId: string; name: string; guarded: boolean }) {
  const { locks, status } = useHub()
  const lock = locks[environmentId]
  const me = status.linked ? (status.user?.oid ?? null) : null
  const [freezing, setFreezing] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const lift = () => {
    if (!lock) return
    if (lock.holder.oid === me) {
      void unfreezeEnvironment(environmentId, null)
      return
    }
    // Someone else's freeze on a protected environment is lifted only by typing its name.
    setConfirm({
      title: `Lift ${lock.holder.name}'s freeze on ${name}?`,
      description: guarded ? `${name} is protected.` : 'Deploys to it can start again.',
      confirmLabel: 'Lift freeze',
      ...(guarded ? { typeToConfirm: name } : {}),
      run: async () => {
        await unfreezeEnvironment(environmentId, guarded ? name : null)
      },
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {lock?.kind === 'release' && (
        <Badge tone="info" dot="pulse">
          {`Releasing — ${lock.holder.name}`}
        </Badge>
      )}
      {lock?.kind === 'manual' && (
        <Badge tone="warn">
          <Snowflake aria-hidden className="size-3" />
          {`Frozen by ${lock.holder.name}${lock.expiresAt ? ` until ${time(lock.expiresAt)}` : ''}${lock.reason ? `: ${lock.reason}` : ''}`}
        </Badge>
      )}
      {!lock && (
        <Button size="sm" variant="ghost" icon={<Lock aria-hidden className="size-3.5" />} onClick={() => setFreezing(true)}>
          Freeze…
        </Button>
      )}
      {lock?.kind === 'manual' && (
        <Button size="sm" variant="ghost" onClick={lift}>
          Lift freeze
        </Button>
      )}
      <FreezeDialog open={freezing} name={name} onClose={() => setFreezing(false)} environmentId={environmentId} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function FreezeDialog({ open, name, environmentId, onClose }: { open: boolean; name: string; environmentId: string; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [hours, setHours] = useState(String(FREEZE_DEFAULT_HOURS))
  const [busy, setBusy] = useState(false)
  const n = Number(hours)
  const valid = Number.isFinite(n) && n > 0 && n <= FREEZE_MAX_HOURS
  const submit = async () => {
    setBusy(true)
    const lock = await freezeEnvironment(environmentId, reason.trim(), n)
    setBusy(false)
    if (!lock) return
    setReason('')
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Freeze ${name}`}
      description="Nobody can start a release here until the freeze ends or someone lifts it."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!valid} onClick={() => void submit()}>
            Freeze
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label="Reason" maxLength={MAX_FREEZE_REASON} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        <TextField label="Hours" type="number" min={1} max={FREEZE_MAX_HOURS} value={hours} onChange={(e) => setHours(e.target.value)} />
      </div>
    </Dialog>
  )
}
