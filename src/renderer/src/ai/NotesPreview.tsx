import { motion } from 'framer-motion'
import { Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { parseNotes, type NotesBlock, type Span } from '../../../shared/notes-markdown'
import { Button } from '../ui/Button'
import { fail } from '../ui/common'
import { spring, useMotionSafe } from '../ui/motion'
import { toast } from '../ui/Toaster'

function spans(list: Span[]): ReactNode {
  return list.map((s, i) => {
    if (s.t === 'bold') return <strong key={i}>{s.v}</strong>
    if (s.t === 'code') return <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[12px]">{s.v}</code>
    if (s.t === 'link')
      return (
        <a key={i} href={s.href} target="_blank" rel="noreferrer" className="text-accent underline">
          {s.v}
        </a>
      )
    return <span key={i}>{s.v}</span>
  })
}

/** Groups consecutive bullets into one list, so the preview has real lists. */
function group(blocks: NotesBlock[]): (NotesBlock | { kind: 'ul'; items: NotesBlock[] })[] {
  const out: (NotesBlock | { kind: 'ul'; items: NotesBlock[] })[] = []
  for (const b of blocks) {
    const last = out.at(-1)
    if (b.kind === 'li' && last?.kind === 'ul') last.items.push(b)
    else if (b.kind === 'li') out.push({ kind: 'ul', items: [b] })
    else out.push(b)
  }
  return out
}

/** The rendered notes. Section headings pop in with a spring stagger as each `##` appears (motion-safe). */
export function NotesPreview({ markdown }: { markdown: string }) {
  const motionSafe = useMotionSafe()
  let heading = 0
  return (
    <div className="space-y-2 text-[13px] leading-5">
      {group(parseNotes(markdown)).map((b, i) => {
        if (b.kind === 'ul')
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {b.items.map((li, j) => (
                <li key={j}>{spans(li.spans)}</li>
              ))}
            </ul>
          )
        if (b.kind === 'h') {
          const order = heading++
          const cls = b.level === 2 ? 'pt-1 text-[14px] font-semibold' : 'text-[13px] font-semibold'
          const Tag = b.level === 2 ? 'h3' : 'h4'
          if (!motionSafe) return <Tag key={i} className={cls}>{spans(b.spans)}</Tag>
          const M = b.level === 2 ? motion.h3 : motion.h4
          return (
            <M
              key={i}
              data-motion="heading"
              className={cls}
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ ...spring, delay: order * 0.05 }}
            >
              {spans(b.spans)}
            </M>
          )
        }
        return <p key={i}>{spans(b.spans)}</p>
      })}
    </div>
  )
}

/** Read-only notes with a copy button, for a release's detail view. */
export function ReleaseNotesReadOnly({ notes }: { notes: string | null }) {
  if (!notes || notes.trim() === '') return null
  const copy = (): void => {
    navigator.clipboard.writeText(notes).then(
      () => toast({ title: 'Release notes copied', tone: 'success' }),
      (e: unknown) => fail('Could not copy the release notes', e),
    )
  }
  return (
    <section aria-label="Release notes" className="rounded-xl border border-line bg-surface-1 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Release notes</h2>
        <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={copy}>
          Copy
        </Button>
      </div>
      <NotesPreview markdown={notes} />
    </section>
  )
}
