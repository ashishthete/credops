import { AnimatePresence, motion } from 'framer-motion'
import { Check, Layers, Pencil, StickyNote, Trash2, Vault, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { EnvironmentMeta, HostMeta } from '../../../../shared/inventory'
import { inv, useInventory } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { ConfirmDialog, RowMenu, type ConfirmRequest } from '../../ui/common'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { useVaultStatus } from '../../vault/status'
import { PaneHeader } from '../products/ProductView'
import { ConnectionCard } from './ConnectionCard'
import { HostDialog, OS_META } from './HostDialog'
import { MembershipEditor } from './MembershipEditor'

interface HostViewProps {
  hostId: string
  /** The environment the host was opened from; the connection card starts there. */
  environmentId?: string
  /** Called after the host is deleted, so the page can move the selection. */
  onDeleted?: () => void
}

export function HostView({ hostId, environmentId, onDeleted }: HostViewProps) {
  const data = useInventory()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const host = data?.hosts.find((h) => h.id === hostId)

  if (!data) {
    return (
      <div className="flex flex-col gap-4 px-8 pt-8">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    )
  }
  if (!host) return null

  const { icon: OsIcon, label: osLabel } = OS_META[host.osIcon]
  const protectedEnv = data.environments.find((e) => e.protected && e.hosts.some((m) => m.hostId === host.id))

  const askDelete = () =>
    setConfirm({
      title: `Delete ${host.label}?`,
      description: `It leaves every environment it's in. Hosts that jump through ${host.label} will connect directly.`,
      confirmLabel: 'Delete host',
      typeToConfirm: protectedEnv ? host.label : undefined,
      run: async () => {
        if (await inv.deleteHost(host.id)) {
          toast({ title: `Deleted ${host.label}`, tone: 'success' })
          onDeleted?.()
        }
      },
    })

  const askRemove = (env: EnvironmentMeta) =>
    setConfirm({
      title: `Remove ${host.label} from ${env.name}?`,
      description: 'The host is kept, along with its places in other environments.',
      confirmLabel: 'Remove host',
      typeToConfirm: env.protected ? env.name : undefined,
      run: async () => {
        if (await inv.removeHost(env.id, host.id)) toast({ title: `Removed ${host.label} from ${env.name}`, tone: 'success' })
      },
    })

  return (
    <>
      <PaneHeader
        lead={
          <span title={osLabel} className="grid size-7 place-items-center rounded-lg bg-white/[0.05] text-fg/85">
            <OsIcon aria-label={osLabel} className="size-4" />
          </span>
        }
        title={host.label}
        badges={<span className="truncate font-mono text-[12.5px] text-muted">{host.address}</span>}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<Pencil aria-hidden className="size-3.5" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <RowMenu
              label={`${host.label} options`}
              items={[
                { label: 'Edit', icon: Pencil, run: () => setEditing(true) },
                { label: 'Delete', icon: Trash2, run: askDelete, danger: true },
              ]}
            />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8">
        {host.tags.length > 0 && (
          <ul aria-label="Tags" className="mb-4 flex flex-wrap gap-1">
            {host.tags.map((t) => (
              <li key={t} className="rounded-md bg-white/[0.05] px-1.5 font-mono text-[11.5px] leading-5 text-fg/80">
                {t}
              </li>
            ))}
          </ul>
        )}
        <ConnectionCard hostId={host.id} environmentId={environmentId} />

        <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-6">
          <Section icon={Layers} title="Environments">
            <MembershipEditor host={host} data={data} onRemove={askRemove} />
          </Section>
          <Section icon={Vault} title="Vaults">
            <VaultLinks host={host} />
          </Section>
        </div>

        {host.notes && (
          <Section icon={StickyNote} title="Notes" className="mt-6">
            <p className="max-w-[72ch] text-[13px] leading-5 whitespace-pre-wrap text-fg/85">{host.notes}</p>
          </Section>
        )}
      </div>

      <HostDialog
        open={editing}
        host={host}
        onClose={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}

function Section({ icon: Icon, title, className = '', children }: { icon: typeof Layers; title: string; className?: string; children: ReactNode }) {
  return (
    <section className={className}>
      <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-fg/90">
        <Icon aria-hidden className="size-3.5 text-muted" />
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Linked vaults as chips; identities from these list first when picking one for the host. */
function VaultLinks({ host }: { host: HostMeta }) {
  const motionSafe = useMotionSafe()
  const data = useInventory()
  const status = useVaultStatus()
  const corrupt = status?.corruptVaultIds ?? []
  const vaults = [...(data?.vaults ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  const linked = vaults.filter((v) => host.vaultIds.includes(v.id))
  const toggle = (id: string) =>
    void inv.setHostVaults(host.id, host.vaultIds.includes(id) ? host.vaultIds.filter((x) => x !== id) : [...host.vaultIds, id])

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <AnimatePresence initial={false}>
        {linked.map((v) => (
          <motion.span
            key={v.id}
            layout={motionSafe ? 'position' : false}
            initial={motionSafe ? { opacity: 0, scale: 0.85 } : { opacity: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={motionSafe ? { opacity: 0, scale: 0.85, transition: fast } : { opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
            className="inline-flex h-7 items-center gap-1.5 rounded-full pr-1 pl-2.5 text-[12.5px] font-medium text-fg"
            style={{ background: `color-mix(in oklab, ${v.color} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${v.color} 40%, transparent)` }}
          >
            <span aria-hidden className="size-2 rounded-full" style={{ background: v.color }} />
            {v.name}
            {corrupt.includes(v.id) && <span className="text-[11.5px] text-err">unreadable</span>}
            <button
              type="button"
              aria-label={`Unlink ${v.name}`}
              onClick={() => toggle(v.id)}
              className="grid size-5 place-items-center rounded-full text-muted hover:bg-white/[0.08] hover:text-fg"
            >
              <X aria-hidden className="size-3" />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
      {linked.length === 0 && <span className="text-[12.5px] text-muted">No linked vaults.</span>}
      <LinkVaultMenu vaults={vaults} linkedIds={host.vaultIds} corruptIds={corrupt} onToggle={toggle} />
    </div>
  )
}

function LinkVaultMenu({
  vaults,
  linkedIds,
  corruptIds,
  onToggle,
}: {
  vaults: { id: string; name: string; color: string }[]
  linkedIds: string[]
  corruptIds: string[]
  onToggle: (id: string) => void
}) {
  const motionSafe = useMotionSafe()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const onKeyDown = (e: KeyboardEvent) => {
    const els = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])]
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-line px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-muted/40 hover:text-fg"
      >
        <Vault aria-hidden className="size-3.5" />
        Link vault
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Link vault"
            onKeyDown={onKeyDown}
            initial={motionSafe ? { opacity: 0, scale: 0.95, y: -4 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
            exit={{ opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
            style={{ transformOrigin: 'top left' }}
            className="absolute top-full left-0 z-40 mt-1 max-h-64 w-[220px] overflow-y-auto rounded-ui border border-line bg-surface-2/95 p-1 shadow-pop backdrop-blur-xl"
          >
            {vaults.map((v) => {
              const checked = linkedIds.includes(v.id)
              return (
                <button
                  key={v.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  // Stays open: link several in a row.
                  onClick={() => onToggle(v.id)}
                  className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] text-fg/90 transition-colors hover:bg-white/6 focus:bg-white/6 focus:outline-none"
                >
                  <span
                    aria-hidden
                    className={`grid size-4 place-items-center rounded transition-colors ${checked ? '' : 'shadow-[inset_0_0_0_1px_var(--border)]'}`}
                    style={checked ? { background: v.color } : undefined}
                  >
                    {checked && <Check className="size-3 text-white" strokeWidth={3} />}
                  </span>
                  <span className="truncate">{v.name}</span>
                  {corruptIds.includes(v.id) && <span className="ml-auto text-[11.5px] text-err">unreadable</span>}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
