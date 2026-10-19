import { Network, SquareTerminal } from 'lucide-react'
import { memo, useMemo } from 'react'
import { ROLE_LABEL } from '../pages/products/ProductView'
import { TUNNEL_TYPE, TunnelStateWord, TunnelSwitch } from '../pages/tunnels/TunnelCard'
import { useTunnel } from '../tunnels/store'
import { Button } from '../ui/Button'
import type { EnvironmentNodeData, HostNodeData, MapGraph } from './graph'
import { REACH_TEXT, useHostPresence } from './presence'

export interface MapListProps {
  graph: MapGraph
  onConnect: (hostId: string, environmentId: string | null) => void
  /** Show on map: the page switches to the canvas and zooms to this placement. */
  onSelect: (id: string) => void
}

const HEAD = 'px-3 py-2 text-left text-[11px] font-medium tracking-wide text-muted uppercase'
const CELL = 'px-3 py-2 align-top text-[12.5px]'

interface Group {
  id: string
  data: EnvironmentNodeData
  hosts: { id: string; data: HostNodeData; tunnelIds: string[]; via: string | null }[]
}

/**
 * The map as a table: one row group per environment, one row per host placement, in the map's order.
 * The same graph the canvas draws, so a filter or search shapes both alike; what the canvas says by
 * frame and line (the group's products, a host's jump) the table says in words.
 */
export function MapList({ graph, onConnect, onSelect }: MapListProps) {
  const groups = useMemo(() => {
    // A tunnel sits in the row of the placement the map draws it from.
    const tunnels = new Map<string, string[]>()
    for (const e of graph.edges) {
      if (e.data.kind !== 'tunnel') continue
      const end = e.source === 'mac' ? e.target : e.source
      tunnels.set(end, [...(tunnels.get(end) ?? []), e.data.tunnelId])
    }
    // A drawn jump names its source placement; one not drawn is carried on the host as its label.
    const label = new Map(graph.nodes.flatMap((n) => (n.data.kind === 'host' ? [[n.id, n.data.label] as const] : [])))
    const via = new Map<string, string>()
    for (const e of graph.edges) {
      const from = e.data.kind === 'jump' ? label.get(e.source) : undefined
      if (from) via.set(e.target, from)
    }
    const out: Group[] = []
    const byId = new Map<string, Group>()
    for (const n of graph.nodes) {
      if (n.data.kind === 'environment') {
        const g: Group = { id: n.id, data: n.data, hosts: [] }
        out.push(g)
        byId.set(n.id, g)
      } else if (n.data.kind === 'host' && n.parentId) {
        byId.get(n.parentId)?.hosts.push({ id: n.id, data: n.data, tunnelIds: tunnels.get(n.id) ?? [], via: via.get(n.id) ?? n.data.jumpLabel })
      }
    }
    return out.filter((g) => g.hosts.length)
  }, [graph])

  return (
    <div className="h-full overflow-y-auto px-8 pt-4 pb-8">
      <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-xl border border-line">
        <caption className="sr-only">Hosts by environment</caption>
        <thead className="bg-surface-2/60">
          <tr>
            {['Host', 'Address', 'Role', 'Reachability', 'Sessions', 'Tunnels'].map((h) => (
              <th key={h} scope="col" className={HEAD}>
                {h}
              </th>
            ))}
            <th scope="col" className={HEAD}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {groups.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={7} className={`${CELL} py-8 text-center text-muted`}>
                No hosts match.
              </td>
            </tr>
          </tbody>
        ) : (
          groups.map((g) => (
            <tbody key={g.id}>
              <tr>
                <th colSpan={7} scope="rowgroup" className="border-t border-line bg-surface/60 px-3 py-1.5 text-left text-[12px] font-semibold text-fg">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: g.data.color }} />
                    {g.data.name}
                    {g.data.productNames.length > 0 && (
                      <span className="font-normal text-muted">
                        <span className="sr-only">, </span>
                        {g.data.productNames.join(', ')}
                      </span>
                    )}
                  </span>
                </th>
              </tr>
              {g.hosts.map((h) => (
                <HostRow key={h.id} id={h.id} d={h.data} tunnelIds={h.tunnelIds} via={h.via} onConnect={onConnect} onSelect={onSelect} />
              ))}
            </tbody>
          ))
        )}
      </table>
    </div>
  )
}

interface HostRowProps {
  id: string
  d: HostNodeData
  tunnelIds: string[]
  /** The jump host this placement connects through, by label. */
  via: string | null
  onConnect: MapListProps['onConnect']
  onSelect: MapListProps['onSelect']
}

const HostRow = memo(function HostRow({ id, d, tunnelIds, via, onConnect, onSelect }: HostRowProps) {
  const { sessions, reach } = useHostPresence(d.hostId)
  return (
    <tr>
      <th scope="row" className={`${CELL} border-t border-line text-left font-semibold text-fg`}>
        {d.label}
      </th>
      <td className={`${CELL} border-t border-line font-mono text-[11.5px] text-muted`}>
        {d.address}
        {via && <span className="font-sans"> via {via}</span>}
      </td>
      <td className={`${CELL} border-t border-line`}>{d.role ? ROLE_LABEL[d.role] : 'No role'}</td>
      <td className={`${CELL} border-t border-line ${reach === 'ok' ? 'text-ok' : reach === 'bad' ? 'text-err' : reach === 'busy' ? 'text-warn' : 'text-muted'}`}>
        {REACH_TEXT[reach]}
      </td>
      <td className={`${CELL} border-t border-line tabular-nums`}>{sessions}</td>
      <td className={`${CELL} border-t border-line`}>
        {tunnelIds.length ? (
          <ul aria-label={`${d.label} tunnels`} className="flex flex-col gap-1">
            {tunnelIds.map((t) => (
              <TunnelItem key={t} id={t} />
            ))}
          </ul>
        ) : (
          <span className="text-muted">None</span>
        )}
      </td>
      <td className={`${CELL} border-t border-line`}>
        <span className="flex justify-end gap-1.5">
          <Button size="sm" icon={<SquareTerminal aria-hidden className="size-3.5" />} onClick={() => onConnect(d.hostId, d.environmentId)}>
            Connect
          </Button>
          <Button size="sm" variant="ghost" icon={<Network aria-hidden className="size-3.5" />} onClick={() => onSelect(id)}>
            Show on map
          </Button>
        </span>
      </td>
    </tr>
  )
})

function TunnelItem({ id }: { id: string }) {
  const { meta, runtime } = useTunnel(id)
  if (!meta) return null
  const state = runtime?.state ?? 'stopped'
  const kind = TUNNEL_TYPE[meta.type]
  return (
    <li className="flex min-w-0 items-center gap-2">
      <span title={kind.title} className="shrink-0 font-mono text-[10.5px] font-semibold" style={{ color: kind.color }}>
        {kind.chip}
      </span>
      <span className="min-w-0 flex-1 truncate" title={meta.label}>
        {meta.label}
      </span>
      <TunnelStateWord state={state} />
      <TunnelSwitch id={id} label={meta.label} state={state} />
    </li>
  )
}
