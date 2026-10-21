import { LOG_TAIL_DEFAULT, LOG_TAIL_MAX } from '../../shared/ops'
import { STEP_LABEL, type StepKind } from '../../shared/deploy'
import { BUILTIN_LABEL, MAX_UNTIL_HOURS, ONCE_BUILTINS, isReadOnlyRunbook, type BuiltinKind } from '../../shared/runbooks'
import { MAX_STEPS_PER_CHECKOUT } from '../../shared/steps'
import { shJoin } from '../ops/quote'
import { composeCommand } from './compose'
import {
  IN_REPO,
  SECRETS_VAR,
  STEP_KEY,
  becomes,
  block,
  checkPlan,
  checkStep,
  clampSec,
  composeOf,
  nm,
  rescueRelease,
  sh,
  stepTask,
  streamed,
  taskBackup,
  taskCheckout,
  taskFetch,
  taskLock,
  taskPrep,
} from './generate'
import { hostBecome, hostOd } from './host-vars'
import { need, sanitizeIdent } from './quote'
import type { DeployPlan, PlanDeployment, PlanOperation, PlanStep } from './runner'

/*
 * Operation (runbook) playbooks: one play per host, and per targeted checkout one block that runs the runbook's
 * items in order. The tasks are the release's own (lock, backup, fetch, checkout, custom steps), plus the compose
 * built-ins here. Same injection rules as generate.ts: services and numbers are validated, then quoted; param values
 * and scripts travel as base64; nothing goes through `environment:`.
 */

type Task = Record<string, unknown>

type Item = PlanOperation['items'][number]

/** `op_<builtin>`: the log and tag kind of a built-in, within [a-z_]. */
const opKind = (b: BuiltinKind): string => `op_${b.replace(/-/g, '_')}`

