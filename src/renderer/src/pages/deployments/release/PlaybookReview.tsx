import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlaybookEditError } from '../../../../../shared/deploy'
import { isHelperTask, playbookSteps, stepLabels, type PlaybookStep } from '../../../../../shared/playbook-steps'
import { api } from '../../../lib/api'
import { Button } from '../../../ui/Button'
import { errorText } from '../../../ui/common'

/** The tasks as the release view names them: helpers left out, a step's several tasks numbered. */
function Tasks({ steps, custom }: { steps: PlaybookStep[]; custom?: Record<string, string> }) {
  const tasks = steps.filter((s) => !isHelperTask(s.name))
  const labels = stepLabels(tasks, custom)
  return tasks.map((s, j) => <li key={`${s.kind}:${j}`}>{labels[j]}</li>)
}

/** A flow playbook's plays are named by their part of the release; a per-host one's by position. */
function playHeading(name: string, i: number): string {
  if (name === 'release prepare') return 'Prepare'
  if (name === 'release tag') return 'Tag'
  const stage = /^release stage (\d+)$/.exec(name)
  return stage ? `Stage ${Number(stage[1]) + 1}` : `Host ${i + 1}`
}

/** How long typing pauses before the edit is checked. */
const VALIDATE_DEBOUNCE_MS = 400

type Checked = { state: 'checking' } | { state: 'ok'; sha256: string } | { state: 'errors'; errors: PlaybookEditError[] } | { state: 'failed'; message: string }

/**
 * The editor for the reviewed (masked) text: each pause in typing asks main to validate it, and only an `ok` answer
 * can be run, with the hash main gave for it. A late answer for older text is dropped.
 */
function PlaybookEditor({
  initial,
  releaseId,
  forceServiceIds,
  onChange,
  onPreviewAgain,
  onRun,
  onCancel,
}: {
  initial: string
  releaseId: string
  forceServiceIds?: string[]
  onChange?: (editing: boolean) => void
  onPreviewAgain?: () => void
  onRun: (text: string, sha256: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  // Nothing is runnable until the text has been checked: the unchanged preview is run with Deploy.
  const [checked, setChecked] = useState<Checked | null>(null)
  const latest = useRef(initial)
  const force = forceServiceIds?.join(',')
  useEffect(() => {
    onChange?.(true)
    return () => onChange?.(false)
  }, [onChange])
  const edit = (next: string) => {
    latest.current = next
    setText(next)
    setChecked({ state: 'checking' })
  }
  useEffect(() => {
    if (checked === null) return
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.invoke('release:validateEdit', releaseId, text, ...(forceServiceIds?.length ? [forceServiceIds] : []))
          if (latest.current !== text) return
          setChecked(res.ok ? { state: 'ok', sha256: res.sha256 } : { state: 'errors', errors: res.errors })
        } catch (err) {
          if (latest.current === text) setChecked({ state: 'failed', message: errorText(err) })
        }
      })()
    }, VALIDATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // The answer being stored is not a new edit to check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, releaseId, force])
  const lines = text.split('\n')
  const bad = new Set(checked?.state === 'errors' ? checked.errors.map((e) => e.line) : [])
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-h-0 overflow-hidden rounded-lg bg-canvas/70 font-mono text-[11.5px] leading-[18px]">
        <pre aria-hidden className="max-h-[50vh] shrink-0 overflow-hidden py-3 pr-2 pl-3 text-right text-muted select-none">
          {lines.map((_, i) => (
            <span key={i} className={`block ${bad.has(i + 1) ? 'font-semibold text-err' : ''}`}>
              {i + 1}
            </span>
          ))}
        </pre>
        <textarea
          aria-label="Edit playbook"
          value={text}
          spellCheck={false}
          wrap="off"
          onChange={(e) => edit(e.target.value)}
          className="max-h-[50vh] min-h-[40vh] min-w-0 flex-1 resize-none overflow-auto bg-transparent py-3 pr-3 whitespace-pre text-fg/90 outline-none"
        />
      </div>
      {checked?.state === 'errors' && (
        <ul aria-label="Playbook problems" className="flex flex-col gap-0.5 text-[12px] text-err">
          {checked.errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono">{`Line ${e.line}`}</span>
              {`: ${e.message}`}
            </li>
          ))}
        </ul>
      )}
      {checked?.state === 'failed' && (
        <div role="alert" className="flex items-center gap-2 text-[12px] text-err">
          <span>{checked.message}</span>
          {onPreviewAgain && /preview again/i.test(checked.message) && (
            <Button size="sm" variant="ghost" onClick={onPreviewAgain}>
              Preview again
            </Button>
          )}
        </div>
      )}
      {checked?.state === 'checking' && <p className="text-[12px] text-muted">Checking</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={checked?.state !== 'ok'} onClick={() => checked?.state === 'ok' && onRun(text, checked.sha256)}>
          Run edited
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Discard edit
        </Button>
      </div>
    </div>
  )
}

