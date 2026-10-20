import { motion } from 'framer-motion'
import { GitCommitHorizontal, ListRestart, Sparkles, Square } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { MAX_NOTES_SUBJECT, type RedactionKind, type ReleaseNotesResult } from '../../../shared/ai'
import { MAX_COMMITS, MAX_RELEASE_NOTES, type CommitInfo } from '../../../shared/deploy'
import { fallbackNotes } from '../../../shared/notes-fallback'
import { parseNotes } from '../../../shared/notes-markdown'
import type { IntegrationStatus } from '../../../shared/settings'
import { api } from '../lib/api'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { plural } from '../ui/common'
import { EmptyState } from '../ui/EmptyState'
import { spring, useMotionSafe } from '../ui/motion'
import { toast } from '../ui/Toaster'
import { NotesPreview } from './NotesPreview'
import { useAiStream } from './stream'

export interface NotesContext {
  environmentId: string
  productName: string | null
  deployments: { id: string; name: string }[]
  version: string | null
}

export interface ReleaseNotesEditorProps {
  commits: CommitInfo[]
  value: string
  onChange: (value: string) => void
  context: NotesContext
}

const KIND_LABEL: Record<RedactionKind, string> = {
  secret: 'secret',
  key: 'key',
  token: 'token',
  env: 'environment value',
  url: 'URL',
  ip: 'IP address',
  host: 'host',
  user: 'username',
  email: 'email address',
}

function wordCount(md: string): number {
  const text = parseNotes(md)
    .flatMap((b) => b.spans.map((s) => s.v))
    .join(' ')
    .trim()
  return text === '' ? 0 : text.split(/\s+/).length
}

type Tab = 'write' | 'preview'
interface Outcome {
  model: string | null
  truncated: boolean
  redactions: ReleaseNotesResult['redactions']
}

