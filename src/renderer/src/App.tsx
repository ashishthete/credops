import { HashRouter } from 'react-router'
import { AppShell } from './shell/AppShell'
import { CommandPalette } from './ui/CommandPalette'
import { Toaster } from './ui/Toaster'
import { UnlockDialog } from './vault/UnlockDialog'
import { VaultSettingsDialog } from './vault/VaultSettingsDialog'

export function App() {
  return (
    <HashRouter>
      <AppShell />
      <CommandPalette />
      <VaultSettingsDialog />
      <UnlockDialog />
      <Toaster />
    </HashRouter>
  )
}
