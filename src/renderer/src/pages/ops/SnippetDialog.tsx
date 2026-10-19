import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { MAX_SCRIPT, MAX_SNIPPET_DESCRIPTION, type SnippetInput } from '../../../../shared/ops'
import { MAX_LABEL } from '../../../../shared/vault'
import { placeholders } from '../../ops/template'
import { saveSnippet, snippetStore } from '../../ops/snippets'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { TextAreaField, TextField } from '../../ui/Field'
import { Switch } from '../../ui/Switch'

export type SnippetRequest = { kind: 'new' } | { kind: 'edit' | 'duplicate'; id: string }

interface Form {
  label: string
  description: string
  tags: string
  script: string
  destructive: boolean
  defaults: Record<string, string>
}

const BLANK: Form = { label: '', description: '', tags: '', script: '', destructive: false, defaults: {} }

function formFor(request: SnippetRequest | null): Form {
  if (!request || request.kind === 'new') return BLANK
  const s = snippetStore.get().snippets.find((x) => x.id === request.id)
  if (!s) return BLANK
  return {
    label: request.kind === 'duplicate' ? `${s.label} copy` : s.label,
    description: s.description,
    tags: s.tags.join(', '),
    script: s.script,
    destructive: s.destructive,
    defaults: Object.fromEntries(s.variables.flatMap((v) => (v.default === null ? [] : [[v.name, v.default]]))),
  }
}

/** A snippet's label, script and variables. A template error from main shows under the script, not as a toast. */
export function SnippetDialog({ request, onClose }: { request: SnippetRequest | null; onClose: () => void }) {
  const formId = useId()
  const { snippets } = useSyncExternalStore(snippetStore.subscribe, snippetStore.get)
  // Keep the last request while the dialog animates out.
  const last = useRef(request)
  if (request) last.current = request
  const r = request ?? last.current
  const [form, setForm] = useState<Form>(() => formFor(r))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const key = request ? (request.kind === 'new' ? 'new' : `${request.kind}:${request.id}`) : null
  useEffect(() => {
    if (!request) return
    setForm(formFor(request))
    setError(null)
    setBusy(false)
    // Reset when the dialog opens or switches snippet, not when the store refreshes mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // An edit of a snippet deleted meanwhile has nothing to show.
  const gone = !!request && request.kind !== 'new' && !snippets.some((s) => s.id === request.id)
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  const names = useMemo(() => placeholders(form.script), [form.script])
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !request) return
    if (!form.label.trim() || !form.script.trim()) return setError('A snippet needs a label and a script.')
    const input: SnippetInput = {
      label: form.label.trim(),
      script: form.script,
      description: form.description.trim(),
      tags: [...new Set(form.tags.split(/[\s,]+/).filter(Boolean))],
      defaults: Object.fromEntries(names.map((n) => [n, form.defaults[n] ? form.defaults[n] : null])),
      destructive: form.destructive,
    }
    setBusy(true)
    const saved = await saveSnippet(request.kind === 'edit' ? request.id : null, input, setError)
    setBusy(false)
    if (saved) onClose()
  }

  const title = r?.kind === 'edit' ? 'Edit snippet' : r?.kind === 'duplicate' ? 'Duplicate snippet' : 'New snippet'
  return (
    <Dialog
      open={request !== null && !gone}
      onClose={onClose}
      title={title}
      description="A saved script. Put {{name}} where a value goes."
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Label" autoFocus maxLength={MAX_LABEL} value={form.label} onChange={(e) => set('label', e.target.value)} />
        <TextField label="Description" maxLength={MAX_SNIPPET_DESCRIPTION} value={form.description} onChange={(e) => set('description', e.target.value)} />
        <TextField label="Tags" hint="Separated by commas." value={form.tags} onChange={(e) => set('tags', e.target.value)} />
        <TextAreaField
          label="Script"
          className="min-h-40 font-mono text-[12.5px]"
          spellCheck={false}
          autoComplete="off"
          maxLength={MAX_SCRIPT}
          hint="Don't put passwords or tokens in a script: it is stored encrypted, but it is still shown in plain text here, and a run's output is kept."
          error={error ?? undefined}
          value={form.script}
          onChange={(e) => set('script', e.target.value)}
        />
        {names.length > 0 && (
          <div aria-label="Variables" className="flex flex-col gap-2 rounded-ui border border-line p-3">
            {names.map((n) => (
              <div key={n} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate rounded-full bg-white/6 px-2 py-0.5 text-center font-mono text-[11.5px] text-fg/90">{n}</span>
                <input
                  aria-label={`Default for ${n}`}
                  placeholder="No default (asked each time)"
                  value={form.defaults[n] ?? ''}
                  onChange={(e) => set('defaults', { ...form.defaults, [n]: e.target.value })}
                  className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface/60 px-2.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent"
                />
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-4">
          <span className="text-[12.5px] text-fg/90">Always ask for confirmation in protected environments</span>
          <Switch label="Always ask for confirmation in protected environments" checked={form.destructive} onChange={(v) => set('destructive', v)} />
        </div>
      </form>
    </Dialog>
  )
}
