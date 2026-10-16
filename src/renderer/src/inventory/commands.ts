import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { registerCommand } from '../ui/commands'
import { useInventory } from './store'
import { environmentKey } from './tree'

/** `/hosts?action=…` opens one of the Hosts page's dialogs, so these commands work from any page. */
export type HostsAction = 'new' | 'import'
export const hostsActionPath = (action: HostsAction) => `/hosts?action=${action}`

/** Palette commands built from the inventory: "Go to" every host and environment, plus new and import. */
export function useInventoryCommands(): void {
  const data = useInventory()
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  const go = useCallback((path: string) => () => navigateRef.current(path), [])

  useEffect(() => {
    const off = [
      registerCommand({ id: 'hosts.new', title: 'New host', section: 'Hosts', keywords: ['server', 'machine'], run: go(hostsActionPath('new')) }),
      registerCommand({
        id: 'hosts.import',
        title: 'Import from ~/.ssh/config',
        section: 'Hosts',
        keywords: ['ssh', 'config', 'openssh'],
        run: go(hostsActionPath('import')),
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [go])

  // Rebuilt whenever the store changes, so renamed or deleted items never linger.
  useEffect(() => {
    if (!data) return
    const productName = new Map(data.products.map((p) => [p.id, p.name]))
    const off = [
      ...data.hosts.map((h) =>
        registerCommand({
          id: `hosts.go.${h.id}`,
          title: `Go to ${h.label}`,
          section: 'Hosts',
          keywords: [h.address, ...h.tags],
          run: go(`/hosts?host=${encodeURIComponent(h.id)}`),
        }),
      ),
      ...data.environments.map((e) => {
        const products = e.productIds.flatMap((id) => productName.get(id) ?? []).sort((a, b) => a.localeCompare(b))
        return registerCommand({
          id: `environments.go.${e.id}`,
          title: `Go to ${e.name} · ${products.length ? products.join(', ') : 'Unassigned'}`,
          section: 'Environments',
          keywords: [e.name],
          run: go(`/products?${new URLSearchParams({ node: environmentKey(e) })}`),
        })
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [data, go])
}
