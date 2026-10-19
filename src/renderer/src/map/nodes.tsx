import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { AppWindow, Database, Laptop, Lock, Server, ShieldCheck, SquareTerminal, type LucideIcon } from 'lucide-react'
import { memo, type CSSProperties, type ReactNode } from 'react'
import type { HostRole } from '../../../shared/inventory'
import { OS_META } from '../pages/hosts/HostDialog'
import { PRODUCT_ICON } from '../pages/products/ProductDialog'
import { GlowDot, ROLE_LABEL } from '../pages/products/ProductView'
import { plural } from '../ui/common'
import { useMotionSafe } from '../ui/motion'
import type { EnvironmentNodeData, HostNodeData, MacNodeData, ProductNodeData } from './graph'
import { REACH_TEXT, useHostPresence, type Reach } from './presence'

/** React Flow wants an index signature on node data; the graph's interfaces don't carry one. */
type FlowData<T> = T & Record<string, unknown>
export type EnvironmentFlowData = FlowData<EnvironmentNodeData & { alsoIn: string[] }>
export type MapFlowNode =
  | Node<FlowData<ProductNodeData>, 'product'>
  | Node<EnvironmentFlowData, 'environment'>
  | Node<FlowData<HostNodeData>, 'host'>
  | Node<FlowData<MacNodeData>, 'mac'>

const ROLE_ICON: Record<HostRole, LucideIcon> = { bastion: ShieldCheck, app: AppWindow, db: Database, other: Server }

const REACH_DOT: Record<Reach, string> = { ok: 'bg-ok text-ok', busy: 'bg-warn text-warn', bad: 'bg-err text-err', unknown: 'bg-muted/50 text-muted' }

// Edges need an anchor in the DOM, but nobody draws new connections: the handles stay, unseen.
const HIDDEN: CSSProperties = { opacity: 0, pointerEvents: 'none' }
const Anchor = ({ type, position }: { type: 'source' | 'target'; position: Position }) => (
  <Handle type={type} position={position} isConnectable={false} style={HIDDEN} />
)

function Chip({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <span
      aria-label={label}
      className={`inline-flex h-4 shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 text-[10px] leading-none font-medium text-muted ring-1 ring-line ${className}`}
    >
      {children}
    </span>
  )
}

const ProductNode = memo(function ProductNode({ data }: NodeProps<Node<FlowData<ProductNodeData>, 'product'>>) {
  const Icon = PRODUCT_ICON[data.icon]
  return (
    <div
      style={{ '--tone': data.color } as CSSProperties}
      className="tone-soft flex h-full w-full items-center gap-2.5 rounded-full px-4"
    >
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={2} />
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-fg">{data.name}</span>
        <span className="block text-[11px] text-muted">{plural(data.environmentCount, 'environment')}</span>
      </span>
      <Anchor type="source" position={Position.Right} />
    </div>
  )
})

const EnvironmentNode = memo(function EnvironmentNode({ data }: NodeProps<Node<EnvironmentFlowData, 'environment'>>) {
  const unassigned = data.environmentId === null
  return (
    <div
      className={`h-full w-full rounded-xl ${unassigned ? 'border border-dashed border-muted/40' : 'border border-line'}`}
      style={
        unassigned
          ? { background: 'color-mix(in oklab, var(--surface) 40%, transparent)' }
          : { borderTop: `3px solid ${data.color}`, background: `color-mix(in oklab, ${data.color} 5%, color-mix(in oklab, var(--surface) 55%, transparent))` }
      }
    >
      <div className="flex h-10 flex-col justify-center px-4">
        <div className="flex items-center gap-2">
          {!unassigned && <GlowDot color={data.color} />}
          <span className={`truncate text-[13px] font-semibold ${unassigned ? 'text-muted' : 'text-fg'}`}>{data.name}</span>
          {data.protected && (
            <span role="img" aria-label="Protected" title="Protected" className="text-warn/90">
              <Lock aria-hidden className="size-3" strokeWidth={2.2} />
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted tabular-nums">{plural(data.hostCount, 'host')}</span>
        </div>
        {data.alsoIn.length > 0 && <p className="truncate text-[10.5px] leading-tight text-muted">also in {data.alsoIn.join(', ')}</p>}
      </div>
      <Anchor type="target" position={Position.Left} />
    </div>
  )
})

const HostNode = memo(function HostNode({ data, selected }: NodeProps<Node<FlowData<HostNodeData>, 'host'>>) {
  const motionSafe = useMotionSafe()
  const { sessions, reach } = useHostPresence(data.hostId)
  const RoleIcon = data.role ? ROLE_ICON[data.role] : Server
  const os = OS_META[data.osIcon]
  const extraVaults = data.vaultNames.length - 2
  return (
    <div
      className={`flex h-full w-full flex-col justify-center gap-1 rounded-[10px] border bg-surface px-2.5 transition-[box-shadow,border-color,translate] ${
        selected ? 'border-accent shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_35%,transparent)]' : 'border-line hover:border-muted/40'
      } ${motionSafe ? 'hover:-translate-y-0.5 hover:shadow-pop' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span role="img" aria-label={data.role ? ROLE_LABEL[data.role] : 'No role'} title={data.role ? ROLE_LABEL[data.role] : 'No role'} className="text-muted">
          <RoleIcon aria-hidden className="size-3.5" strokeWidth={2} />
        </span>
        <span role="img" aria-label={os.label} title={os.label} className="text-muted">
          <os.icon aria-hidden className="size-3.5" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-fg">{data.label}</span>
        {sessions > 0 && (
          <Chip label={plural(sessions, 'session')} className="text-ok">
            <SquareTerminal aria-hidden className="size-2.5" strokeWidth={2.4} />
            {sessions}
          </Chip>
        )}
        <span
          role="img"
          aria-label={REACH_TEXT[reach]}
          title={REACH_TEXT[reach]}
          className={`size-2 shrink-0 rounded-full ${REACH_DOT[reach]} ${reach === 'busy' && motionSafe ? 'od-pulse' : ''}`}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">{data.address}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {/* Names can repeat across vaults and the data carries no ids, so position is the key. */}
          {data.vaultNames.slice(0, 2).map((name, i) => (
            <Chip key={i} className="max-w-14">
              <span className="truncate">{name}</span>
            </Chip>
          ))}
          {extraVaults > 0 && <Chip>+{extraVaults}</Chip>}
          {data.sharedCount > 1 && <Chip>shared ×{data.sharedCount}</Chip>}
          {data.jumpLabel && <Chip className="max-w-24"><span className="truncate">via {data.jumpLabel}</span></Chip>}
        </span>
      </div>
      {data.attachments.length > 0 && <div data-attachments className="flex gap-1" />}
      <Anchor type="target" position={Position.Left} />
      <Anchor type="source" position={Position.Right} />
    </div>
  )
})

const MacNode = memo(function MacNode({ data }: NodeProps<Node<FlowData<MacNodeData>, 'mac'>>) {
  return (
    <div className="flex h-full w-full items-center gap-3 rounded-xl border border-line bg-surface px-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
        <Laptop aria-hidden className="size-4.5" strokeWidth={2} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-fg">This Mac</span>
        <span className="block text-[11px] text-muted">{plural(data.tunnelCount, 'tunnel')}</span>
      </span>
      {/* Tunnels arrive from the groups on the left, in either direction. */}
      <Anchor type="target" position={Position.Left} />
      <Anchor type="source" position={Position.Left} />
    </div>
  )
})

export const nodeTypes = { product: ProductNode, environment: EnvironmentNode, host: HostNode, mac: MacNode }
