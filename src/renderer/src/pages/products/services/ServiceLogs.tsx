import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AppServiceMeta } from '../../../../../shared/services'
import { deployStore } from '../../../deploy/store'
import { useInventory } from '../../../inventory/store'
import { api } from '../../../lib/api'
import { onContainerLog } from '../../../ops/containers'
import { createStore } from '../../../ui/store'
import { DeploymentDialog, type DeploymentRequest } from '../../deployments/DeploymentDialog'
import { LogsDrawer, type LogsTarget } from '../../ops/containers/LogsDrawer'

/** Main ends a compose follow docker or sudo refused with this hint; the checkout's sudo setting is the fix. */
const NEEDS_SUDO = /check the checkout's sudo setting/

/** `docker compose logs -f` for one service, always live; open while `service` is non-null. */
export function ServiceLogs({ service, onClose }: { service: AppServiceMeta | null; onClose: () => void }) {
  const data = useInventory()
  const [settings, setSettings] = useState<DeploymentRequest | null>(null)
  const [needsSudo, setNeedsSudo] = useState(false)
  // The follow running now; only its end can raise or clear the hint.
  const current = useRef<string | null>(null)
  // Follows that ended on the sudo hint, kept for one that ends before its reply names it.
  const refused = useRef(new Set<string>())
  const last = useRef(service)
  if (service) last.current = service
  const svc = service ?? last.current

  useEffect(
    () =>
      onContainerLog((event) => {
        if (!('ended' in event)) return
        const sudo = !!event.error && NEEDS_SUDO.test(event.error.message)
        if (event.followId === current.current) setNeedsSudo(sudo)
        else if (sudo) refused.current.add(event.followId)
      }),
    [],
  )

  const checkout = svc?.deploymentId ? deployStore.get().deployments.find((d) => d.id === svc.deploymentId) : undefined
  const hostLabel = data?.hosts.find((h) => h.id === checkout?.hostId)?.label ?? 'its host'
  const id = svc?.id
  const target = useMemo<LogsTarget | null>(
    () =>
      service && id
        ? {
            id,
            title: `${service.name} logs on ${hostLabel}`,
            follow: async (tail) => {
              setNeedsSudo(false)
              current.current = null
              const got = await api.invoke('service:logs', id, tail)
              if (got) {
                current.current = got
                if (refused.current.has(got)) setNeedsSudo(true)
              }
              return got
            },
            hint:
              needsSudo && checkout
                ? {
                    label: 'Open checkout settings',
                    // The follow has ended; the logs close so the settings dialog has the keyboard.
                    run: () => {
                      setSettings({ kind: 'edit', id: checkout.id, focus: 'useSudo' })
                      onClose()
                    },
                  }
                : undefined,
          }
        : null,
    [service, id, hostLabel, needsSudo, checkout, onClose],
  )

  return (
    <>
      <LogsDrawer target={target} onClose={onClose} />
      <DeploymentDialog request={settings} onClose={() => setSettings(null)} />
    </>
  )
}

/** The service the palette's `Logs:` command opened; one at a time, drawn by ServiceLogsHost. */
const paletteLogs = createStore<string | null>(null)

export const openServiceLogs = (serviceId: string) => paletteLogs.set(serviceId)

/** Mounted once by the shell: the logs drawer the palette opens, wherever you are. */
export function ServiceLogsHost() {
  const id = useSyncExternalStore(paletteLogs.subscribe, paletteLogs.get)
  const service = useSyncExternalStore(deployStore.subscribe, () =>
    id ? deployStore.get().services.find((s): s is AppServiceMeta => s.id === id && s.kind === 'service') : undefined,
  )
  useEffect(() => () => paletteLogs.set(null), [])
  return <ServiceLogs service={service ?? null} onClose={() => paletteLogs.set(null)} />
}
