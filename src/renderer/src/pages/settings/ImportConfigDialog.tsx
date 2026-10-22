import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { IMPORT_ACTIONS, type ConfigSegment, type ImportAction, type ImportItem, type ImportPreview, type ImportNeedsSecret } from '../../../../shared/config-file'
import { reloadInventory, useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { loadTunnels } from '../../tunnels/store'
import { Button } from '../../ui/Button'
import { attempt } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { TextField } from '../../ui/Field'
import { exitFast, fast, useMotionSafe } from '../../ui/motion'
import { RegionSelect } from '../hosts/RegionDialog'
import { toast } from '../../ui/Toaster'

const ACTION_LABEL: Record<ImportAction, string> = { add: 'Add', update: 'Update', unchanged: 'Unchanged', skip: 'Skip' }
const KIND_LABEL: Record<ImportItem['kind'], string> = {
  regions: 'Region',
  products: 'Product',
  identities: 'Identity',
  hosts: 'Host',
  environments: 'Environment',
  tunnels: 'Tunnel',
  deployments: 'Checkout',
  services: 'Service',
  runbooks: 'Runbook',
}
const FIELD_LABEL: Record<string, string> = {
  password: 'password',
  key: 'SSH key',
  becomeSecret: 'sudo password',
  envTemplate: '.env template',
  steps: 'step secrets',
  flow: 'flow step secrets',
  items: 'runbook step secrets',
  vaults: 'vault access',
  identityId: 'identity',
  defaultIdentityId: 'default identity',
}

/**
 * The preview of a config file opened in main, or why it can't be imported. Cancel drops main's copy of the file.
 * With `segment`, a page's import: its notes say which objects came along as dependencies, and how many were ignored.
 */
export function ImportConfigDialog({
  preview,
  segment,
  onClose,
}: {
  preview: ImportPreview | { errors: string[] }
  segment?: ConfigSegment
  onClose: () => void
}) {
  if ('errors' in preview) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={segment ? `Import ${segment}` : 'Import config'}
        width={520}
        footer={
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <p className="text-[13px] font-semibold text-fg">This file can't be imported</p>
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-[12px] leading-5 text-err">
          {preview.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </Dialog>
    )
  }
  return <PreviewDialog preview={preview} segment={segment} onClose={onClose} />
}

function PreviewDialog({ preview, segment, onClose }: { preview: ImportPreview; segment?: ConfigSegment; onClose: () => void }) {
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [regionId, setRegionId] = useState('')
  const data = useInventory()
  // A version 1 file has no regions, so its new hosts need one; only a lone region is a safe guess.
  const regions = data?.regions ?? []
  const region = regionId || (regions.length === 1 ? regions[0].id : '')
  const confirmed = preview.protectedEnvironments.every((name) => typed[name] === name) && (!preview.needsRegion || !!region)

  // The whole config sends no segment at all.
  const seg = segment ? ([segment] as const) : ([] as const)
  const cancel = () => {
    void api.invoke('config:importDiscard', preview.token, ...seg).catch(() => undefined)
    onClose()
  }

  const apply = async () => {
    setBusy(true)
    try {
      const res = await attempt(segment ? `Couldn't import the ${segment}` : "Couldn't import the config", async () =>
        api.invoke(
          'config:importApply',
          preview.token,
          {
            typedNames: preview.protectedEnvironments.filter((n) => typed[n] === n),
            ...(preview.needsRegion ? { regionId: region } : {}),
          },
          ...seg,
        ),
      )
      if (!res) return
      const n = res.needsSecret.length
      toast({ title: `Imported: ${res.counts.add} added, ${res.counts.update} updated${n ? `; ${n} need a secret` : ''}`, tone: 'success' })
      onClose()
      void reloadInventory()
      void loadTunnels()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={cancel}
      title={segment ? `Import ${segment}` : 'Import config'}
      description={
        segment
          ? `Only ${segment} are imported, with what they need that isn't here yet. Nothing is deleted, and nothing here that they need is changed.`
          : 'Nothing is deleted. Objects that are not in the file stay as they are.'
      }
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!confirmed} onClick={() => void apply()}>
            Import
          </Button>
        </>
      }
    >
      <div className="max-h-[52vh] space-y-1 overflow-y-auto">
        {IMPORT_ACTIONS.map((a) => (
          <Group key={a} action={a} items={preview.items.filter((i) => i.action === a)} count={preview.counts[a]} notes={!!segment} />
        ))}
        {segment && !!preview.ignored && (
          <p className="px-1.5 py-1 text-[12.5px] font-semibold text-muted">
            Ignored {preview.ignored}: not {segment} and not needed by them
          </p>
        )}
      </div>
      {preview.needsRegion && (
        <div className="mt-4">
          <RegionSelect label="Put new hosts in region" value={region} onChange={setRegionId} hint="The file predates regions, so its hosts don't say where they run." />
        </div>
      )}
      {preview.needsSecret.length > 0 && <NeedsSecret entries={preview.needsSecret} />}
      {preview.protectedEnvironments.length > 0 && (
        <div className="mt-4 space-y-3">
          {preview.protectedEnvironments.map((name) => (
            <TextField
              key={name}
              label={`Type ${name} to confirm`}
              value={typed[name] ?? ''}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped((t) => ({ ...t, [name]: e.target.value }))}
            />
          ))}
        </div>
      )}
    </Dialog>
  )
}

