import { useHub } from '../../hub/store'
import type { InventoryData } from '../../inventory/store'

/** Resolves a group id to its name; undefined when the groups aren't loaded (only admins can list them). */
export function useHubGroupNames(): (id: string) => string | undefined {
  const { groups } = useHub()
  const byId = new Map(groups.map((g) => [g.id, g.name]))
  return (id) => byId.get(id)
}

/**
 * Splits items by the product of their environment on this machine, in product order. What isn't local, or
 * whose product is unknown, comes back as `rest` in its given order: the Hub manifest doesn't carry the product.
 */
export function byLocalProduct<T>(items: T[], envIdOf: (item: T) => string, data: InventoryData | null): { groups: { id: string; name: string; items: T[] }[]; rest: T[] } {
  const productOf = new Map((data?.environments ?? []).map((e) => [e.id, e.productId]))
  const groups = (data?.products ?? []).flatMap((p) => {
    const at = (id: string) => p.environmentIds.indexOf(id) + 1 || p.environmentIds.length + 1
    const mine = items.filter((i) => productOf.get(envIdOf(i)) === p.id).sort((a, b) => at(envIdOf(a)) - at(envIdOf(b)))
    return mine.length ? [{ id: p.id, name: p.name, items: mine }] : []
  })
  const grouped = new Set(groups.flatMap((g) => g.items))
  return { groups, rest: items.filter((i) => !grouped.has(i)) }
}
