import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import type { NotificationRecord, NotifyChannel } from '../../../shared/settings'
import { inventoryStore } from '../inventory/store'
import { api } from '../lib/api'
import { tunnelStore } from '../tunnels/store'
import { toast } from '../ui/Toaster'

export const CHANNEL_LABEL: Record<NotifyChannel, string> = { teams: 'Teams', email: 'Email', macos: 'macOS', qa: 'QA' }

/** `#/tunnels` (a notification click) and `/tunnels` both route in-app. */
export const toPath = (route: string): string => (route.startsWith('#') ? route.slice(1) : route) || '/'

/** Where a log row's source lives, and the environment it belongs to. */
async function locate(r: NotificationRecord): Promise<{ envId: string | null; envName: string | null; path: string }> {
  const envName = (id: string | null) => (id ? (inventoryStore.get()?.environments.find((e) => e.id === id)?.name ?? null) : null)
  if (r.sourceType === 'tunnel') {
    const tunnelId = r.sourceId.split('@')[0]
    const envId = tunnelStore.get().tunnels.find((t) => t.id === tunnelId)?.environmentId ?? null
    return { envId, envName: envName(envId), path: '/tunnels' }
  }
  if (r.sourceType === 'release') {
    const rel = await api.invoke('release:get', r.sourceId).catch(() => null)
    const envId = rel?.environmentId ?? null
    return { envId, envName: rel?.environmentName ?? envName(envId), path: envId ? `/deployments?env=${envId}` : '/deployments' }
  }
  return { envId: null, envName: null, path: '/settings' }
}

/**
 * App-wide main-process pushes: `app:navigate` (a macOS notification was clicked) routes, and a failed
 * `notify:sent` toasts with a View action. Successes stay quiet; the release view lists them.
 */
export function AppEvents(): null {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  useEffect(() => {
    const offNav = api.on('app:navigate', ({ route }) => void navigateRef.current(toPath(route)))
    const offSent = api.on('notify:sent', (r) => {
      if (r.status !== 'failed') return
      void locate(r).then(({ envName, path }) =>
        toast({
          title: `${CHANNEL_LABEL[r.channel]} notification${envName ? ` to ${envName}` : ''} failed`,
          description: r.detail ?? undefined,
          tone: 'error',
          action: { label: 'View', run: () => void navigateRef.current(path) },
        }),
      )
    })
    const offNotice = api.on('hub:notice', ({ message }) => toast({ title: message, tone: 'error' }))
    return () => {
      offNav()
      offSent()
      offNotice()
    }
  }, [])
  return null
}
