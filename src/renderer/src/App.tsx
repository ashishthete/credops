import { HashRouter } from 'react-router'
import { AppShell } from './shell/AppShell'
import { CommandPalette } from './ui/CommandPalette'
import { Toaster } from './ui/Toaster'

export function App() {
  return (
    <HashRouter>
      <AppShell />
      <CommandPalette />
      <Toaster />
    </HashRouter>
  )
}
