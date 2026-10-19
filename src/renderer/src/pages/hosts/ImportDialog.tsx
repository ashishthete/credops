import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { FileQuestion, FileWarning, KeyRound, RotateCw, Route, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HOST_ROLES, type HostRole, type SshImportCandidate, type SshImportPreview, type SshImportResult } from '../../../../shared/inventory'
import { DEFAULT_VAULT_ID } from '../../../../shared/vault'
import { inv, useInventory } from '../../inventory/store'
import { api } from '../../lib/api'
import { loadTunnels } from '../../tunnels/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { errorText, plural } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { SelectField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { useVaultStatus } from '../../vault/status'
import { withUnlock } from '../../vault/unlock'
import { ROLE_LABEL } from '../products/ProductView'

type Step = 'preview' | 'where' | 'done'

const SKIP_REASON: Record<SshImportResult['skipped'][number]['reason'], string> = {
  exists: 'Already added',
  'not-found': 'No longer in the config',
  invalid: 'Skipped',
}

const importable = (c: SshImportCandidate) => c.valid && !c.existingHostId
const target = (c: SshImportCandidate) => `${c.user ? `${c.user}@` : ''}${c.hostName}${c.port ? `:${c.port}` : ''}`

interface ImportDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the first created host's id (or null when none were). */
  onImported: (firstHostId: string | null) => void
}

