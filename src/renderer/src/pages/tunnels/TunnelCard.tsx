import { motion } from 'framer-motion'
import { ArrowLeftToLine, ArrowRightToLine, Copy, Globe, Lock, Pencil, RotateCw, SquareTerminal, Trash2, type LucideIcon } from 'lucide-react'
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isLoopback, minutesText, type TunnelMeta, type TunnelRuntime, type TunnelState, type TunnelType } from '../../../../shared/tunnels'
import { ExplainButton } from '../../ai/ExplainPanel'
import { api } from '../../lib/api'
import { runnableSshCommand } from '../../tunnels/form'
import { startTunnel, stopTunnel, useTunnel, useTunnelStats } from '../../tunnels/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { plural, RowMenu } from '../../ui/common'
import { exitFast, fast, spring, useMotionSafe, useShake } from '../../ui/motion'
import { Padlock } from '../../ui/Padlock'
import { Sparkline } from '../../ui/Sparkline'
import { Switch } from '../../ui/Switch'
import { toast } from '../../ui/Toaster'
import { RouteLine } from './RouteLine'

export const TUNNEL_TYPE: Record<TunnelType, { chip: string; title: string; icon: LucideIcon; color: string }> = {
  L: { chip: 'L', title: 'Local forward', icon: ArrowRightToLine, color: 'var(--accent)' },
  R: { chip: 'R', title: 'Remote forward', icon: ArrowLeftToLine, color: '#9b7bff' },
  D: { chip: 'SOCKS', title: 'SOCKS proxy', icon: Globe, color: '#2bb8b0' },
}

/** The colour a state glows in; stopped has none. */
const GLOW: Record<TunnelState, string | null> = {
  stopped: null,
  connecting: 'var(--warn)',
  up: 'var(--ok)',
  retrying: 'var(--warn)',
  failed: 'var(--err)',
}

/** On while the tunnel runs or is trying to; off once stopped or given up. */
export const isRunning = (state: TunnelState | undefined) => !!state && state !== 'stopped' && state !== 'failed'

/** `1.2 MB/s`, `30 KB/s`, `512 B/s` (decimal units, as network tools show them). */
export function formatRate(bytesPerSec: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = Math.max(0, bytesPerSec)
  let i = 0
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000
    i++
  }
  const n = i === 0 || v >= 10 ? Math.round(v) : Math.round(v * 10) / 10
  return `${n} ${units[i]}/s`
}