/**
 * The playbook a release will run: its steps per deployment on the left, the full text on the right.
 * `customLabels`: per run id, its custom steps' labels by key (the run rows' `label`/`key`).
 */
export function PlaybookReview({
  playbook,
  autoRollback,
  onSave,
  customLabels = {},
  inventory,
  editable = false,
  releaseId,
  forceServiceIds,
  onRunEdited,
  onEditingChange,
  onPreviewAgain,
}: {
  playbook: string | null
  /** With a release flow: the inventory the hash covers too (host vars and the version, no secret values). */
  inventory?: string
  autoRollback: boolean
  onSave: () => void
  customLabels?: Record<string, Record<string, string>>
  /** Offers Edit: the text is checked by `release:validateEdit` for `releaseId`, with the same forced services as the preview. */
  editable?: boolean
  releaseId?: string
  forceServiceIds?: string[]
  /** The edited text as typed (masked, as shown) and the hash main gave for it; the caller starts the release with both. */
  onRunEdited?: (text: string, sha256: string) => void
  onEditingChange?: (editing: boolean) => void
  /** Offered when main no longer holds the preview the edit is checked against. */
  onPreviewAgain?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const plays = useMemo(() => (playbook === null ? [] : playbookSteps(playbook)), [playbook])
  // A new preview replaces the text being edited.
  useEffect(() => setEditing(false), [playbook])
  if (playbook === null) return <p className="text-[12px] text-muted">Generating the playbook</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-[12.5px] text-fg/90">This is exactly what will run. Deploy runs it unchanged.</p>
        {editable && releaseId && onRunEdited && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {!editing && (
          <Button size="sm" variant="ghost" onClick={onSave}>
            Save as .yml…
          </Button>
        )}
      </div>
      <div className="flex min-h-0 gap-3">
        <ol aria-label="Playbook steps" className="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto text-[12px]">
          {plays.map((play, i) => (
            <li key={i} className="flex flex-col gap-1.5">
              {plays.length > 1 && <span className="text-[11px] tracking-wide text-muted uppercase">{playHeading(play.name, i)}</span>}
              {play.steps.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-fg/85">
                  <Tasks steps={play.steps} />
                </ul>
              )}
              {play.deployments.map((d) => (
                <div key={d.runId ?? d.name} className="flex flex-col gap-0.5">
                  <span className="font-medium text-fg">{d.name}</span>
                  <ul className="flex flex-col gap-0.5 pl-2 text-fg/85">
                    <Tasks steps={d.steps} custom={d.runId ? customLabels[d.runId] : undefined} />
                    {d.rollback && <li className="text-muted">{autoRollback ? 'Roll back if a step fails' : 'Stop if a step fails'}</li>}
                  </ul>
                </div>
              ))}
            </li>
          ))}
        </ol>
        {editing && releaseId && onRunEdited ? (
          <PlaybookEditor
            initial={playbook}
            releaseId={releaseId}
            forceServiceIds={forceServiceIds}
            onChange={onEditingChange}
            onPreviewAgain={onPreviewAgain}
            onRun={onRunEdited}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <pre className="max-h-[50vh] min-w-0 flex-1 overflow-auto rounded-lg bg-canvas/70 p-3 font-mono text-[11.5px] whitespace-pre text-fg/90">{playbook}</pre>
        )}
      </div>
      {inventory !== undefined && (
        <pre
          aria-label="Inventory (hashed with the playbook)"
          className="max-h-[30vh] overflow-auto rounded-lg bg-canvas/70 p-3 font-mono text-[11.5px] whitespace-pre text-fg/90"
        >
          {inventory}
        </pre>
      )}
    </div>
  )
}
