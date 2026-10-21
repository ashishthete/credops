import { ArrowDown, ArrowUp, Plus, Trash2, Workflow, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FlowStage, ReleaseFlow } from '../../../../../shared/deploy'
import type { AppServiceMeta } from '../../../../../shared/services'
import { MAX_FLOW_STAGES, validateStep, type Step, type StepBody } from '../../../../../shared/steps'
import { api } from '../../../lib/api'
import { Button } from '../../../ui/Button'
import { SelectField } from '../../../ui/Field'
import { StepEditor } from '../../deployments/StepEditor'

const ON_FAILURE: Record<ReleaseFlow['onFailure'], string> = {
  'stop-all': 'Stop every host',
  'continue-other-hosts': 'Let the other hosts finish the stage',
}

/** `backend → migrate → frontend ∥ fastapi`: stages left to right, a stage's parallel services joined by ∥, a step stage by its step's name. */
export function flowPreview(flow: ReleaseFlow, names: Record<string, string>): string {
  return flow.stages
    .map((st) => (st.kind === 'step' ? st.step.name : st.serviceIds.map((id) => names[id] ?? 'unknown service').join(' ∥ ')))
    .join(' → ')
}

/** A step id and name no other step of the flow uses. */
function newStep(flow: ReleaseFlow): StepBody {
  const used = new Set(flow.stages.flatMap((st) => (st.kind === 'step' ? [st.step.id, st.step.name] : [])))
  let n = 1
  while (used.has(`step-${n}`)) n++
  return {
    id: `step-${n}`,
    name: `step-${n}`,
    run: 'shell',
    service: null,
    script: '',
    cwd: null,
    sudo: 'docker',
    timeoutSec: 600,
    onFailure: 'stop',
    when: { kind: 'always' },
    secrets: [],
  }
}

/** StepEditor edits a checkout step; a flow step is its body, placed by its stage instead of an anchor. */
const asStep = (body: StepBody): Step => ({ ...body, anchor: 'after_up', alsoOnRollback: false })
const asBody = ({ anchor: _anchor, alsoOnRollback: _rollback, ...body }: Step): StepBody => body

/** What is wrong with each stage, as main's check would say it; undefined when nothing is. */
function stageErrors(flow: ReleaseFlow, services: AppServiceMeta[], secretIds: string[]): (string | undefined)[] {
  const allowedSecretIds = new Set(secretIds)
  return flow.stages.map((st, i) => {
    if (st.kind === 'services') return st.serviceIds.length === 0 ? `Stage ${i + 1} has no services` : undefined
    const bound = services.find((s) => s.id === st.serviceId)
    if (!bound) return `Stage ${i + 1} needs a service to run in`
    const serviceNames = services.filter((s) => s.deploymentId === bound.deploymentId).map((s) => s.composeService)
    try {
      validateStep(st.step, { allowedSecretIds, serviceNames, body: true })
      return undefined
    } catch (e) {
      return e instanceof Error ? e.message : 'step is not valid'
    }
  })
}

/**
 * The environment's release flow: the order its services go up in, with steps between stages. Every host prepares
 * first (fetch, build), then each stage runs on the hosts of its services, the services of one stage side by side.
 * Without a flow each host releases in turn. Secrets are picked by name; a value is never shown or held.
 */
