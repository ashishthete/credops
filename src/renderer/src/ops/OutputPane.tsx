import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDown, Check, Copy } from 'lucide-react'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { RUN_OUTPUT_CHARS } from '../../../shared/ops'
import { fast, spring, useMotionSafe } from '../ui/motion'
import type { HostOutput } from './runs'

/** Chunk spans a pane keeps; past it the oldest two merge, so the DOM stays small however long a run talks. */
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
  nextKey: number
}

const NONE: Spans = { source: undefined, spans: [], total: 0, chars: 0, nextKey: 0 }

/** The stderr ranges of `out` that fall in [from, out.text.length), relative to `from`. */
function errIn(out: HostOutput, from: number): [number, number][] {
  return out.errRanges.flatMap(([a, b]): [number, number][] => (b > from ? [[Math.max(a, from) - from, b - from]] : []))
}

/** Joins two spans into one (keyed as the first), keeping where stderr wrote. */
function merge(a: Span, b: Span): Span {
  return { key: a.key, text: a.text + b.text, err: [...a.err, ...b.err.map(([s, e]): [number, number] => [s + a.text.length, e + a.text.length])] }
}

/** Drops `cut` chars from the front of the spans. */
function trimFront(spans: Span[], cut: number): Span[] {
  let i = 0
  while (i < spans.length && cut >= spans[i].text.length) cut -= spans[i++].text.length
  const rest = spans.slice(i)
  if (cut > 0 && rest.length) {
    const s = rest[0]
    rest[0] = {
      key: s.key,
      text: s.text.slice(cut),
      err: s.err.map(([a, b]): [number, number] => [Math.max(0, a - cut), b - cut]).filter(([a, b]) => b > a),
    }
  }
  return rest
}

/**
 * The spans for `out`, built on `prev`: new text since `prev.total` becomes one span appended at the end.
 * Output that went back (a reload, another run) or skipped past what the text holds starts over from it.
 * Capped like the store: at most `RUN_OUTPUT_CHARS` chars and `MAX_SPANS` spans.
 */
function advance(prev: Spans, out: HostOutput | undefined): Spans {
  if (!out || !out.text) return { ...NONE, source: out, nextKey: prev.nextKey }
  const fresh = out.total - prev.total
  let spans = prev.spans
  let chars = prev.chars
  let nextKey = prev.nextKey
  if (fresh < 0 || fresh > out.text.length || !prev.source) {
    spans = [{ key: nextKey++, text: out.text, err: errIn(out, 0) }]
    chars = out.text.length
  } else if (fresh > 0) {
    const from = out.text.length - fresh
    spans = [...spans, { key: nextKey++, text: out.text.slice(from), err: errIn(out, from) }]
    chars += fresh
  }
  if (chars > RUN_OUTPUT_CHARS) {
    spans = trimFront(spans, chars - RUN_OUTPUT_CHARS)
    chars = RUN_OUTPUT_CHARS
  }
  if (spans.length > MAX_SPANS) {
    spans = spans.slice()
    while (spans.length > MAX_SPANS) spans.splice(0, 2, merge(spans[0], spans[1]))
  }
  return { source: out, spans, total: out.total, chars, nextKey }
}

/** A span re-renders only when it changes, which for all but a merged oldest one is never. */
const Chunk = memo(function Chunk({ span }: { span: Span }) {
  if (!span.err.length) return <span data-chunk>{span.text}</span>
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

/** A run of consecutive spans; it re-renders only when one of its spans changes. */
const Block = memo(
  function Block({ spans }: { spans: Span[] }) {
    return spans.map((s) => <Chunk key={s.key} span={s} />)
  },
  (a, b) => a.spans.length === b.spans.length && a.spans.every((s, i) => s === b.spans[i]),
)

/** The spans grouped by key; merging the oldest only changes the first block. */
function blocks(spans: Span[]): [number, Span[]][] {
  const out: [number, Span[]][] = []
  for (const s of spans) {
    const id = Math.floor(s.key / BLOCK)
    if (out.at(-1)?.[0] === id) out.at(-1)![1].push(s)
    else out.push([id, [s]])
  }
  return out
}

/**
 * A host's output, streamed: new text is appended as a span and earlier spans never re-render. Stderr is
 * tinted. The view follows the end until the user scrolls up, then offers "Jump to live".
 */
export function OutputPane({ output, label, className = 'max-h-80' }: { output: HostOutput | undefined; label: string; className?: string }) {
  const motionSafe = useMotionSafe()
  const built = useRef<Spans>(NONE)
  if (built.current.source !== output) built.current = advance(built.current, output)
  const { spans } = built.current

  const log = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [away, setAway] = useState(false)
  const [copied, setCopied] = useState(false)

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
        setTimeout(() => setCopied(false), 1200)
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
        {spans.length ? (
          <pre className="px-3 py-2.5 font-mono text-[12px] leading-[1.55] break-all whitespace-pre-wrap text-fg/90">
            {blocks(spans).map(([id, group]) => (
              <Block key={id} spans={group} />
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
