import { fuzzyMatch } from '../ui/commands'
import { domainOf, type MapGraph, type MapNodeData } from './graph'

/** What a node is found by: product and environment names; a host's label, address, tags, region and its services' domains. */
function searchable(d: MapNodeData): string[] {
  if (d.kind === 'product' || d.kind === 'environment') return [d.name]
  if (d.kind === 'host') {
    const domains = d.attachments.flatMap((a) => (a.url ? [domainOf(a.url)] : []))
    return [d.label, d.address, ...d.tags, ...(d.region ? [d.region.code, d.region.displayName] : []), ...domains]
  }
  return []
}

/**
 * Nodes matching `query`, best first; equal scores keep node order. `best` is the first match, or null
 * when nothing matches (an empty query matches nothing).
 */
export function searchGraph(graph: MapGraph, query: string): { matches: string[]; best: string | null } {
  if (!query.trim()) return { matches: [], best: null }
  const scored: { id: string; score: number }[] = []
  for (const n of graph.nodes) {
    let score = -Infinity
    for (const text of searchable(n.data)) score = Math.max(score, fuzzyMatch(query, text)?.score ?? -Infinity)
    if (score > -Infinity) scored.push({ id: n.id, score })
  }
  // Array sort is stable, so ties stay in node order.
  scored.sort((a, b) => b.score - a.score)
  const matches = scored.map((s) => s.id)
  return { matches, best: matches[0] ?? null }
}
