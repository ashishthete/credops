import { Globe2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { RegionMeta } from '../../../../shared/inventory'
import { inv, useInventory } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../ui/Toaster'
import { RegionDialog } from './RegionDialog'

/** Every region with its host count: create, edit and delete. Main refuses to delete one a host still uses. */
export function RegionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = useInventory()
  // `null` while closed, `undefined` for a new region.
  const [editing, setEditing] = useState<RegionMeta | undefined | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const regions = [...(data?.regions ?? [])].sort((a, b) => a.code.localeCompare(b.code))

  const askDelete = (r: RegionMeta) =>
    setConfirm({
      title: `Delete ${r.code}?`,
      description: r.hostCount > 0 ? `${plural(r.hostCount, 'host')} ${r.hostCount === 1 ? 'is' : 'are'} in it.` : 'No hosts are in it.',
      confirmLabel: 'Delete region',
      run: async () => {
        let refused: string | null = null
        if (await inv.deleteRegion(r.id, (m) => (refused = m))) toast({ title: `Deleted ${r.code}`, tone: 'success' })
        // Main's reason (hosts still in it) stays in the confirmation.
        return refused === null ? undefined : { refused }
      },
    })

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Regions"
        description="Every host belongs to one region. Environments, checkouts and services show the regions of the hosts they run on."
        width={560}
        footer={
          <>
            <Button variant="ghost" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing(undefined)} className="mr-auto">
              New region
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        {regions.length === 0 ? (
          <EmptyState icon={Globe2} title="No regions yet" text="Create one before adding your first host." />
        ) : (
          <ul aria-label="Regions" className="-mx-1 flex max-h-[52vh] flex-col overflow-y-auto">
            {regions.map((r) => (
              <li key={r.id} aria-label={r.code} className="group flex h-11 items-center gap-3 rounded-lg px-2 hover:bg-white/[0.03]">
                <span className="w-32 shrink-0 truncate font-mono text-[12.5px] text-fg">{r.code}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/85">{r.displayName}</span>
                <span className="w-20 shrink-0 truncate text-[12px] text-muted">{r.provider || '—'}</span>
                <span className="w-16 shrink-0 text-right text-[12px] text-muted tabular-nums">{plural(r.hostCount, 'host')}</span>
                <span className="flex shrink-0 gap-0.5">
                  <IconButton label={`Edit ${r.code}`} icon={Pencil} onClick={() => setEditing(r)} />
                  <IconButton label={`Delete ${r.code}`} icon={Trash2} onClick={() => askDelete(r)} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <RegionDialog open={editing !== null} region={editing ?? undefined} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}

function IconButton({ label, icon: Icon, onClick }: { label: string; icon: typeof Pencil; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-muted opacity-60 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  )
}
