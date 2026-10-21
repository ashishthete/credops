import type { StepKind } from '../../../shared/deploy'
import { isHelperTask, stepLabels, type PlaybookPlay, type PlaybookStep } from '../../../shared/playbook-steps'
import { runServices, type ChipState, type PipelineState, type TaskResult } from './pipeline'

export type RowState = ChipState['state'] | 'changed'

/**
 * Which log lines are a row's: its step's when the step is one task; else its own task's (main tags them). A
 * release from before that has only step lines, so its rows of a several-task step share them, and say so.
 */
export type RowOutput = { stepId: string; wholeStep?: true } | { taskKey: string }

/** One Ansible task of the release, as the step list shows it. */
export interface TaskRow {
  key: string
  stepId: string
  kind: StepKind
  /** As the playbook review calls it: the step's label, numbered when the step has several tasks. */
  label: string
  /** The task's playbook name (`health site 0`); '' for a step the stored playbook doesn't list. */
  name: string
  state: RowState
  startedAt: number | null
  durationMs: number | null
  /** Set when the task retried. */
  attempts: number | null
  rc: number | null
  error: string | null
  /** The step's first failed row: it opens by itself and carries the failure panel. */
  failure: boolean
  output: RowOutput
}

export interface RunRows {
  runId: string
  /** The deployment's name, as the playbook review heads it. */
  title: string
  /** What it deploys: its services or the whole checkout. */
  detail: string
  rows: TaskRow[]
}

export interface HostRows {
  hostId: string
  hostLabel: string
  /** Host-wide tasks before the deployments: the lock. */
  before: TaskRow[]
  runs: RunRows[]
  /** The unlock, which runs from its own playbook. */
  after: TaskRow[]
}

interface Spec {
  stepId: string
  kind: StepKind
  label: string
  name: string
}

const fromStep = (s: PlaybookStep): Spec | null => (s.stepId ? { stepId: s.stepId, kind: s.kind as StepKind, label: s.label, name: s.name } : null)
const fromChip = (c: ChipState): Spec => ({ stepId: c.stepId, kind: c.kind, label: c.label, name: '' })
/** `custom`: a run's custom step labels by key (`c_<n>`); keys repeat across runs, so it is per run. */
function specs(steps: PlaybookStep[], custom: Record<string, string> = {}): Spec[] {
  const tasks = steps.filter((s) => !isHelperTask(s.name))
  const labels = stepLabels(tasks, custom)
  return tasks.flatMap((s, i) => {
    const x = fromStep(s)
    return x ? [{ ...x, label: labels[i] }] : []
  })
}

/**
 * The release's steps as one row per Ansible task: per host its lock, then each deployment's tasks in playbook
 * order, then its unlock; the release-wide steps last. Each row's state is its task's own result (`task.done`)
 * where there is one, else its step's. Steps the stored playbook doesn't list (the auto-rollback and unlock run
 * from their own playbooks; an old release may have no playbook at all) are rows from their steps. Pure.
 */
