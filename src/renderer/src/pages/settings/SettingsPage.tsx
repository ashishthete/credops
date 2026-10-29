import { ClipboardCopy, Download, FileJson, Fingerprint, FolderOpen, LifeBuoy, Upload } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { toast } from '../../ui/Toaster'
import { vaultStatusStore } from '../../vault/status'
import { openVaultSettings } from '../../vault/VaultSettingsDialog'
import { useConfigTransfer } from './ConfigTransfer'
import { IntegrationsSection } from './IntegrationsPage'
import { TerminalSection } from './TerminalSettings'

export function SettingsPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end px-8 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-8 pb-8">
        <UnlockSection />
        <IntegrationsSection />
        <TerminalSection />
        <ConfigSection />
        <SupportSection />
      </div>
    </div>
  )
}

/** What unlocks the vaults now, and the way into changing it (the same dialog as the sidebar's sliders). */
function UnlockSection() {
  const status = useSyncExternalStore(vaultStatusStore.subscribe, vaultStatusStore.get)
  if (!status?.setUp) return null
  const on = [status.quickUnlock === 'touchId' && 'Touch ID', status.pin.enabled && 'PIN', status.hasPassword && 'master password'].filter(Boolean)
  const lock = status.autoLockMinutes ? `locks after ${status.autoLockMinutes} minutes idle` : 'never locks by itself'

  return (
    <section aria-labelledby="settings-unlock" className="mt-2 max-w-[640px] rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
          <Fingerprint aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id="settings-unlock" className="text-[14px] font-semibold text-fg">
            Unlock
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Unlocks with {on.join(', ') || 'nothing set up'} and {lock}.
            {status.quickUnlock !== 'touchId' && !status.pin.enabled && ' Add Touch ID or a PIN to stop typing the master password.'}
          </p>
        </div>
      </div>
      <div className="mt-4 flex gap-2 pl-11">
        <Button size="sm" onClick={openVaultSettings}>
          Unlock methods and auto-lock
        </Button>
      </div>
    </section>
  )
}

function ConfigSection() {
  const { exporting, opening, exportConfig, openImport, dialog } = useConfigTransfer()

  return (
    <section aria-labelledby="settings-config" className="mt-2 max-w-[640px] rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
          <FileJson aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id="settings-config" className="text-[14px] font-semibold text-fg">
            Configuration
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Exports products, environments, hosts, identities, tunnels, checkouts and services. Secrets are never exported;
            references to vault items are kept by name. Free-text fields (notes, hooks, descriptions, env values and URLs) are exported as written, so check them for anything sensitive.
            Importing adds and updates by id or name and never deletes.
          </p>
        </div>
      </div>
      <div className="mt-4 flex gap-2 pl-11">
        <Button size="sm" loading={exporting} icon={<Download aria-hidden className="size-3.5" />} onClick={() => void exportConfig()}>
          Export config…
        </Button>
        <Button size="sm" loading={opening} icon={<Upload aria-hidden className="size-3.5" />} onClick={() => void openImport()}>
          Import config…
        </Button>
      </div>
      {dialog}
    </section>
  )
}

function SupportSection() {
  const [copying, setCopying] = useState(false)

  const copyDiagnostics = async () => {
    setCopying(true)
    try {
      await api.invoke('app:copyDiagnostics')
      toast({ title: 'Diagnostics copied', description: 'Paste them into your support request.', tone: 'success' })
    } catch {
      toast({ title: "Couldn't copy diagnostics", tone: 'error' })
    } finally {
      setCopying(false)
    }
  }

  const revealLog = async () => {
    try {
      await api.invoke('app:revealLog')
    } catch {
      toast({ title: "Couldn't show the log file", tone: 'error' })
    }
  }

  return (
    <section aria-labelledby="settings-support" className="max-w-[640px] rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
          <LifeBuoy aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id="settings-support" className="text-[14px] font-semibold text-fg">
            Support
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Copies the app, OS and schema versions, how many hosts and environments you have, and the last 200 log lines.
            Secrets are masked, and host, environment and product names, addresses and emails are replaced, so the text is safe to
            paste into a support request.
          </p>
        </div>
      </div>
      <div className="mt-4 flex gap-2 pl-11">
        <Button size="sm" loading={copying} icon={<ClipboardCopy aria-hidden className="size-3.5" />} onClick={() => void copyDiagnostics()}>
          Copy diagnostics
        </Button>
        <Button size="sm" variant="ghost" icon={<FolderOpen aria-hidden className="size-3.5" />} onClick={() => void revealLog()}>
          Show log file
        </Button>
      </div>
    </section>
  )
}