export function ReleaseFlowSection({
  services,
  flow,
  onSave,
}: {
  /** The environment's services; only those in a checkout can be staged. */
  services: AppServiceMeta[]
  flow: ReleaseFlow | null
  onSave: (flow: ReleaseFlow | null) => Promise<unknown>
}) {
  const staged = useMemo(() => services.filter((s) => s.deploymentId !== null), [services])
  const names = useMemo(() => Object.fromEntries(services.map((s) => [s.id, s.name])), [services])
  const [draft, setDraft] = useState<ReleaseFlow | null>(null)
  const [busy, setBusy] = useState(false)
  // Removing drops every step stage's script with no undo, so it is asked inline first.
  const [removing, setRemoving] = useState(false)
  const [secrets, setSecrets] = useState<{ id: string; name: string }[]>([])

  // Secret names only (never values), for a step's secrets, while editing.
  const editing = draft !== null
  useEffect(() => {
    if (!editing) return
    let live = true
    api.invoke('secret:list').then(
      (list) => live && setSecrets((list ?? []).map((s) => ({ id: s.id, name: s.name }))),
      () => live && setSecrets([]),
    )
    return () => {
      live = false
    }
  }, [editing])

  const save = async (next: ReleaseFlow | null) => {
    setBusy(true)
    try {
      const ok = await onSave(next)
      if (ok !== false) {
        setDraft(null)
        setRemoving(false)
      }
    } finally {
      setBusy(false)
    }
  }

  const shown = draft ?? flow
  return (
    <section aria-label="Release flow" className="mt-6 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-fg/90">
          <Workflow aria-hidden className="size-3.5 text-muted" />
          Release flow
        </h3>
        {!editing && (
          <div className="ml-auto flex gap-1.5">
            {flow ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => {
                    setRemoving(false)
                    setDraft(structuredClone(flow))
                  }}>
                  Edit flow
                </Button>
                <Button size="sm" variant="ghost" disabled={removing} onClick={() => setRemoving(true)}>
                  Remove flow
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={staged.length === 0}
                onClick={() => setDraft({ onFailure: 'stop-all', stages: [{ kind: 'services', serviceIds: staged.map((s) => s.id) }] })}
              >
                Set up flow
              </Button>
            )}
          </div>
        )}
      </div>
      {removing && !editing && (
        <div
          role="group"
          aria-label="Remove the release flow?"
          className="flex items-center gap-3 rounded-lg border border-err/30 bg-err/[0.06] px-3 py-2 text-[12.5px] text-fg/90"
        >
          <span className="flex-1">Remove the release flow? Its step stages and their scripts go with it, and each host releases in turn again.</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(false)}>
            Keep flow
          </Button>
          <Button size="sm" variant="danger" loading={busy} onClick={() => void save(null)}>
            Remove
          </Button>
        </div>
      )}
      {shown ? (
        <p className="text-[12.5px] text-fg/90">
          <span data-testid="flow-preview" className="font-mono">
            {flowPreview(shown, names)}
          </span>
          {!editing && <span className="text-muted"> · if a stage fails: {ON_FAILURE[shown.onFailure].toLowerCase()}</span>}
        </p>
      ) : (
        <p className="text-[12.5px] text-muted">No flow: each host releases in turn.</p>
      )}
      {draft && (
        <FlowEditor
          draft={draft}
          services={staged}
          secrets={secrets}
          busy={busy}
          onChange={setDraft}
          onSave={() => void save(draft)}
          onCancel={() => setDraft(null)}
        />
      )}
    </section>
  )
}

