import { useEffect, useId, useState } from 'react'
import { VAULT_RESET_CONFIRM } from '../../../shared/vault'
import { api } from '../lib/api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { TextField } from '../ui/Field'
import { toast } from '../ui/Toaster'
import { vaultStatusStore } from './status'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

const POINTS = [
  "The master password can't be recovered.",
  'Resetting permanently erases every secret in every vault: passwords, private keys, passphrases and other secret items.',
  'It also turns off Touch ID quick unlock.',
  'Open terminals and tunnels will be closed.',
  'Products, environments, hosts, tunnels and other settings are kept. Files in ~/.ssh are not touched.',
  'Hosts that used a vault identity will need it added again.',
]

/**
 * The forgotten-password way out, from the lock screen: erases every vault secret once the user
 * types RESET. The new (not set up) status puts the gate on the first-run setup step.
 */
export function ResetVaultsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = useId()

  useEffect(() => {
    if (!open) return
    setTyped('')
    setError(null)
  }, [open])

  const ready = typed === VAULT_RESET_CONFIRM
  const reset = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await api.invoke('vault:reset', typed)
      onClose()
      vaultStatusStore.set(status)
      toast({ title: 'Vaults reset', description: 'Choose a new master password.', tone: 'info' })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Reset vaults?"
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" form={formId} type="submit" disabled={!ready} loading={busy}>
            Erase secrets and reset
          </Button>
        </>
      }
    >
      <ul className="mb-4 flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-5 text-muted marker:text-muted/60">
        {POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          void reset()
        }}
      >
        <TextField
          autoFocus
          label={`Type ${VAULT_RESET_CONFIRM} to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          readOnly={busy}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          error={error ?? undefined}
        />
      </form>
    </Dialog>
  )
}
