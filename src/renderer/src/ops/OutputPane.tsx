import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDown, Check, Copy } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RUN_OUTPUT_CHARS } from '../../../shared/ops'
import { fast, spring, useMotionSafe } from '../ui/motion'
import type { HostOutput } from './runs'

/**
 * Chunk spans a pane keeps, and stderr pieces across them (F12). Past either, or past the store's char cap, the
 * oldest whole block goes, so the blocks that stay keep their identity and never re-render.
 */
export const MAX_SPANS = 2000
/** Spans are rendered in blocks of this many keys, so an append reconciles one block, not every span. */
const BLOCK = 64
/** Within this many pixels of the end counts as following the live output. */
const STICK_PX = 8

/** One appended piece of text; `err` are [start, end) offsets into it where stderr wrote. */
interface Span {
  key: number
  text: string
  err: [number, number][]
}

interface Spans {
  /** The output these spans were built from; a new one is applied once. */
  source: HostOutput | undefined
  spans: Span[]
  /** `source.total` once applied. */
  total: number
  chars: number
  errs: number
  nextKey: number
  /** Older output was dropped here (the store may still hold it). */
  hidden: boolean
}

const NONE: Spans = { source: undefined, spans: [], total: 0, chars: 0, errs: 0, nextKey: 0, hidden: false }

const blockOf = (s: Span) => Math.floor(s.key / BLOCK)

/**
 * The stderr ranges of `out` in [from, out.text.length), relative to `from`: touching ranges joined, and past
 * `MAX_SPANS` the oldest folded into one (as the store does), so one span never holds more than the cap.
 */
function errIn(out: HostOutput, from: number): [number, number][] {
  const ranges: [number, number][] = []
  for (const [a, b] of out.errRanges) {
    if (b <= from) continue
    const r: [number, number] = [Math.max(a, from) - from, b - from]
    const last = ranges.at(-1)
    if (last && last[1] >= r[0]) last[1] = r[1]
    else ranges.push(r)
  }
  if (ranges.length <= MAX_SPANS) return ranges
  const fold = ranges.length - MAX_SPANS + 1
  return [[ranges[0][0], ranges[fold - 1][1]], ...ranges.slice(fold)]
}

/** Drops `cut` chars from the front of a span. */
function trimFront(s: Span, cut: number): Span {
  return {
    key: s.key,
    text: s.text.slice(cut),
    err: s.err.map(([a, b]): [number, number] => [Math.max(0, a - cut), b - cut]).filter(([a, b]) => b > a),
  }
}

/**
 * The spans for `out`, built on `prev`: new text since `prev.total` becomes one span appended at the end.
 * Output that went back (a reload, another run) or skipped past what the text holds starts over from it.
 * Past the caps the oldest whole block is dropped (one span at a time once only one block is left), so the
 * spans kept are never rebuilt; only a single span bigger than the char cap is cut.
 */
function advance(prev: Spans, out: HostOutput | undefined): Spans {
  if (!out || !out.text) return { ...NONE, source: out, nextKey: prev.nextKey }
  const fresh = out.total - prev.total
  let { spans, chars, errs, nextKey, hidden } = prev
  const add = (from: number) => {
    const span = { key: nextKey++, text: out.text.slice(from), err: errIn(out, from) }
    spans = [...spans, span]
    chars += span.text.length
    errs += span.err.length
  }
  if (fresh < 0 || fresh > out.text.length || !prev.source) {
    spans = []
    chars = errs = 0
    hidden = false
    add(0)
  } else if (fresh > 0) {
    add(out.text.length - fresh)
  }
  const over = () => spans.length > MAX_SPANS || errs > MAX_SPANS || chars > RUN_OUTPUT_CHARS
  if (over() && spans.length > 1) {
    spans = spans.slice()
    while (over() && spans.length > 1) {
      const block = blockOf(spans[0])
      const n = blockOf(spans.at(-1)!) === block ? 1 : spans.findIndex((s) => blockOf(s) !== block)
      for (const s of spans.splice(0, n)) {
        chars -= s.text.length
        errs -= s.err.length
      }
      hidden = true
    }
  }
  if (chars > RUN_OUTPUT_CHARS) {
    const s = trimFront(spans[0], chars - RUN_OUTPUT_CHARS)
    errs += s.err.length - spans[0].err.length
    spans = [s]
    chars = RUN_OUTPUT_CHARS
  }
  return { source: out, spans, total: out.total, chars, errs, nextKey, hidden }
}

/** An RFC 3339 timestamp at the start of a line, as `docker logs --timestamps` writes it. */
const STAMP = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))(?= |$)/gm

