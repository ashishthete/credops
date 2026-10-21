import { TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { bumpVersion, BREAK_LOCK_CONFIRM_MESSAGE, PLAYBOOK_CHANGED_MESSAGE, REVIEW_EXPIRED_MESSAGE, type PlaybookPreview, type VersionBump } from '../../../../../shared/deploy'
import { hostRegions, regionRefs, regionsOfHosts } from '../../../../../shared/regions'
import { pickerGroups, selectionRequest, type PickerGroup } from '../../../deploy/picker'
import { closeRelease, openRelease, startReleaseSync, usePreflight } from '../../../deploy/releases'
import { loadSettings, startDeploySync, useDeploy, useDeployments, useServices } from '../../../deploy/store'
import { useHub } from '../../../hub/store'
import { useInventory } from '../../../inventory/store'
import { api } from '../../../lib/api'
import { Button } from '../../../ui/Button'
import { attempt, ConfirmDialog, plural, type ConfirmRequest } from '../../../ui/common'
import { Dialog } from '../../../ui/Dialog'
import { RegionChip } from '../../../ui/RegionChip'
import { Segmented } from '../../../ui/Segmented'
import { createStore } from '../../../ui/store'
import { CommitList } from './CommitList'
import { PlaybookReview } from './PlaybookReview'
import { PreflightChecklist } from './PreflightChecklist'
import { CheckoutNotice, DatabaseRows, ServicePicker } from './ServicePicker'
import { ReleaseView } from './ReleaseView'

export interface ReleaseNotesEditorProps {
  environmentId: string
  serviceIds: string[]
  value: string
  onChange: (value: string) => void
}

const notesEditor = createStore<ComponentType<ReleaseNotesEditorProps> | null>(null)

/** Phase 9 puts its release-notes editor in the wizard through this; the value goes to `release:preflight`. */
export function registerReleaseNotesEditor(component: ComponentType<ReleaseNotesEditorProps>): () => void {
  notesEditor.set(component)
  return () => {
    if (notesEditor.get() === component) notesEditor.set(null)
  }
}

/** Renders nothing until an editor is registered. */
export function ReleaseNotesSlot(props: ReleaseNotesEditorProps) {
  const Editor = useSyncExternalStore(notesEditor.subscribe, notesEditor.get)
  return Editor ? <Editor {...props} /> : null
}

const BUMPS = [
  { id: 'patch', label: 'patch' },
  { id: 'minor', label: 'minor' },
  { id: 'major', label: 'major' },
] as const satisfies readonly { id: VersionBump; label: string }[]
const FURTHER: Partial<Record<VersionBump, VersionBump>> = { patch: 'minor', minor: 'major' }
const PHASE_9 = 'Available with notifications (Phase 9)'

type Step = 'pick' | 'preflight' | 'review' | 'started'

/** Pick services, run preflight, review the playbook and start the release, on one surface. */
export function DeployWizard({
  environmentId,
  preselect,
  preselectCheckouts = [],
  onClose,
}: {
  environmentId: string
  /** Services ticked at the start. */
  preselect: string[]
  /** Checkouts with no services ticked whole at the start. */
  preselectCheckouts?: string[]
  onClose: () => void
}) {
  const data = useInventory()
  const { catalog } = useHub()
  // A Hub environment this machine doesn't hold comes from the team catalog, with the same protected rule.
  const hubEnv = catalog.find((c) => c.environment.id === environmentId)?.environment
  const env = data?.environments.find((e) => e.id === environmentId) ?? (hubEnv ? { name: hubEnv.name, protected: hubEnv.protected, color: undefined } : undefined)
  const checkouts = useDeployments(environmentId)
  const services = useServices(environmentId)
  const settings = useDeploy().settings[environmentId]
  const versioned = settings?.versioned ?? false

  // The selection starts from `preselect` every time; it is not remembered.
  const [selected, setSelected] = useState(() => new Set(preselect))
  const [wholes, setWholes] = useState(() => new Set(preselectCheckouts))
  const [bump, setBump] = useState<VersionBump>('minor')
  const [backup, setBackup] = useState(true)
  const [notes, setNotes] = useState('')
  const [step, setStep] = useState<Step>('pick')
  const [releaseId, setReleaseId] = useState<string | null>(null)
  const [redeploy, setRedeploy] = useState(false)
  const [busy, setBusy] = useState(false)
  // release:start in flight: the wizard can't be closed or rewound until it answers.
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // The playbook under review; Deploy sends its hash, and main refuses the start if what would run differs.
  const [reviewed, setReviewed] = useState<PlaybookPreview | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const pre = usePreflight(releaseId)
  const report = pre?.report ?? null

  useEffect(() => startReleaseSync(), [])
  useEffect(() => startDeploySync(), [])
  useEffect(() => void loadSettings(environmentId), [environmentId])

  const { groups, unavailable } = useMemo(() => pickerGroups(services, checkouts, selected, wholes), [services, checkouts, selected, wholes])
  const request = selectionRequest(groups)
  const picked = groups.filter((g) => g.selected.size > 0 || (!g.services.length && g.whole))
  const hostLabel = (id: string) => data?.hosts.find((h) => h.id === id)?.label ?? id
  const effectiveBump: VersionBump = versioned ? bump : 'none'
  const current = settings?.currentVersion ?? null
  const next = versioned ? bumpVersion(current, bump) : null
  const preview = next && (current ? `${current} → ${next}` : next)

  // The preflight release this wizard holds; discarded unless it was started.
  const held = useRef<string | null>(null)
  // Bumped by every preflight run and every drop; a preflight that answers for an older attempt is discarded.
  const attemptRef = useRef(0)
  // Main aborts a preflight still checking, so this only fails when the release moved on (started, locked
  // vault, IPC gone). Nothing to show for a release the user already left; the log line names no release.
  const discard = (id: string) =>
    void api.invoke('release:discard', id).catch(() => console.warn("Couldn't discard an unused preflight release"))
  const drop = () => {
    attemptRef.current++
    const id = held.current
    held.current = null
    if (!id) return
    closeRelease(id)
    discard(id)
  }
  // Unmount drops too, which bumps the attempt: a preflight still in flight is discarded when it answers.
  useEffect(() => drop, [])

  const close = () => {
    if (starting) return
    drop()
    onClose()
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (!n.delete(id)) n.add(id)
      return n
    })
  const toggleGroup = (g: PickerGroup) => {
    if (!g.services.length) {
      setWholes((w) => {
        const n = new Set(w)
        if (!n.delete(g.checkout.id)) n.add(g.checkout.id)
        return n
      })
      return
    }
    setSelected((s) => {
      const n = new Set(s)
      for (const svc of g.services) {
        if (g.whole) n.delete(svc.id)
        else n.add(svc.id)
      }
      return n
    })
  }
  const all = () => {
    const every = groups.every((g) => g.whole)
    setSelected(every ? new Set() : new Set(groups.flatMap((g) => g.services.map((s) => s.id))))
    setWholes(every ? new Set() : new Set(groups.filter((g) => !g.services.length).map((g) => g.checkout.id)))
  }

  const runPreflight = async (withBump = effectiveBump) => {
    drop()
    const token = attemptRef.current
    setReleaseId(null)
    setRedeploy(false)
    setError(null)
    setStep('preflight')
    setBusy(true)
    const out = await attempt(
      "Couldn't run preflight",
      () =>
        api.invoke('release:preflight', {
          environmentId,
          serviceIds: request.serviceIds,
          ...(request.checkoutIds.length ? { checkoutIds: request.checkoutIds } : {}),
          bump: withBump,
          options: { backup, notify: false, qa: false },
          ...(notes.trim() ? { releaseNotes: notes } : {}),
        }),
      (message) => {
        if (token === attemptRef.current) setError(message)
      },
    )
    // Closed, rewound or run again meanwhile: this release was never held, so it goes now.
    if (token !== attemptRef.current) {
      if (out) discard(out.releaseId)
      return
    }
    setBusy(false)
    if (!out) return
    const id = out.releaseId
    held.current = id
    setReleaseId(id)
    void attempt("Couldn't load the release", () => openRelease(id), (message) => {
      if (held.current === id) setError(message)
    })
  }

  const review = async () => {
    if (!releaseId) return
    const id = releaseId
    setReviewed(null)
    setSaved(null)
    setStep('review')
    const out = await attempt("Couldn't generate the playbook", () => api.invoke('deploy:previewPlaybook', id), setError)
    if (out && held.current === id) setReviewed(out)
  }

  const save = async () => {
    if (!releaseId || !reviewed) return
    const out = await attempt("Couldn't save the playbook", () => api.invoke('deploy:savePlaybook', releaseId, reviewed.sha256))
    if (out) setSaved(out.path)
  }

  const back = () => {
    if (starting) return
    drop()
    setBusy(false)
    setReleaseId(null)
    setError(null)
    setStep('pick')
  }

  const start = async () => {
    if (!releaseId || !env || !reviewed) return
    const { sha256 } = reviewed
    const begin = async (typedName?: string) => {
      setStarting(true)
      setError(null)
      let changed = false
      const ok = await attempt(
        "Couldn't start the release",
        () => api.invoke('release:start', releaseId, { ...(typedName !== undefined ? { typedName } : {}), redeploy, playbookSha256: sha256 }),
        (message) => {
          changed = message.includes(PLAYBOOK_CHANGED_MESSAGE) || message.includes(REVIEW_EXPIRED_MESSAGE)
          setError(message)
        },
      )
      setStarting(false)
      if (ok === undefined) {
        // Show what would run now, so the next Deploy is bound to the playbook the person has seen.
        if (changed) {
          setReviewed(null)
          const out = await attempt("Couldn't generate the playbook", () => api.invoke('deploy:previewPlaybook', releaseId), setError)
          if (out && held.current === releaseId) setReviewed(out)
        }
        return
      }
      held.current = null
      setStep('started')
    }
    if (env.protected) {
      setConfirm({
        title: `Deploy to ${env.name}?`,
        description: `${env.name} is protected.`,
        confirmLabel: 'Deploy',
        typeToConfirm: env.name,
        run: () => begin(env.name),
      })
      return
    }
    await begin()
  }

  const breakLock = (hostId: string) => {
    if (!releaseId) return
    const label = hostLabel(hostId)
    setConfirm({
      title: `Break the lock on ${label}?`,
      description: `${BREAK_LOCK_CONFIRM_MESSAGE}. Another release may still be running there.`,
      confirmLabel: 'Break lock',
      typeToConfirm: label,
      run: async () => {
        const ok = await attempt("Couldn't break the lock", () => api.invoke('release:break-lock', releaseId, hostId, { typedLabel: label }))
        if (ok !== undefined) void runPreflight()
      },
    })
  }

  const further = FURTHER[bump]
  const ready = !!report && !report.blocked
  const nothingNew = !!report && report.commitsTotal === 0
  const hosts = new Set(picked.map((g) => g.checkout.hostId)).size
  const whole = request.checkoutIds.length
  // What the confirm step names: the services (and whole checkouts) going out, and the regions of the hosts they run on.
  const deploying = picked.flatMap((g) => (g.services.length ? g.services.filter((s) => g.selected.has(s.id)).map((s) => s.name) : [g.checkout.name]))
  const regions = data ? regionRefs(regionsOfHosts(hostRegions(data.hosts), picked.map((g) => g.checkout.hostId)), data.regions) : []
  const spread = regions.length > 1
  const summary = [`Deploying to ${env?.name ?? ''}`, plural(hosts, 'host'), plural(request.serviceIds.length, 'service'), ...(whole ? [plural(whole, 'whole checkout')] : [])].join(' · ')

  const footer = {
    pick: (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button disabled={!picked.length} onClick={() => void runPreflight()}>
          Run preflight
        </Button>
      </>
    ),
    preflight: (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="ghost" onClick={back}>
          Back
        </Button>
        <Button disabled={!ready || (nothingNew && !redeploy)} onClick={() => void review()}>
          Review playbook
        </Button>
      </>
    ),
    review: (
      <>
        <Button variant="ghost" disabled={starting} onClick={close}>
          Cancel
        </Button>
        <Button
          variant="ghost"
          disabled={starting}
          onClick={() => {
            setError(null)
            setStep('preflight')
          }}
        >
          Back
        </Button>
        <Button disabled={!reviewed} loading={starting} onClick={() => void start()}>
          Deploy
        </Button>
      </>
    ),
    started: <Button onClick={onClose}>Close</Button>,
  }[step]

  return (
    <>
      <Dialog open onClose={close} width={680} title={`Deploy to ${env?.name ?? ''}`} footer={<div className="flex justify-end gap-2">{footer}</div>}>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          {step === 'pick' && (
            <>
              <ServicePicker
                groups={groups}
                unavailable={unavailable}
                hostLabel={hostLabel}
                report={null}
                onToggle={toggle}
                onToggleGroup={toggleGroup}
                onAll={all}
              />
              {versioned && (
                <div className="flex items-center gap-3">
                  <Segmented label="Version bump" options={BUMPS} value={bump as (typeof BUMPS)[number]['id']} onChange={setBump} size="sm" />
                  {preview && <span className="font-mono text-[12.5px] text-fg/85 tabular-nums">{preview}</span>}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-4 text-[12.5px] text-fg/90">
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-3.5 accent-(--accent)" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
                  Back up databases
                </label>
                <label title={PHASE_9} className="flex items-center gap-2 text-muted">
                  <input type="checkbox" className="size-3.5 accent-(--accent)" checked={false} disabled onChange={() => {}} />
                  Notify
                </label>
                <label title={PHASE_9} className="flex items-center gap-2 text-muted">
                  <input type="checkbox" className="size-3.5 accent-(--accent)" checked={false} disabled onChange={() => {}} />
                  QA
                </label>
              </div>
              <ReleaseNotesSlot environmentId={environmentId} serviceIds={request.serviceIds} value={notes} onChange={setNotes} />
            </>
          )}

          {step === 'preflight' && (
            <>
              <PreflightChecklist
                checks={pre?.checks ?? []}
                report={report}
                checking={!error}
                fixes={{
                  repoPath: (id) => checkouts.find((d) => d.id === id)?.repoPath ?? null,
                  busy,
                  onBreakLock: breakLock,
                  onBumpFurther:
                    versioned && further
                      ? () => {
                          setBump(further)
                          void runPreflight(further)
                        }
                      : null,
                }}
              />
              {picked.map((g) => (
                <DatabaseRows key={`db:${g.checkout.id}`} checkoutId={g.checkout.id} report={report} />
              ))}
              {picked.map((g) => (
                <CheckoutNotice key={g.checkout.id} group={g} report={report} />
              ))}
              {report && !nothingNew && <CommitList groups={picked} report={report} />}
              {nothingNew && (
                <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <span className="flex-1 text-[12.5px] text-fg/90">Nothing new to deploy</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!ready}
                    onClick={() => {
                      setRedeploy(true)
                      void review()
                    }}
                  >
                    Redeploy anyway
                  </Button>
                </div>
              )}
            </>
          )}

          {step === 'review' && (
            <>
              <div className="flex flex-col gap-2 border-l-2 pl-3" style={{ borderColor: env?.color }}>
                <p className="text-[13px] font-medium text-fg">{summary}</p>
                <p
                  aria-label={`Deploys ${deploying.join(', ')}${regions.length ? ` · ${regions.map((r) => r.code).join(', ')}` : ''}`}
                  className={`flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg/90 ${spread ? 'self-start rounded-lg border border-warn/40 bg-warn/8 px-3 py-2' : ''}`}
                >
                  {spread && <TriangleAlert role="img" aria-label={`Reaches ${regions.length} regions`} className="size-3.5 shrink-0 text-warn" />}
                  <span>Deploys {deploying.join(', ')}</span>
                  {regions.length > 0 && <span aria-hidden>·</span>}
                  {regions.map((r) => (
                    <RegionChip key={r.id} region={r} emphasis={spread} />
                  ))}
                </p>
                {next && <p className="font-mono text-[12.5px] text-fg/85 tabular-nums">{preview}</p>}
                <p className="text-[12px] text-muted">
                  {[backup ? 'Databases backed up first' : 'No database backup', ...(redeploy ? ['Redeploys the current commits'] : [])].join(' · ')}
                </p>
              </div>
              <PlaybookReview playbook={reviewed?.playbook ?? null} autoRollback={settings?.autoRollback ?? false} onSave={() => void save()} />
              {saved && <p className="text-[12px] text-muted">Saved to {saved}</p>}
            </>
          )}

          {step === 'started' && releaseId && <ReleaseView releaseId={releaseId} />}

          {busy && step === 'preflight' && !releaseId && <p className="text-[12px] text-muted">Starting preflight</p>}
          {error && (
            <p role="alert" className="text-[12.5px] text-err">
              {error}
            </p>
          )}
        </div>
      </Dialog>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}
