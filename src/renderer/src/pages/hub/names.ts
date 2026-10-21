import { useHub } from '../../hub/store'
import type { InventoryData } from '../../inventory/store'

/** Resolves a group id to its name; undefined when the groups aren't loaded (only admins can list them). */
export function useHubGroupNames(): (id: string) => string | undefined {
  const { groups } = useHub()
  const byId = new Map(groups.map((g) => [g.id, g.name]))
  return (id) => byId.get(id)
}

/**
 * Splits items by product, in product order. An environment on this machine goes under its own product; one that
 * isn't goes under the product its Hub manifest names (`hubProductOf`), by name and ignoring case, since product ids
 * are local to each desktop: a local product's group when the names match, else a group of its own after them.
 * What has neither (a manifest from an older desktop) comes back as `rest` in its given order.
 */
export function byProduct<T>(
  items: T[],
  envIdOf: (item: T) => string,
  data: InventoryData | null,
  hubProductOf: (item: T) => string | undefined = () => undefined,
): { groups: { id: string; name: string; items: T[] }[]; rest: T[] } {
  const productOf = new Map((data?.environments ?? []).map((e) => [e.id, e.productId]))
  const local = (data?.products ?? []).map((p) => {
    const at = (id: string) => p.environmentIds.indexOf(id) + 1 || p.environmentIds.length + 1
    const mine = items.filter((i) => productOf.get(envIdOf(i)) === p.id).sort((a, b) => at(envIdOf(a)) - at(envIdOf(b)))
    return { id: p.id, name: p.name, items: mine }
  })
  const byName = new Map(local.map((g) => [g.name.toLowerCase(), g]))
  const hubOnly: typeof local = []
  for (const i of items) {
    const name = productOf.has(envIdOf(i)) ? undefined : hubProductOf(i)
    if (!name) continue
    const key = name.toLowerCase()
    let g = byName.get(key)
    if (!g) {
      g = { id: `hub:${key}`, name, items: [] }
      byName.set(key, g)
      hubOnly.push(g)
    }
    g.items.push(i)
  }
  const groups = [...local, ...hubOnly].filter((g) => g.items.length)
  const grouped = new Set(groups.flatMap((g) => g.items))
  return { groups, rest: items.filter((i) => !grouped.has(i)) }
}
