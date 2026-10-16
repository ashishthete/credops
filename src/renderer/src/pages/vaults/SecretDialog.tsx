import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  MAX_SECRET_NAME,
  MAX_SECRET_VALUE,
  SECRET_KINDS,
  type SecretKind,
  type SecretMeta,
  type SecretPatch,
} from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SecretAreaField, SelectField, TextField } from '../../ui/Field'
import { toast } from '../../ui/Toaster'
import { attempt } from './common'

interface SecretDialogProps {
  open: boolean
  vaultId: string
  /** Edits this secret; creates a new one when absent. */
  secret?: SecretMeta
  onClose: () => void
  onSaved: (secret: SecretMeta) => void
}

export function SecretDialog({ open, vaultId, secret, onClose, onSaved }: SecretDialogProps) {
  const formId = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SecretKind>('password')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  // The value never outlives the dialog, whether it saved or not.
  useEffect(() => {
    setValue('')
    if (!open) return
    setName(secret?.name ?? '')
    setKind(secret?.kind ?? 'password')
  }, [open, secret])

  const editing = !!secret
  const valid = name.trim().length > 0 && (editing || value.length > 0)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    const trimmed = name.trim()
    const v = value
    setBusy(true)
    const saved = await attempt(editing ? "Couldn't update the secret" : "Couldn't save the secret", () => {
      if (!secret) return api.invoke('secret:create', { vaultId, name: trimmed, kind, value: v })
      const patch: SecretPatch = {}
      if (trimmed !== secret.name) patch.name = trimmed
      if (kind !== secret.kind) patch.kind = kind
      if (v) patch.value = v
      return api.invoke('secret:update', secret.id, patch)
    })
    setBusy(false)
    if (saved) {
      // Cleared only once stored, so a failed save can be retried without retyping.
      setValue('')
      toast({ title: editing ? `Updated ${saved.name}` : `Saved ${saved.name}`, tone: 'success' })
      onSaved(saved)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit secret' : 'New secret'}
      description={
        editing ? 'Rename it, change its kind, or replace its value.' : 'Encrypted with this vault’s key before it is stored.'
      }
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!valid} loading={busy}>
            Save secret
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <div className="grid grid-cols-[1fr_132px] gap-3">
          <TextField
            autoFocus
            label="Name"
            placeholder="DATABASE_URL"
            maxLength={MAX_SECRET_NAME}
            spellCheck={false}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
          />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as SecretKind)}>
            {SECRET_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </SelectField>
        </div>
        <SecretAreaField
          label="Value"
          maxLength={MAX_SECRET_VALUE}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          hint={editing ? 'Leave empty to keep the current value.' : undefined}
        />
      </form>
    </Dialog>
  )
}
