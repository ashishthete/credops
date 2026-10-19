import { motion } from 'framer-motion'
import { ChevronRight, Globe, Laptop, Server, Target, Unplug, type LucideIcon } from 'lucide-react'
import { useSyncExternalStore, type CSSProperties } from 'react'
import type { TunnelErrorCode, TunnelState, TunnelType } from '../../../../shared/tunnels'
import { statsStore } from '../../tunnels/store'
import { useMotionSafe } from '../../ui/motion'

/** Bind failures happen on this machine; everything else (the link, the server, a probe) is the remote side. */
const LOCAL_FAILURES: readonly TunnelErrorCode[] = ['port-in-use', 'bind-denied']

export const breakSide = (code: TunnelErrorCode | undefined): 'local' | 'remote' =>
  code && LOCAL_FAILURES.includes(code) ? 'local' : 'remote'

// Dash speed in three steps of combined throughput: idle, busy, flat out.
const FLOW_DURATION = ['2.4s', '1.1s', '0.45s'] as const

export function flowStep(bytesPerSec: number): 0 | 1 | 2 {
  return bytesPerSec >= 1_000_000 ? 2 : bytesPerSec >= 10_000 ? 1 : 0
}

/** Re-renders only when the step changes, not on every stats tick. */
function useFlowStep(id: string | undefined): 0 | 1 | 2 {
  return useSyncExternalStore(statsStore.subscribe, () => {
    const s = id ? statsStore.get()[id] : undefined
    return flowStep(s ? s.last.rateIn + s.last.rateOut : 0)
  })
}

export const hostPort = (address: string, port: number | string) => `${address.includes(':') ? `[${address}]` : address}:${port}`

export interface RouteLineProps {
  /** Drives the flow speed from this tunnel's stats; omit for a static drawing (e.g. a dialog preview). */
  tunnelId?: string
  type: TunnelType
  hostLabel: string
  bindAddress: string
  /** A string draws a placeholder, e.g. `…` in a dialog preview before the port is typed. */
  bindPort: number | string
  targetHost: string | null
  targetPort: number | string | null
  state: TunnelState
  errorCode?: TunnelErrorCode
}

type NodeRole = 'local' | 'host' | 'target'
interface RouteNode {
  role: NodeRole
  label: string
  /** The `:port` tail of the label; it stays visible while the part before it truncates. */
  port: string
  icon: LucideIcon
}

/** A node for `host:port`, split so the port survives truncation. */
function addressNode(role: NodeRole, address: string, port: number | string, icon: LucideIcon): RouteNode {
  const label = hostPort(address, port)
  return { role, label, port: `:${port}`, icon }
}

/** The three stops traffic passes, in the direction it flows. */
function routeNodes({ type, hostLabel, bindAddress, bindPort, targetHost, targetPort }: RouteLineProps): RouteNode[] {
  const targetIcon = type === 'D' ? Globe : Target
  const target: RouteNode =
    targetHost === null
      ? { role: 'target', label: '*', port: '', icon: targetIcon }
      : addressNode('target', targetHost, targetPort ?? '', targetIcon)
  if (type === 'R') {
    return [
      { role: 'host', label: `${hostLabel}:${bindPort}`, port: `:${bindPort}`, icon: Server },
      { role: 'local', label: 'this Mac', port: '', icon: Laptop },
      target,
    ]
  }
  return [addressNode('local', bindAddress, bindPort, Laptop), { role: 'host', label: hostLabel, port: '', icon: Server }, target]
}

type Look = 'idle' | 'live' | 'wait' | 'bad' | 'dim'

const NODE: Record<Look, string> = {
  idle: 'border-line bg-surface-2 text-muted',
  dim: 'border-line bg-surface-2 text-muted/70',
  live: 'border-ok/55 bg-ok/12 text-ok',
  wait: 'border-warn/60 bg-warn/15 text-warn',
  bad: 'border-err/60 bg-err/15 text-err',
}

const STROKE: Record<Look, string> = {
  idle: 'var(--border)',
  dim: 'color-mix(in oklab, var(--err) 35%, var(--border))',
  live: 'var(--ok)',
  wait: 'var(--warn)',
  bad: 'var(--err)',
}

function nodeLook(role: NodeRole, state: TunnelState, broken: NodeRole): Look {
  switch (state) {
    case 'up':
      return 'live'
    case 'connecting':
    case 'retrying':
      // As in the connect overlay: this machine is fine, the hop being dialled lights up amber.
      return role === 'local' ? 'live' : role === 'host' ? 'wait' : 'idle'
    case 'failed':
      return role === broken ? 'bad' : 'dim'
    default:
      return 'idle'
  }
}

