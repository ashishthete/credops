import { AnimatePresence, motion } from 'framer-motion'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { MAX_VAULT_NAME, type VaultMeta } from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { attempt, ColorPicker, plural, RowMenu, VAULT_COLORS, type ConfirmRequest } from './common'

interface VaultRailProps {
  vaults: VaultMeta[] | null
  currentId: string
  corruptIds: readonly string[]
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (vault: VaultMeta) => void
  onChanged: (vault: VaultMeta) => void
  onDeleted: (id: string) => void
  confirm: (req: ConfirmRequest) => void
}

const describe = (v: VaultMeta, corrupt: boolean) =>
  corrupt
    ? `${v.name}, can't be opened`
    : `${v.name}, ${plural(v.counts.secrets, 'secret')}, ${plural(v.counts.keys, 'key')}, ${plural(v.counts.identities, 'identity', 'identities')}`

export function VaultRail({ vaults, currentId, corruptIds, onSelect, onNew, onRename, onChanged, onDeleted, confirm }: VaultRailProps) {
  const motionSafe = useMotionSafe()

  const recolor = async (v: VaultMeta, color: string) => {
    if (color === v.color) return
    const next = await attempt("Couldn't change the color", () => api.invoke('vault:update', v.id, { color }))
    if (next) onChanged(next)
  }

  const askDelete = (v: VaultMeta) =>
    confirm({
      title: `Delete ${v.name}?`,
      description: 'Its secrets, SSH keys and identities are deleted with it. Linked key files in ~/.ssh stay.',
      confirmLabel: 'Delete vault',
      typeToConfirm: v.name,
      run: async () => {
        const ok = await attempt("Couldn't delete the vault", async () => {
          await api.invoke('vault:delete', v.id)
          return true
        })
        if (ok) {
          onDeleted(v.id)
          toast({ title: `Deleted ${v.name}`, tone: 'success' })
        }
      },
    })

  return (
    <nav aria-label="Vaults" className="flex w-[236px] shrink-0 flex-col border-r border-line bg-surface/40">
      <div className="app-drag flex h-16 shrink-0 items-end px-5 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">Vaults</h1>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2">
        {vaults === null
          ? Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="px-2.5 py-2">
                <Skeleton className="h-9 w-full rounded-lg" />
              </li>
            ))
          : vaults.map((v) => {
              const selected = v.id === currentId
              const corrupt = corruptIds.includes(v.id)
              return (
                <motion.li
                  key={v.id}
                  layout={motionSafe ? 'position' : false}
                  initial={motionSafe ? { opacity: 0, x: -6 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  transition={motionSafe ? spring : fast}
                  className="group relative"
                >
                  <button
                    type="button"
                    aria-label={describe(v, corrupt)}
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => onSelect(v.id)}
                    className={`relative flex w-full items-center gap-2.5 rounded-lg py-2 pr-9 pl-2.5 text-left transition-colors ${
                      selected ? 'text-fg' : 'text-fg/80 hover:bg-white/[0.035] hover:text-fg'
                    }`}
                  >
                    {selected && (
                      <motion.span
                        layoutId={motionSafe ? 'vault-rail-current' : undefined}
                        transition={spring}
                        aria-hidden
                        className="absolute inset-0 rounded-lg bg-white/[0.06] shadow-[inset_0_0_0_1px_var(--border)]"
                      />
                    )}
                    <span
                      aria-hidden
                      className="relative size-2.5 shrink-0 rounded-full"
                      style={{
                        background: corrupt ? 'transparent' : v.color,
                        boxShadow: corrupt ? `inset 0 0 0 1.5px ${v.color}` : `0 0 10px -1px ${v.color}`,
                      }}
                    />
                    <span className="relative flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-medium">{v.name}</span>
                      <span className={`truncate text-[11.5px] ${corrupt ? 'text-err/90' : 'text-muted'}`}>
                        {corrupt ? "Can't be opened" : `${v.counts.secrets} · ${v.counts.keys} · ${v.counts.identities}`}
                      </span>
                    </span>
                  </button>
                  <RowMenu
                    label={`${v.name} options`}
                    className={`absolute top-1/2 right-1.5 -translate-y-1/2 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
                      selected ? 'opacity-100' : 'opacity-0'
                    }`}
                    extra={() => (
                      <div className="border-b border-line/70 px-2 pt-1.5 pb-2">
                        <ColorPicker label={`${v.name} color`} value={v.color} onChange={(c) => void recolor(v, c)} />
                      </div>
                    )}
                    items={[
                      { label: 'Rename', icon: Pencil, run: () => onRename(v) },
                      ...(v.isDefault ? [] : [{ label: 'Delete', icon: Trash2, run: () => askDelete(v), danger: true }]),
                    ]}
                  />
                </motion.li>
              )
            })}
      </ul>
      <div className="border-t border-line/70 p-2.5">
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-white/[0.04] hover:text-fg"
        >
          <Plus aria-hidden className="size-3.5" />
          New vault
        </button>
      </div>
    </nav>
  )
}

/** Create a vault, or rename and recolor one. */
export function VaultDialog({
  open,
  vault,
  onClose,
  onSaved,
}: {
  open: boolean
  vault?: VaultMeta
  onClose: () => void
  onSaved: (vault: VaultMeta, created: boolean) => void
}) {
  const motionSafe = useMotionSafe()
  const formId = useId()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(VAULT_COLORS[0].hex)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(vault?.name ?? '')
    setColor(vault?.color ?? VAULT_COLORS[0].hex)
  }, [open, vault])

  const valid = name.trim().length > 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const input = { name: name.trim(), color }
    const saved = await attempt(vault ? "Couldn't update the vault" : "Couldn't create the vault", () =>
      vault ? api.invoke('vault:update', vault.id, input) : api.invoke('vault:create', input),
    )
    setBusy(false)
    if (saved) {
      if (!vault) toast({ title: `Created ${saved.name}`, tone: 'success' })
      onSaved(saved, !vault)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={vault ? 'Edit vault' : 'New vault'}
      description={vault ? undefined : 'A separate space with its own key, for one project or environment.'}
      icon={
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={color}
            aria-hidden
            initial={motionSafe ? { scale: 0.4, opacity: 0 } : { opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={motionSafe ? { ...spring, damping: 16 } : fast}
            className="block size-3.5 rounded-full"
            style={{ background: color, boxShadow: `0 0 14px ${color}` }}
          />
        </AnimatePresence>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!valid} loading={busy}>
            {vault ? 'Save' : 'Create vault'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <TextField
          autoFocus
          label="Name"
          placeholder="Staging"
          maxLength={MAX_VAULT_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-fg/90">Color</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
      </form>
    </Dialog>
  )
}
