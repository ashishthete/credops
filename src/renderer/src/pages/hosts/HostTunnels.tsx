import { AnimatePresence, motion } from 'framer-motion'
import { Plus } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { TunnelMeta } from '../../../../shared/tunnels'
import { startTunnel, stopTunnel, tunnelStore, useTunnel } from '../../tunnels/store'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { Switch } from '../../ui/Switch'
import { hostPort } from '../tunnels/RouteLine'
import { isRunning, STATE_DOT, STATE_WORD, TUNNEL_TYPE } from '../tunnels/TunnelCard'
import { TunnelDialog, type TunnelRequest } from '../tunnels/TunnelDialog'

/** `127.0.0.1:5433 → localhost:5432`, `web-1:8080 → localhost:3000`, `SOCKS on 127.0.0.1:1080`. */
function routeSummary(t: TunnelMeta, hostLabel: string): string {
  const target = t.targetHost !== null ? hostPort(t.targetHost, t.targetPort ?? '') : ''
  if (t.type === 'D') return `SOCKS on ${hostPort(t.bindAddress, t.bindPort)}`
  if (t.type === 'R') return `${hostLabel}:${t.bindPort} → ${target}`
  return `${hostPort(t.bindAddress, t.bindPort)} → ${target}`
}

interface HostTunnelsProps {
  hostId: string
  hostLabel: string
  /** The environment the host is looked at from; a new tunnel starts in it. */
  environmentId?: string
}

/** The host's tunnels, each with a start/stop switch, and a shortcut to a new one already pointed at this host. */
export function HostTunnels({ hostId, hostLabel, environmentId }: HostTunnelsProps) {
  const motionSafe = useMotionSafe()
  const { tunnels } = useSyncExternalStore(tunnelStore.subscribe, tunnelStore.get)
  const mine = useMemo(() => tunnels.filter((t) => t.hostId === hostId).sort((a, b) => a.label.localeCompare(b.label)), [tunnels, hostId])
  const [request, setRequest] = useState<TunnelRequest | null>(null)

  return (
    <div className="flex flex-col gap-2">
      {mine.length === 0 ? (
        <p className="text-[12.5px] text-muted">No tunnels on this host yet.</p>
      ) : (
        <ul className="flex max-w-[640px] flex-col gap-1">
          <AnimatePresence initial={false}>
            {mine.map((t) => (
              <motion.li
                key={t.id}
                aria-label={t.label}
                layout={motionSafe ? 'position' : false}
                initial={motionSafe ? { opacity: 0, y: -4 } : { opacity: 0 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: fast }}
                transition={motionSafe ? spring : fast}
              >
                <TunnelRow id={t.id} hostLabel={hostLabel} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <button
        type="button"
        onClick={() => setRequest({ kind: 'new', hostId, environmentId })}
        className="flex h-7 w-fit items-center gap-1.5 rounded-full border border-dashed border-line px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-muted/40 hover:text-fg"
      >
        <Plus aria-hidden className="size-3.5" />
        New tunnel for this host
      </button>
      <TunnelDialog request={request} onClose={() => setRequest(null)} />
    </div>
  )
}

function TunnelRow({ id, hostLabel }: { id: string; hostLabel: string }) {
  const motionSafe = useMotionSafe()
  const { meta, runtime } = useTunnel(id)
  // A start or stop awaiting its reply; connecting stays clickable so it can be cancelled.
  const [inFlight, setInFlight] = useState(false)
  if (!meta) return null
  const state = runtime?.state ?? 'stopped'
  const kind = TUNNEL_TYPE[meta.type]
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-surface/50 px-3 py-2 transition-colors hover:bg-surface">
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full transition-colors duration-500 ${STATE_DOT[state]} ${state === 'connecting' && motionSafe ? 'od-pulse' : ''}`}
      />
      <span className="min-w-0 truncate text-[13px] font-medium text-fg" title={meta.label}>
        {meta.label}
      </span>
      <span title={kind.title} className="shrink-0 font-mono text-[10.5px] font-semibold text-muted">
        {kind.chip}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{routeSummary(meta, hostLabel)}</span>
      <span className={`shrink-0 text-[11.5px] ${state === 'failed' ? 'text-err' : state === 'up' ? 'text-ok' : 'text-muted'}`}>
        {STATE_WORD[state]}
      </span>
      <Switch
        label={`Run ${meta.label}`}
        checked={isRunning(state)}
        busy={inFlight}
        pending={state === 'connecting'}
        onChange={(on) => {
          setInFlight(true)
          void (on ? startTunnel(id) : stopTunnel(id)).finally(() => setInFlight(false))
        }}
      />
    </div>
  )
}
