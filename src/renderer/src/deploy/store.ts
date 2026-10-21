import { useMemo, useSyncExternalStore } from 'react'
import type {
  DeploymentInput,
  DeploymentMeta,
  DeploymentPatch,
  EnvDeploySettings,
  EnvDeploySettingsPatch,
  Tooling,
} from '../../../shared/deploy'
import type { ServiceInput, ServiceMeta, ServicePatch, ServiceUpdateResult } from '../../../shared/services'
import { api } from '../lib/api'
import { loadTunnels } from '../tunnels/store'
import { attempt, fail } from '../ui/common'
import { createStore } from '../ui/store'

export interface DeployState {
  deployments: DeploymentMeta[]
  services: ServiceMeta[]
  /** Db services whose saved route differs from their running tunnel's: the user chose not to restart yet. */
  routeChanged: Record<string, true>
  settings: Record<string, EnvDeploySettings>
  tooling: Tooling | null
  loaded: boolean
}

const EMPTY: DeployState = { deployments: [], services: [], routeChanged: {}, settings: {}, tooling: null, loaded: false }

export const deployStore = createStore<DeployState>(EMPTY)

/** Bumped by resetDeploy and by every local write; a read that started before either must not overwrite. */
let generation = 0
let written = 0
let syncUsers = 0
let stopSync: (() => void) | null = null
/** Events within this window share one refetch: a running release emits many. */
const SYNC_DEBOUNCE_MS = 100

export function resetDeploy(): void {
  generation++
  deployStore.set(EMPTY)
}

/**
 * Reads the lists, the tooling report and the settings of `envIds` (plus any already cached) in parallel.
 * A list written locally while the read was in flight stays as written.
 */
export async function loadDeploy(envIds: string[] = []): Promise<void> {
  const started = generation
  const seen = written
  try {
    const wanted = [...new Set([...Object.keys(deployStore.get().settings), ...envIds])]
    const [deployments, services, tooling, settings] = await Promise.all([
      api.invoke('deploy:list'),
      api.invoke('service:list'),
      api.invoke('deploy:tooling'),
      Promise.all(wanted.map((id) => api.invoke('deploy:settings', id))),
    ])
    if (started !== generation) return
    const s = deployStore.get()
    const fresh = seen === written
    deployStore.set({
      ...s,
      deployments: fresh ? (deployments ?? s.deployments) : s.deployments,
      services: fresh ? (services ?? s.services) : s.services,
      settings: { ...s.settings, ...Object.fromEntries((settings ?? []).filter(Boolean).map((x) => [x.environmentId, x])) },
      tooling: tooling ?? s.tooling,
      loaded: true,
    })
  } catch (err) {
    fail("Couldn't load your deployments", err)
  }
}

/** Loads one environment's settings when they aren't cached yet. */
export async function loadSettings(envId: string): Promise<void> {
  if (deployStore.get().settings[envId]) return
  const started = generation
  try {
    const got = await api.invoke('deploy:settings', envId)
    if (started !== generation || !got) return
    const s = deployStore.get()
    if (!s.settings[envId]) deployStore.set({ ...s, settings: { ...s.settings, [envId]: got } })
  } catch (err) {
    fail("Couldn't load the deploy settings", err)
  }
}

/** Refetches on `deploy:changed`; concurrent callers share one subscription. Returns the unsubscribe. */
export function startDeploySync(): () => void {
  if (syncUsers++ === 0) {
    // loadDeploy also refreshes every cached environment's settings (the current version moves after a release).
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let all = false
    const flush = () => {
      timer ??= setTimeout(() => {
        timer = null
        const ids = all ? undefined : [...pending]
        all = false
        pending.clear()
        void loadDeploy(ids)
      }, SYNC_DEBOUNCE_MS)
    }
    const off = api.on('deploy:changed', ({ environmentId }) => {
      pending.add(environmentId)
      flush()
    })
    // deploy:list also carries the Hub's environments, which arrive (or go) when the catalog does.
    const offCatalog = api.on('hub:catalog', () => {
      all = true
      flush()
    })
    void loadDeploy()
    stopSync = () => {
      off()
      offCatalog()
      if (timer) clearTimeout(timer)
    }
  }
  let left = false
  return () => {
    if (left) return
    left = true
    if (--syncUsers === 0) {
      stopSync?.()
      stopSync = null
    }
  }
}

