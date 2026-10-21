import { Pencil, Play, Plus, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { isReadOnlyRunbook, RUNBOOK_TEMPLATES, type Runbook } from '../../../../shared/runbooks'
import type { AppServiceMeta } from '../../../../shared/services'
import { useServices } from '../../deploy/store'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { attempt, plural } from '../../ui/common'
import { RunbookDialog } from './RunbookDialog'
import { RunRunbookDialog } from './RunRunbookDialog'

/** An environment's saved operations: run one, edit it, or start one from a template. */
export function RunbooksSection({ environmentId }: { environmentId: string }) {
  const apps = useServices(environmentId).filter((s): s is AppServiceMeta => s.kind === 'service')
  const [runbooks, setRunbooks] = useState<Runbook[] | null>(null)
  const [templates, setTemplates] = useState(false)
  const [running, setRunning] = useState<Runbook | null>(null)
  // "new" starts a runbook, a runbook edits it; null is closed.
  const [editing, setEditing] = useState<Runbook | 'new' | null>(null)

  const load = useCallback(async () => {
    const list = await attempt("Couldn't load the runbooks", () => api.invoke('runbook:list', environmentId))
    if (list) setRunbooks(list)
  }, [environmentId])
  useEffect(() => void load(), [load])

  // A template is saved only when picked, aimed at every service here; the person edits the targets after.
  const create = async (id: (typeof RUNBOOK_TEMPLATES)[number]['id']) => {
    const tpl = RUNBOOK_TEMPLATES.find((t) => t.id === id)
    if (!tpl) return
    setTemplates(false)
    const input = { ...tpl.build(apps.map((s) => s.id)), environmentId }
    const saved = await attempt("Couldn't create the runbook", () => api.invoke('runbook:save', input))
    if (saved) void load()
  }

  return (
    <section aria-label="Runbooks" className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-[12.5px] font-semibold text-fg/90">Runbooks</h3>
        <Button size="sm" variant="ghost" icon={<Wand2 aria-hidden className="size-3.5" />} aria-expanded={templates} onClick={() => setTemplates((t) => !t)}>
          New from template
        </Button>
        <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing('new')}>
          New runbook
        </Button>
      </div>
      {templates && (
        <div role="group" aria-label="Templates" className="mb-2 flex flex-wrap gap-1.5">
          {RUNBOOK_TEMPLATES.map((t) => (
            <Button key={t.id} size="sm" variant="ghost" onClick={() => void create(t.id)}>
              {t.name}
            </Button>
          ))}
        </div>
      )}
      {runbooks && runbooks.length === 0 && <p className="text-[12.5px] text-muted">No runbooks yet. Start from a template, or write your own.</p>}
      {!!runbooks?.length && (
        <ul aria-label="Runbook list" className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {runbooks.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-fg">{r.name}</span>
                {r.description && <span className="truncate text-[12px] text-muted">{r.description}</span>}
              </div>
              {isReadOnlyRunbook(r) && <Badge tone="info">Read-only</Badge>}
              <span className="text-[12px] text-muted">{plural(r.targetServiceIds.length, 'service')}</span>
              <Button size="sm" variant="ghost" aria-label={`Edit ${r.name}`} icon={<Pencil aria-hidden className="size-3.5" />} onClick={() => setEditing(r)}>
                Edit
              </Button>
              <Button size="sm" aria-label={`Run ${r.name}`} icon={<Play aria-hidden className="size-3.5" />} onClick={() => setRunning(r)}>
                Run
              </Button>
            </li>
          ))}
        </ul>
      )}
      <RunbookDialog
        environmentId={environmentId}
        runbook={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
      {running && <RunRunbookDialog key={running.id} runbook={running} onClose={() => setRunning(null)} />}
    </section>
  )
}
