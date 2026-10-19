import { useHub } from '../../hub/store'

/** Resolves a group id to its name; ids not loaded yet (non-admins) read as "Group". */
export function useHubGroupNames(): (id: string) => string {
  const { groups } = useHub()
  const byId = new Map(groups.map((g) => [g.id, g.name]))
  return (id) => byId.get(id) ?? 'Group'
}
