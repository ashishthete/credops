import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import type { SnippetMeta } from '../../../../shared/ops'
import { insertSnippet, insertStore, onInserted, requestInsert } from '../../ops/insert'
import { loadSnippets, snippetStore } from '../../ops/snippets'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { TextField } from '../../ui/Field'

/**
 * The insert dialogs, mounted once by the shell so the palette, the terminal toolbar and the Snippets tab share them:
 * a picker of snippets, and the fields for one snippet's variables.
 */
export function InsertHost() {
  const request = useSyncExternalStore(insertStore.subscribe, insertStore.get)
  const navigate = useNavigate()
  useEffect(() => {
    onInserted(() => navigate('/terminals'))
    return () => onInserted(null)
  }, [navigate])
  const { snippets, loaded } = useSyncExternalStore(snippetStore.subscribe, snippetStore.get)
  useEffect(() => {
    if (request && !loaded) void loadSnippets()
  }, [request, loaded])
  // Keep the last request while the dialog animates out.
  const last = useRef(request)
  if (request) last.current = request
  const r = request ?? last.current
  const close = () => insertStore.set(null)
  const snippet = r?.kind === 'fill' ? snippets.find((s) => s.id === r.snippetId) : undefined
  // A snippet deleted while its fields were open has nothing to insert.
  useEffect(() => {
    if (request?.kind === 'fill' && loaded && !snippet) close()
  }, [request, loaded, snippet])

  return (
    <>
      <Dialog open={request?.kind === 'pick'} onClose={close} title="Insert a snippet" description="It is typed into the active terminal. Nothing runs until you press Enter." width={420}>
        {snippets.length === 0 ? (
          <p className="text-[12.5px] text-muted">{loaded ? 'No snippets yet. Add one on the Ops page.' : 'Loading…'}</p>
        ) : (
          <ul aria-label="Snippets" className="-mx-1 max-h-72 overflow-y-auto">
            {snippets.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    close()
                    requestInsert(s.id)
                  }}
                  className="flex h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-[13px] text-fg/90 transition-colors hover:bg-white/6 focus:bg-white/6 focus:outline-none"
                >
                  <span className="truncate">{s.label}</span>
                  {s.tags[0] && <span className="shrink-0 text-[11.5px] text-muted">{s.tags.join(', ')}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <FillDialog snippet={request?.kind === 'fill' ? snippet : undefined} onClose={close} />
    </>
  )
}

function FillDialog({ snippet, onClose }: { snippet: SnippetMeta | undefined; onClose: () => void }) {
  const last = useRef(snippet)
  if (snippet) last.current = snippet
  const s = snippet ?? last.current
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!snippet) return
    setValues(Object.fromEntries(snippet.variables.map((v) => [v.name, v.default ?? ''])))
    setError(null)
    setBusy(false)
    // Reset when a snippet opens, not when the store refreshes under the fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippet?.id])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!snippet || busy) return
    setBusy(true)
    setError(null)
    // Blank fields are left out, so main uses the default or says what is missing.
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
    const ok = await insertSnippet(snippet, filled, setError)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog
      open={!!snippet}
      onClose={onClose}
      title={s ? `Insert ${s.label}` : ''}
      description="Fill in the variables. The text is typed into the active terminal without Enter."
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="insert-snippet-form" loading={busy}>
            Insert
          </Button>
        </>
      }
    >
      <form id="insert-snippet-form" onSubmit={submit} className="flex flex-col gap-3">
        {s?.variables.map((v, i) => (
          <TextField
            key={v.name}
            autoFocus={i === 0}
            label={v.name}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder={v.default === null ? 'Required' : 'Blank uses the default'}
            value={values[v.name] ?? ''}
            onChange={(e) => setValues((cur) => ({ ...cur, [v.name]: e.target.value }))}
          />
        ))}
        {error && (
          <p role="alert" className="text-[12.5px] text-err">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
