import {
  STEP_LABEL,
  type DeploymentRunStatus,
  type ReleaseDetail,
  type ReleaseStatus,
  type RunEvent,
  type StepKind,
  type StepState,
  type TaskState,
} from '../../../shared/deploy'
import { playbookSteps, type PlaybookPlay } from '../../../shared/playbook-steps'
import { listNames } from '../../../shared/services'

export interface ChipState {
  stepId: string
  kind: StepKind
  label: string
  state: StepState | 'rolled_back'
  startedAt: number | null
  durationMs: number | null
  error: string | null
}

/** One Ansible task's result (`task.done`); `at` is when it arrived. */
export interface TaskResult {
  task: string
  hostId: string | null
  state: TaskState
  rc: number | null
  attempts: number | null
  durationMs: number
  at: number
}

export interface LaneRun {
  runId: string
  name: string
  /** The selected services' names; [] when the run deploys its whole checkout. */
  services: string[]
  wholeCheckout: boolean
  status: DeploymentRunStatus
  chips: ChipState[]
  previousCommit: string | null
  deployedCommit: string | null
}

/** `<checkout>: <services>`, or `<checkout>: whole checkout`. */
/** What a run deploys: its services, or the whole checkout. */
export const runServices = (run: Pick<LaneRun, 'services' | 'wholeCheckout'>) => (run.wholeCheckout || !run.services.length ? 'whole checkout' : listNames(run.services))
export const runLabel = (run: Pick<LaneRun, 'name' | 'services' | 'wholeCheckout'>) => `${run.name}: ${runServices(run)}`

export interface Lane {
  hostId: string
  hostLabel: string
  lock: ChipState | null
  runs: LaneRun[]
  unlock: ChipState | null
}

export interface PipelineState {
  releaseId: string
  status: ReleaseStatus
  lanes: Lane[]
  /** Release-wide steps: the version tag and the finalize steps. */
  release: ChipState[]
  rollback: { active: boolean; runIds: string[]; ok: boolean | null }
  version: { from: string | null; to: string | null }
  lockBusy: { hostId: string; text: string; stale: boolean }[]
  /** Per step id, its tasks' results in arrival order; empty for releases from before `task.done`. */
  tasks: Record<string, TaskResult[]>
  /** The stored release playbook's tasks, for the step list; empty until the release has one. */
  plays: PlaybookPlay[]
  lastSeq: number
  /** An event arrived past `lastSeq + 1`; the store refetches from `lastSeq`. */
  gap: boolean
  result: { status: string; error?: string } | null
}

const chip = (stepId: string, kind: StepKind): ChipState => ({
  stepId,
  kind,
  label: STEP_LABEL[kind],
  state: 'pending',
  startedAt: null,
  durationMs: null,
  error: null,
})

/**
 * The pipeline before any event: one lane per host in run order, every planned step pending. Events from seq 1
 * then bring it to the live state, so a reopened release and a watched one end up the same.
 */
export function initialPipeline(detail: ReleaseDetail): PipelineState {
  const lanes: Lane[] = []
  for (const run of [...detail.runs].sort((a, b) => a.position - b.position)) {
    const hostId = run.hostId ?? ''
    let lane = lanes.find((l) => l.hostId === hostId)
    if (!lane) {
      lane = { hostId, hostLabel: run.hostLabel, lock: chip(`host:${hostId}:lock`, 'lock'), runs: [], unlock: chip(`host:${hostId}:unlock`, 'unlock') }
      lanes.push(lane)
    }
    lane.runs.push({
      runId: run.id,
      name: run.deploymentName,
      services: run.wholeCheckout ? [] : run.services.map((s) => s.name),
      wholeCheckout: run.wholeCheckout,
      status: 'pending',
      chips: run.steps.map((s) => chip(s.stepId, s.kind)),
      previousCommit: null,
      deployedCommit: null,
    })
  }
  return {
    releaseId: detail.id,
    status: detail.status,
    lanes,
    release: detail.kind === 'release' && detail.version !== null ? [chip('release:version', 'version')] : [],
    rollback: { active: false, runIds: [], ok: null },
    version: { from: detail.previousVersion, to: detail.version },
    lockBusy: [],
    tasks: {},
    plays: detail.playbook ? playbookSteps(detail.playbook) : [],
    lastSeq: 0,
    gap: false,
    result: null,
  }
}

/**
 * Applies events in seq order. Pure: the input is never changed, and only the lanes an event touches are copied.
 * An event at or below `lastSeq` was applied already; one past `lastSeq + 1` sets `gap` and is left for the refetch.
 * `log` events are not the pipeline's.
 */
