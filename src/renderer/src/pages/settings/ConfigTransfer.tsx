import { Download, Upload } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import type { ConfigCounts, ConfigSegment, ImportPreview } from '../../../../shared/config-file'
import { api } from '../../lib/api'
import { attempt, plural, RowMenu } from '../../ui/common'
import { toast } from '../../ui/Toaster'
import { ImportConfigDialog } from './ImportConfigDialog'

const total = (counts: ConfigCounts): number => Object.values(counts).reduce((a, b) => a + b, 0)
/** The toast names the file only: the full path stays in main's dialog. */
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * Export and import of the whole config (Settings), or with `segment` of a page's part of it. `dialog` renders the
 * import preview once a file is open.
 */
export function useConfigTransfer(segment?: ConfigSegment): {
  exporting: boolean
  opening: boolean
  /** Either file dialog is open: a second one would only stack on it. */
  busy: boolean
  exportConfig: () => Promise<void>
  openImport: () => Promise<void>
  dialog: ReactNode
} {
  const [exporting, setExporting] = useState(false)
  const [opening, setOpening] = useState(false)
  // A ref, not state: a double click lands before the first click's render.
  const running = useRef(false)
  const [preview, setPreview] = useState<ImportPreview | { errors: string[] } | null>(null)
  // The whole config sends no segment at all.
  const seg = segment ? ([segment] as const) : ([] as const)
  const what = segment ? `the ${segment}` : 'the config'

  const exportConfig = async () => {
    if (running.current) return
    running.current = true
    setExporting(true)
    try {
      // null: the save dialog was closed, which needs no comment.
      const res = await attempt(`Couldn't export ${what}`, () => api.invoke('config:export', ...seg))
      if (res)
        toast({
          title: `Exported ${plural(total(res.counts), 'item')} to ${basename(res.path)}`,
          ...(res.omitted ? { description: `${plural(res.omitted, 'secret value')} ${res.omitted === 1 ? 'was' : 'were'} left out` } : {}),
          tone: 'success',
        })
    } finally {
      running.current = false
      setExporting(false)
    }
  }

  const openImport = async () => {
    if (running.current) return
    running.current = true
    setOpening(true)
    try {
      // null: the open dialog was closed.
      const res = await attempt(segment ? "Couldn't open the file" : "Couldn't open the config", () => api.invoke('config:importOpen', ...seg))
      if (res) setPreview(res)
    } finally {
      running.current = false
      setOpening(false)
    }
  }

  const dialog = preview && <ImportConfigDialog preview={preview} segment={segment} onClose={() => setPreview(null)} />
  return { exporting, opening, busy: exporting || opening, exportConfig, openImport, dialog }
}

/** A page's "⋯" menu with Import and Export of its segment, for a page header. */
export function ConfigTransferMenu({ segment, className }: { segment: ConfigSegment; className?: string }) {
  const { exportConfig, openImport, dialog } = useConfigTransfer(segment)
  // A segment is named as its page names its objects: "Import hosts…".
  const label = segment
  return (
    <>
      <RowMenu
        label={`Import or export ${label}`}
        className={className}
        items={[
          { label: `Import ${label}…`, icon: Upload, run: () => void openImport() },
          { label: `Export ${label}…`, icon: Download, run: () => void exportConfig() },
        ]}
      />
      {dialog}
    </>
  )
}
