import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, getStraightPath, type Edge, type EdgeProps } from '@xyflow/react'
import { ShieldCheck, Unplug } from 'lucide-react'
import { createContext, memo, useContext, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { TunnelState } from '../../../shared/tunnels'
import { formatRate, TUNNEL_TYPE } from '../pages/tunnels/TunnelCard'
import { FLOW_DURATION, flowStep } from '../pages/tunnels/RouteLine'
import { statsStore, useTunnel } from '../tunnels/store'
import { useMotionSafe } from '../ui/motion'
import type { JumpEdgeData, MembershipEdgeData, TunnelEdgeData } from './graph'

/** React Flow wants an index signature on edge data; the graph's interfaces don't carry one. */
type FlowData<T> = T & Record<string, unknown>
export type MembershipFlowData = FlowData<MembershipEdgeData & { color: string }>
export type MapFlowEdge =
  | Edge<FlowData<TunnelEdgeData>, 'tunnel'>
  | Edge<FlowData<JumpEdgeData>, 'jump'>
  | Edge<MembershipFlowData, 'membership'>

export type EdgeTone = 'ok' | 'warn' | 'err' | 'muted'

export function edgeTone(state: TunnelState): EdgeTone {
  switch (state) {
    case 'up':
      return 'ok'
    case 'connecting':
    case 'retrying':
      return 'warn'
    case 'failed':
      return 'err'
    default:
      return 'muted'
  }
}

const TONE: Record<EdgeTone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', muted: 'var(--muted)' }
const FLOW_WIDTH = [1.5, 2.25, 3] as const
// One period with the `od-flow` keyframes (3 + 5), so the loop never jumps; throughput scales the width only.
const FLOW_DASH = '3 5'
const DOTTED = '1 4'

export interface EdgeActions {
  select: (id: string) => void
  /** Lights an edge's two end nodes, as hovering the edge does; null clears it. */
  hover: (id: string | null) => void
}

/** The chip's handlers; MapCanvas provides them, so they never ride in edge data. */
export const EdgeActionsContext = createContext<EdgeActions>({ select: () => {}, hover: () => {} })

/** One rate as a number, so a tick re-renders only the edge whose own rates moved. */
function useRate(tunnelId: string, key: 'rateIn' | 'rateOut'): number {
  return useSyncExternalStore(statsStore.subscribe, () => statsStore.get()[tunnelId]?.last[key] ?? 0)
}

const TunnelEdge = memo(function TunnelEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<FlowData<TunnelEdgeData>, 'tunnel'>>) {
  const { tunnelId, tunnelType, label } = data!
  const motionSafe = useMotionSafe()
  const actions = useContext(EdgeActionsContext)
  // A focused chip lights its edge the way hover does, for keyboard users.
  const [focused, setFocused] = useState(false)
  const state = useTunnel(tunnelId).runtime?.state ?? 'stopped'
  const rateIn = useRate(tunnelId, 'rateIn')
  const rateOut = useRate(tunnelId, 'rateOut')
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  const tone = edgeTone(state)
  const up = state === 'up'
  const step = flowStep(rateIn + rateOut)
  const duration = FLOW_DURATION[step]
  const flowing = up && motionSafe
  const kind = TUNNEL_TYPE[tunnelType]
  const dash = up || tone === 'warn' ? FLOW_DASH : state === 'stopped' ? DOTTED : undefined

  return (
    <>
      <BaseEdge
        path={path}
        interactionWidth={20}
        data-tone={tone}
        data-source={source}
        data-target={target}
        className={['od-edge', flowing && 'od-flow', focused && 'od-edge-lit'].filter(Boolean).join(' ')}
        strokeDasharray={dash}
        strokeLinecap="round"
        style={
          {
            stroke: TONE[tone],
            strokeWidth: up ? FLOW_WIDTH[step] : 1.5,
            opacity: state === 'stopped' ? 0.5 : undefined,
            '--od-tone': TONE[tone],
            ...(up ? { '--od-flow-dur': duration } : {}),
          } as CSSProperties
        }
      />
      {flowing && (
        <circle r={2} fill={TONE.ok} className="od-travel" style={{ '--od-flow-dur': duration } as CSSProperties}>
          <animateMotion dur={duration} repeatCount="indefinite" path={path} />
        </circle>
      )}
      {state === 'failed' && (
        <g data-break transform={`translate(${labelX} ${labelY})`}>
          <circle r={8} fill="var(--surface)" stroke={TONE.err} strokeWidth={1} />
          <Unplug x={-5} y={-5} size={10} color={TONE.err} strokeWidth={2.4} />
        </g>
      )}
      <EdgeLabelRenderer>
        {/* Sits just above the midpoint, so the line (and a break glyph) stays visible under it. */}
        <button
          type="button"
          aria-label={`${label}, ${kind.title}, ${state}`}
          onClick={() => actions.select(id)}
          onFocus={() => {
            setFocused(true)
            actions.hover(id)
          }}
          onBlur={() => {
            setFocused(false)
            actions.hover(null)
          }}
          className="nodrag nopan absolute flex max-w-56 items-center gap-1.5 rounded-full border border-line bg-surface/95 py-0.5 pr-2 pl-0.5 text-[10.5px] leading-none whitespace-nowrap text-fg shadow-sm outline-none hover:border-muted/50 focus-visible:ring-2 focus-visible:ring-accent/70"
          style={{ transform: `translate(-50%, calc(-100% - 6px)) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
        >
          <span
            className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold"
            style={{ color: kind.color, background: `color-mix(in oklab, ${kind.color} 16%, transparent)` }}
          >
            {kind.chip}
          </span>
          <span className="min-w-0 truncate">{label}</span>
          {up && (
            <span className="font-mono text-muted tabular-nums">
              ↓ {formatRate(rateIn)} ↑ {formatRate(rateOut)}
            </span>
          )}
          {state === 'retrying' && <span className="text-warn">retrying</span>}
          {state === 'failed' && <span className="text-err">failed</span>}
        </button>
      </EdgeLabelRenderer>
    </>
  )
})

const JumpEdge = memo(function JumpEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<FlowData<JumpEdgeData>, 'jump'>>) {
  const viaEnvDefault = data!.viaEnvDefault
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 })
  return (
    <>
      <title>{viaEnvDefault ? 'Jump host · environment default' : 'Jump host'}</title>
      <BaseEdge
        path={path}
        interactionWidth={20}
        className="od-edge"
        strokeDasharray={viaEnvDefault ? '10 5' : '4 4'}
        style={{ stroke: TONE.muted, strokeWidth: 1.25, opacity: 0.8, '--od-tone': TONE.muted } as CSSProperties}
      />
      <g data-marker="jump" transform={`translate(${sourceX + 9} ${sourceY})`}>
        <circle r={7} fill="var(--surface)" stroke={TONE.muted} strokeWidth={1} />
        <ShieldCheck x={-4.5} y={-4.5} size={9} color={TONE.muted} strokeWidth={2.4} />
      </g>
    </>
  )
})

const MembershipEdge = memo(function MembershipEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<MembershipFlowData, 'membership'>>) {
  const { primary, color } = data!
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  return (
    <BaseEdge
      path={path}
      interactionWidth={0}
      strokeDasharray={primary ? undefined : DOTTED}
      strokeLinecap="round"
      style={{ stroke: color, strokeWidth: 1, opacity: primary ? 0.7 : 0.4 }}
    />
  )
})

export const edgeTypes = { tunnel: TunnelEdge, jump: JumpEdge, membership: MembershipEdge }
