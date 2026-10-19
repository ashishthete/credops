import { useId, useState } from 'react'
import type { SecretKind, SecretMeta } from '../../../shared/vault'
import { Button } from '../ui/Button'
import { SecretField, SelectField, TextField } from '../ui/Field'
import { createSecret } from './store'

const NEW = '__new'

export interface SecretPickerProps {
  label: string
  kind: SecretKind
  value: string | null
  secrets: SecretMeta[]
  /** Called with the picked id, or null for none; also called with a freshly created secret's id. */
  onChange: (id: string | null) => void
  /** e.g. "key" or "webhook": shapes "New key…" and "Save key". */
  noun: string
  defaultName: string
  /** The inline field's label, e.g. "New API key". */
  newLabel: string
  hint?: string
  disabled?: boolean
}

/**
 * A select of `kind` secrets plus "New <noun>…", which opens an inline SecretField. The value is sent to
 * the vault through secret:create and cleared at once; it is never shown again.
 */
export function SecretPicker({ label, kind, value, secrets, onChange, noun, defaultName, newLabel, hint, disabled }: SecretPickerProps) {
  const id = useId()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState(defaultName)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const choices = secrets.filter((s) => s.kind === kind)
  const missing = value !== null && !choices.some((s) => s.id === value)

  const save = async () => {
    setBusy(true)
    const meta = await createSecret(kind, name.trim(), secret)
    setBusy(false)
    if (!meta) return
    setSecret('')
    setAdding(false)
    setName(defaultName)
    onChange(meta.id)
  }

  return (
    <div className="flex flex-col gap-2">
      <SelectField
        id={id}
        label={label}
        hint={hint}
        disabled={disabled}
        value={adding ? NEW : (value ?? '')}
        onChange={(e) => {
          const next = e.target.value
          if (next === NEW) return setAdding(true)
          setAdding(false)
          setSecret('')
          onChange(next || null)
        }}
      >
        <option value="">None</option>
        {missing && <option value={value!}>A secret in a locked or missing vault</option>}
        {choices.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value={NEW}>New {noun}…</option>
      </SelectField>
      {adding && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface/60 p-3">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <SecretField
            label={newLabel}
            hint="Stored in the default vault. It is not shown again."
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => (setAdding(false), setSecret(''))}>
              Cancel
            </Button>
            <Button size="sm" loading={busy} disabled={!secret || !name.trim()} onClick={() => void save()}>
              Save {noun}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