function FlowEditor({
  draft,
  services,
  secrets,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ReleaseFlow
  services: AppServiceMeta[]
  secrets: { id: string; name: string }[]
  busy: boolean
  onChange: (next: ReleaseFlow) => void
  onSave: () => void
  onCancel: () => void
}) {
  const errors = stageErrors(
    draft,
    services,
    secrets.map((s) => s.id),
  )
  const stages = draft.stages
  const setStages = (next: FlowStage[]) => onChange({ ...draft, stages: next })
  const setStage = (i: number, st: FlowStage) => setStages(stages.map((x, j) => (j === i ? st : x)))
  const move = (i: number, dir: -1 | 1) => {
    const next = [...stages]
    ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
    setStages(next)
  }
  const full = stages.length >= MAX_FLOW_STAGES

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface/60 p-3">
      <ol className="flex flex-col gap-2">
        {stages.map((st, i) => {
          const n = i + 1
          return (
            <li key={i} role="group" aria-label={`Stage ${n}`} className="flex flex-col gap-2 rounded-lg border border-line/60 bg-canvas/40 p-2.5">
              <div className="flex items-center gap-1">
                <span className="text-[11px] tracking-wide text-muted uppercase">
                  Stage {n} · {st.kind === 'step' ? 'step' : 'services'}
                </span>
                <span className="ml-auto flex gap-0.5">
                  <IconButton label={`Move stage ${n} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp aria-hidden className="size-3.5" />
                  </IconButton>
                  <IconButton label={`Move stage ${n} down`} disabled={i === stages.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown aria-hidden className="size-3.5" />
                  </IconButton>
                  <IconButton label={`Remove stage ${n}`} disabled={stages.length === 1} onClick={() => setStages(stages.filter((_, j) => j !== i))}>
                    <Trash2 aria-hidden className="size-3.5" />
                  </IconButton>
                </span>
              </div>
              {st.kind === 'services' ? (
                <ServicesStage n={n} stage={st} services={services} onChange={(next) => setStage(i, next)} />
              ) : (
                <>
                  <SelectField label="Runs in the checkout of" value={st.serviceId} onChange={(e) => setStage(i, { ...st, serviceId: e.target.value })}>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </SelectField>
                  <StepEditor
                    step={asStep(st.step)}
                    onChange={(next) => setStage(i, { ...st, step: asBody(next) })}
                    secrets={secrets}
                    serviceNames={services.filter((s) => s.deploymentId === services.find((x) => x.id === st.serviceId)?.deploymentId).map((s) => s.composeService)}
                  />
                </>
              )}
              {errors[i] && <p className="text-[11.5px] text-err">{errors[i]}</p>}
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-end gap-2">
        <Button size="sm" variant="ghost" icon={<Plus aria-hidden className="size-3.5" />} disabled={full} onClick={() => setStages([...stages, { kind: 'services', serviceIds: [] }])}>
          Add services stage
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus aria-hidden className="size-3.5" />}
          disabled={full || services.length === 0}
          onClick={() => setStages([...stages, { kind: 'step', serviceId: services[0].id, step: newStep(draft) }])}
        >
          Add step stage
        </Button>
        <div className="ml-auto w-64">
          <SelectField label="If a stage fails" value={draft.onFailure} onChange={(e) => onChange({ ...draft, onFailure: e.target.value as ReleaseFlow['onFailure'] })}>
            {Object.entries(ON_FAILURE).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </SelectField>
        </div>
      </div>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" loading={busy} disabled={errors.some(Boolean)} onClick={onSave}>
          Save flow
        </Button>
      </div>
    </div>
  )
}

function ServicesStage({
  n,
  stage,
  services,
  onChange,
}: {
  n: number
  stage: Extract<FlowStage, { kind: 'services' }>
  services: AppServiceMeta[]
  onChange: (next: Extract<FlowStage, { kind: 'services' }>) => void
}) {
  const left = services.filter((s) => !stage.serviceIds.includes(s.id))
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stage.serviceIds.map((id) => {
        const name = services.find((s) => s.id === id)?.name ?? 'unknown service'
        return (
          <span key={id} className="inline-flex h-6 items-center gap-1 rounded-md border border-line px-1.5 text-[12px] text-fg">
            {name}
            <button
              type="button"
              aria-label={`Remove ${name} from stage ${n}`}
              onClick={() => onChange({ ...stage, serviceIds: stage.serviceIds.filter((x) => x !== id) })}
              className="grid size-4 place-items-center rounded text-muted hover:text-fg"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        )
      })}
      {left.length > 0 && (
        <select
          aria-label={`Add a service to stage ${n}`}
          value=""
          onChange={(e) => e.target.value && onChange({ ...stage, serviceIds: [...stage.serviceIds, e.target.value] })}
          className="h-6 rounded-md border border-dashed border-line bg-transparent px-1.5 text-[12px] text-muted"
        >
          <option value="">Add service…</option>
          {left.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-lg text-muted hover:bg-white/6 hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  )
}
