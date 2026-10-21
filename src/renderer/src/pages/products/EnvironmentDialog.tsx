import { motion } from 'framer-motion'
import { Check, ShieldCheck } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { DEFAULT_SSH_PORT, MAX_NAME, MAX_URL, parseEnvDomain, type EnvironmentMeta } from '../../../../shared/inventory'
import { identityChoices } from '../../inventory/choices'
import { inv, type InventoryData } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { ColorPicker, VAULT_COLORS } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { toast } from '../../ui/Toaster'
import { EnvironmentNotifications } from './EnvironmentNotifications'
// regions-ui: one product per environment, read as a list until the Regions UI.
import { productIdsOf } from '../../inventory/regions-stopgap'

const DEFAULT_COLOR = VAULT_COLORS.find((c) => c.name === 'Green')!.hex

/** Blank means "use 22"; anything else must be a whole port number. */
function parsePort(text: string): { value: number | null; error?: string } {
  const t = text.trim()
  if (!t) return { value: null }
  const n = Number(t)
  return /^\d+$/.test(t) && n >= 1 && n <= 65535 ? { value: n } : { value: null, error: 'Use a port from 1 to 65535.' }
}

interface EnvironmentDialogProps {
  open: boolean
  /** Edits this environment; creates a new one when absent. */
  environment?: EnvironmentMeta
  /** Products a new environment starts in. */
  productIds: string[]
  data: InventoryData
  corruptVaultIds: readonly string[]
  onClose: () => void
  onSaved: (environment: EnvironmentMeta, created: boolean) => void
}

