import { useEffect, useId, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { MAX_NAME, MAX_PROVIDER, REGION_CODE, type RegionMeta } from '../../../../shared/inventory'
import { inv, useInventory } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextField } from '../../ui/Field'
import { toast } from '../../ui/Toaster'

interface RegionDialogProps {
  open: boolean
  /** Edits this region; creates a new one when absent. */
  region?: RegionMeta
  onClose: () => void
  onSaved: (region: RegionMeta) => void
}

/** A region's code, display name and provider. Main's refusals (a code already taken) show in the form. */
export function RegionDialog({ open, region, onClose, onSaved }: RegionDialogProps) {
  const formId = useId()
  const [code, setCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [provider, setProvider] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setCode(region?.code ?? '')
    setDisplayName(region?.displayName ?? '')
    setProvider(region?.provider ?? '')
    setError(null)
    // Reset when the dialog opens or switches region, not when a refresh hands over a new object mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, region?.id])

  // Main lowercases the code; the form shows what it will be stored as.
  const c = code.trim().toLowerCase()
  const codeError = c && !REGION_CODE.test(c) ? 'Use lowercase letters, digits and hyphens, not starting with a hyphen.' : undefined
  const valid = !!c && !codeError && displayName.trim().length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    // Opened from inside another dialog's form, the submit would bubble on to that form.
    e.stopPropagation()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const saved = await inv.saveRegion({ code: c, displayName: displayName.trim(), provider: provider.trim() }, region?.id, setError)
    setBusy(false)
    if (saved) {
      toast({ title: region ? `Saved ${saved.code}` : `Created ${saved.code}`, tone: 'success' })
      onSaved(saved)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={region ? `Edit ${region.code}` : 'New region'}
      description={region ? undefined : 'Where hosts run, e.g. a cloud region or a data centre. Every host belongs to one.'}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!valid} loading={busy}>
            {region ? 'Save' : 'Create region'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <TextField
          autoFocus
          label="Code"
          placeholder="eu-west-1"
          maxLength={63}
          value={code}
          onChange={(e) => {
            setCode(e.target.value)
            setError(null)
          }}
          error={codeError}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="font-mono"
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Display name" placeholder="Ireland" maxLength={MAX_NAME} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <TextField
            label="Provider"
            placeholder="aws, azure, on-prem"
            maxLength={MAX_PROVIDER}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            hint={provider.trim() ? undefined : 'Optional'}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {error && (
          <p role="alert" className="text-[12.5px] text-err">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** The select's value for its "New region…" entry; never a region id (those are UUIDs). */
const NEW_REGION = 'new-region'

interface RegionSelectProps {
  label?: string
  value: string
  onChange: (regionId: string) => void
  hint?: string
  disabled?: boolean
}

/**
 * Picks a region, ordered by code, with "New region…" at the end, which creates one without leaving the dialog
 * this sits in and picks it. With no regions yet, that entry is all there is.
 */
export function RegionSelect({ label = 'Region', value, onChange, hint, disabled }: RegionSelectProps) {
  const data = useInventory()
  const [creating, setCreating] = useState(false)
  const regions = [...(data?.regions ?? [])].sort((a, b) => a.code.localeCompare(b.code))
  const known = !value || regions.some((r) => r.id === value)

  return (
    <>
      <SelectField
        label={label}
        value={value}
        disabled={disabled}
        hint={hint ?? (regions.length === 0 ? 'Hosts need a region. Create the first one here.' : undefined)}
        onChange={(e) => (e.target.value === NEW_REGION ? setCreating(true) : onChange(e.target.value))}
      >
        {/* Hidden, so the list offers only real choices while the closed select still says what's wanted. */}
        <option value="" disabled hidden>
          {regions.length ? 'Choose a region' : 'No regions yet'}
        </option>
        {regions.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName && r.displayName !== r.code ? `${r.code} · ${r.displayName}` : r.code}
          </option>
        ))}
        {!known && (
          <option value={value} disabled>
            Unavailable region
          </option>
        )}
        <option value={NEW_REGION}>New region…</option>
      </SelectField>
      {/* Outside the dialog this select sits in, so it stacks above it and its form isn't nested in that one. */}
      {createPortal(
        <RegionDialog
          open={creating}
          onClose={() => setCreating(false)}
          onSaved={(r) => {
            setCreating(false)
            onChange(r.id)
          }}
        />,
        document.body,
      )}
    </>
  )
}
