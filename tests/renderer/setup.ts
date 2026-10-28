import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetKept } from '../../src/renderer/src/ui/kept'

// jsdom has no matchMedia; report "no preference" for every query.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// jsdom doesn't scroll and logs "Not implemented" for every scrollTo; make it a no-op.
window.scrollTo = () => {}

// xterm probes a 2D canvas when it loads (the shell imports it); jsdom has none and logs "Not implemented".
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext

afterEach(() => {
  cleanup()
  // Pages keep filters and drafts across navigation; each test starts without them.
  resetKept()
})

// Tests run as macOS, so `mod` is the Meta key.
Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })

// The shell loads its bigger pages lazily; suites that drive pages through it get them eagerly, so a page
// is on screen in the same tick as before. shell-pages.test.tsx covers the lazy loading itself.
vi.mock('../../src/renderer/src/shell/pages', async () => {
  const [deployments, release, logs, vaults, tunnels, map, ops, hub, audit, settings] = await Promise.all([
    import('../../src/renderer/src/pages/deployments/DeploymentsPage'),
    import('../../src/renderer/src/pages/deployments/ReleasePage'),
    import('../../src/renderer/src/pages/deployments/PlaybookLogsPage'),
    import('../../src/renderer/src/pages/vaults/VaultsPage'),
    import('../../src/renderer/src/pages/tunnels/TunnelsPage'),
    import('../../src/renderer/src/pages/map/MapPage'),
    import('../../src/renderer/src/pages/ops/OpsPage'),
    import('../../src/renderer/src/pages/hub/HubPage'),
    import('../../src/renderer/src/pages/AuditPage'),
    import('../../src/renderer/src/pages/settings/SettingsPage'),
  ])
  return {
    DeploymentsPage: deployments.DeploymentsPage,
    ReleasePage: release.ReleasePage,
    PlaybookLogsPage: logs.PlaybookLogsPage,
    VaultsPage: vaults.VaultsPage,
    TunnelsPage: tunnels.TunnelsPage,
    MapPage: map.MapPage,
    OpsPage: ops.OpsPage,
    HubPage: hub.HubPage,
    AuditPage: audit.AuditPage,
    SettingsPage: settings.SettingsPage,
    preloadPages: () => () => {},
  }
})
