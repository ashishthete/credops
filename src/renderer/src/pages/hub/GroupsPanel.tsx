import { Check, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { HubGroup } from '../../../../shared/hub'
import { addGrant, addMembers, createGroup, deleteGroup, removeGrant, removeMember, renameGroup, useHub } from '../../hub/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ConfirmDialog, plural, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { TextField } from '../../ui/Field'
import { GrantPicker, grantLabel, useGrantEnvs } from './GrantPicker'
import { ListSkeleton } from './shared'


export function GroupsPanel() {
  const { groups, adminLoaded } = useHub()
  const [name, setName] = useState('')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // Default first and pinned; the rest by name.
  const sorted = [...groups].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name))

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    if (await createGroup(name.trim())) setName('')
  }

  if (!adminLoaded) return <ListSkeleton />
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <form onSubmit={(e) => void create(e)} className="flex items-end gap-2">
        <div className="flex-1">
          <TextField label="New group" placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" icon={<Plus aria-hidden className="size-3.5" />} disabled={!name.trim()}>
          Create group
        </Button>
      </form>
      {sorted.length === 0 && <EmptyState icon={ShieldCheck} title="No groups yet" text="Create a group to decide who can deploy what." />}
      {sorted.map((g) => (
        <GroupCard key={g.id} group={g} onDelete={setConfirm} />
      ))}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

function GroupCard({ group: g, onDelete }: { group: HubGroup; onDelete: (r: ConfirmRequest) => void }) {
  const { users } = useHub()
  const envs = useGrantEnvs()
  const scopeLabel = (s: HubGroup['grants'][number]['scope']) => grantLabel(s, envs)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(g.name)
  const [pick, setPick] = useState('')
  const byOid = new Map(users.map((u) => [u.oid, u]))
  const candidates = users.filter((u) => u.status !== 'disabled' && !g.memberOids.includes(u.oid))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    if (await renameGroup(g.id, draft.trim())) setRenaming(false)
  }

  return (
    <article aria-label={g.name} className="rounded-xl border border-line bg-surface/70 p-4">
      <header className="flex items-center justify-between gap-3">
        {renaming ? (
          <form onSubmit={(e) => void save(e)} className="flex items-center gap-2">
            <input
              aria-label={`New name for ${g.name}`}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 rounded-md border border-line bg-surface-2/60 px-2 text-[13px] text-fg"
            />
            <Button size="sm" type="submit" aria-label="Save name" icon={<Check aria-hidden className="size-3.5" />} />
            <Button size="sm" variant="ghost" aria-label="Cancel rename" icon={<X aria-hidden className="size-3.5" />} onClick={() => setRenaming(false)} />
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[14px] font-semibold text-fg">{g.name}</h3>
            {g.builtin && <Badge tone="info">Built in</Badge>}
            <span className="text-[12px] text-muted">{plural(g.memberOids.length, 'member')}</span>
          </div>
        )}
        {!g.builtin && !renaming && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" aria-label={`Rename ${g.name}`} icon={<Pencil aria-hidden className="size-3.5" />} onClick={() => { setDraft(g.name); setRenaming(true) }} />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${g.name}`}
              icon={<Trash2 aria-hidden className="size-3.5" />}
              onClick={() =>
                onDelete({
                  title: `Delete ${g.name}?`,
                  description: 'Its members stay in the Hub but lose the access this group gave them.',
                  confirmLabel: 'Delete group',
                  run: async () => {
                    await deleteGroup(g.id)
                  },
                })
              }
            />
          </div>
        )}
      </header>
      {g.description && <p className="mt-1 text-[12.5px] text-muted">{g.description}</p>}

      <h4 className="mt-4 mb-1.5 text-[12px] font-semibold text-fg/90">Members</h4>
      <ul className="flex flex-wrap gap-1.5">
        {g.memberOids.length === 0 && <li className="text-[12.5px] text-muted">No members yet</li>}
        {g.memberOids.map((oid) => {
          const label = byOid.get(oid)?.name ?? oid
          return (
            <li key={oid} className="inline-flex h-6 items-center gap-1 rounded-full bg-white/[0.05] pr-1 pl-2.5 text-[12px] text-fg">
              {label}
              <button
                type="button"
                aria-label={`Remove ${label} from ${g.name}`}
                onClick={() => void removeMember(g.id, oid)}
                className="grid size-4 place-items-center rounded-full text-muted hover:bg-white/10 hover:text-fg"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <select
          aria-label={`Add member to ${g.name}`}
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="h-7 rounded-md border border-line bg-surface-2/60 px-2 text-[12.5px] text-fg"
        >
          <option value="">Choose a person…</option>
          {candidates.map((u) => (
            <option key={u.oid} value={u.oid}>
              {u.name} ({u.upn})
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="ghost"
          disabled={!pick}
          aria-label={`Add to ${g.name}`}
          onClick={async () => {
            if (await addMembers(g.id, [pick])) setPick('')
          }}
        >
          Add
        </Button>
      </div>

      <h4 className="mt-4 mb-1.5 text-[12px] font-semibold text-fg/90">Grants</h4>
      <ul className="flex flex-col gap-1">
        {g.grants.length === 0 && <li className="text-[12.5px] text-muted">No grants: members can't deploy anything.</li>}
        {g.grants.map((gr) => (
          <li key={gr.id} className="flex items-center justify-between text-[13px] text-fg">
            {scopeLabel(gr.scope)}
            <Button size="sm" variant="ghost" aria-label={`Remove grant ${scopeLabel(gr.scope)} from ${g.name}`} onClick={() => void removeGrant(gr.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <GrantPicker groupName={g.name} onAdd={(scope) => addGrant(g.id, scope)} />
    </article>
  )
}