/** `notes`: show each object's notes (a page import's dependency rows). */
function Group({ action, items, count, notes }: { action: ImportAction; items: ImportItem[]; count: number; notes: boolean }) {
  const [open, setOpen] = useState(false)
  const motionSafe = useMotionSafe()
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        disabled={count === 0}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12.5px] font-semibold text-fg hover:bg-surface-2/60 disabled:text-muted disabled:hover:bg-transparent"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight aria-hidden className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        {ACTION_LABEL[action]} {count}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={motionSafe ? { opacity: 0, y: -4 } : { opacity: 0 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: exitFast }}
            transition={fast}
            className="mb-1 space-y-0.5 pl-[26px]"
          >
            {items.map((i) => (
              <li key={`${i.kind}:${i.id}`} className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-5">
                <span className="w-[84px] shrink-0 text-muted">{KIND_LABEL[i.kind]}</span>
                <span className="truncate text-fg">{i.name}</span>
                {i.fields && i.fields.length > 0 && <span className="truncate text-muted">{i.fields.join(', ')}</span>}
                {notes && i.notes && <span className="truncate text-muted">{i.notes.join('; ')}</span>}
                {i.reason && <span className="truncate text-warn">{i.reason}</span>}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </section>
  )
}

function NeedsSecret({ entries }: { entries: ImportNeedsSecret[] }) {
  return (
    <section aria-labelledby="import-needs-secret" className="mt-4 rounded-lg border border-line bg-surface-2/40 p-3">
      <h3 id="import-needs-secret" className="flex items-center gap-1.5 text-[12.5px] font-semibold text-fg">
        <KeyRound aria-hidden className="size-3.5 text-warn" />
        Needs a secret
      </h3>
      <p className="mt-1 text-[12px] text-muted">These are imported without the secret, or skipped. Add the secret to a vault here, then set it or import again.</p>
      <ul className="mt-2 space-y-0.5">
        {entries.map((e, i) => (
          <li key={i} className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-5">
            <span className="w-[84px] shrink-0 text-muted">{KIND_LABEL[e.kind]}</span>
            {e.field === 'envVars' ? (
              // "<host>: <KEY> left blank; set it in the host editor"
              <span className="truncate text-fg">{`${e.name}: ${e.reason ?? ''}`}</span>
            ) : (
              <>
                <span className="truncate text-fg">{e.name}</span>
                <span className="truncate text-muted">
                  {FIELD_LABEL[e.field] ?? e.field}
                  {e.reason ? `: ${e.reason}` : ''}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
