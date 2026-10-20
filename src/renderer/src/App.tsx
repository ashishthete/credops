import { HashRouter } from 'react-router'
import { ExplainPanel } from './ai/ExplainPanel'
import './ai/register'
import { AppEvents } from './settings/events'
import { AppShell } from './shell/AppShell'
import { CommandPalette } from './ui/CommandPalette'
import { Toaster } from './ui/Toaster'
import { AuthGate } from './vault/AuthGate'
import { VaultSettingsDialog } from './vault/VaultSettingsDialog'

export function App() {
  return (
    <HashRouter>
      {/* Nothing inside the gate is mounted until the vaults are unlocked. */}
      <AuthGate>
        <AppShell />
        <AppEvents />
        <CommandPalette />
        <ExplainPanel />
        <VaultSettingsDialog />
      </AuthGate>
      <Toaster />
    </HashRouter>
  )
}
