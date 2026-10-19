import { useHub } from '../../hub/store'

/** Resolves a group id to its name; undefined when the groups aren't loaded (only admins can list them). */
export function useHubGroupNames(): (id: string) => string | undefined {
  const { groups } = useHub()
  const byId = new Map(groups.map((g) => [g.id, g.name]))
  return (id) => byId.get(id)
}
