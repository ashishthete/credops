import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDown, Copy, Download, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { STEP_LABEL, type StepKind } from '../../../../../shared/deploy'
import { parseAnsi, stripAnsi } from '../../../deploy/ansi'
import type { LogFilter } from '../../../deploy/log-buffer'
import { usePipeline, useReleaseLog } from '../../../deploy/releases'
import { plural } from '../../../ui/common'
import { fast, spring, useMotionSafe } from '../../../ui/motion'
import { useShortcut } from '../../../ui/shortcuts'
import { runLabel } from './Pipeline'

export const ROW_H = 18
export const OVERSCAN = 20
/** Used while the viewport has no measured height yet. */
const FALLBACK_VIEWPORT = 400

// Fixed palette names from parseAnsi; never a value taken from the log.
const ANSI_COLOR: Record<string, string> = {
  black: '#6b7280',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#d946ef',
  cyan: '#06b6d4',
  white: '#d1d5db',
  'bright-black': '#9ca3af',
  'bright-red': '#f87171',
  'bright-green': '#4ade80',
  'bright-yellow': '#facc15',
  'bright-blue': '#60a5fa',
  'bright-magenta': '#e879f9',
  'bright-cyan': '#22d3ee',
  'bright-white': '#f9fafb',
}

/** Marks every case-insensitive occurrence of `query` in `text`. */
function marked(text: string, query: string) {
  if (!query) return text
  const low = text.toLowerCase()
  const q = query.toLowerCase()
  const out: (string | ReactElement)[] = []
  let at = 0
  for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
    if (i > at) out.push(text.slice(at, i))
    out.push(<mark key={i} className="rounded-[2px] bg-warn/40 text-fg">{text.slice(i, i + q.length)}</mark>)
    at = i + q.length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** One log line with its colours; always text, never markup. */
export function LogText({ line, query = '' }: { line: string; query?: string }) {
  return (
    <>
      {parseAnsi(line).map((seg, i) =>
        seg.fg || seg.bold ? (
          <span key={i} style={seg.fg ? { color: ANSI_COLOR[seg.fg] } : undefined} className={seg.bold ? 'font-semibold' : undefined}>
            {marked(seg.text, query)}
          </span>
        ) : (
          <span key={i}>{marked(seg.text, query)}</span>
        ),
      )}
    </>
  )
}

const STREAM_TINT = { out: '', err: 'text-err/90', ansible: 'text-muted' } as const

function FilterChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-6 rounded-full border px-2 text-[11.5px] ${on ? 'border-accent/60 bg-accent/12 text-fg' : 'border-line text-muted hover:text-fg'}`}
    >
      {label}
    </button>
  )
}

/**
 * The release's log, virtualized: only the rows in view plus an overscan are in the DOM. It follows the end
 * until the user scrolls up, then a pill offers to jump back with the count of lines that arrived meanwhile.
 */
export function LiveLog({ releaseId, filter, onFilterChange }: { releaseId: string; filter: LogFilter; onFilterChange: (f: LogFilter) => void }) {
  const motionSafe = useMotionSafe()
  const { buffer, version } = useReleaseLog(releaseId)
  const pipeline = usePipeline(releaseId)
  const view = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const [follow, setFollow] = useState(true)
  const [top, setTop] = useState(0)
  const [pausedAt, setPausedAt] = useState(0)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT)

  const total = buffer?.count(filter) ?? 0
  const height = total * ROW_H
  const scrollTop = follow ? Math.max(0, height - viewport) : top
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN)
  const rows = buffer ? buffer.slice(first, last, filter) : []
  const fresh = follow ? 0 : Math.max(0, total - pausedAt)
  const filterKey = `${filter.hostId ?? ''}|${filter.runId ?? ''}|${filter.stepId ?? ''}`

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => (buffer && query ? buffer.search(query, filter) : []), [buffer, version, query, filterKey])

  useLayoutEffect(() => {
    const el = view.current
    if (!el) return
    setViewport(el.clientHeight || FALLBACK_VIEWPORT)
    if (follow) el.scrollTop = height
  }, [follow, height])

  useEffect(() => {
    setHit(0)
  }, [query, filterKey])

  const pause = (at: number) => {
    if (follow) setPausedAt(total)
    setFollow(false)
    setTop(at)
  }
  const resume = () => setFollow(true)

  const onScroll = () => {
    const el = view.current
    if (!el) return
    const at = el.scrollTop
    if (at + viewport >= height - ROW_H) {
      if (!follow) resume()
      return
    }
    pause(at)
  }

  const goTo = (i: number) => {
    if (!matches.length) return
    const n = ((i % matches.length) + matches.length) % matches.length
    setHit(n)
    const at = Math.max(0, matches[n] * ROW_H - viewport / 2)
    pause(at)
    if (view.current) view.current.scrollTop = at
  }

  useShortcut('mod+f', () => searchBox.current?.focus())

  const onBodyKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.key === 'End') {
      e.preventDefault()
      resume()
    } else if (e.key === 'n' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      goTo(hit + 1)
    } else if (e.key === 'N' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      goTo(hit - 1)
    }
  }

  const visibleText = () => {
    const from = Math.floor(scrollTop / ROW_H)
    const to = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_H))
    return (buffer?.slice(from, to, filter) ?? []).map((l) => stripAnsi(l.text)).join('\n')
  }
  const copyVisible = () => void navigator.clipboard?.writeText(visibleText()).catch(() => {})
  const download = () => {
    if (!buffer || typeof URL.createObjectURL !== 'function') return
    const text = buffer
      .slice(0, total, filter)
      .map((l) => stripAnsi(l.text))
      .join('\n')
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `release-${releaseId}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const set = (patch: LogFilter) => onFilterChange({ ...filter, ...patch })
  const lanes = pipeline?.lanes ?? []
  const stepKind = filter.stepId ? (filter.stepId.split(':').at(-1) as StepKind) : null
  const hostLabel = (id: string | null) => lanes.find((l) => l.hostId === id)?.hostLabel ?? null

  return (
    <div className="flex min-h-0 flex-col gap-2" onKeyDown={onBodyKey}>
      <div className="flex flex-wrap items-center gap-1.5">
        {lanes.length > 1 &&
          lanes.map((l) => (
            <FilterChip key={l.hostId} label={l.hostLabel} on={filter.hostId === l.hostId} onClick={() => set({ hostId: filter.hostId === l.hostId ? null : l.hostId })} />
          ))}
        {lanes
          .flatMap((l) => l.runs)
          .map((r) => (
            <FilterChip key={r.runId} label={runLabel(r)} on={filter.runId === r.runId} onClick={() => set({ runId: filter.runId === r.runId ? null : r.runId })} />
          ))}
        {filter.stepId && (
          <button
            type="button"
            onClick={() => set({ stepId: null })}
            aria-label="Clear the step filter"
            className="inline-flex h-6 items-center gap-1 rounded-full border border-accent/60 bg-accent/12 px-2 text-[11.5px] text-fg"
          >
            {`${(stepKind && STEP_LABEL[stepKind]) ?? filter.stepId}`}
            <X aria-hidden className="size-3" />
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <label className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-accent/60">
            <Search aria-hidden className="size-3.5 text-muted" />
            <input
              ref={searchBox}
              aria-label="Search the log"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                goTo(e.shiftKey ? hit - 1 : hit + 1)
              }}
              className="w-32 bg-transparent text-[12px] text-fg outline-none placeholder:text-muted"
            />
            {query && <span className="text-[11px] text-muted tabular-nums">{matches.length ? `${hit + 1}/${matches.length}` : '0'}</span>}
          </label>
          <button type="button" onClick={copyVisible} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:text-fg">
            <Copy aria-hidden className="size-3.5" />
            Copy visible
          </button>
          <button type="button" onClick={download} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:text-fg">
            <Download aria-hidden className="size-3.5" />
            Download log
          </button>
        </span>
      </div>

      <div className="relative">
        {buffer && buffer.hidden > 0 && (
          <p className="border-b border-line/50 px-3 py-1 text-[11.5px] text-muted">{`(${plural(buffer.hidden, 'earlier line')} hidden)`}</p>
        )}
        <div
          ref={view}
          role="log"
          aria-label="Release log"
          aria-live="off"
          tabIndex={0}
          onScroll={onScroll}
          className="h-72 overflow-auto rounded-lg border border-line/70 bg-canvas/70 font-mono text-[12px] focus:outline-none focus-visible:border-accent/50"
        >
          {total === 0 ? (
            <p className="px-3 py-2 text-muted">Waiting for output…</p>
          ) : (
            <div className="relative" style={{ height }}>
              {rows.map((l, i) => {
                const pos = first + i
                const current = matches[hit] === pos
                return (
                  <div
                    key={l.index}
                    data-row={pos}
                    className={`absolute inset-x-0 truncate px-3 whitespace-pre ${STREAM_TINT[l.stream]} ${current ? 'bg-warn/15' : ''}`}
                    style={{ top: pos * ROW_H, height: ROW_H, lineHeight: `${ROW_H}px` }}
                    title={hostLabel(l.hostId) ?? undefined}
                  >
                    <LogText line={l.text} query={query} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <AnimatePresence>
          {!follow && (
            <span className="absolute bottom-2.5 left-1/2 -translate-x-1/2">
              <motion.button
                type="button"
                onClick={resume}
                initial={motionSafe ? { opacity: 0, y: 6 } : { opacity: 0 }}
                animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
                exit={{ opacity: 0, transition: fast }}
                transition={motionSafe ? spring : fast}
                className="flex h-7 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-medium whitespace-nowrap text-white shadow-pop"
              >
                <ArrowDown aria-hidden className="size-3.5" />
                {`Jump to live${fresh ? ` (+${fresh})` : ''}`}
              </motion.button>
            </span>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
