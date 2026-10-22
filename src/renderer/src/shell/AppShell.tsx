import { motion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { useHubCommands } from '../hub/commands'
import { resetHub, startHubSync } from '../hub/store'
import { useInventoryCommands } from '../inventory/commands'
import { loadInventory } from '../inventory/store'
import { useMapCommands } from '../map/commands'
import { AuditPage } from '../pages/AuditPage'
import { HubPage } from '../pages/hub/HubPage'
import { HostsPage } from '../pages/hosts/HostsPage'
import { MapPage } from '../pages/map/MapPage'
import { OpsPage } from '../pages/ops/OpsPage'
import { DeploymentsPage } from '../pages/deployments/DeploymentsPage'
import { PlaybookLogsPage } from '../pages/deployments/PlaybookLogsPage'
import { ReleasePage } from '../pages/deployments/ReleasePage'
import { ProductsPage } from '../pages/products/ProductsPage'
import { SettingsPage } from '../pages/settings/SettingsPage'
import { KnownHostsDialog, closeKnownHosts, openKnownHosts } from '../pages/terminals/KnownHostsDialog'
import { PromptHost } from '../pages/terminals/PromptHost'
import { TerminalDeck } from '../pages/terminals/TerminalDeck'
import { TunnelsPage } from '../pages/tunnels/TunnelsPage'
import { resetVaultsCache, VaultsPage } from '../pages/vaults/VaultsPage'
import { SETTINGS_PATH, useSettingsCommands } from '../settings/commands'
import { resetOps, startOpsSync } from '../ops/runs'
import { resetReleases, startReleaseSync } from '../deploy/releases'
import { resetLatest } from '../deploy/latest'
import { resetDeploy, startDeploySync } from '../deploy/store'
import { useDeployCommands } from '../deploy/commands'
import { ServiceLogsHost } from '../pages/products/services/ServiceLogs'
import { disposeAll } from '../terminal/registry'
import { resetSessions, startSessionSync } from '../terminal/sessions'
import { InsertHost } from '../pages/ops/InsertHost'
import { useOpsCommands } from '../ops/commands'
import { useTunnelCommands } from '../tunnels/commands'
import { resetTunnels, startTunnelSync } from '../tunnels/store'
import { registerCommand } from '../ui/commands'
import { fast, useMotionSafe } from '../ui/motion'
import { useShortcut } from '../ui/shortcuts'
import { SECTIONS, sectionShortcut } from './sections'
import { Sidebar } from './Sidebar'
import { useAccountCommands } from '../vault/account'
import { SignInBanner } from '../vault/SignInBanner'

/** Sidebar plus routed pages. Needs a router above it (HashRouter in the app, MemoryRouter in tests). */
export function AppShell() {
  const location = useLocation()
  const motionSafe = useMotionSafe()
  useSectionNavigation()
  useInventoryCommands()
  useTunnelCommands()
  useMapCommands()
  useOpsCommands()
  useHubCommands()
  useSettingsCommands()
  useDeployCommands()
  useAccountCommands()
  // The shell mounts only while unlocked, so every unlock reloads (F22).
  useEffect(() => {
    void loadInventory()
  }, [])
  useEffect(
    () =>
      registerCommand({
        id: 'knownhosts.open',
        title: 'Known hosts…',
        section: 'Terminals',
        keywords: ['ssh', 'fingerprint', 'trust', 'host key'],
        run: openKnownHosts,
      }),
    [],
  )
  useEffect(() => {
    const stop = startSessionSync()
    const stopTunnels = startTunnelSync()
    const stopOps = startOpsSync()
    const stopHub = startHubSync()
    const stopReleases = startReleaseSync()
    // The map's service chips and the palette's deploy commands need the services and checkouts.
    const stopDeploy = startDeploySync()
    return () => {
      stop()
      stopTunnels()
      stopOps()
      stopHub()
      stopReleases()
      stopDeploy()
      disposeAll()
      // Events stop while unmounted (the vault locked); the next mount's session list is the truth.
      resetSessions()
      resetTunnels()
      resetOps()
      resetHub()
      resetReleases()
      resetDeploy()
      resetLatest()
      // Relies on a lock unmounting the shell; see the cache in VaultsPage.
      resetVaultsCache()
      closeKnownHosts()
    }
  }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-fg">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <SignInBanner />
        <div className="relative min-h-0 flex-1">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(60%_100%_at_30%_0%,color-mix(in_oklab,var(--accent)_7%,transparent),transparent)]"
          />
          {/* Enter-only transition: the next page never waits on the previous one to leave. */}
          <motion.div
            key={location.pathname}
            className="relative h-full"
            initial={motionSafe ? { opacity: 0, y: 6 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
            transition={fast}
          >
            <Routes location={location}>
              <Route path="/" element={<Navigate to={SECTIONS[0].path} replace />} />
              <Route path="/deployments" element={<DeploymentsPage />} />
              <Route path="/deployments/release/:id" element={<ReleasePage />} />
              <Route path="/deployments/release/:id/logs" element={<PlaybookLogsPage />} />
              <Route path="/products" element={<ProductsPage />} />
              {/* The deck below draws this page; it stays mounted so terminals survive navigation. */}
              <Route path="/terminals" element={null} />
              <Route path="/hosts" element={<HostsPage />} />
              <Route path="/environments" element={<Navigate to="/products" replace />} />
              <Route path="/vaults" element={<VaultsPage />} />
              <Route path="/tunnels" element={<TunnelsPage />} />
              <Route path="/map" element={<MapPage />} />
              <Route path="/ops" element={<Navigate to="/ops/run" replace />} />
              <Route path="/ops/:tab" element={<OpsPage />} />
              <Route path="/hub" element={<HubPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path={SETTINGS_PATH} element={<SettingsPage />} />
              <Route path="*" element={<Navigate to={SECTIONS[0].path} replace />} />
            </Routes>
          </motion.div>
          <TerminalDeck visible={location.pathname === '/terminals'} />
        </div>
      </main>
      <PromptHost />
      <InsertHost />
      <ServiceLogsHost />
      <KnownHostsDialog />
    </div>
  )
}

// mod+1…mod+9 (later sections have none) and a "Go to …" palette command per section.
function useSectionNavigation() {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })

  useEffect(() => {
    const unregister = SECTIONS.map((s, i) =>
      registerCommand({
        id: `nav.${s.id}`,
        title: `Go to ${s.label}`,
        section: 'Navigate',
        keywords: [s.id],
        shortcut: sectionShortcut(i) ?? undefined,
        run: () => navigateRef.current(s.path),
      }),
    )
    return () => unregister.forEach((fn) => fn())
  }, [])

  // SECTIONS is a fixed-length constant, so the hook order is stable.
  for (let i = 0; i < SECTIONS.length; i++) {
    useShortcut(sectionShortcut(i), () => navigate(SECTIONS[i].path))
  }
}
