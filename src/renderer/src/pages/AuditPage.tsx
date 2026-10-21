import { AnimatePresence, motion } from 'framer-motion'
import {
  Copy,
  Download,
  FilterX,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEvent,
  type AuditFilter,
  type AuditOutcome,
  type ChainVerification,
} from '../../../shared/audit'
import { api } from '../lib/api'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { registerCommand } from '../ui/commands'
import { EmptyState } from '../ui/EmptyState'
import { exitFast, fast, spring, staggerDelay, useMotionSafe } from '../ui/motion'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../ui/Toaster'
import type { Tone } from '../ui/tone'

const PAGE_SIZE = 200
const SEARCH_DEBOUNCE_MS = 250

const OUTCOMES: AuditOutcome[] = ['success', 'failure', 'denied', 'info']

const OUTCOME_TONE: Record<AuditOutcome, Tone> = {
  success: 'success',
  failure: 'error',
  denied: 'warn',
  info: 'info',
}

const BREAK_REASON: Record<Extract<ChainVerification, { ok: false }>['reason'], string> = {
  'hash-mismatch': 'Its contents no longer match the recorded hash.',
  'prev-link-mismatch': 'Its link to the previous event is broken; an event may be missing.',
}

interface Filters {
  search: string
  outcome: AuditOutcome | ''
  action: AuditAction | ''
  from: string
  to: string
}

const NO_FILTERS: Filters = { search: '', outcome: '', action: '', from: '', to: '' }

// <input type="date"> gives YYYY-MM-DD; the log compares ISO strings, so widen to local day bounds.
function dayBound(value: string, end: boolean): string | undefined {
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
  const date = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)
  return date.toISOString()
}

