import { TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  bumpVersion,
  stepBound,
  BREAK_LOCK_CONFIRM_MESSAGE,
  DEFAULT_RELEASE_OPTIONS,
  NOTHING_SELECTED_MESSAGE,
  ORIGIN_MOVED_MESSAGE,
  PLAYBOOK_CHANGED_MESSAGE,
  REVIEW_EXPIRED_MESSAGE,
  type PlaybookPreview,
  type ReleaseDetail,
  type VersionBump,
} from '../../../../../shared/deploy'
import { hostRegions, regionRefs, regionsOfHosts } from '../../../../../shared/regions'
import { pickerGroups, selectionRequest, type PickerGroup } from '../../../deploy/picker'
import { originMoved } from '../../../deploy/pipeline'
import { closeRelease, openRelease, startReleaseSync, usePipeline, usePreflight } from '../../../deploy/releases'
import { flushReleaseNotes, ReleaseNotesSlot, RELEASE_OPTIONS_UNAVAILABLE, releaseOptionDefaults, releaseOptionsAvailable } from '../../../deploy/slots'
import { loadSettings, startDeploySync, useDeploy, useDeployments, useServices } from '../../../deploy/store'
import { useHub } from '../../../hub/store'
import { useInventory } from '../../../inventory/store'
import { api } from '../../../lib/api'
import { Button } from '../../../ui/Button'
import { attempt, ConfirmDialog, plural, type ConfirmRequest } from '../../../ui/common'
import { Dialog } from '../../../ui/Dialog'
import { RegionChip } from '../../../ui/RegionChip'
import { Segmented } from '../../../ui/Segmented'
import { CommitList } from './CommitList'
import { PlaybookReview } from './PlaybookReview'
import { AnsibleTerminal } from './AnsibleTerminal'
import { PreflightChecklist } from './PreflightChecklist'
import { CheckoutNotice, DatabaseRows, ServicePicker, SkipRows } from './ServicePicker'
import { ReleaseView } from './ReleaseView'