/** Two steps: pick hosts from ~/.ssh/config, then say where they go. Ends on a summary. */
export function ImportDialog({ open, onClose, onImported }: ImportDialogProps) {
  const motionSafe = useMotionSafe()
  const data = useInventory()
  const status = useVaultStatus()
  const [step, setStep] = useState<Step>('preview')
  const [preview, setPreview] = useState<SshImportPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [vaultId, setVaultId] = useState(DEFAULT_VAULT_ID)
  const [environmentId, setEnvironmentId] = useState('')
  const [role, setRole] = useState<HostRole>('app')
  const [withForwards, setWithForwards] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SshImportResult | null>(null)
  // A lock mid-import unmounts the app until the unlock, so the outcome may land with nobody to show it.
  const mounted = useRef(true)
  useEffect(() => {
    // Set here, not just initially: StrictMode runs this cleanup once and then the effect again.
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Each load bumps the generation, so a slow answer to an earlier one is dropped.
  const generation = useRef(0)
  const loadPreview = useCallback(() => {
    const gen = ++generation.current
    setPreview(null)
    setPreviewError(null)
    withUnlock(() => api.invoke('sshconfig:preview')).then(
      // undefined means the unlock was cancelled; Retry asks again.
      (p) => gen === generation.current && (p ? setPreview(p) : setPreviewError('OpsDeck is locked. Unlock it to read the file.')),
      (err: unknown) => gen === generation.current && setPreviewError(errorText(err)),
    )
  }, [])

  useEffect(() => {
    if (!open) return
    setStep('preview')
    setChosen(new Set())
    setVaultId(DEFAULT_VAULT_ID)
    setEnvironmentId('')
    setRole('app')
    setWithForwards(true)
    setResult(null)
    loadPreview()
    return () => {
      generation.current++
    }
  }, [open, loadPreview])

  // Corrupt vaults can't take new identities or keys (F26); Default first.
  const vaults = useMemo(() => {
    const corrupt = status?.corruptVaultIds ?? []
    return (data?.vaults ?? [])
      .filter((v) => !corrupt.includes(v.id))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  }, [data, status])
  const vault = vaults.some((v) => v.id === vaultId) ? vaultId : (vaults[0]?.id ?? '')
  const environments = useMemo(() => [...(data?.environments ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [data])

  const candidates = preview?.candidates ?? []
  const picked = candidates.filter((c) => importable(c) && chosen.has(c.alias))
  const aliases = picked.map((c) => c.alias)
  const forwardCount = picked.reduce((n, c) => n + c.forwards.length, 0)

  const run = async () => {
    setBusy(true)
    const res = await inv.importSshConfig({
      vaultId: vault,
      aliases,
      ...(environmentId ? { environmentId, role } : {}),
      ...(forwardCount > 0 && !withForwards ? { forwards: false } : {}),
    })
    if (res && res.tunnelsCreated > 0) void loadTunnels()
    if (!mounted.current) {
      if (res) toast({ title: `Imported ${plural(res.created.length, 'host')}${res.tunnelsCreated > 0 ? `, ${plural(res.tunnelsCreated, 'tunnel')}` : ''}`, tone: 'success' })
      return
    }
    setBusy(false)
    if (!res) return
    setResult(res)
    setStep('done')
    onImported(res.created[0]?.id ?? null)
  }

  const footer: Record<Step, ReactNode> = {
    preview: (
      <>
        <Button variant="ghost" onClick={onClose}>
          {preview && !preview.found ? 'Close' : 'Cancel'}
        </Button>
        {(!preview || preview.found) && (
          <Button disabled={aliases.length === 0} onClick={() => setStep('where')}>
            Next
          </Button>
        )}
      </>
    ),
    where: (
      <>
        <Button variant="ghost" disabled={busy} onClick={() => setStep('preview')}>
          Back
        </Button>
        <Button loading={busy} disabled={!vault} onClick={() => void run()}>
          {`Import ${plural(aliases.length, 'host')}`}
        </Button>
      </>
    ),
    done: <Button onClick={onClose}>Done</Button>,
  }

  return (
    <Dialog open={open} onClose={busy ? () => {} : onClose} title="Import from ~/.ssh/config" width={580} footer={footer[step]}>
      <Steps step={step} />
      <motion.div
        key={step}
        initial={motionSafe ? { opacity: 0, x: 16 } : { opacity: 0 }}
        animate={motionSafe ? { opacity: 1, x: 0 } : { opacity: 1 }}
        transition={motionSafe ? spring : fast}
      >
        {step === 'preview' &&
          (previewError ? (
            <PreviewError message={previewError} onRetry={loadPreview} />
          ) : (
            <PreviewStep preview={preview} chosen={chosen} onChange={setChosen} />
          ))}
        {step === 'where' && (
          <div className="flex flex-col gap-4">
            <p className="text-[12.5px] leading-5 text-muted">
              {plural(aliases.length, 'host')} from your config. Keys and users they name become identities in the vault you pick.
            </p>
            <SelectField label="Vault" value={vault} onChange={(e) => setVaultId(e.target.value)} hint="Holds the identities and keys this import creates.">
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </SelectField>
            <div className="grid grid-cols-[1fr_160px] gap-3">
              <SelectField label="Environment" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
                <option value="">No environment</option>
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectField>
              <SelectField label="Role" value={role} disabled={!environmentId} onChange={(e) => setRole(e.target.value as HostRole)}>
                {HOST_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </SelectField>
            </div>
            {forwardCount > 0 && (
              <label className="flex items-center gap-2.5 text-[12.5px] text-fg/90">
                <input type="checkbox" className="size-4 accent-accent" checked={withForwards} onChange={(e) => setWithForwards(e.target.checked)} />
                {`Also create tunnels for ${plural(forwardCount, 'port forward')}`}
              </label>
            )}
          </div>
        )}
        {step === 'done' && result && <ResultStep result={result} />}
      </motion.div>
    </Dialog>
  )
}

/** A real sequence, so it's numbered: where you are of the two choices. */
function Steps({ step }: { step: Step }) {
  const items = [
    { id: 'preview', label: 'Choose hosts' },
    { id: 'where', label: 'Where they go' },
  ] as const
  const at = step === 'done' ? 2 : items.findIndex((i) => i.id === step)
  return (
    <ol className="mb-4 flex items-center gap-2 text-[12px]">
      {items.map((it, i) => (
        <li key={it.id} aria-current={i === at ? 'step' : undefined} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className={`h-px w-6 transition-colors ${i <= at ? 'bg-accent/60' : 'bg-line'}`} />}
          <span
            className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold transition-colors ${
              i < at ? 'bg-accent text-white' : i === at ? 'bg-accent/18 text-fg shadow-[inset_0_0_0_1px_var(--accent)]' : 'bg-white/[0.05] text-muted'
            }`}
          >
            {i + 1}
          </span>
          <span className={i === at ? 'font-medium text-fg' : 'text-muted'}>{it.label}</span>
        </li>
      ))}
    </ol>
  )
}

function PreviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-8 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-err/10 text-err">
        <FileWarning aria-hidden className="size-5" />
      </span>
      <h3 className="text-[14px] font-semibold text-fg">Couldn't read ~/.ssh/config</h3>
      <p className="max-w-[44ch] text-[12.5px] leading-5 text-muted">{message}</p>
      <Button variant="ghost" size="sm" className="mt-1" icon={<RotateCw aria-hidden className="size-3.5" />} onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function PreviewStep({ preview, chosen, onChange }: { preview: SshImportPreview | null; chosen: Set<string>; onChange: (s: Set<string>) => void }) {
  if (!preview) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-11 rounded-lg" />
        ))}
      </div>
    )
  }
  if (!preview.found) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="grid size-11 place-items-center rounded-xl bg-white/[0.05] text-muted">
          <FileQuestion aria-hidden className="size-5" />
        </span>
        <h3 className="text-[14px] font-semibold text-fg">No ~/.ssh/config found</h3>
        <p className="max-w-[44ch] text-[12.5px] leading-5 text-muted">Add hosts by hand with New host, or create the file and try again.</p>
      </div>
    )
  }

  const open = preview.candidates.filter(importable)
  const allOn = open.length > 0 && open.every((c) => chosen.has(c.alias))
  const someOn = open.some((c) => chosen.has(c.alias))
  const toggle = (alias: string) => {
    const next = new Set(chosen)
    if (next.has(alias)) next.delete(alias)
    else next.add(alias)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {preview.warnings.length > 0 && <Warnings title="About the file" items={preview.warnings} />}
      {preview.candidates.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] text-muted">The file names no hosts that can be imported.</p>
      ) : (
        <>
          <label className="flex items-center gap-2.5 px-3 text-[12.5px] font-medium text-fg/90">
            <input
              type="checkbox"
              aria-label="Select all"
              className="size-4 accent-accent"
              checked={allOn}
              ref={(el) => {
                if (el) el.indeterminate = someOn && !allOn
              }}
              disabled={open.length === 0}
              onChange={() => onChange(allOn ? new Set() : new Set(open.map((c) => c.alias)))}
            />
            Select all
            <span className="text-muted">{plural(open.length, 'new host')}</span>
          </label>
          <ul aria-label="Hosts in the config" className="flex max-h-[320px] flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-canvas/40 p-1.5">
            {preview.candidates.map((c) => (
              <CandidateRow key={c.alias} candidate={c} checked={importable(c) && chosen.has(c.alias)} onToggle={() => toggle(c.alias)} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function CandidateRow({ candidate: c, checked, onToggle }: { candidate: SshImportCandidate; checked: boolean; onToggle: () => void }) {
  const disabled = !importable(c)
  return (
    <li>
      <label
        className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
          disabled ? 'opacity-60' : checked ? 'bg-accent/8' : 'hover:bg-white/[0.03]'
        }`}
      >
        <input type="checkbox" aria-label={c.alias} className="mt-0.5 size-4 accent-accent" checked={checked} disabled={disabled} onChange={onToggle} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-fg">{c.alias}</span>
            <span className="truncate font-mono text-[11.5px] text-muted">{target(c)}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* The key is named by a badge only; its path and contents never reach the page. */}
              {c.identityFile && (
                <Badge tone="info" className="gap-1">
                  <KeyRound aria-hidden className="size-3" />
                  key
                </Badge>
              )}
              {c.proxyJump && (
                <Badge tone={c.jumpResolvable ? 'info' : 'warn'} className="gap-1">
                  <Route aria-hidden className="size-3" />
                  via {c.proxyJump}
                </Badge>
              )}
              {c.existingHostId ? (
                <span className="text-[11.5px] text-muted">Already added</span>
              ) : !c.valid ? (
                <span className="text-[11.5px] font-medium text-err">Skipped</span>
              ) : null}
            </span>
          </span>
          {c.warnings.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {c.warnings.map((w, i) => (
                <span key={`${i}-${w}`} className="rounded-md bg-warn/12 px-1.5 text-[11.5px] leading-5 text-warn">
                  {w}
                </span>
              ))}
            </span>
          )}
        </span>
      </label>
    </li>
  )
}

function Warnings({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-lg bg-warn/8 px-3 py-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_30%,transparent)]">
      <h4 className="flex items-center gap-1.5 text-[12px] font-semibold text-warn">
        <TriangleAlert aria-hidden className="size-3.5" />
        {title}
      </h4>
      <ul className="mt-1 flex flex-col gap-0.5 text-[12px] leading-5 text-fg/80">
        {items.map((w, i) => (
          <li key={`${i}-${w}`}>{w}</li>
        ))}
      </ul>
    </div>
  )
}

function ResultStep({ result }: { result: SshImportResult }) {
  const n = result.created.length
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4 rounded-xl bg-ok/8 px-4 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ok)_28%,transparent)]">
        <CountUp to={n} />
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[14px] font-semibold text-fg">{`Imported ${plural(n, 'host')}`}</h3>
          <p className="text-[12.5px] text-muted">
            {plural(result.identitiesCreated, 'identity', 'identities')} created, {plural(result.keysLinked, 'key')} linked
            {result.tunnelsCreated > 0 && `, ${plural(result.tunnelsCreated, 'tunnel')}`}
          </p>
        </div>
      </div>
      {result.skipped.length > 0 && (
        <div>
          <h4 className="mb-1 text-[12px] font-semibold text-fg/90">Not imported</h4>
          <ul className="flex flex-col gap-0.5 text-[12.5px]">
            {result.skipped.map((s) => (
              <li key={s.alias} className="flex justify-between gap-3">
                <span className="truncate font-medium text-fg/90">{s.alias}</span>
                <span className="shrink-0 text-muted">{SKIP_REASON[s.reason]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && <Warnings title="Worth knowing" items={result.warnings} />}
    </div>
  )
}

/** The created count springs up from zero; with reduced motion it just shows. */
function CountUp({ to }: { to: number }) {
  const motionSafe = useMotionSafe()
  const value = useMotionValue(motionSafe ? 0 : to)
  const shown = useTransform(value, (v) => Math.round(v))
  useEffect(() => {
    if (!motionSafe) return value.set(to)
    const controls = animate(value, to, { type: 'spring', stiffness: 120, damping: 20 })
    return () => controls.stop()
  }, [to, motionSafe, value])
  return (
    <motion.span
      aria-hidden
      initial={motionSafe ? { scale: 0.6, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1 }}
      transition={motionSafe ? { ...spring, damping: 14 } : fast}
      className="min-w-[2ch] text-center text-[34px] leading-none font-semibold tracking-tight text-ok tabular-nums"
    >
      {shown}
    </motion.span>
  )
}