/** Release notes: Claude streams a draft the user can edit at any time; the commit list is the fallback. */
export function ReleaseNotesEditor({ commits, value, onChange, context }: ReleaseNotesEditorProps) {
  const motionSafe = useMotionSafe()
  const ids = useId()
  const [status, setStatus] = useState<IntegrationStatus['ai'] | null>(null)
  const [tab, setTab] = useState<Tab>('write')
  const [showCommits, setShowCommits] = useState(false)
  const [showKinds, setShowKinds] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const stream = useAiStream<ReleaseNotesResult>({ onText: onChange })
  const streaming = stream.state === 'streaming'

  useEffect(() => {
    let live = true
    api.invoke('ai:status').then(
      (s) => live && setStatus(s ?? { configured: false, model: '' }),
      () => live && setStatus({ configured: false, model: '' }),
    )
    return () => {
      live = false
    }
  }, [])

  const words = useMemo(() => wordCount(value), [value])

  if (commits.length === 0) {
    return <EmptyState icon={GitCommitHorizontal} title="No new commits" text="Redeploy — no new commits, no notes or notifications" />
  }

  const generate = async (): Promise<void> => {
    setProblem(null)
    setOutcome(null)
    const req = {
      environmentId: context.environmentId,
      productName: context.productName,
      deployments: context.deployments,
      version: context.version,
      commits: commits.slice(0, MAX_COMMITS).map((c) => ({ ...c, subject: c.subject.slice(0, MAX_NOTES_SUBJECT) })),
    }
    const res = await stream.start((requestId) => api.invoke('ai:releaseNotes', requestId, req))
    if (!res) return
    if (res.error?.code === 'cancelled') return
    if (res.error) {
      // Claude failed: keep whatever is in the box (streamed text, or the user's draft) and say why.
      setProblem(res.error.message)
      return
    }
    onChange(res.text.slice(0, MAX_RELEASE_NOTES))
    setOutcome({ model: res.model, truncated: res.truncated, redactions: res.redactions })
  }

  const edit = (next: string): void => {
    if (streaming) {
      stream.stop()
      toast({ title: 'Stopped — your edits win', tone: 'info' })
    }
    onChange(next)
  }

  const configured = status?.configured === true
  const model = outcome?.model ?? (status?.model || null)
  const redacted = Object.entries(outcome?.redactions ?? {}).filter(([, n]) => (n ?? 0) > 0) as [RedactionKind, number][]
  const redactedTotal = redacted.reduce((a, [, n]) => a + n, 0)
  const errorMessage = problem ?? (stream.state === 'error' ? stream.error : null)
  const genLabel = streaming ? 'Stop' : stream.state === 'idle' ? 'Generate with Claude' : 'Regenerate'

  return (
    <div className="rounded-xl border border-line bg-surface-2/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          aria-expanded={showCommits}
          aria-controls={`${ids}-commits`}
          onClick={() => setShowCommits((v) => !v)}
          className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted hover:text-fg"
        >
          {plural(commits.length, 'commit')}
        </button>
        {model && <Badge tone="info">{model}</Badge>}
        <span className="flex-1" />
        {configured && (
          <Button
            size="sm"
            variant={streaming ? 'ghost' : 'primary'}
            icon={streaming ? <Square className="size-3.5" /> : <Sparkles className="size-3.5" />}
            onClick={() => (streaming ? stream.stop() : void generate())}
          >
            {genLabel}
          </Button>
        )}
      </div>
      {showCommits && (
        <ul id={`${ids}-commits`} className="max-h-40 overflow-auto border-b border-line px-4 py-2 text-[12px] text-muted">
          {commits.map((c) => (
            <li key={`${c.deploymentId}:${c.sha}`} className="truncate">
              {c.subject}
            </li>
          ))}
        </ul>
      )}
      {status && !configured && (
        <div role="note" className="mx-3 mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
          Claude isn't set up, so the notes come from the commit list.{' '}
          <a href="#/settings" className="text-accent underline">
            Open Settings
          </a>
        </div>
      )}
      <div role="tablist" aria-label="Notes view" className="flex gap-4 px-3 pt-2">
        {(['write', 'preview'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`relative pb-1.5 text-[12.5px] ${tab === t ? 'text-fg' : 'text-muted hover:text-fg'}`}
          >
            {t === 'write' ? 'Write' : 'Preview'}
            {tab === t &&
              (motionSafe ? (
                <motion.span data-motion="underline" layoutId={`${ids}-underline`} transition={spring} className="absolute inset-x-0 -bottom-px h-0.5 rounded bg-accent" />
              ) : (
                <span className="absolute inset-x-0 -bottom-px h-0.5 rounded bg-accent" />
              ))}
          </button>
        ))}
      </div>
      <div className="relative p-3">
        {tab === 'write' ? (
          <>
            <textarea
              aria-label="Release notes"
              value={value}
              maxLength={MAX_RELEASE_NOTES}
              onChange={(e) => edit(e.target.value)}
              placeholder="## Features&#10;- …"
              className="min-h-48 w-full resize-y rounded-lg border border-line bg-surface-1 px-3 py-2 font-mono text-[12.5px] leading-5 outline-none focus:border-accent"
            />
            {streaming && motionSafe && (
              <span data-caret aria-hidden className="pointer-events-none absolute right-6 bottom-6 animate-pulse text-accent">
                ▍
              </span>
            )}
          </>
        ) : (
          <div className="min-h-48 rounded-lg border border-line bg-surface-1 px-4 py-3">
            {value.trim() === '' ? <p className="text-[12.5px] text-muted">Nothing to preview yet</p> : <NotesPreview markdown={value} />}
          </div>
        )}
        {errorMessage && (
          <p role="alert" className="mt-2 text-[12.5px] text-err">
            {errorMessage}
          </p>
        )}
        {outcome?.truncated && <p className="mt-2 text-[12.5px] text-warn">Cut off at the length limit</p>}
      </div>
      <div className="relative flex flex-wrap items-center gap-3 border-t border-line px-3 py-2 text-[12px] text-muted">
        {redactedTotal > 0 && (
          <span className="relative">
            <button type="button" aria-expanded={showKinds} onClick={() => setShowKinds((v) => !v)} className="underline decoration-dotted hover:text-fg">
              {plural(redactedTotal, 'value')} redacted
            </button>
            {showKinds && (
              <ul className="absolute bottom-6 left-0 z-10 min-w-40 rounded-lg border border-line bg-surface-1 px-3 py-2 text-fg shadow-lg">
                {redacted.map(([k, n]) => (
                  <li key={k}>{plural(n, KIND_LABEL[k])}</li>
                ))}
              </ul>
            )}
          </span>
        )}
        <span>{plural(words, 'word')}</span>
        <span className="flex-1" />
        <Button size="sm" variant={configured || status === null ? 'ghost' : 'primary'} icon={<ListRestart className="size-3.5" />} onClick={() => edit(fallbackNotes(commits))}>
          Use commit list instead
        </Button>
      </div>
    </div>
  )
}
