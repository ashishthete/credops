import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { useInventory } from '../inventory/store'
import { openServiceLogs } from '../pages/products/services/ServiceLogs'
import { registerCommands, type Command } from '../ui/commands'
import { releaseStore } from './releases'
import { deployStore } from './store'

const q = encodeURIComponent

/** `/deployments?env=<id>&action=deploy` opens the deploy wizard for that environment. */
export const deployPath = (envId: string) => `/deployments?env=${q(envId)}&action=deploy`
export const historyPath = (envId: string) => `/deployments?env=${q(envId)}&tab=history`
export const releasePath = (releaseId: string) => `/deployments/release/${q(releaseId)}`

/**
 * Palette commands for deployments: deploy and history per environment with checkouts, the running
 * releases, and the logs of each service that runs from a checkout.
 */
export function useDeployCommands(): void {
  const data = useInventory()
  const deployments = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().deployments)
  const services = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().services)
  const active = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().active)
  const byId = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().byId)
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  const go = useCallback((path: string) => () => navigateRef.current(path), [])

  useEffect(() => {
    if (!data) return
    const envs = data.environments.filter((e) => deployments.some((d) => d.environmentId === e.id))
    const envName = new Map(data.environments.map((e) => [e.id, e.name]))
    const cmds: Command[] = envs.flatMap((e) => [
      { id: `deploy.wizard.${e.id}`, title: `Deploy services in ${e.name}…`, section: 'Deployments', keywords: ['release', 'ship', 'deploy'], run: go(deployPath(e.id)) },
      { id: `deploy.history.${e.id}`, title: `Deployment history: ${e.name}`, section: 'Deployments', keywords: ['releases', 'rollback'], run: go(historyPath(e.id)) },
    ])
    const running = active.flatMap((id) => (byId[id] ? [byId[id]] : []))
    for (const r of running) {
      cmds.push({
        id: `deploy.release.${r.id}`,
        title: running.length > 1 ? `Open running release: ${r.environmentName}${r.version ? ` ${r.version}` : ''}` : 'Open running release',
        section: 'Deployments',
        keywords: ['pipeline', 'progress', r.environmentName],
        run: go(releasePath(r.id)),
      })
    }
    for (const s of services) {
      if (s.kind !== 'service' || !s.deploymentId) continue
      cmds.push({
        id: `deploy.logs.${s.id}`,
        title: `Logs: ${s.name} (${envName.get(s.environmentId) ?? 'unknown environment'})`,
        section: 'Deployments',
        keywords: ['docker', 'compose', 'tail'],
        run: () => openServiceLogs(s.id),
      })
    }
    return registerCommands(cmds)
  }, [data, deployments, services, active, byId, go])
}