export function reducePipeline(s: PipelineState, events: RunEvent[]): PipelineState {
  let next: PipelineState | null = null
  const copied = new Set<number>()
  let releaseCopied = false
  const draft = (): PipelineState => (next ??= { ...s, lanes: [...s.lanes] })
  const lane = (i: number): Lane => {
    const d = draft()
    if (!copied.has(i)) {
      copied.add(i)
      d.lanes[i] = structuredClone(d.lanes[i])
    }
    return d.lanes[i]
  }
  const releaseChips = (): ChipState[] => {
    const d = draft()
    if (!releaseCopied) {
      releaseCopied = true
      d.release = d.release.map((c) => ({ ...c }))
    }
    return d.release
  }
  const cur = () => next ?? s

  /** The chip `stepId` names, made writable; a step the plan didn't list is appended where it belongs. */
  const findChip = (stepId: string, kind?: StepKind): ChipState | null => {
    const parts = stepId.split(':')
    if (parts[0] === 'release') {
      const k = (kind ?? parts[1]) as StepKind
      const list = releaseChips()
      let c = list.find((x) => x.stepId === stepId)
      if (!c && kind) list.push((c = chip(stepId, k)))
      return c ?? null
    }
    if (parts[0] === 'host') {
      const i = cur().lanes.findIndex((l) => l.hostId === parts[1])
      if (i < 0) return null
      const l = lane(i)
      const which = parts[2] === 'unlock' ? 'unlock' : 'lock'
      if (!l[which]) l[which] = chip(stepId, which)
      return l[which]
    }
    const i = cur().lanes.findIndex((l) => l.runs.some((r) => r.runId === parts[0]))
    if (i < 0) return null
    const run = lane(i).runs.find((r) => r.runId === parts[0])!
    let c = run.chips.find((x) => x.stepId === stepId)
    if (!c && kind) run.chips.push((c = chip(stepId, kind)))
    return c ?? null
  }
  const findRun = (runId: string): LaneRun | null => {
    const i = cur().lanes.findIndex((l) => l.runs.some((r) => r.runId === runId))
    return i < 0 ? null : lane(i).runs.find((r) => r.runId === runId)!
  }

  for (const ev of events) {
    const at = cur()
    if (ev.seq <= at.lastSeq) continue
    if (ev.seq > at.lastSeq + 1) {
      if (!at.gap) draft().gap = true
      continue
    }
    const d = draft()
    d.lastSeq = ev.seq
    d.gap = false
    switch (ev.type) {
      case 'run.started':
        d.status = 'running'
        if (ev.version) d.version = { ...d.version, to: ev.version }
        break
      case 'preflight.done':
        d.status = ev.report.blocked ? 'blocked' : 'ready'
        break
      case 'step.started': {
        const c = findChip(ev.stepId, ev.kind)
        if (c) Object.assign(c, { state: 'running', startedAt: Date.parse(ev.at), durationMs: null, error: null })
        break
      }
      case 'step.done': {
        const c = findChip(ev.stepId)
        if (c) Object.assign(c, { state: ev.state, durationMs: ev.durationMs, error: ev.state === 'warn' ? (ev.message ?? null) : null })
        break
      }
      case 'step.failed': {
        const c = findChip(ev.stepId)
        if (c) Object.assign(c, { state: 'failed', durationMs: ev.durationMs, error: ev.error })
        break
      }
      case 'task.done': {
        const { stepId, task, hostId, state, rc, attempts, durationMs } = ev
        d.tasks = { ...d.tasks, [stepId]: [...(d.tasks[stepId] ?? []), { task, hostId, state, rc, attempts, durationMs, at: Date.parse(ev.at) }] }
        break
      }
      case 'deployment.updated': {
        const r = findRun(ev.deploymentRunId)
        if (!r) break
        r.status = ev.status
        if (ev.previousCommit !== undefined) r.previousCommit = ev.previousCommit
        if (ev.deployedCommit !== undefined) r.deployedCommit = ev.deployedCommit
        break
      }
      case 'lock.busy':
        d.lockBusy = [...d.lockBusy.filter((b) => b.hostId !== ev.hostId), { hostId: ev.hostId, text: ev.text, stale: ev.stale }]
        break
      case 'rollback.started':
        d.status = 'rolling_back'
        d.rollback = { active: true, runIds: [...ev.deploymentRunIds], ok: null }
        for (const id of ev.deploymentRunIds) {
          const r = findRun(id)
          if (!r) continue
          for (const c of r.chips) if (c.state === 'ok' || c.state === 'warn') c.state = 'rolled_back'
        }
        break
      case 'rollback.done':
        d.rollback = { ...d.rollback, active: false, ok: ev.ok }
        break
      case 'version.bumped':
        d.version = { from: ev.from, to: ev.to }
        break
      case 'run.finished':
        d.status = ev.status
        d.result = ev.error !== undefined ? { status: ev.status, error: ev.error } : { status: ev.status }
        break
      default:
        // log, log.truncated and preflight.check belong to the log and the checklist.
        break
    }
  }
  return next ?? s
}

const median = (xs: number[]): number => {
  const v = [...xs].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * Time left: each pending or running step costs the median of its kind's past durations (less what a running
 * one has used). Hosts run side by side, so the slowest lane counts, then the release-wide steps. Null when no
 * remaining step has any history.
 */
export function etaMs(s: PipelineState, history: Partial<Record<StepKind, number[]>>, now: number): number | null {
  let known = false
  const left = (c: ChipState | null): number => {
    if (!c || (c.state !== 'pending' && c.state !== 'running')) return 0
    const past = history[c.kind]
    if (!past?.length) return 0
    known = true
    const m = median(past)
    return c.state === 'running' && c.startedAt !== null ? Math.max(0, m - (now - c.startedAt)) : m
  }
  let lanes = 0
  for (const l of s.lanes) {
    const t = left(l.lock) + l.runs.reduce((sum, r) => sum + r.chips.reduce((x, c) => x + left(c), 0), 0) + left(l.unlock)
    lanes = Math.max(lanes, t)
  }
  const total = lanes + s.release.reduce((x, c) => x + left(c), 0)
  return known ? total : null
}