export function EnvironmentDialog({ open, environment, productIds, data, corruptVaultIds, onClose, onSaved }: EnvironmentDialogProps) {
  const formId = useId()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(DEFAULT_COLOR)
  const [isProtected, setProtected] = useState(false)
  const [products, setProducts] = useState<string[]>([])
  const [identityId, setIdentityId] = useState('')
  const [port, setPort] = useState('')
  const [jumpId, setJumpId] = useState('')
  const [domain, setDomain] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(environment?.name ?? '')
    setColor(environment?.color ?? DEFAULT_COLOR)
    setProtected(environment?.protected ?? false)
    setProducts((environment ? productIdsOf(environment) : undefined) ?? productIds)
    setIdentityId(environment?.defaultIdentityId ?? '')
    setPort(environment?.defaultPort != null ? String(environment.defaultPort) : '')
    setJumpId(environment?.defaultJumpHostId ?? '')
    setDomain(environment?.domain ?? '')
    // productIds is read when the dialog opens, not tracked while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, environment])

  // No host is in view, so no vault is "linked": every usable vault lists as Other vaults.
  const groups = useMemo(
    () => identityChoices(data.identities, data.vaults, [], [...corruptVaultIds]).filter((g) => g.identities.length),
    [data.identities, data.vaults, corruptVaultIds],
  )
  const hosts = useMemo(() => [...data.hosts].sort((a, b) => a.label.localeCompare(b.label)), [data.hosts])
  const sortedProducts = useMemo(() => [...data.products].sort((a, b) => a.name.localeCompare(b.name)), [data.products])

  const parsedPort = parsePort(port)
  const parsedDomain = domain.trim() ? parseEnvDomain(domain) : null
  const domainError = parsedDomain && !parsedDomain.ok ? parsedDomain.error : undefined
  const valid = name.trim().length > 0 && !parsedPort.error && !domainError

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const saved = await inv.saveEnvironment(
      {
        name: name.trim(),
        color,
        protected: isProtected,
        defaultPort: parsedPort.value,
        defaultIdentityId: identityId || null,
        defaultJumpHostId: jumpId || null,
        domain: domain.trim() || null,
        // regions-ui: the dialog still edits a list; an environment takes the first.
        productId: products[0] ?? '',
      },
      environment?.id,
    )
    setBusy(false)
    if (saved) {
      toast({ title: environment ? `Saved ${saved.name}` : `Created ${saved.name}`, tone: 'success' })
      onSaved(saved, !environment)
    }
  }

  const toggleProduct = (id: string) => setProducts((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={environment ? 'Edit environment' : 'New environment'}
      description={environment ? undefined : 'A set of hosts with shared defaults, like staging or prod.'}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!valid} loading={busy}>
            {environment ? 'Save' : 'Create environment'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <TextField autoFocus label="Name" placeholder="staging" maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-fg/90">Color</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <Switch label="Protected" checked={isProtected} onChange={setProtected} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span id={`${formId}-products`} className="text-[12.5px] font-medium text-fg/90">
            Products
          </span>
          <div role="group" aria-labelledby={`${formId}-products`} className="flex flex-wrap gap-1.5">
            {sortedProducts.map((p) => (
              <ProductChip key={p.id} name={p.name} color={p.color} pressed={products.includes(p.id)} onToggle={() => toggleProduct(p.id)} />
            ))}
            {sortedProducts.length === 0 && <span className="text-[12px] text-muted">No products yet. It will sit under Unassigned.</span>}
          </div>
        </div>
        <TextField
          label="Domain or URL"
          hint="e.g. staging.example.com"
          error={domainError}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          maxLength={MAX_URL}
          spellCheck={false}
          autoCapitalize="off"
          className="font-mono"
        />
        <div className="grid grid-cols-[1fr_112px] gap-3">
          <SelectField label="Default identity" value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
            <option value="">App default (your SSH keys)</option>
            {groups.map((g) => (
              <optgroup key={g.vault.id} label={`${g.group}: ${g.vault.name}`}>
                {g.identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label} ({i.username})
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectField>
          <TextField
            label="Default port"
            inputMode="numeric"
            placeholder={String(DEFAULT_SSH_PORT)}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            error={parsedPort.error}
            className="font-mono tabular-nums"
          />
        </div>
        <SelectField label="Default jump host" value={jumpId} onChange={(e) => setJumpId(e.target.value)}>
          <option value="">None, connect directly</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </SelectField>
      </form>
      {/* Saves on its own: integrations belong to an existing environment. */}
      {environment && <EnvironmentNotifications environment={environment} />}
    </Dialog>
  )
}

function ProductChip({ name, color, pressed, onToggle }: { name: string; color: string; pressed: boolean; onToggle: () => void }) {
  const motionSafe = useMotionSafe()
  return (
    <motion.button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      whileTap={motionSafe ? { scale: 0.94 } : undefined}
      transition={spring}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-[background-color,box-shadow,color] ${
        pressed ? 'text-fg' : 'text-muted shadow-[inset_0_0_0_1px_var(--border)] hover:text-fg'
      }`}
      style={
        pressed
          ? { background: `color-mix(in oklab, ${color} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 45%, transparent)` }
          : undefined
      }
    >
      <span className="grid size-3 place-items-center">
        {pressed ? (
          <motion.span
            initial={motionSafe ? { scale: 0.3, opacity: 0 } : { opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={motionSafe ? spring : fast}
            className="grid"
          >
            <Check aria-hidden className="size-3" strokeWidth={3} style={{ color }} />
          </motion.span>
        ) : (
          <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />
        )}
      </span>
      {name}
    </motion.button>
  )
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  const motionSafe = useMotionSafe()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title="Deleting a protected environment asks for its name"
      className="flex h-8 items-center gap-2 rounded-lg px-1.5 text-[12.5px] font-medium text-fg/90"
    >
      <ShieldCheck aria-hidden className={`size-3.5 transition-colors ${checked ? 'text-warn' : 'text-muted'}`} />
      {label}
      <span
        aria-hidden
        className={`relative flex h-[18px] w-8 items-center rounded-full px-0.5 transition-colors ${checked ? 'justify-end bg-warn/80' : 'justify-start bg-white/10'}`}
      >
        <motion.span layout={motionSafe} transition={spring} className="size-3.5 rounded-full bg-white shadow" />
      </span>
    </button>
  )
}