/** The environment's deployments in run order. Stable between renders until the list changes. */
export function useDeployments(envId: string | null): DeploymentMeta[] {
  const all = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().deployments)
  return useMemo(
    () => (envId ? all.filter((d) => d.environmentId === envId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)) : []),
    [all, envId],
  )
}

/** The environment's services in position order. Stable between renders until the list changes. */
export function useServices(envId: string | null): ServiceMeta[] {
  const all = useSyncExternalStore(deployStore.subscribe, () => deployStore.get().services)
  return useMemo(
    () => (envId ? all.filter((s) => s.environmentId === envId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)) : []),
    [all, envId],
  )
}

export const useDeploy = (): DeployState => useSyncExternalStore(deployStore.subscribe, deployStore.get)

type OnError = (message: string) => void

export async function createDeployment(input: DeploymentInput, onError?: OnError): Promise<DeploymentMeta | undefined> {
  const meta = await attempt("Couldn't create the deployment", () => api.invoke('deploy:create', input), onError)
  if (meta) {
    written++
    const s = deployStore.get()
    deployStore.set({ ...s, deployments: [...s.deployments.filter((d) => d.id !== meta.id), meta] })
  }
  return meta
}

export async function updateDeployment(id: string, patch: DeploymentPatch, onError?: OnError): Promise<DeploymentMeta | undefined> {
  const meta = await attempt("Couldn't save the deployment", () => api.invoke('deploy:update', id, patch), onError)
  if (meta) {
    written++
    const s = deployStore.get()
    deployStore.set({ ...s, deployments: s.deployments.map((d) => (d.id === id ? meta : d)) })
  }
  return meta
}

export async function deleteDeployment(id: string): Promise<boolean> {
  const done = await attempt("Couldn't delete the deployment", async () => {
    await api.invoke('deploy:delete', id)
    return true
  })
  if (!done) return false
  written++
  const s = deployStore.get()
  deployStore.set({ ...s, deployments: s.deployments.filter((d) => d.id !== id) })
  return true
}

/** Applies the order at once and sends it; a refusal restores the previous order. */
export async function reorderDeployments(envId: string, ids: string[]): Promise<void> {
  const before = deployStore.get()
  const position = new Map(ids.map((id, i) => [id, i]))
  written++
  deployStore.set({
    ...before,
    deployments: before.deployments.map((d) => (d.environmentId === envId && position.has(d.id) ? { ...d, position: position.get(d.id)! } : d)),
  })
  const ok = await attempt("Couldn't reorder the deployments", async () => {
    await api.invoke('deploy:reorder', envId, ids)
    return true
  })
  if (!ok) {
    written++
    deployStore.set({ ...deployStore.get(), deployments: before.deployments })
  }
}

export async function updateSettings(envId: string, patch: EnvDeploySettingsPatch): Promise<boolean> {
  const next = await attempt("Couldn't save the deploy settings", () => api.invoke('deploy:updateSettings', envId, patch))
  if (!next) return false
  const s = deployStore.get()
  deployStore.set({ ...s, settings: { ...s.settings, [envId]: next } })
  return true
}

function putService(meta: ServiceMeta): void {
  written++
  const s = deployStore.get()
  const at = s.services.findIndex((x) => x.id === meta.id)
  deployStore.set({ ...s, services: at < 0 ? [...s.services, meta] : s.services.map((x) => (x.id === meta.id ? meta : x)) })
}

function setRouteChanged(id: string, on: boolean): void {
  const s = deployStore.get()
  if (!!s.routeChanged[id] === on) return
  const { [id]: _gone, ...rest } = s.routeChanged
  deployStore.set({ ...s, routeChanged: on ? { ...rest, [id]: true } : rest })
}

