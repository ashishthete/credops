import { Download, FileJson, Upload } from 'lucide-react'
import { useState } from 'react'
import type { ConfigCounts, ImportPreview } from '../../../../shared/config-file'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { attempt, plural } from '../../ui/common'
import { toast } from '../../ui/Toaster'
import { ImportConfigDialog } from './ImportConfigDialog'
import { IntegrationsSection } from './IntegrationsPage'

const total = (counts: ConfigCounts): number => Object.values(counts).reduce((a, b) => a + b, 0)
/** The toast names the file only: the full path stays in main's dialog. */
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function SettingsPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end px-8 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-8 pb-8">
        <IntegrationsSection />
        <ConfigSection />
      </div>
    </div>
  )
}

function ConfigSection() {
  const [exporting, setExporting] = useState(false)
  const [opening, setOpening] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | { errors: string[] } | null>(null)

  const exportConfig = async () => {
    setExporting(true)
    try {
      // null: the save dialog was closed, which needs no comment.
      const res = await attempt("Couldn't export the config", () => api.invoke('config:export'))
      if (res)
        toast({
          title: `Exported ${plural(total(res.counts), 'item')} to ${basename(res.path)}`,
          ...(res.omitted ? { description: `${plural(res.omitted, 'secret value')} ${res.omitted === 1 ? 'was' : 'were'} left out` } : {}),
          tone: 'success',
        })
    } finally {
      setExporting(false)
    }
  }

  const openImport = async () => {
    setOpening(true)
    try {
      // null: the open dialog was closed.
      const res = await attempt("Couldn't open the config", () => api.invoke('config:importOpen'))
      if (res) setPreview(res)
    } finally {
      setOpening(false)
    }
  }

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
      {preview && <ImportConfigDialog preview={preview} onClose={() => setPreview(null)} />}
    </section>
  )
}
