import { AnimatePresence } from 'framer-motion'
import { ClipboardCopy, KeyRound, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { SshKeyMeta, SshKeySource } from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { toast } from '../../ui/Toaster'
import type { Tone } from '../../ui/tone'
import { attempt, ListRow, RowMenu, type ConfirmRequest } from './common'
import { RenameKeyDialog } from './KeyDialogs'

const SOURCE_TONE: Record<SshKeySource, Tone> = { file: 'info', imported: 'warn', generated: 'success' }

interface KeysPanelProps {
  keys: SshKeyMeta[]
  stagger: boolean
  onChanged: (next: SshKeyMeta) => void
  onDeleted: (id: string) => void
  confirm: (req: ConfirmRequest) => void
}

export function KeysPanel({ keys, stagger, onChanged, onDeleted, confirm }: KeysPanelProps) {
  const [renaming, setRenaming] = useState<SshKeyMeta | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  return (
    <>
      <ul className="flex flex-col">
        <AnimatePresence initial={stagger}>
          {keys.map((k, i) => (
            <KeyRow
              key={k.id}
              sshKey={k}
              index={i}
              stagger={stagger}
              onRename={() => {
                setRenaming(k)
                setRenameOpen(true)
              }}
              onDelete={() =>
                confirm({
                  title: `Delete ${k.label}?`,
                  description:
                    k.source === 'file'
                      ? 'OpsDeck forgets this key. The file in ~/.ssh is left alone.'
                      : 'The private key is removed from this vault for good.',
                  confirmLabel: 'Delete key',
                  run: async () => {
                    const ok = await attempt("Couldn't delete the key", async () => {
                      await api.invoke('key:delete', k.id)
                      return true
                    })
                    if (ok) {
                      onDeleted(k.id)
                      toast({ title: `Deleted ${k.label}`, tone: 'success' })
                    }
                  },
                })
              }
            />
          ))}
        </AnimatePresence>
      </ul>
      <RenameKeyDialog
        open={renameOpen}
        sshKey={renaming}
        onClose={() => setRenameOpen(false)}
        onSaved={(k) => {
          onChanged(k)
          setRenameOpen(false)
        }}
      />
    </>
  )
}

interface KeyRowProps {
  sshKey: SshKeyMeta
  index: number
  stagger: boolean
  onRename: () => void
  onDelete: () => void
}

function KeyRow({ sshKey: k, index, stagger, onRename, onDelete }: KeyRowProps) {
  const copyPublic = async () => {
    const ok = await attempt("Couldn't copy the public key", async () => {
      await api.invoke('key:copyPublic', k.id)
      return true
    })
    if (ok) toast({ title: 'Public key copied', tone: 'success' })
  }

  return (
    <ListRow label={k.label} index={index} stagger={stagger}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent shadow-[inset_0_0_0_1px_var(--border)]">
        <KeyRound aria-hidden className="size-4" strokeWidth={1.9} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{k.label}</span>
          <Badge tone={SOURCE_TONE[k.source]}>{k.source}</Badge>
          {k.hasPassphrase && (
            <Badge tone="warn" dot>
              Encrypted
            </Badge>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2.5 font-mono text-[11.5px] leading-4">
          <span className="shrink-0 text-fg/70">{k.keyType}</span>
          <span className="truncate text-muted" title={k.fingerprint}>
            {k.fingerprint}
          </span>
        </div>
        {k.filePath && <span className="truncate font-mono text-[11px] text-muted/70">{k.filePath}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          icon={<ClipboardCopy aria-hidden className="size-3.5" />}
          onClick={() => void copyPublic()}
        >
          Copy public key
        </Button>
        <RowMenu
          label={`${k.label} options`}
          items={[
            { label: 'Rename', icon: Pencil, run: onRename },
            { label: 'Delete', icon: Trash2, run: onDelete, danger: true },
          ]}
        />
      </div>
    </ListRow>
  )
}
