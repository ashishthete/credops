/**
 * The small Markdown subset release notes use: `#`/`##`/`###` headings, `-`/`*` bullets, paragraphs,
 * `**bold**`, `` `code` `` and `[text](https://…)` links. Pure: shared by the notes editor and email.
 */
export type Span = { t: 'text' | 'bold' | 'code'; v: string } | { t: 'link'; v: string; href: string }
export type NotesBlock = { kind: 'h'; level: 2 | 3; spans: Span[] } | { kind: 'li'; spans: Span[] } | { kind: 'p'; spans: Span[] }

export const MAX_NOTES = 20_000

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/
/** Bold, code, or a link whose href may hold one level of parentheses. */
const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g

/** A normalised `https:` href, or null: any other scheme renders as text. */
function httpsHref(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

export function parseInline(s: string): Span[] {
  const spans: Span[] = []
  let from = 0
  for (const m of s.matchAll(INLINE)) {
    const at = m.index
    if (at > from) spans.push({ t: 'text', v: s.slice(from, at) })
    if (m[1] !== undefined) spans.push({ t: 'bold', v: m[1] })
    else if (m[2] !== undefined) spans.push({ t: 'code', v: m[2] })
    else {
      const href = httpsHref(m[4]!)
      spans.push(href ? { t: 'link', v: m[3]!, href } : { t: 'text', v: m[3]! })
    }
    from = at + m[0].length
  }
  if (from < s.length) spans.push({ t: 'text', v: s.slice(from) })
  return spans
}

export function parseNotes(md: string): NotesBlock[] {
  const blocks: NotesBlock[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'p', spans: parseInline(para.join(' ')) })
    para = []
  }
  for (const raw of md.slice(0, MAX_NOTES).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const h = HEADING.exec(line)
    const li = h ? null : BULLET.exec(line)
    if (line.trim() === '') flush()
    else if (h) {
      flush()
      blocks.push({ kind: 'h', level: h[1]!.length >= 3 ? 3 : 2, spans: parseInline(h[2]!.trim()) })
    } else if (li) {
      flush()
      blocks.push({ kind: 'li', spans: parseInline(li[1]!.trim()) })
    } else para.push(line.trim())
  }
  flush()
  return blocks
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function spansToHtml(spans: readonly Span[]): string {
  return spans
    .map((s) =>
      s.t === 'bold' ? `<strong>${escapeHtml(s.v)}</strong>`
      : s.t === 'code' ? `<code>${escapeHtml(s.v)}</code>`
      : s.t === 'link' ? `<a href="${escapeHtml(s.href)}">${escapeHtml(s.v)}</a>`
      : escapeHtml(s.v),
    )
    .join('')
}

function spansToText(spans: readonly Span[]): string {
  return spans.map((s) => (s.t === 'link' ? `${s.v} <${s.href}>` : s.v)).join('')
}

export function notesToHtml(blocks: readonly NotesBlock[]): string {
  const out: string[] = []
  let inList = false
  for (const b of blocks) {
    if (b.kind !== 'li' && inList) {
      out.push('</ul>')
      inList = false
    }
    if (b.kind === 'li') {
      if (!inList) out.push('<ul>')
      inList = true
      out.push(`<li>${spansToHtml(b.spans)}</li>`)
    } else if (b.kind === 'h') out.push(`<h${b.level}>${spansToHtml(b.spans)}</h${b.level}>`)
    else out.push(`<p>${spansToHtml(b.spans)}</p>`)
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

export function notesToText(blocks: readonly NotesBlock[]): string {
  let out = ''
  blocks.forEach((b, i) => {
    const line = b.kind === 'li' ? `- ${spansToText(b.spans)}` : spansToText(b.spans)
    if (i > 0) out += b.kind === 'li' && blocks[i - 1]!.kind === 'li' ? '\n' : '\n\n'
    out += line
  })
  return out
}
