import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useInventory, inventoryStore } from '../inventory/store'
import { byName } from '../inventory/tree'
import { registerCommand, registerCommands } from '../ui/commands'
import { parseScope, scopeKey } from './graph'
import { clearPins, pinsStore } from './viewport'
// regions-ui: one product per environment, read as a list until the Regions UI.
import { productIdsOf } from '../inventory/regions-stopgap'

/** `/map?find=1` focuses the map's search box once; the page drops the param again. */
export const FIND_PARAM = 'find'
/** `/map?focus=<hostId>` zooms to the host's first placement and selects it, once. */
export const FOCUS_PARAM = 'focus'

export const showHostOnMapPath = (hostId: string) => `/map?${new URLSearchParams({ [FOCUS_PARAM]: hostId })}`
export const showEnvironmentOnMapPath = (environmentId: string) => `/map?${new URLSearchParams({ env: environmentId })}`
export const showProductOnMapPath = (productId: string) => `/map?${new URLSearchParams({ product: productId })}`

/**
 * The Map palette commands while the shell is mounted. Opening the map is `nav.map` ("Go to Map", mod+6),
 * registered with the other sections, so it is not repeated here.
 */
export function useMapCommands(): void {
  const data = useInventory()
  const navigate = useNavigate()
  const location = useLocation()
  const latest = useRef({ navigate, location })
  useEffect(() => {
    latest.current = { navigate, location }
  })
  const go = useCallback((path: string) => () => latest.current.navigate(path), [])

  useEffect(() => {
    const off = [
      registerCommand({ id: 'map.find', title: 'Find on map', section: 'Map', keywords: ['search', 'topology'], run: go(`/map?${FIND_PARAM}=1`) }),
      registerCommand({
        id: 'map.reset',
        title: 'Reset map layout',
        section: 'Map',
        keywords: ['positions', 'drag', 'topology'],
        run: () => {
          // On the map, the view it shows; from anywhere else, every view's dragged positions.
          const { location } = latest.current
          const inventory = inventoryStore.get()
          if (location.pathname === '/map' && inventory) clearPins(scopeKey(parseScope(new URLSearchParams(location.search), inventory)))
          else pinsStore.set({})
        },
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [go])

  // Rebuilt whenever the inventory changes, so renamed or deleted items never linger.
  useEffect(() => {
    if (!data) return
    const productName = new Map(data.products.map((p) => [p.id, p.name]))
    return registerCommands([
      ...data.environments.map((e) => ({
        id: `map.env.${e.id}`,
        title: `Show ${e.name} on map`,
        section: 'Map',
        keywords: [e.name, ...productIdsOf(e).flatMap((id) => productName.get(id) ?? []).sort(byName)],
        run: go(showEnvironmentOnMapPath(e.id)),
      })),
      ...data.hosts.map((h) => ({
        id: `map.host.${h.id}`,
        title: `Show ${h.label} on map`,
        section: 'Map',
        keywords: [h.address, ...h.tags],
        run: go(showHostOnMapPath(h.id)),
      })),
    ])
  }, [data, go])
}