/** `text` with line-start timestamps dimmed. */
function dimStamps(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(STAMP)) {
    if (m.index > at) parts.push(text.slice(at, m.index))
    parts.push(
      <span key={m.index} data-stamp className="text-muted/70">
        {m[1]}
      </span>,
    )
    at = m.index + m[1].length
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/** A span never changes once added, so it renders once (a single span over the char cap is cut, as a new one). */
const Chunk = memo(function Chunk({ span, dim }: { span: Span; dim: boolean }) {
  if (!span.err.length) return <span data-chunk>{dim ? dimStamps(span.text) : span.text}</span>
  const parts = []
  let at = 0
  for (const [a, b] of span.err) {
    if (a > at) parts.push(span.text.slice(at, a))
    parts.push(
      <span key={a} data-stream="err" className="text-err">
        {span.text.slice(a, b)}
      </span>,
    )
    at = b
  }
  if (at < span.text.length) parts.push(span.text.slice(at))
  return <span data-chunk>{parts}</span>
})

/** A run of consecutive spans; it re-renders only when it gains a span (the newest block only). */
const Block = memo(
  function Block({ spans, dim }: { spans: Span[]; dim: boolean }) {
    return spans.map((s) => <Chunk key={s.key} span={s} dim={dim} />)
  },
  (a, b) => a.dim === b.dim && a.spans.length === b.spans.length && a.spans.every((s, i) => s === b.spans[i]),
)

/** The spans grouped by key, so dropping the oldest block leaves the others as they were. */
function blocks(spans: Span[]): [number, Span[]][] {
  const out: [number, Span[]][] = []
  for (const s of spans) {
    const id = blockOf(s)
    if (out.at(-1)?.[0] === id) out.at(-1)![1].push(s)
    else out.push([id, [s]])
  }
  return out
}

/**
 * A host's output, streamed: new text is appended as a span and earlier spans never re-render. Stderr is
 * tinted. The view follows the end until the user scrolls up, then offers "Jump to live".
 */
export function OutputPane({
  output,
  label,
  className = 'max-h-80',
  dimTimestamps = false,
}: {
  output: HostOutput | undefined
  label: string
  className?: string
  /** Dim a leading timestamp on each line (container logs). */
  dimTimestamps?: boolean
}) {
  const motionSafe = useMotionSafe()
  const built = useRef<Spans>(NONE)
  if (built.current.source !== output) built.current = advance(built.current, output)
  const { spans, hidden } = built.current

  const log = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [away, setAway] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  useLayoutEffect(() => {
    const el = log.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [spans])

  const onScroll = () => {
    const el = log.current
    if (!el) return
    following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - STICK_PX
    setAway(!following.current)
  }
  const jump = () => {
    const el = log.current
    following.current = true
    setAway(false)
    if (el) el.scrollTop = el.scrollHeight
  }
  const copy = () => {
    // Output stays in the renderer: no toast, success or not.
    void navigator.clipboard
      ?.writeText(output?.text ?? '')
      .then(() => {
        setCopied(true)
        clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }

  return (
    <div className="group/pane relative">
      <div
        ref={log}
        role="log"
        aria-label={`Output of ${label}`}
        aria-live="off"
        tabIndex={0}
        onScroll={onScroll}
        className={`overflow-auto rounded-lg border border-line/70 bg-canvas/70 focus:outline-none focus-visible:border-accent/50 ${className}`}
      >
        {hidden && (
          <p className="border-b border-line/50 px-3 py-1.5 text-[11.5px] text-muted">Older output is hidden here; Copy output copies all that's kept.</p>
        )}
        {spans.length ? (
          <pre className="px-3 py-2.5 font-mono text-[12px] leading-[1.55] break-all whitespace-pre-wrap text-fg/90">
            {blocks(spans).map(([id, group]) => (
              <Block key={id} spans={group} dim={dimTimestamps} />
            ))}
          </pre>
        ) : (
          <p className="px-3 py-2.5 font-mono text-[12px] text-muted">No output yet</p>
        )}
      </div>
      <button
        type="button"
        aria-label={`Copy output of ${label}`}
        title="Copy output"
        onClick={copy}
        disabled={!output?.text}
        className="absolute top-1.5 right-3 grid size-7 place-items-center rounded-md border border-line/60 bg-surface-2/90 text-muted opacity-0 backdrop-blur transition-[opacity,color] group-hover/pane:opacity-100 hover:text-fg focus-visible:opacity-100 disabled:hidden"
      >
        {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
      <AnimatePresence>
        {away && (
          <motion.button
            type="button"
            onClick={jump}
            initial={motionSafe ? { opacity: 0, y: 6, x: '-50%' } : { opacity: 0, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, transition: fast }}
            transition={motionSafe ? spring : fast}
            className="absolute bottom-2.5 left-1/2 flex h-7 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-medium text-white shadow-pop"
          >
            <ArrowDown aria-hidden className="size-3.5" />
            Jump to live
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
