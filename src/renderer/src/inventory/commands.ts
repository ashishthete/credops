import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useConnect } from '../terminal/connect'
import { registerCommand, registerCommands } from '../ui/commands'
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
  const { connect, connectLocal } = useConnect()
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
      registerCommand({
        id: 'terminal.local',
        title: 'New local shell',
        section: 'Terminals',
        keywords: ['terminal', 'shell', 'console'],
        shortcut: 'mod+t',
        run: () => void connectLocal(),
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [go, connectLocal])

  // Rebuilt whenever the store changes, so renamed or deleted items never linger.
  useEffect(() => {
    if (!data) return
    const productName = new Map(data.products.map((p) => [p.id, p.name]))
    const envById = new Map(data.environments.map((e) => [e.id, e]))
    return registerCommands([
      ...data.hosts.map((h) => {
        const envs = h.environments.flatMap((m) => envById.get(m.environmentId) ?? [])
        return {
          id: `connect:${h.id}`,
          title: `Connect to ${h.label}`,
          section: 'Terminals',
          keywords: [h.address, ...h.tags, ...envs.map((e) => e.name)],
          // A host in exactly one environment connects with its defaults; otherwise there is no single context.
          run: () => void connect(h.id, envs.length === 1 ? envs[0].id : undefined),
        }
      }),
      ...data.hosts.map((h) => ({
        id: `hosts.go.${h.id}`,
        title: `Go to ${h.label}`,
        section: 'Hosts',
        keywords: [h.address, ...h.tags],
        run: go(`/hosts?host=${encodeURIComponent(h.id)}`),
      })),
      ...data.environments.map((e) => {
        const products = e.productIds.flatMap((id) => productName.get(id) ?? []).sort((a, b) => a.localeCompare(b))
        return {
          id: `environments.go.${e.id}`,
          title: `Go to ${e.name} · ${products.length ? products.join(', ') : 'Unassigned'}`,
          section: 'Environments',
          keywords: [e.name],
          run: go(`/products?${new URLSearchParams({ node: environmentKey(e) })}`),
        }
      }),
    ])
  }, [data, go, connect])
}
