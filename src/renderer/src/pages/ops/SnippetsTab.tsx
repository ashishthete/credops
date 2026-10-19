import { AnimatePresence } from 'framer-motion'
import { Copy, FileCode2, Pencil, Play, Plus, Search, SquareTerminal, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { SnippetMeta } from '../../../../shared/ops'
import { requestInsert } from '../../ops/insert'
import { deleteSnippet, loadSnippets, snippetStore } from '../../ops/snippets'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ConfirmDialog, ListRow, RowMenu, type ConfirmRequest } from '../../ui/common'
import { EmptyState } from '../../ui/EmptyState'
import { Skeleton } from '../../ui/Skeleton'
import { SnippetDialog, type SnippetRequest } from './SnippetDialog'

/** The snippet library: search and tag filters over saved scripts, with run, insert, edit, duplicate and delete. */
export function SnippetsTab() {
  const { snippets, loaded } = useSyncExternalStore(snippetStore.subscribe, snippetStore.get)
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<ReadonlySet<string>>(new Set())
  const [request, setRequest] = useState<SnippetRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const stagger = useRef(true)

  useEffect(() => {
    if (!loaded) void loadSnippets()
  }, [loaded])
  useEffect(() => {
    if (loaded) stagger.current = false
  }, [loaded])

  // The palette's New snippet arrives as ?action=new; open the dialog and drop the param.
  const [params, setParams] = useSearchParams()
  const wanted = params.get('action')
  useEffect(() => {
    if (wanted !== 'new') return
    setRequest({ kind: 'new' })
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.delete('action')
        return out
      },
      { replace: true },
    )
  }, [wanted, setParams])

  const allTags = useMemo(() => [...new Set(snippets.flatMap((s) => s.tags))].sort(), [snippets])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return snippets.filter(
      (s) =>
        (tags.size === 0 || s.tags.some((t) => tags.has(t))) &&
        (!q || [s.label, s.description, ...s.tags].some((x) => x.toLowerCase().includes(q))),
    )
  }, [snippets, query, tags])

  const askDelete = (s: SnippetMeta) =>
    setConfirm({
      title: `Delete ${s.label}?`,
      description: 'The snippet is removed. Runs already started are not affected.',
      confirmLabel: 'Delete',
      run: () => deleteSnippet(s.id),
    })
  const toggle = (t: string) =>
    setTags((cur) => {
      const next = new Set(cur)
      if (!next.delete(t)) next.add(t)
      return next
    })

  const empty = loaded && snippets.length === 0
  const add = () => setRequest({ kind: 'new' })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!empty && (
        <div className="flex items-center gap-3 px-8 pt-4 pb-3">
          <label className="relative block w-72">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
            <input
              type="search"
              aria-label="Search snippets"
              placeholder="Search snippets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-full rounded-md border border-line bg-surface/60 pr-2.5 pl-8 text-[13px] text-fg outline-none placeholder:text-muted focus:border-accent"
            />
          </label>
          <div role="group" aria-label="Filter by tag" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tags.has(t)}
                onClick={() => toggle(t)}
                className={`h-6 rounded-full border px-2.5 text-[11.5px] transition-colors ${
                  tags.has(t) ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={add}>
            New snippet
          </Button>
        </div>
      )}

      {!loaded ? (
        <div className="flex flex-col gap-2 px-8 pt-6">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-ui" />
          ))}
        </div>
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center pb-16">
          <EmptyState
            icon={FileCode2}
            title="Scripts you run again and again"
            text="Save a command with {{variables}}, then run it on many hosts or type it into a terminal."
            action={{ label: 'New snippet', run: add }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
          {shown.length === 0 ? (
            <p className="pt-12 text-center text-[12.5px] text-muted">No snippet matches.</p>
          ) : (
            <ul className="overflow-hidden rounded-ui border border-line">
              <AnimatePresence initial={stagger.current}>
                {shown.map((s, i) => (
                  <ListRow key={s.id} label={s.label} index={i} stagger={stagger.current}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium text-fg">{s.label}</span>
                        {s.destructive && <Badge tone="warn">Destructive</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {s.description && <span className="mr-1 truncate text-[12px] text-muted">{s.description}</span>}
                        {s.variables.map((v) => (
                          <span key={v.name} className="rounded-full bg-white/6 px-2 py-0.5 font-mono text-[11px] text-fg/80">
                            {v.name}
                          </span>
                        ))}
                        {s.tags.map((t) => (
                          <span key={t} className="text-[11.5px] text-muted">
                            #{t}
                          </span>
                        ))}
                      </div>
                    </div>
                    <RowMenu
                      label={`Actions for ${s.label}`}
                      items={[
                        { label: 'Run', icon: Play, run: () => navigate(`/ops/run?snippet=${encodeURIComponent(s.id)}`) },
                        { label: 'Insert into terminal', icon: SquareTerminal, run: () => requestInsert(s.id) },
                        { label: 'Edit', icon: Pencil, run: () => setRequest({ kind: 'edit', id: s.id }) },
                        { label: 'Duplicate', icon: Copy, run: () => setRequest({ kind: 'duplicate', id: s.id }) },
                        { label: 'Delete', icon: Trash2, danger: true, run: () => askDelete(s) },
                      ]}
                    />
                  </ListRow>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>
      )}
      <SnippetDialog request={request} onClose={() => setRequest(null)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