/** Each item's step key: `op_<builtin>`, then `_2`, `_3` for repeats; a step keeps its PlanStep key. */
function itemKeys(items: Item[]): string[] {
  const seen = new Map<string, number>()
  return items.map((i) => {
    if (i.type === 'step') return i.step.key
    const base = opKind(i.builtin)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}_${n}`
  })
}

/**
 * The step rows one target runs, in order, under the keys its tasks are tagged with. backup-db and pull-only run the
 * release's own tasks, so their rows are the release's. prune-images runs on a host's first target only.
 */
export function operationSteps(items: Item[], firstOnHost: boolean): { key: string; kind: StepKind; label: string }[] {
  const keys = itemKeys(items)
  return items.flatMap((i, n): { key: string; kind: StepKind; label: string }[] => {
    if (i.type === 'step') return [{ key: i.step.key, kind: 'custom' as const, label: i.step.label }]
    switch (i.builtin) {
      case 'backup-db':
        return [{ key: 'backup', kind: 'backup' as const, label: STEP_LABEL.backup }]
      case 'pull-only':
        return [
          { key: 'fetch', kind: 'fetch' as const, label: STEP_LABEL.fetch },
          { key: 'checkout', kind: 'checkout' as const, label: STEP_LABEL.checkout },
        ]
      case 'prune-images':
        if (!firstOnHost) return []
      // falls through
      default:
        return [{ key: keys[n], kind: 'op' as const, label: BUILTIN_LABEL[i.builtin] }]
    }
  })
}

const COMPOSE_SUB: Partial<Record<BuiltinKind, string>> = { restart: 'restart', stop: 'stop', start: 'start', status: 'ps', logs: 'logs' }

/** One streamed built-in command on the checkout, tagged and streamed under its item's key (become applies, as for build and up). */
function opTask(b: BuiltinKind, key: string, d: PlanDeployment, body: string): Task {
  return sh(nm(b, d), key, d.runId, streamed(key, body), { timeout: clampSec(d.composeTimeoutSec, 'compose timeout'), chdir: IN_REPO, become: becomes(d), guarded: true })
}

function builtinTasks(it: Extract<Item, { type: 'builtin' }>, key: string, d: PlanDeployment, firstOnHost: boolean): Task[] {
  const b = it.builtin
  switch (b) {
    case 'restart':
    case 'stop':
    case 'start':
    case 'status':
      return [opTask(b, key, d, composeCommand(composeOf(d), [COMPOSE_SUB[b]!], d.services ?? []))]
    case 'logs': {
      const tail = it.tail ?? LOG_TAIL_DEFAULT
      need(Number.isInteger(tail) && tail >= 1 && tail <= LOG_TAIL_MAX, 'logs tail')
      return [opTask(b, key, d, composeCommand(composeOf(d), ['logs', '--tail', String(tail)], d.services ?? []))]
    }
    case 'prune-images': {
      const h = it.untilHours
      // Images are host-wide: once per host, not once per checkout.
      if (!firstOnHost) return []
      need(h === undefined || (Number.isInteger(h) && h >= 1 && h <= MAX_UNTIL_HOURS), 'prune hours')
      return [opTask(b, key, d, shJoin(['docker', 'image', 'prune', '-f', ...(h === undefined ? [] : ['--filter', `until=${h}h`])]))]
    }
    case 'backup-db':
      need(d.backup !== null, 'backup setting')
      return [taskBackup(d)]
    case 'pull-only':
      return [taskFetch(d), taskCheckout(d)]
    default:
      return need(false, 'built-in') as never
  }
}

function checkOperation(plan: DeployPlan): PlanOperation {
  const op = plan.operation
  if (plan.kind !== 'operation' || !op) return need(false, 'operation') as never
  need(op.items.length >= 1 && op.items.length <= MAX_STEPS_PER_CHECKOUT, 'operation items')
  for (const b of ONCE_BUILTINS) need(op.items.filter((i) => i.type === 'builtin' && i.builtin === b).length <= 1, 'operation items')
  need((plan.flow ?? null) === null && (plan.prepare ?? null) === null, 'operation')
  need(typeof op.lock === 'boolean' && (op.lock || isReadOnlyRunbook({ items: op.items.map((i) => (i.type === 'step' ? { type: 'step' as const, step: i.step.step } : i)) })), 'operation lock')
  const keys = new Set<string>()
  for (const i of op.items) {
    if (i.type !== 'step') continue
    const p = i.step
    need(STEP_KEY.test(p.key) && !keys.has(p.key), 'step key')
    keys.add(p.key)
    need(p.anchor === null, 'step anchor')
    need(p.step.when.kind === 'always', 'step when')
    checkStep(p)
  }
  need(op.targets.length >= 1, 'operation targets')
  const seen = new Set<string>()
  for (const t of op.targets) {
    need(!seen.has(t.runId) && plan.deployments.some((d) => d.runId === t.runId) && Array.isArray(t.services), 'operation target')
    seen.add(t.runId)
  }
  return op
}

const stepsOf = (op: PlanOperation): PlanStep[] => op.items.flatMap((i) => (i.type === 'step' ? [i.step] : []))

export function generateOperation(plan: DeployPlan): string {
  const op = checkOperation(plan)
  checkPlan(plan)
  const steps = stepsOf(op)
  const keys = itemKeys(op.items)
  const plays: Record<string, unknown>[] = []
  for (const h of plan.hosts) {
    const targets = op.targets.flatMap((t) => {
      const d = plan.deployments.find((x) => x.runId === t.runId)!
      // An empty service list acts on the whole checkout.
      return d.hostId === h.hostId ? [{ ...d, services: t.services.length > 0 ? t.services : null }] : []
    })
    if (targets.length === 0) continue
    const vars: Record<string, unknown> = { od: hostOd(plan, h, targets), s: SECRETS_VAR }
    const become = hostBecome(targets)
    if (become !== undefined) vars.ansible_become_password = become
    // The prep task makes the run directory the streams write to, so it stays when there is no lock.
    const tasks: Task[] = [taskPrep(h), ...(op.lock ? [taskLock(h)] : [])]
    for (const [n, d] of targets.entries()) {
      const items = op.items.flatMap((i, k) => (i.type === 'step' ? [stepTask(d, i.step, null)] : builtinTasks(i, keys[k], d, n === 0)))
      tasks.push(block(d, 'operation', items, rescueRelease(d), steps))
    }
    plays.push({ name: `operation ${sanitizeIdent(h.alias)}`, hosts: h.alias, gather_facts: false, strategy: 'linear', vars, tasks })
  }
  return JSON.stringify(plays, null, 2)
}