/** Marks a db service whose new route waits for a restart the user declined. */
export const markRouteChanged = (id: string): void => setRouteChanged(id, true)

export async function createService(input: ServiceInput, onError?: OnError): Promise<ServiceMeta | undefined> {
  const meta = await attempt("Couldn't create the service", () => api.invoke('service:create', input), onError)
  if (meta) putService(meta)
  return meta
}

export async function updateService(id: string, patch: ServicePatch, onError?: OnError): Promise<ServiceUpdateResult | undefined> {
  const out = await attempt("Couldn't save the service", () => api.invoke('service:update', id, patch), onError)
  if (out) putService(out.service)
  return out
}

export async function deleteService(id: string, deleteTunnel: boolean): Promise<boolean> {
  const done = await attempt("Couldn't delete the service", async () => {
    await api.invoke('service:delete', id, { deleteTunnel })
    return true
  })
  if (!done) return false
  written++
  const s = deployStore.get()
  const { [id]: _gone, ...routeChanged } = s.routeChanged
  deployStore.set({ ...s, services: s.services.filter((x) => x.id !== id), routeChanged })
  if (deleteTunnel) void loadTunnels()
  return true
}

/** Applies the order at once and sends it; a refusal restores the previous order. */
export async function reorderServices(envId: string, ids: string[]): Promise<void> {
  const before = deployStore.get()
  const position = new Map(ids.map((id, i) => [id, i]))
  written++
  deployStore.set({
    ...before,
    services: before.services.map((x) => (x.environmentId === envId && position.has(x.id) ? { ...x, position: position.get(x.id)! } : x)),
  })
  const ok = await attempt("Couldn't reorder the services", async () => {
    await api.invoke('service:reorder', envId, ids)
    return true
  })
  if (!ok) {
    written++
    deployStore.set({ ...deployStore.get(), services: before.services })
  }
}

/** Opens the service's URL in the browser; main reads the stored URL, never one from here. */
export async function openService(id: string): Promise<void> {
  await attempt("Couldn't open the service", () => api.invoke('service:open', id))
}

/**
 * Rereads one environment's services: opening a tunnel can set its local port and tunnel. When a local
 * write landed during the read, the local list is kept and only those two fields are taken from the read.
 */
async function refreshServices(envId: string): Promise<void> {
  const seen = written
  const list = await api.invoke('service:list', envId).catch(() => null)
  if (!list) return
  const s = deployStore.get()
  if (seen === written) {
    deployStore.set({ ...s, services: [...s.services.filter((x) => x.environmentId !== envId), ...list] })
    return
  }
  const fresh = new Map(list.map((x) => [x.id, x]))
  deployStore.set({
    ...s,
    services: s.services.map((x) => {
      const f = fresh.get(x.id)
      return x.kind === 'db' && f?.kind === 'db' ? { ...x, localPort: f.localPort, tunnelId: f.tunnelId } : x
    }),
  })
}

const envOf = (id: string): string | undefined => deployStore.get().services.find((x) => x.id === id)?.environmentId

/** Creates the db's tunnel on first open and starts it; the new tunnel and its port are read back. */
export async function openServiceTunnel(id: string): Promise<void> {
  const rt = await attempt("Couldn't open the tunnel", () => api.invoke('service:tunnelOpen', id))
  if (!rt) return
  // Opening writes a stale route, so a declined restart is no longer pending.
  setRouteChanged(id, false)
  const envId = envOf(id)
  await Promise.all([envId ? refreshServices(envId) : undefined, loadTunnels()])
}

export async function closeServiceTunnel(id: string): Promise<void> {
  await attempt("Couldn't close the tunnel", () => api.invoke('service:tunnelClose', id))
}

/** Writes the db's new route to its tunnel; a running one restarts on it. */
export async function syncServiceTunnel(id: string): Promise<boolean> {
  const done = await attempt("Couldn't restart the tunnel", async () => {
    await api.invoke('service:tunnelSync', id)
    return true
  })
  if (!done) return false
  setRouteChanged(id, false)
  void loadTunnels()
  return true
}
