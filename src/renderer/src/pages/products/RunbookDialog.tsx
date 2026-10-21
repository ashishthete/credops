import { Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { LOG_TAIL_DEFAULT } from '../../../../shared/ops'
import {
  BUILTIN_LABEL,
  BUILTINS,
  isReadOnlyRunbook,
  MAX_PARAMS,
  ONCE_BUILTINS,
  type BuiltinKind,
  type Runbook,
  type RunbookInput,
  type RunbookItem,
  runbookInput,
  type RunbookParam,
} from '../../../../shared/runbooks'
import type { AppServiceMeta } from '../../../../shared/services'
import { useServices } from '../../deploy/store'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { attempt, ConfirmDialog, type ConfirmRequest } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { SelectField, TextAreaField, TextField } from '../../ui/Field'
import { Switch } from '../../ui/Switch'

const PATTERNS: RunbookParam['pattern'][] = ['identifier', 'number', 'path', 'free']

const itemLabel = (it: RunbookItem) => (it.type === 'builtin' ? BUILTIN_LABEL[it.builtin] : `Step: ${it.step.name}`)

const BLANK: RunbookInput = { environmentId: '', name: '', description: '', targetServiceIds: [], items: [], params: [], lock: true, notify: false }

/** Creates a runbook, or edits (and deletes) the one given. Main validates the whole input again on save. */
export function RunbookDialog({
  environmentId,
  runbook,
  open,
  onClose,
  onSaved,
}: {
  environmentId: string
  runbook: Runbook | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  // The last runbook, so the body stays while the dialog animates out.
  const last = useRef(runbook)
  if (open) last.current = runbook
  return (
    <Dialog open={open} onClose={onClose} width={640} title={last.current ? `Edit ${last.current.name}` : 'New runbook'} description="Saved operations you can run on this environment's services.">
      {open && <Body key={runbook?.id ?? 'new'} environmentId={environmentId} runbook={runbook} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  )
}

function Body({ environmentId, runbook, onClose, onSaved }: { environmentId: string; runbook: Runbook | null; onClose: () => void; onSaved: () => void }) {
  const formId = useId()
  const apps = useServices(environmentId).filter((s): s is AppServiceMeta => s.kind === 'service')
  const [draft, setDraft] = useState<RunbookInput>(() => (runbook ? runbookInput(runbook) : { ...BLANK, environmentId }))
  const [add, setAdd] = useState<BuiltinKind>('restart')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const set = (patch: Partial<RunbookInput>) => setDraft((d) => ({ ...d, ...patch }))
  const readOnly = isReadOnlyRunbook(draft)
  useEffect(() => setError(null), [draft])

  const addItem = () => {
    if (ONCE_BUILTINS.includes(add) && draft.items.some((i) => i.type === 'builtin' && i.builtin === add)) return setError(`${BUILTIN_LABEL[add]} can be in a runbook only once`)
    set({ items: [...draft.items, add === 'logs' ? { type: 'builtin', builtin: add, tail: LOG_TAIL_DEFAULT } : { type: 'builtin', builtin: add }] })
  }
  const setParam = (i: number, patch: Partial<RunbookParam>) => set({ params: draft.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) })
  // A choice has no pattern to match and a text param has no choices; the one that no longer applies is reset.
  const setKind = (i: number, type: RunbookParam['type']) => setParam(i, type === 'choice' ? { type, pattern: 'identifier' } : { type, choices: [] })

  const submit = async () => {
    setBusy(true)
    const out = await attempt("Couldn't save the runbook", () => api.invoke('runbook:save', { ...draft, ...(runbook ? { id: runbook.id } : {}) }), setError)
    setBusy(false)
    if (!out) return
    onSaved()
    onClose()
  }

  const remove = () => {
    if (!runbook) return
    setConfirm({
      title: `Delete ${runbook.name}?`,
      description: 'Past runs stay in the history.',
      confirmLabel: 'Delete',
      run: async () => {
        const ok = await attempt("Couldn't delete the runbook", async () => {
          await api.invoke('runbook:delete', runbook.id)
          return true
        })
        if (ok) {
          onSaved()
          onClose()
        }
      },
    })
  }

  return (
    <>
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <TextField label="Name" value={draft.name} autoFocus onChange={(e) => set({ name: e.target.value })} />
        <TextAreaField label="Description" value={draft.description} rows={2} onChange={(e) => set({ description: e.target.value })} />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[12.5px] font-medium text-fg/90">Services</legend>
          {apps.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-[12.5px] text-fg/90">
              <input
                type="checkbox"
                checked={draft.targetServiceIds.includes(s.id)}
                onChange={(e) => set({ targetServiceIds: e.target.checked ? [...draft.targetServiceIds, s.id] : draft.targetServiceIds.filter((x) => x !== s.id) })}
                className="size-3.5 rounded accent-(--accent)"
              />
              {s.name}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-fg/90">Steps</span>
          <ol aria-label="Runbook steps" className="flex flex-col gap-1">
            {draft.items.map((it, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-fg/90">
                <span className="flex-1">{itemLabel(it)}</span>
                <button type="button" aria-label={`Remove ${itemLabel(it)}`} onClick={() => set({ items: draft.items.filter((_, j) => j !== i) })} className="text-muted hover:text-fg">
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <SelectField label="Add a step" value={add} onChange={(e) => setAdd(e.target.value as BuiltinKind)}>
                {BUILTINS.map((b) => (
                  <option key={b} value={b}>
                    {BUILTIN_LABEL[b]}
                  </option>
                ))}
              </SelectField>
            </div>
            <Button variant="ghost" onClick={addItem}>
              Add
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[12.5px] font-medium text-fg/90">Params</span>
          {draft.params.map((p, i) => (
            <div key={i} className="flex items-end gap-2">
              <TextField label={`Param ${i + 1} name`} value={p.name} spellCheck={false} onChange={(e) => setParam(i, { name: e.target.value })} />
              <TextField label={`Param ${i + 1} label`} value={p.label} onChange={(e) => setParam(i, { label: e.target.value })} />
              <SelectField label={`Param ${i + 1} type`} value={p.type} onChange={(e) => setKind(i, e.target.value as RunbookParam['type'])}>
                <option value="text">Text</option>
                <option value="choice">Choice</option>
              </SelectField>
              {p.type === 'choice' ? (
                <TextField
                  label={`Param ${i + 1} choices`}
                  hint="Comma separated"
                  value={p.choices.join(', ')}
                  onChange={(e) => setParam(i, { choices: e.target.value.split(',').map((c) => c.trim()).filter(Boolean) })}
                />
              ) : (
                <SelectField label={`Param ${i + 1} pattern`} value={p.pattern} onChange={(e) => setParam(i, { pattern: e.target.value as RunbookParam['pattern'] })}>
                  {PATTERNS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </SelectField>
              )}
              <button type="button" aria-label={`Remove param ${i + 1}`} onClick={() => set({ params: draft.params.filter((_, j) => j !== i) })} className="mb-2.5 text-muted hover:text-fg">
                <Trash2 aria-hidden className="size-3.5" />
              </button>
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={draft.params.length >= MAX_PARAMS}
              onClick={() => set({ params: [...draft.params, { name: '', label: '', type: 'text', pattern: 'identifier', choices: [] }] })}
            >
              Add a param
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {/* Only a read-only runbook may run without the host lock; main turns the lock on for any other. */}
          <label className="flex items-center gap-2 text-[12.5px] text-fg/90">
            <Switch label="Lock hosts while it runs" checked={readOnly ? draft.lock : true} disabled={!readOnly} onChange={(lock) => set({ lock })} />
            Lock hosts while it runs
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-fg/90">
            <Switch label="Notify when it finishes" checked={draft.notify} onChange={(notify) => set({ notify })} />
            Notify when it finishes
          </label>
        </div>
        {error && (
          <p role="alert" className="text-[12.5px] text-err">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          {runbook && (
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </div>
      </form>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}