/**
 * `127.0.0.1:5433 → db → localhost:5432`, drawn as three nodes and two connectors. Up: the dashes
 * stream, faster with more traffic. Connecting: amber, the server pulsing. Retrying: amber and still. Failed: red, with a
 * break glyph on the side that failed. Reduced motion keeps colour and text only.
 */
export function RouteLine(props: RouteLineProps) {
  const { tunnelId, state, errorCode } = props
  const motionSafe = useMotionSafe()
  const step = useFlowStep(tunnelId)
  const nodes = routeNodes(props)
  const side = state === 'failed' ? breakSide(errorCode) : null
  const broken: NodeRole = side === 'local' ? 'local' : 'host'

  return (
    <div
      role="img"
      aria-label={`Route: ${nodes.map((n) => n.label).join(' → ')}`}
      data-state={state}
      className="flex items-start"
    >
      {nodes.map((node, i) => (
        <div key={node.role} className={`flex min-w-0 items-start ${i === 0 ? 'shrink-0' : 'flex-1'}`}>
          {i > 0 && (
            <Connector
              look={connectorLook(state, i)}
              flowing={state === 'up' && motionSafe}
              duration={FLOW_DURATION[step]}
              // The first connector joins this machine and the server, so the break goes there,
              // nearer whichever end failed.
              broken={i === 1 && side ? { side, near: nodes[0].role === broken } : null}
            />
          )}
          <Node
            node={node}
            look={nodeLook(node.role, state, broken)}
            // Only while dialling; a retry backoff or a locked pause stays amber and still.
            pulsing={motionSafe && node.role === 'host' && state === 'connecting'}
          />
        </div>
      ))}
    </div>
  )
}

function connectorLook(state: TunnelState, index: number): Look {
  if (state === 'up') return 'live'
  if (state === 'connecting' || state === 'retrying') return 'wait'
  if (state === 'failed') return index === 1 ? 'bad' : 'dim'
  return 'idle'
}

function Node({ node, look, pulsing }: { node: RouteNode; look: Look; pulsing: boolean }) {
  const motionSafe = useMotionSafe()
  const Icon = node.icon
  return (
    <div className="relative flex w-[88px] min-w-0 shrink-0 flex-col items-center gap-1.5" data-node={node.role}>
      <motion.span
        aria-hidden
        className={`relative grid size-7 place-items-center rounded-full border transition-colors duration-300 ${NODE[look]} ${pulsing ? 'od-pulse' : ''}`}
        // Pops once on reaching up, like a hop in the connect overlay.
        key={look === 'live' ? 'live' : 'other'}
        initial={motionSafe && look === 'live' ? { scale: 0.85 } : false}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 500, damping: 14 }}
      >
        <Icon className="size-3.5" strokeWidth={2} />
      </motion.span>
      <span
        title={node.label}
        className={`flex max-w-full font-mono text-[11px] transition-colors ${look === 'bad' ? 'text-err' : look === 'idle' || look === 'dim' ? 'text-muted' : 'text-fg/90'}`}
      >
        <span className="min-w-0 truncate">{node.label.slice(0, node.label.length - node.port.length)}</span>
        {node.port && (
          <span data-port className="shrink-0">
            {node.port}
          </span>
        )}
      </span>
    </div>
  )
}

interface ConnectorProps {
  look: Look
  flowing: boolean
  duration: string
  /** The failed side, and whether it is this connector's left end. */
  broken: { side: 'local' | 'remote'; near: boolean } | null
}

function Connector({ look, flowing, duration, broken }: ConnectorProps) {
  const stroke = STROKE[look]
  const solid = look === 'bad' || look === 'dim'
  return (
    // Reaches under the neighbouring node boxes to stop just short of their circles.
    <div aria-hidden className="relative -mx-6 h-7 min-w-6 flex-1">
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        {/* A faint rail under the dashes, so a still route still reads as a line. */}
        <line x1="0" x2="100%" y1="50%" y2="50%" stroke={stroke} strokeOpacity={0.22} strokeWidth={2} strokeLinecap="round" />
        <line
          x1="0"
          x2="100%"
          y1="50%"
          y2="50%"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={solid ? undefined : '3 5'}
          className={`transition-[stroke] duration-500 ${flowing ? 'od-flow' : ''}`}
          style={flowing ? ({ '--od-flow-dur': duration } as CSSProperties) : undefined}
        />
      </svg>
      <ChevronRight
        className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 transition-colors duration-500"
        style={{ color: stroke }}
        strokeWidth={2.6}
      />
      {broken && (
        <span
          data-break={broken.side}
          title={broken.side === 'local' ? 'Failed on this machine' : 'Failed on the remote side'}
          className={`absolute top-1/2 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-surface text-err ${broken.near ? 'left-1/4' : 'left-3/4'}`}
        >
          <Unplug className="size-3.5" strokeWidth={2.2} />
        </span>
      )}
    </div>
  )
}