const BUMPS = [
  { id: 'patch', label: 'patch' },
  { id: 'minor', label: 'minor' },
  { id: 'major', label: 'major' },
] as const satisfies readonly { id: VersionBump; label: string }[]
const FURTHER: Partial<Record<VersionBump, VersionBump>> = { patch: 'minor', minor: 'major' }
const NOTIFY_HINT = "Sends the Teams and email notifications in the environment's Notifications and QA settings"
const QA_HINT = "Runs the QA workflow in the environment's Notifications and QA settings"

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
  const own = data?.environments.find((e) => e.id === environmentId)
  const productName = (own && data?.products.find((p) => p.id === own.productId)?.name) ?? null
  const env = own ?? (hubEnv ? { name: hubEnv.name, protected: hubEnv.protected, color: undefined } : undefined)
  const checkouts = useDeployments(environmentId)
  const services = useServices(environmentId)
  const settings = useDeploy().settings[environmentId]
  const versioned = settings?.versioned ?? false

  // The selection starts from `preselect` every time; it is not remembered.
  const [selected, setSelected] = useState(() => new Set(preselect))
  const [wholes, setWholes] = useState(() => new Set(preselectCheckouts))
  const [bump, setBump] = useState<VersionBump>('minor')
  const [backup, setBackup] = useState(true)
  // Registered at startup by ai/register; read once, as nothing registers later.
  const [available] = useState(releaseOptionsAvailable)
  const [notify, setNotify] = useState(available.notify && DEFAULT_RELEASE_OPTIONS.notify)
  const [qa, setQa] = useState(false)
  const qaTouched = useRef(false)
  // The preflighted release for the notes editor in the review.
  const [detail, setDetail] = useState<ReleaseDetail | null>(null)
  const [step, setStep] = useState<Step>('pick')
  const [releaseId, setReleaseId] = useState<string | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  const [redeploy, setRedeploy] = useState(false)
  // Skippable services the person chose to deploy anyway; sent as `forceServiceIds` to the preview and the start.
  const [force, setForce] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  // release:start in flight: the wizard can't be closed or rewound until it answers.
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // The playbook under review; Deploy sends its hash, and main refuses the start if what would run differs.
  const [reviewed, setReviewed] = useState<PlaybookPreview | null>(null)
  // The person is editing the playbook: Deploy would run the unedited one, so it waits.
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const pre = usePreflight(releaseId)
  const report = pre?.report ?? null
  const pipeline = usePipeline(releaseId)

  useEffect(() => startReleaseSync(), [])
  useEffect(() => startDeploySync(), [])
  useEffect(() => void loadSettings(environmentId), [environmentId])
  useEffect(() => {
    let live = true
    void releaseOptionDefaults(environmentId).then((d) => {
      if (live && d.qa !== undefined && !qaTouched.current) setQa(d.qa)
    })
    return () => {
      live = false
    }
  }, [environmentId])

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
    setForce(new Set())
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
          options: { backup, notify: available.notify && notify, qa: available.qa && qa },
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

  // The forced services go only when there are some, so a plain preview asks for the release alone.
  const previewOf = (id: string, forced: Set<string>) => api.invoke('deploy:previewPlaybook', id, ...(forced.size ? [[...forced]] : []))

  const review = async (forced = force) => {
    if (!releaseId) return
    const id = releaseId
    setReviewed(null)
    setSaved(null)
    setStep('review')
    // The notes editor drafts from the preflight's commits and saves onto this release. A release that can't
    // be read fails the preview too, which says so; the editor just stays away.
    if (detail?.id !== id)
      void api.invoke('release:get', id).then(
        (d) => {
          if (held.current === id) setDetail(d)
        },
        () => {},
      )
    const out = await attempt("Couldn't generate the playbook", () => previewOf(id, forced), setError)
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

  // `edit`: the person's edited text with the hash main gave it, run in place of the generated playbook.
  const start = async (edit?: { text: string; sha256: string }) => {
    if (!releaseId || !env || !reviewed) return
    const sha256 = edit?.sha256 ?? reviewed.sha256
    const forced = force
    const begin = async (typedName?: string) => {
      setStarting(true)
      setError(null)
      let changed = false
      const ok = await attempt(
        "Couldn't start the release",
        // release:start answers nothing, so success is marked here: undefined is attempt's failure.
        async () => {
          // The release runs with the notes main holds: an edit still on its debounce goes first.
          await flushReleaseNotes(releaseId)
          await api.invoke('release:start', releaseId, {
            ...(typedName !== undefined ? { typedName } : {}),
            redeploy,
            playbookSha256: sha256,
            ...(edit ? { editedPlaybook: edit.text } : {}),
            ...(forced.size ? { forceServiceIds: [...forced] } : {}),
          })
          return true
        },
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
          const out = await attempt("Couldn't generate the playbook", () => previewOf(releaseId, forced), setError)
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

  // The started release failed and can't be previewed again: stop watching it and preflight a new one.
  const previewAgain = () => {
    if (releaseId) closeRelease(releaseId)
    void runPreflight()
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
        const ok = await attempt("Couldn't break the lock", async () => (await api.invoke('release:break-lock', releaseId, hostId, { typedLabel: label }), true))
        if (ok !== undefined) void runPreflight()
      },
    })
  }

  const further = FURTHER[bump]
  const ready = !!report && !report.blocked
  const nothingNew = !!report && report.commitsTotal === 0
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? 'unknown service'
  // Preflight never calls a step-bound service skippable; a flow saved since it ran is held to the same rule as start.
  const bound = stepBound(settings?.flow ?? null)
  const skippable = request.serviceIds.filter((id) => report?.serviceCommits[id]?.skippable && !bound.has(id))
  const skipped = skippable.filter((id) => !force.has(id)).map((id) => ({ id, name: nameOf(id) }))
  // Every selected service would be skipped: there is nothing to deploy until one is forced.
  const allSkipped = !!report && !redeploy && !request.checkoutIds.length && request.serviceIds.length > 0 && skipped.length === request.serviceIds.length
  const forceOne = (id: string) => setForce((f) => new Set(f).add(id))
  // A custom step is named by its run row's label; the run's chips carry it under `<runId>:<key>`.
  const customLabels = useMemo(() => {
    const out: Record<string, Record<string, string>> = {}
    for (const run of pipeline?.lanes.flatMap((l) => l.runs) ?? []) {
      for (const c of run.chips) if (c.kind === 'custom') (out[run.runId] ??= {})[c.stepId.slice(run.runId.length + 1)] = c.label
    }
    return out
  }, [pipeline?.lanes])
  const moved = step === 'started' && !!pipeline && originMoved(pipeline)
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
        <Button disabled={!ready || (nothingNew && !redeploy) || allSkipped} onClick={() => void review()}>
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
        <Button disabled={!reviewed || editing} loading={starting} onClick={() => void start()}>
          Deploy
        </Button>
      </>
    ),
    started: <Button onClick={onClose}>Close</Button>,
  }[step]

  return (
    <>
      <Dialog open onClose={close} width={680} title={`Deploy to ${env?.name ?? ''}`} footer={<div className="flex justify-end gap-2">{footer}</div>}>
        <div className="flex max-h-[60vh] min-w-0 flex-col gap-4 overflow-x-hidden overflow-y-auto">
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
              <div role="group" aria-label="Options" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3 text-[12.5px] text-fg/90">
                <span className="text-[11px] font-medium tracking-wide text-muted uppercase">Options</span>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-3.5 accent-(--accent)" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
                  Back up databases
                </label>
                <label title={available.notify ? NOTIFY_HINT : RELEASE_OPTIONS_UNAVAILABLE} className={`flex items-center gap-2 ${available.notify ? '' : 'text-muted'}`}>
                  <input
                    type="checkbox"
                    className="size-3.5 accent-(--accent)"
                    checked={available.notify && notify}
                    disabled={!available.notify}
                    onChange={(e) => setNotify(e.target.checked)}
                  />
                  Notify
                </label>
                <label title={available.qa ? QA_HINT : RELEASE_OPTIONS_UNAVAILABLE} className={`flex items-center gap-2 ${available.qa ? '' : 'text-muted'}`}>
                  <input
                    type="checkbox"
                    className="size-3.5 accent-(--accent)"
                    checked={available.qa && qa}
                    disabled={!available.qa}
                    onChange={(e) => {
                      qaTouched.current = true
                      setQa(e.target.checked)
                    }}
                  />
                  QA
                </label>
              </div>
              <ReleaseNotesSlot environmentId={environmentId} release={null} productName={productName} />
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
              {releaseId && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    aria-expanded={showOutput}
                    onClick={() => setShowOutput((v) => !v)}
                    className="w-fit text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline"
                  >
                    {showOutput ? 'Hide ansible output' : 'Show ansible output'}
                  </button>
                  {showOutput && <AnsibleTerminal releaseId={releaseId} className="h-64 shrink-0" />}
                </div>
              )}
              {picked.map((g) => (
                <DatabaseRows key={`db:${g.checkout.id}`} checkoutId={g.checkout.id} report={report} />
              ))}
              {picked.map((g) => (
                <CheckoutNotice key={g.checkout.id} group={g} report={report} />
              ))}
              {report && !nothingNew && <CommitList groups={picked} report={report} />}
              {report && !nothingNew && <SkipRows services={skipped} onForce={forceOne} />}
              {allSkipped && !nothingNew && <p className="text-[12.5px] text-fg/90">{NOTHING_SELECTED_MESSAGE}</p>}
              {nothingNew && (
                <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <span className="flex-1 text-[12.5px] text-fg/90">Nothing new to deploy</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!ready}
                    onClick={() => {
                      // A redeploy runs every selected service, the unchanged ones too.
                      const forced = new Set([...force, ...skippable])
                      setRedeploy(true)
                      setForce(forced)
                      void review(forced)
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
              {detail && detail.id === releaseId && <ReleaseNotesSlot environmentId={environmentId} release={detail} productName={productName} />}
              {!!reviewed?.skippedServiceIds?.length && (
                <p className="text-[12px] text-muted">{`Skipped, no changes: ${reviewed.skippedServiceIds.map(nameOf).join(', ')}`}</p>
              )}
              <PlaybookReview
                playbook={reviewed?.playbook ?? null}
                inventory={reviewed?.inventory}
                autoRollback={settings?.autoRollback ?? false}
                customLabels={customLabels}
                onSave={() => void save()}
                editable
                releaseId={releaseId ?? undefined}
                forceServiceIds={force.size ? [...force] : undefined}
                onRunEdited={(text, sha256) => void start({ text, sha256 })}
                onEditingChange={setEditing}
                busy={starting}
                onPreviewAgain={() => void review()}
              />
              {saved && <p className="text-[12px] text-muted">Saved to {saved}</p>}
            </>
          )}

          {moved && (
            <div role="alert" className="flex items-center gap-3 rounded-lg border border-err/30 bg-err/[0.06] px-3 py-2 text-[12.5px] text-err">
              <span className="flex-1">The release stopped: {ORIGIN_MOVED_MESSAGE}.</span>
              <Button size="sm" variant="ghost" onClick={previewAgain}>
                Preview again
              </Button>
            </div>
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
