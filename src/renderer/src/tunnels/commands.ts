import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { useInventory } from '../inventory/store'
import { isRunning, TUNNEL_TYPE } from '../pages/tunnels/TunnelCard'
import { registerCommand, registerCommands } from '../ui/commands'
import { startTunnel, stopTunnel, tunnelStore } from './store'

/** `/tunnels?action=new` opens the tunnel dialog, so the command works from any page. */
export const newTunnelPath = '/tunnels?action=new'

/**
 * Palette commands for tunnels: New tunnel, and a start or stop for each saved tunnel, following its state.
 * "Go to Tunnels" is the shell's section command and is not repeated here.
 */
export function useTunnelCommands(): void {
  const data = useInventory()
  const { tunnels, runtime } = useSyncExternalStore(tunnelStore.subscribe, tunnelStore.get)
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  const go = useCallback((path: string) => () => navigateRef.current(path), [])

  useEffect(
    () =>
      registerCommand({
        id: 'tunnels.new',
        title: 'New tunnel',
        section: 'Tunnels',
        keywords: ['port forward', 'socks', 'proxy'],
        run: go(newTunnelPath),
      }),
    [go],
  )

  // Rebuilt on every state change, so each title says what running it will do.
  useEffect(() => {
    const hostLabel = new Map(data?.hosts.map((h) => [h.id, h.label]))
    return registerCommands(
      tunnels.map((t) => {
        const running = isRunning(runtime[t.id]?.state)
        return {
          id: `tunnels.toggle.${t.id}`,
          title: `${running ? 'Stop' : 'Start'} tunnel ${t.label}`,
          section: 'Tunnels',
          keywords: [...(hostLabel.has(t.hostId) ? [hostLabel.get(t.hostId)!] : []), TUNNEL_TYPE[t.type].title, String(t.bindPort)],
          run: () => void (running ? stopTunnel(t.id) : startTunnel(t.id)),
        }
      }),
    )
  }, [tunnels, runtime, data])
}
