import { lazy, type ComponentType } from 'react'

// The bigger pages load on first visit, so the first screen doesn't wait on code for every section.
// Products and Hosts (the start page and the most used) stay in the main bundle.

const loaders = {
  DeploymentsPage: () => import('../pages/deployments/DeploymentsPage'),
  ReleasePage: () => import('../pages/deployments/ReleasePage'),
  PlaybookLogsPage: () => import('../pages/deployments/PlaybookLogsPage'),
  VaultsPage: () => import('../pages/vaults/VaultsPage'),
  TunnelsPage: () => import('../pages/tunnels/TunnelsPage'),
  MapPage: () => import('../pages/map/MapPage'),
  OpsPage: () => import('../pages/ops/OpsPage'),
  HubPage: () => import('../pages/hub/HubPage'),
  AuditPage: () => import('../pages/AuditPage'),
  SettingsPage: () => import('../pages/settings/SettingsPage'),
}
/** A page component from the module `load` resolves to, exported as `name`. */
const page = <M, K extends keyof M>(load: () => Promise<M>, name: K) =>
  lazy(async () => ({ default: (await load())[name] as unknown as ComponentType }))

export const DeploymentsPage = page(loaders.DeploymentsPage, 'DeploymentsPage')
export const ReleasePage = page(loaders.ReleasePage, 'ReleasePage')
export const PlaybookLogsPage = page(loaders.PlaybookLogsPage, 'PlaybookLogsPage')
export const VaultsPage = page(loaders.VaultsPage, 'VaultsPage')
export const TunnelsPage = page(loaders.TunnelsPage, 'TunnelsPage')
export const MapPage = page(loaders.MapPage, 'MapPage')
export const OpsPage = page(loaders.OpsPage, 'OpsPage')
export const HubPage = page(loaders.HubPage, 'HubPage')
export const AuditPage = page(loaders.AuditPage, 'AuditPage')
export const SettingsPage = page(loaders.SettingsPage, 'SettingsPage')

/** Fetches every lazy page once the app is idle, so a first visit to one rarely waits. */
export function preloadPages(): () => void {
  const load = () => {
    for (const l of Object.values(loaders)) void l().catch(() => {})
  }
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(load, { timeout: 5000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(load, 2000)
  return () => clearTimeout(id)
}
