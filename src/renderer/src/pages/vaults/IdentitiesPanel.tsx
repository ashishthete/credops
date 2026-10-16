import { AnimatePresence } from 'framer-motion'
import { Fingerprint, KeyRound, Pencil, RectangleEllipsis, Trash2, UserRound } from 'lucide-react'
import { useState } from 'react'
import type { IdentityMeta, SshKeyMeta } from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { toast } from '../../ui/Toaster'
import { attempt, ListRow, RowMenu, type ConfirmRequest } from '../../ui/common'
import { IdentityDialog } from './IdentityDialog'

interface IdentitiesPanelProps {
  identities: IdentityMeta[]
  keys: SshKeyMeta[]
  stagger: boolean
  onChanged: (next: IdentityMeta) => void
  onDeleted: (id: string) => void
  confirm: (req: ConfirmRequest) => void
}

export function IdentitiesPanel({ identities, keys, stagger, onChanged, onDeleted, confirm }: IdentitiesPanelProps) {
  // Kept after close so the dialog keeps its content while it animates out.
  const [editing, setEditing] = useState<IdentityMeta | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  return (
    <>
      <ul className="flex flex-col">
        <AnimatePresence initial={stagger}>
          {identities.map((idn, i) => (
            <IdentityRow
              key={idn.id}
              identity={idn}
              sshKey={keys.find((k) => k.id === idn.sshKeyId)}
              index={i}
              stagger={stagger}
              onEdit={() => {
                setEditing(idn)
                setEditOpen(true)
              }}
              onDelete={() =>
                confirm({
                  title: `Delete ${idn.label}?`,
                  description: 'Hosts using this identity will need another one to connect.',
                  confirmLabel: 'Delete identity',
                  run: async () => {
                    const ok = await attempt("Couldn't delete the identity", async () => {
                      await api.invoke('identity:delete', idn.id)
                      return true
                    })
                    if (ok) {
                      onDeleted(idn.id)
                      toast({ title: `Deleted ${idn.label}`, tone: 'success' })
                    }
                  },
                })
              }
            />
          ))}
        </AnimatePresence>
      </ul>
      <IdentityDialog
        open={editOpen}
        vaultId={editing?.vaultId ?? ''}
        keys={keys}
        identity={editing ?? undefined}
        onClose={() => setEditOpen(false)}
        onSaved={(idn) => {
          onChanged(idn)
          setEditOpen(false)
        }}
      />
    </>
  )
}

interface IdentityRowProps {
  identity: IdentityMeta
  sshKey: SshKeyMeta | undefined
  index: number
  stagger: boolean
  onEdit: () => void
  onDelete: () => void
}

function IdentityRow({ identity: idn, sshKey, index, stagger, onEdit, onDelete }: IdentityRowProps) {
  const how =
    idn.auth === 'agent'
      ? { icon: Fingerprint, text: 'SSH agent' }
      : idn.auth === 'key'
        ? { icon: KeyRound, text: sshKey?.label ?? 'Missing key' }
        : { icon: RectangleEllipsis, text: idn.hasPassword ? 'Password' : 'No password stored' }
  return (
    <ListRow label={idn.label} index={index} stagger={stagger}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted shadow-[inset_0_0_0_1px_var(--border)]">
        <UserRound aria-hidden className="size-4" strokeWidth={1.9} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[13px] font-medium text-fg">{idn.label}</span>
        <span className="truncate font-mono text-[11.5px] text-muted">{idn.username}</span>
      </div>
      <Badge tone={idn.auth === 'key' && !sshKey ? 'warn' : 'info'} className="shrink-0">
        <how.icon aria-hidden className="size-3" />
        {how.text}
      </Badge>
      <RowMenu
        label={`${idn.label} options`}
        items={[
          { label: 'Edit', icon: Pencil, run: onEdit },
          { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
        ]}
      />
    </ListRow>
  )
}