/** Only the fields that are set, so the backend sees a minimal filter. */
function toAuditFilter(f: Filters, text: string): AuditFilter {
  const filter: AuditFilter = {}
  if (text.trim()) filter.text = text.trim()
  if (f.outcome) filter.outcome = f.outcome
  if (f.action) filter.actions = [f.action]
  const from = f.from && dayBound(f.from, false)
  const to = f.to && dayBound(f.to, true)
  if (from) filter.from = from
  if (to) filter.to = to
  return filter
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function AuditPage() {
  const motionSafe = useMotionSafe()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const text = useDebounced(filters.search, SEARCH_DEBOUNCE_MS)
  const filter = useMemo(() => toAuditFilter(filters, text), [filters, text])
  const filterKey = JSON.stringify(filter)

  const [rows, setRows] = useState<AuditEvent[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AuditEvent | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [lastCheck, setLastCheck] = useState<ChainVerification | null>(null)
  // Rows stagger in only for the first batch; later loads appear without the cascade.
  const [staggered, setStaggered] = useState(false)
  const generation = useRef(0)
  // Verify and export append their own audit events; bumping this re-lists so they show up.
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  })

  useEffect(() => {
    const gen = ++generation.current
    setRefreshing(true)
    api
      .invoke('audit:list', { ...filter, limit: PAGE_SIZE })
      .then((page) => {
        if (gen !== generation.current) return
        setRows(page)
        setHasMore(page.length === PAGE_SIZE)
        setLoadError(null)
      })
      .catch((e: unknown) => {
        if (gen !== generation.current) return
        // With rows on screen the empty state never shows, so say so in a toast instead.
        if (rowsRef.current?.length) toast({ title: "Couldn't refresh events", description: errorText(e), tone: 'error' })
        setRows((r) => r ?? [])
        setLoadError(errorText(e))
      })
      .finally(() => {
        if (gen === generation.current) setRefreshing(false)
      })
    // filterKey captures filter's contents; the object itself is rebuilt every render.
  }, [filterKey, reloadKey])

  useEffect(() => {
    if (rows && !staggered) {
      const t = setTimeout(() => setStaggered(true), 600)
      return () => clearTimeout(t)
    }
  }, [rows, staggered])

  const loadMore = async () => {
    // A refresh in flight would replace the rows this page continues from.
    if (!rows?.length || refreshing) return
    const gen = generation.current
    setLoadingMore(true)
    try {
      const page = await api.invoke('audit:list', { ...filter, limit: PAGE_SIZE, beforeId: rows[rows.length - 1].id })
      if (gen !== generation.current) return
      setRows((r) => [...(r ?? []), ...page])
      setHasMore(page.length === PAGE_SIZE)
    } catch (e) {
      toast({ title: "Couldn't load more events", description: errorText(e), tone: 'error' })
    } finally {
      setLoadingMore(false)
    }
  }

  const verify = useCallback(async () => {
    setVerifying(true)
    try {
      const result = await api.invoke('audit:verify')
      setLastCheck(result)
      const noun = result.count === 1 ? 'event' : 'events'
      if (result.ok) {
        toast({ title: `Chain intact · ${result.count} ${noun}`, description: 'Every event matches its hash.', tone: 'success' })
      } else {
        toast({
          title: `Chain broken at event #${result.brokenAtId}`,
          description: `${BREAK_REASON[result.reason]} Checked ${result.count} ${noun}.`,
          tone: 'error',
        })
      }
    } catch (e) {
      toast({ title: "Couldn't verify the chain", description: errorText(e), tone: 'error' })
    } finally {
      setVerifying(false)
      reload()
    }
  }, [reload])

  const exportCsv = useCallback(async (current: AuditFilter) => {
    setExporting(true)
    // null: the user closed the save dialog, which needs no comment and logs nothing.
    let logged = false
    try {
      const result = await api.invoke('audit:exportCsv', current)
      logged = result !== null
      if (result) toast({ title: 'Exported CSV', description: result.path, tone: 'success' })
    } catch (e) {
      logged = true
      toast({ title: "Couldn't export CSV", description: errorText(e), tone: 'error' })
    } finally {
      setExporting(false)
      if (logged) reload()
    }
  }, [reload])

  const filterRef = useRef(filter)
  useEffect(() => {
    filterRef.current = filter
  })

  useEffect(() => {
    const off = [
      registerCommand({ id: 'audit.verify', title: 'Verify audit chain', section: 'Audit', run: () => void verify() }),
      registerCommand({
        id: 'audit.export',
        title: 'Export audit CSV',
        section: 'Audit',
        keywords: ['download', 'csv'],
        run: () => void exportCsv(filterRef.current),
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [verify, exportCsv])

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }))
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[19px] font-semibold tracking-tight text-fg">Audit trail</h1>
          <ChainStatus check={lastCheck} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            loading={verifying}
            icon={<ShieldCheck aria-hidden className="size-3.5" />}
            onClick={() => void verify()}
          >
            Verify chain
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={exporting}
            icon={<Download aria-hidden className="size-3.5" />}
            onClick={() => void exportCsv(filter)}
          >
            Export CSV
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 px-8 pb-4">
        <label className="relative flex h-8 min-w-[220px] flex-1 items-center">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-muted" />
          <input
            type="search"
            aria-label="Search events"
            placeholder="Search action, target or actor…"
            spellCheck={false}
            value={filters.search}
            onChange={(e) => set('search', e.target.value)}
            className={`${FIELD} w-full pl-8`}
          />
        </label>
        <select
          aria-label="Outcome"
          value={filters.outcome}
          onChange={(e) => set('outcome', e.target.value as Filters['outcome'])}
          className={FIELD}
        >
          <option value="">All outcomes</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <select
          aria-label="Action"
          value={filters.action}
          onChange={(e) => set('action', e.target.value as Filters['action'])}
          className={FIELD}
        >
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="From"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(e) => set('from', e.target.value)}
          className={FIELD}
        />
        <span aria-hidden className="text-[12px] text-muted">
          –
        </span>
        <input
          type="date"
          aria-label="To"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(e) => set('to', e.target.value)}
          className={FIELD}
        />
        <AnimatePresence initial={false}>
          {filtered && (
            <motion.div
              initial={motionSafe ? { opacity: 0, scale: 0.9 } : { opacity: 0 }}
              animate={motionSafe ? { opacity: 1, scale: 1 } : { opacity: 1 }}
              exit={motionSafe ? { opacity: 0, scale: 0.9, transition: exitFast } : { opacity: 0, transition: exitFast }}
              transition={fast}
            >
              <Button variant="ghost" size="sm" icon={<FilterX aria-hidden className="size-3.5" />} onClick={() => setFilters(NO_FILTERS)}>
                Clear
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        <div
          className={`overflow-hidden rounded-ui border border-line bg-surface/70 transition-opacity duration-150 ${
            refreshing && rows ? 'opacity-60' : ''
          }`}
        >
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-medium tracking-wide text-muted uppercase">
                <th className="w-[160px] px-4 py-2.5 font-medium">Time</th>
                <th className="w-[160px] px-3 py-2.5 font-medium">Action</th>
                <th className="w-[110px] px-3 py-2.5 font-medium">Outcome</th>
                <th className="px-3 py-2.5 font-medium">Actor</th>
                <th className="px-3 py-2.5 font-medium">Target</th>
              </tr>
            </thead>
            <tbody>
              {rows === null
                ? Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} />)
                : rows.map((ev, i) => (
                    <EventRow
                      key={ev.id}
                      event={ev}
                      index={i}
                      stagger={!staggered}
                      selected={selected?.id === ev.id}
                      onOpen={() => setSelected(ev)}
                    />
                  ))}
            </tbody>
          </table>
          {rows?.length === 0 &&
            (loadError ? (
              <EmptyState icon={ShieldAlert} title="Couldn't load the audit log" text={loadError} />
            ) : filtered ? (
              <EmptyState
                icon={FilterX}
                title="No events match"
                text="Try a broader search or a wider date range."
                action={{ label: 'Clear filters', run: () => setFilters(NO_FILTERS) }}
              />
            ) : (
              <EmptyState icon={ScrollText} title="No events yet" text="Everything OpsDeck does on your behalf lands here." />
            ))}
        </div>
        {hasMore && rows && rows.length > 0 && (
          <div className="flex justify-center pt-4">
            <Button variant="ghost" size="sm" loading={loadingMore} disabled={refreshing} onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </div>

      <DetailsDrawer event={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

const FIELD =
  'h-8 rounded-lg border border-line bg-surface-2/60 px-2.5 text-[12.5px] text-fg transition-colors placeholder:text-muted/70 hover:border-muted/30 focus:border-accent/60 focus:outline-none [color-scheme:dark]'

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const formatTime = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : timeFormat.format(d)
}

function ChainStatus({ check }: { check: ChainVerification | null }) {
  const motionSafe = useMotionSafe()
  return (
    <AnimatePresence mode="popLayout">
      {check && (
        <motion.span
          key={String(check.ok)}
          initial={motionSafe ? { opacity: 0, x: -4 } : { opacity: 0 }}
          animate={motionSafe ? { opacity: 1, x: 0 } : { opacity: 1 }}
          exit={{ opacity: 0, transition: exitFast }}
          transition={fast}
        >
          <Badge tone={check.ok ? 'success' : 'error'} dot>
            {check.ok ? 'Verified' : 'Tampered'}
          </Badge>
        </motion.span>
      )}
    </AnimatePresence>
  )
}

function SkeletonRow() {
  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="px-4 py-3">
        <Skeleton className="h-3.5 w-24" />
      </td>
      <td className="px-3 py-3">
        <Skeleton className="h-3.5 w-20" />
      </td>
      <td className="px-3 py-3">
        <Skeleton className="h-4 w-14 rounded-full" />
      </td>
      <td className="px-3 py-3">
        <Skeleton className="h-3.5 w-28" />
      </td>
      <td className="px-3 py-3">
        <Skeleton className="h-3.5 w-32" />
      </td>
    </tr>
  )
}

interface EventRowProps {
  event: AuditEvent
  index: number
  stagger: boolean
  selected: boolean
  onOpen: () => void
}

function EventRow({ event: ev, index, stagger, selected, onOpen }: EventRowProps) {
  const motionSafe = useMotionSafe()
  const animate = stagger && motionSafe && index < 30
  return (
    <motion.tr
      initial={animate ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: animate ? staggerDelay(index) : 0 }}
      onClick={onOpen}
      className={`group cursor-default border-b border-line/60 transition-colors last:border-0 ${
        selected ? 'bg-accent/10' : 'hover:bg-white/[0.025]'
      }`}
    >
      <td className="truncate px-4 py-2.5 text-muted tabular-nums">
        <button
          type="button"
          aria-label={`Event #${ev.id} details`}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          className="rounded text-left transition-colors group-hover:text-fg focus-visible:text-fg"
          title={ev.ts}
        >
          {formatTime(ev.ts)}
        </button>
      </td>
      <td className="truncate px-3 py-2.5 font-mono text-[12px] text-fg">{ev.action}</td>
      <td className="px-3 py-2.5">
        <Badge tone={OUTCOME_TONE[ev.outcome] ?? 'info'} dot>
          {ev.outcome}
        </Badge>
      </td>
      <td className="truncate px-3 py-2.5 text-fg/85">{`${ev.actorOsUser}@${ev.actorMachine}`}</td>
      <td className="truncate px-3 py-2.5">
        {ev.targetLabel || ev.targetId ? (
          <span className="flex min-w-0 items-center gap-2">
            {ev.targetType && <span className="shrink-0 text-[11px] text-muted">{ev.targetType}</span>}
            <span className="truncate text-fg/85">{ev.targetLabel ?? ev.targetId}</span>
          </span>
        ) : (
          <span className="text-muted/60">—</span>
        )}
      </td>
    </motion.tr>
  )
}