export function taskRows(s: Pick<PipelineState, 'lanes' | 'release' | 'tasks'>, plays: PlaybookPlay[]): { hosts: HostRows[]; release: TaskRow[] } {
  const chips = new Map<string, ChipState>()
  for (const l of s.lanes) {
    if (l.lock) chips.set(l.lock.stepId, l.lock)
    for (const r of l.runs) for (const c of r.chips) chips.set(c.stepId, c)
    if (l.unlock) chips.set(l.unlock.stepId, l.unlock)
  }
  for (const c of s.release) chips.set(c.stepId, c)

  const hosts = s.lanes.map((lane) => {
    const play = plays.find(
      (p) => p.steps.some((st) => st.stepId === `host:${lane.hostId}:lock`) || p.deployments.some((d) => lane.runs.some((r) => r.runId === d.runId)),
    )
    return {
      hostId: lane.hostId,
      hostLabel: lane.hostLabel,
      before: play ? specs(play.steps) : lane.lock ? [fromChip(lane.lock)] : [],
      runs: lane.runs.map((run) => {
        const dep = play?.deployments.find((d) => d.runId === run.runId)
        const custom = Object.fromEntries(run.chips.filter((c) => c.kind === 'custom').map((c) => [c.stepId.slice(c.stepId.indexOf(':') + 1), c.label]))
        const listed = dep ? specs(dep.steps, custom) : []
        const rest = run.chips.filter((c) => !listed.some((x) => x.stepId === c.stepId)).map(fromChip)
        return { runId: run.runId, title: dep?.name || run.name, detail: runServices(run), specs: [...listed, ...rest] }
      }),
      after: lane.unlock ? [fromChip(lane.unlock)] : [],
    }
  })

  // Rows of one step share its chip; how many there are decides whether the step's duration and output are the row's.
  const siblings = new Map<string, Spec[]>()
  const all = [...hosts.flatMap((h) => [...h.before, ...h.runs.flatMap((r) => r.specs), ...h.after]), ...s.release.map(fromChip)]
  for (const x of all) siblings.set(x.stepId, [...(siblings.get(x.stepId) ?? []), x])
  const count = (stepId: string) => siblings.get(stepId)?.length ?? 0
  const pendingSeen = new Set<string>()
  const failedSeen = new Set<string>()

  /**
   * The task's own result: by name, or else by its place in the step. Main redacts the name it sends, so a
   * deployment name that holds a secret value matches only by place; results arrive in task order.
   */
  const resultOf = (x: Spec, results: TaskResult[]): TaskResult | undefined => {
    if (!x.name) return undefined
    const named = results.filter((r) => r.task === x.name).at(-1)
    if (named) return named
    const mates = siblings.get(x.stepId) ?? []
    const at = results[mates.indexOf(x)]
    return at && !mates.some((m) => m.name === at.task) ? at : undefined
  }

  const row = (x: Spec): TaskRow => {
    const chip = chips.get(x.stepId)
    const results = s.tasks[x.stepId] ?? []
    const own = resultOf(x, results)
    const multi = count(x.stepId) > 1
    let state: TaskRow['state']
    let startedAt: number | null = null
    if (chip?.state === 'rolled_back') state = 'rolled_back'
    else if (own) state = chip?.state === 'warn' && (own.state === 'ok' || own.state === 'changed') ? 'warn' : own.state
    else {
      // The step's first task without a result is the one its chip speaks for; the ones after it wait.
      const first = !pendingSeen.has(x.stepId)
      pendingSeen.add(x.stepId)
      if (!chip) state = 'pending'
      else if (chip.state === 'running') {
        state = first ? 'running' : 'pending'
        if (first) startedAt = results.length ? Math.max(...results.map((r) => r.at)) : chip.startedAt
      } else if (multi && (chip.state === 'failed' || chip.state === 'cancelled')) {
        // only one task ended the step: the first without a result, unless a result already says which
        state = first && !results.some((r) => r.state === 'failed') ? chip.state : 'pending'
      } else state = chip.state
    }
    const failure = state === 'failed' && !failedSeen.has(x.stepId)
    if (state === 'failed') failedSeen.add(x.stepId)
    const settled = state !== 'pending' && state !== 'running'
    return {
      key: `${x.stepId}|${x.name}`,
      stepId: x.stepId,
      kind: x.kind,
      label: x.label,
      name: x.name,
      state,
      startedAt,
      durationMs: own ? own.durationMs : settled && !multi ? (chip?.durationMs ?? null) : null,
      attempts: own && own.attempts !== null && own.attempts > 1 ? own.attempts : null,
      rc: own?.rc ?? null,
      error: state === 'failed' || state === 'warn' ? (chip?.error ?? null) : null,
      failure,
      output: !multi
        ? { stepId: x.stepId }
        : !results.length && chip && chip.state !== 'pending' && chip.state !== 'running'
          ? { stepId: x.stepId, wholeStep: true }
          : { taskKey: `${x.stepId}|${own?.task ?? x.name}` },
    }
  }

  return {
    hosts: hosts.map((h) => ({
      hostId: h.hostId,
      hostLabel: h.hostLabel,
      before: h.before.map(row),
      runs: h.runs.map((r) => ({ runId: r.runId, title: r.title, detail: r.detail, rows: r.specs.map(row) })),
      after: h.after.map(row),
    })),
    release: s.release.map((c) => row(fromChip(c))),
  }
}

/** Every row in list order: per host its lock, deployments and unlock, then the release-wide steps. */
export function allRows({ hosts, release }: { hosts: HostRows[]; release: TaskRow[] }): TaskRow[] {
  return [...hosts.flatMap((h) => [...h.before, ...h.runs.flatMap((g) => g.rows), ...h.after]), ...release]
}

/** How far the release is: rows that finished (in any state) out of all of them, and the ones running now. */
export function taskProgress(rows: TaskRow[]): { done: number; total: number; current: TaskRow[] } {
  return {
    done: rows.filter((r) => r.state !== 'pending' && r.state !== 'running').length,
    total: rows.length,
    current: rows.filter((r) => r.state === 'running'),
  }
}
