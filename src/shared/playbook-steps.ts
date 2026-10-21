// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import { STEP_LABEL, type StepKind } from './deploy'

/** One Ansible task as the review and the release view name it. */
export interface PlaybookStep {
  /** The task's `od_step` tag (fetch, build, up, ...); '' when it has none. */
  kind: string
  label: string
  /** The task's own name in the playbook, e.g. `fetch backend`. */
  name: string
  /** `<runId>:<kind>`, the id the run's step events carry; null for a task without an `od_run` tag. */
  stepId: string | null
}

export interface PlaybookDeployment {
  name: string
  runId: string | null
  steps: PlaybookStep[]
  /** A failed step stops this release, which then rolls back (when the environment's auto-rollback is on). */
  rollback: boolean
}

export interface PlaybookPlay {
  /** The play's host alias (`od-1`). */
  host: string
  /** Host-wide tasks before the deployments: the lock. */
  steps: PlaybookStep[]
  deployments: PlaybookDeployment[]
}

/** The lock's mkdir/touch helper: part of the lock step, not a step of its own (events and views skip it). */
export const isHelperTask = (name: string): boolean => name.startsWith('lock prep ')

/**
 * What the review and the release view call each task: its step's label, numbered when the step has several
 * tasks (`Health 1`, `Health 2`, one per URL). Helper tasks are left out before this.
 */
export function stepLabels(steps: Pick<PlaybookStep, 'stepId' | 'label'>[]): string[] {
  const total = new Map<string, number>()
  for (const s of steps) if (s.stepId) total.set(s.stepId, (total.get(s.stepId) ?? 0) + 1)
  const seen = new Map<string, number>()
  return steps.map((s) => {
    if (!s.stepId || (total.get(s.stepId) ?? 0) < 2) return s.label
    const n = (seen.get(s.stepId) ?? 0) + 1
    seen.set(s.stepId, n)
    return `${s.label} ${n}`
  })
}

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

function tag(t: Obj, key: string): string | null {
  const tags = Array.isArray(t.tags) ? t.tags : []
  for (const x of tags) if (typeof x === 'string' && x.startsWith(`${key}=`)) return x.slice(key.length + 1)
  return null
}

function stepOf(t: Obj): PlaybookStep {
  const kind = tag(t, 'od_step') ?? ''
  const run = tag(t, 'od_run')
  return {
    kind,
    label: STEP_LABEL[kind as StepKind] ?? kind,
    name: typeof t.name === 'string' ? t.name : '',
    stepId: run && kind ? `${run}:${kind}` : null,
  }
}

/**
 * The steps of a generated playbook, in the order Ansible runs them: per play (host), its lock, then one block
 * per deployment named by the deployment, then that block's tasks. Reads the text the generator wrote (JSON,
 * which is YAML); anything else gives no steps. The wizard's review and the release view both use this.
 */
export function playbookSteps(playbook: string): PlaybookPlay[] {
  let plays: unknown
  try {
    plays = JSON.parse(playbook)
  } catch {
    return []
  }
  if (!Array.isArray(plays)) return []
  return plays.filter(isObj).map((play) => {
    const out: PlaybookPlay = { host: typeof play.hosts === 'string' ? play.hosts : '', steps: [], deployments: [] }
    for (const t of Array.isArray(play.tasks) ? play.tasks : []) {
      if (!isObj(t)) continue
      if (!('block' in t)) {
        out.steps.push(stepOf(t))
        continue
      }
      if (!Array.isArray(t.block)) continue
      const d = isObj(t.vars) && isObj(t.vars.d) ? t.vars.d : {}
      const rescue = Array.isArray(t.rescue) ? t.rescue.filter(isObj) : []
      out.deployments.push({
        name: typeof d.name === 'string' ? d.name : typeof t.name === 'string' ? t.name.replace(/^deployment /, '') : '',
        runId: typeof d.run === 'string' ? d.run : null,
        steps: t.block.filter(isObj).map(stepOf),
        rollback: rescue.some((r) => isObj(r['ansible.builtin.set_fact']) && 'od_failed' in r['ansible.builtin.set_fact']),
      })
    }
    return out
  })
}