function DetailsDrawer({ event, onClose }: { event: AuditEvent | null; onClose: () => void }) {
  const motionSafe = useMotionSafe()
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const open = event !== null

  // Remember what opened the drawer (unless focus is already inside it) and move focus in.
  useEffect(() => {
    if (!event) return
    const active = document.activeElement
    if (active instanceof HTMLElement && !panelRef.current?.contains(active)) returnFocus.current = active
    panelRef.current?.focus()
  }, [event])

  const close = useCallback(() => {
    onClose()
    const el = returnFocus.current
    returnFocus.current = null
    if (el?.isConnected) el.focus()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // The palette handles (and prevents) its own Esc first.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  return (
    <AnimatePresence>
      {event && (
        <motion.div
          key="drawer"
          ref={panelRef}
          role="dialog"
          aria-label={`Event #${event.id}`}
          tabIndex={-1}
          className="absolute inset-y-0 right-0 z-30 flex w-[420px] max-w-[90%] flex-col border-l border-line bg-surface/95 shadow-pop backdrop-blur-xl focus:outline-none"
          initial={motionSafe ? { x: 48, opacity: 0 } : { opacity: 0 }}
          animate={motionSafe ? { x: 0, opacity: 1 } : { opacity: 1 }}
          exit={motionSafe ? { x: 48, opacity: 0, transition: exitFast } : { opacity: 0, transition: exitFast }}
          transition={motionSafe ? spring : fast}
        >
          <EventDetails event={event} onClose={close} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function EventDetails({ event: ev, onClose }: { event: AuditEvent; onClose: () => void }) {
  const corrupt = ev.details._corrupt === true
  const json = JSON.stringify(ev.details, null, 2)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      toast({ title: 'Details copied', tone: 'success' })
    } catch {
      toast({ title: "Couldn't copy to the clipboard", tone: 'error' })
    }
  }

  return (
    <>
      <div className="app-drag flex h-16 shrink-0 items-end justify-between gap-3 border-b border-line px-5 pb-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[15px] font-semibold text-fg">Event #{ev.id}</h2>
          <Badge tone={OUTCOME_TONE[ev.outcome] ?? 'info'} dot>
            {ev.outcome}
          </Badge>
        </div>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-white/6 hover:text-fg"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2.5 text-[12.5px]">
          <Field label="Action">
            <span className="font-mono text-[12px]">{ev.action}</span>
          </Field>
          <Field label="Time">
            <span className="tabular-nums">{ev.ts}</span>
          </Field>
          <Field label="Actor">{`${ev.actorOsUser}@${ev.actorMachine}`}</Field>
          <Field label="Target">
            {ev.targetLabel || ev.targetId ? (
              <>
                {ev.targetLabel ?? ev.targetId}
                {ev.targetType && <span className="ml-1.5 text-muted">({ev.targetType})</span>}
              </>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Field>
          <Field label="Hash">
            <span className="font-mono text-[11px] break-all text-muted">{ev.hash}</span>
          </Field>
          <Field label="Previous">
            <span className="font-mono text-[11px] break-all text-muted">{ev.prevHash}</span>
          </Field>
        </dl>

        <div className="mt-5 flex items-center justify-between">
          <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">Details</h3>
          <div className="flex items-center gap-2">
            {corrupt && (
              <Badge tone="warn" dot>
                Unreadable JSON
              </Badge>
            )}
            <button
              type="button"
              onClick={() => void copy()}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-white/6 hover:text-fg"
            >
              <Copy aria-hidden className="size-3" /> Copy
            </button>
          </div>
        </div>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-canvas/70 p-3 text-[12px] leading-5 whitespace-pre-wrap text-fg/90">
          {json}
        </pre>
      </div>
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  )
}