/** `just now`, `12 min`, `3 h 5 min`, `2 d 4 h`. */
export function formatUptime(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`
}

export interface TunnelCardProps {
  id: string
  hostLabel: string
  /** The tunnel's environment is protected (deleting asks for its name). */
  protectedEnv: boolean
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

/** One tunnel: its route, a start/stop switch, live status and throughput. Stats ticks re-render only its throughput row. */
export const TunnelCard = memo(function TunnelCard({ id, hostLabel, protectedEnv, onEdit, onDuplicate, onDelete }: TunnelCardProps) {
  const motionSafe = useMotionSafe()
  const { meta, runtime } = useTunnel(id)
  const state = runtime?.state ?? 'stopped'
  const transitions = useTransitions(state)
  const shake = useShake<HTMLDivElement>(transitions.failed)
  if (!meta) return null

  const glow = GLOW[state]
  const kind = TUNNEL_TYPE[meta.type]
  const exposed = !isLoopback(meta.bindAddress)
  const copyCommand = () => {
    api
      .invoke('host:resolve', meta.hostId, ...(meta.environmentId ? [meta.environmentId] : []))
      .then((host) => {
        if (!host) throw new Error("Couldn't work out how to reach this tunnel's host.")
        if (!navigator.clipboard) throw new Error('The clipboard is not available.')
        return navigator.clipboard.writeText(runnableSshCommand(meta, host)).then(() =>
          toast({
            title: 'Copied the ssh command',
            // A key or password kept in CredOps isn't something another terminal can use.
            description: host.identity.auth === 'key' || host.identity.auth === 'password' ? `It logs in as ${host.identity.username}; that terminal needs its own key or password.` : undefined,
            tone: 'success',
          }),
        )
      })
      .catch((err: unknown) => toast({ title: "Couldn't copy the command", description: err instanceof Error ? err.message : String(err), tone: 'error' }))
  }

  return (
    <motion.article
      aria-label={meta.label}
      data-state={state}
      layout={motionSafe ? 'position' : false}
      initial={motionSafe ? { opacity: 0, scale: 0.94, y: 10 } : { opacity: 0 }}
      animate={motionSafe ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1 }}
      exit={motionSafe ? { opacity: 0, scale: 0.92, transition: exitFast } : { opacity: 0, transition: exitFast }}
      transition={motionSafe ? spring : fast}
      style={{
        borderColor: glow ? `color-mix(in oklab, ${glow} 38%, var(--border))` : undefined,
        boxShadow: glow ? `0 10px 32px -18px color-mix(in oklab, ${glow} 70%, transparent)` : undefined,
      }}
      className="group relative rounded-[14px] border border-line bg-surface/70 transition-[border-color,box-shadow,background-color] duration-500 hover:bg-surface"
    >
      {/* One soft ring each time the tunnel comes up. */}
      {motionSafe && transitions.up > 0 && (
        <motion.span
          key={transitions.up}
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-[14px] shadow-[0_0_0_2px_var(--ok)]"
          initial={{ opacity: 0.75, scale: 1 }}
          animate={{ opacity: 0, scale: 1.035 }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      )}
      <div ref={shake} className="flex flex-col gap-3.5 p-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            title={kind.title}
            style={{ '--tone': kind.color } as CSSProperties}
            className="tone-soft inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-[10.5px] font-semibold"
          >
            <kind.icon aria-hidden className="size-3" strokeWidth={2.4} />
            {kind.chip}
          </span>
          <h3 className="min-w-0 truncate text-[13.5px] font-medium text-fg" title={meta.label}>
            {meta.label}
          </h3>
          {protectedEnv && (
            <span aria-label="Protected environment" title="Protected environment" className="shrink-0 text-warn">
              <Lock aria-hidden className="size-3.5" />
            </span>
          )}
          {exposed && (
            <span
              className="shrink-0"
              title={meta.type === 'R' ? "Exposed on the server's network" : `Reachable by anyone who can reach ${meta.bindAddress}`}>
              <Badge tone="warn">Exposed</Badge>
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <TunnelSwitch id={id} label={meta.label} state={state} />
            <RowMenu
              label={`Actions for ${meta.label}`}
              items={[
                { label: 'Edit', icon: Pencil, run: () => onEdit(id) },
                { label: 'Duplicate', icon: Copy, run: () => onDuplicate(id) },
                { label: 'Copy SSH command', icon: SquareTerminal, run: copyCommand },
                { label: 'Delete', icon: Trash2, danger: true, run: () => onDelete(id) },
              ]}
            />
          </span>
        </div>

        <RouteLine
          tunnelId={id}
          type={meta.type}
          hostLabel={hostLabel}
          bindAddress={meta.bindAddress}
          bindPort={runtime?.boundPort ?? meta.bindPort}
          targetHost={meta.targetHost}
          targetPort={meta.targetPort}
          state={state}
          errorCode={runtime?.error?.code}
        />

        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <StatusLine runtime={runtime} />
          <p aria-live="polite" aria-atomic className="sr-only" data-testid="tunnel-announce">
            {announcement(meta.label, runtime)}
          </p>
          {(state === 'up' || state === 'retrying') && <Throughput id={id} label={meta.label} live={state === 'up'} />}
        </div>
        {(state === 'up' || state === 'retrying') && <OpenFailures id={id} />}
      </div>
    </motion.article>
  )
})

/** Starts or stops a tunnel. Only a request awaiting its reply blocks it, so a connecting tunnel can be cancelled. */
export function TunnelSwitch({ id, label, state }: { id: string; label: string; state: TunnelState }) {
  const [inFlight, setInFlight] = useState(false)
  return (
    <Switch
      label={`Run ${label}`}
      checked={isRunning(state)}
      busy={inFlight}
      pending={state === 'connecting'}
      onChange={(on) => {
        setInFlight(true)
        void (on ? startTunnel(id) : stopTunnel(id)).finally(() => setInFlight(false))
      }}
    />
  )
}

/**
 * Counts entries into `up` and `failed` after mount, so the ripple and the shake play on a change of
 * state and never for a tunnel that was already up or failed when the page opened.
 */
function useTransitions(state: TunnelState) {
  const prev = useRef(state)
  const [counts, setCounts] = useState({ up: 0, failed: 0 })
  useEffect(() => {
    if (prev.current === state) return
    prev.current = state
    if (state === 'up' || state === 'failed') setCounts((c) => ({ ...c, [state]: c[state] + 1 }))
  }, [state])
  return counts
}

/** What a screen reader hears: set once on failing or pausing for unlock, not on every countdown tick. */
function announcement(label: string, runtime: TunnelRuntime | undefined): string {
  if (runtime?.state === 'failed') return `${label} failed: ${runtime.error?.message ?? 'the tunnel failed.'}`
  if (runtime?.state === 'retrying' && runtime.error?.code === 'locked') return `${label} is waiting for unlock`
  return ''
}

/**
 * The clock, re-read every `everyMs` (never when null) and whenever `key` changes. A new key reads the
 * clock during render, so the first frame of a new state never shows a time from long ago.
 */
function useNow(everyMs: number | null, key: string): number {
  const [read, setRead] = useState(() => ({ key, now: Date.now() }))
  let now = read.now
  if (read.key !== key) {
    now = Date.now()
    setRead({ key, now })
  }
  useEffect(() => {
    if (everyMs === null) return
    const timer = setInterval(() => setRead((r) => ({ ...r, now: Date.now() })), everyMs)
    return () => clearInterval(timer)
  }, [everyMs, key])
  return now
}

/** The state's one-word name, shared by every tunnel row. */
export const STATE_WORD: Record<TunnelState, string> = {
  stopped: 'Stopped',
  connecting: 'Connecting',
  up: 'Up',
  retrying: 'Retrying',
  failed: 'Failed',
}

/** The state word's colour: green only when up, red only when failed. */
const STATE_TONE: Record<TunnelState, string> = {
  stopped: 'text-muted',
  connecting: 'text-muted',
  up: 'text-ok',
  retrying: 'text-muted',
  failed: 'text-err',
}

/** The state's word in its colour, for the compact tunnel rows (host page, map panel, map list). */
export function TunnelStateWord({ state }: { state: TunnelState }) {
  return <span className={`shrink-0 text-[11.5px] ${STATE_TONE[state]}`}>{STATE_WORD[state]}</span>
}

/** The status dot's colour per state. */
export const STATE_DOT: Record<TunnelState, string> = {
  stopped: 'bg-muted/50 text-muted',
  connecting: 'bg-warn text-warn',
  up: 'bg-ok text-ok',
  retrying: 'bg-warn text-warn',
  failed: 'bg-err text-err',
}

/** The status wording every tunnel view shares: `Up 12 min`, the retry countdown, or the failure. */
export function StatusLine({ runtime }: { runtime: TunnelRuntime | undefined }) {
  const motionSafe = useMotionSafe()
  const state = runtime?.state ?? 'stopped'
  const locked = state === 'retrying' && runtime?.error?.code === 'locked'
  const counting = state === 'retrying' && !locked && !!runtime?.retryAt
  // The countdown ticks every second; the uptime only needs the minute to roll over.
  const now = useNow(counting ? 1000 : state === 'up' ? 15_000 : null, `${state}|${runtime?.retryAt}|${runtime?.upAt}`)

  const dot = (
    <span
      aria-hidden
      className={`size-2 shrink-0 rounded-full transition-colors duration-500 ${STATE_DOT[state]} ${state === 'connecting' && motionSafe ? 'od-pulse' : ''}`}
    />
  )
  const line = (children: ReactNode, className = 'text-muted') => (
    <p className={`flex min-w-0 items-center gap-2 text-[12px] ${className}`}>{children}</p>
  )

  if (!runtime || state === 'stopped') return line(<>{dot}Stopped</>)
  if (state === 'connecting') return line(<>{dot}<span className="text-fg/90">Connecting…</span></>)
  if (state === 'up') {
    const since = runtime.upAt ? Date.parse(runtime.upAt) : now
    return line(
      <>
        {dot}
        <span className="text-fg/90">Up {formatUptime(Math.max(0, now - since))}</span>
        {runtime.stopsAt && <StopsIn at={Date.parse(runtime.stopsAt)} now={now} />}
        {runtime.liveness === 'keepalive' && (
          <span title="This server doesn't allow probing the forward, so only the SSH keepalive watches it">
            Liveness: keepalive only
          </span>
        )}
      </>,
    )
  }
  if (locked) {
    return line(
      <>
        <span data-icon="padlock" className="text-warn">
          <Padlock open={false} className="size-3.5" />
        </span>
        <span className="text-fg/90">Waiting for unlock</span>
      </>,
    )
  }
  if (state === 'retrying') {
    // The pending attempt: after failure n comes attempt n + 1, and the last one is attempt maxFailures.
    const attempt = `(attempt ${runtime.failures + 1} of ${runtime.maxFailures})`
    const secs = runtime.retryAt ? Math.max(0, Math.ceil((Date.parse(runtime.retryAt) - now) / 1000)) : null
    return line(
      <>
        {dot}
        <span className="shrink-0 text-fg/90 tabular-nums">
          {secs === null ? `Retrying ${attempt}` : secs > 0 ? `Retrying in ${secs} s ${attempt}` : `Retrying now ${attempt}`}
        </span>
        {runtime.error && (
          <span className="min-w-0 truncate" title={runtime.error.message}>
            {runtime.error.message}
          </span>
        )}
      </>,
    )
  }
  // Failed: the message verbatim (a port-in-use one names the holder), and a way to try again.
  return (
    <div className="flex w-full min-w-0 items-start gap-2 text-[12px]">
      <span className="mt-[5px]">{dot}</span>
      <p className="min-w-0 flex-1 leading-[18px] break-words text-err">{runtime.error?.message ?? 'The tunnel failed.'}</p>
      <ExplainButton subject={{ kind: 'tunnel', tunnelId: runtime.id }} />
      <Button size="sm" variant="ghost" icon={<RotateCw aria-hidden className="size-3" />} onClick={() => void startTunnel(runtime.id)}>
        Retry
      </Button>
    </div>
  )
}

/** The time limit's countdown, amber in its last five minutes; the exact time is in the tooltip. */
function StopsIn({ at, now }: { at: number; now: number }) {
  const mins = Math.max(0, Math.ceil((at - now) / 60_000))
  const clock = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <span className={`shrink-0 tabular-nums ${mins <= 5 ? 'text-warn' : ''}`} title={`Disconnects automatically at ${clock}`} data-testid="tunnel-stops-in">
      {mins <= 1 ? 'Disconnects in under a minute' : `Disconnects in ${minutesText(mins)}`}
    </span>
  )
}

/**
 * Connections the server would not forward to the target. The tunnel itself stays up (its probe only
 * checks this side), so without this a client like a database GUI just sees its connection close.
 */
function OpenFailures({ id }: { id: string }) {
  const stats = useTunnelStats(id)
  if (!stats?.last.openFailed) return null
  const { openFailed, lastOpenError } = stats.last
  return (
    <p role="status" className="text-[12px] leading-[18px] break-words text-warn" data-testid="tunnel-open-failures">
      {plural(openFailed, 'connection')} failed. {lastOpenError}
    </p>
  )
}

/** Reads only this tunnel's stats, so a tick re-renders this row and nothing else. */
function Throughput({ id, label, live }: { id: string; label: string; live: boolean }) {
  const stats = useTunnelStats(id)
  if (!stats) return null
  const { rateIn, rateOut, connections } = stats.last
  const text = `↓ ${formatRate(rateIn)} ↑ ${formatRate(rateOut)} · ${plural(connections, 'connection')}`
  const total = stats.inSamples.map((v, i) => v + (stats.outSamples[i] ?? 0))
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span title={text} className="min-w-0 truncate font-mono text-[11px] text-muted tabular-nums">
        {text}
      </span>
      <Sparkline values={total} tone={live ? 'success' : 'warn'} label={`Throughput of ${label}`} className="h-6 w-20 shrink-0" />
    </div>
  )
}
