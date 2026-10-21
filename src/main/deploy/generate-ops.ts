import { LOG_TAIL_DEFAULT, LOG_TAIL_MAX } from '../../shared/ops'
import { isReadOnlyRunbook, type BuiltinKind } from '../../shared/runbooks'
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

const MAX_PRUNE_HOURS = 168
type Item = PlanOperation['items'][number]

/** `op_<builtin>`: the log and tag kind of a built-in, within [a-z_]. */
const opKind = (b: BuiltinKind): string => `op_${b.replace(/-/g, '_')}`

const COMPOSE_SUB: Partial<Record<BuiltinKind, string>> = { restart: 'restart', stop: 'stop', start: 'start', status: 'ps', logs: 'logs' }

/** One streamed built-in command on the checkout (Ansible's become applies, as for build and up). */
function opTask(b: BuiltinKind, d: PlanDeployment, body: string): Task {
  const kind = opKind(b)
  return sh(nm(b, d), kind, d.runId, streamed(kind, body), { timeout: clampSec(d.composeTimeoutSec, 'compose timeout'), chdir: IN_REPO, become: becomes(d), guarded: true })
}

function builtinTasks(it: Extract<Item, { type: 'builtin' }>, d: PlanDeployment): Task[] {
  const b = it.builtin
  switch (b) {
    case 'restart':
    case 'stop':
    case 'start':
    case 'status':
      return [opTask(b, d, composeCommand(composeOf(d), [COMPOSE_SUB[b]!], d.services ?? []))]
    case 'logs': {
      const tail = it.tail ?? LOG_TAIL_DEFAULT
      need(Number.isInteger(tail) && tail >= 1 && tail <= LOG_TAIL_MAX, 'logs tail')
      return [opTask(b, d, composeCommand(composeOf(d), ['logs', '--tail', String(tail)], d.services ?? []))]
    }
    case 'prune-images': {
      const h = it.untilHours
      need(h === undefined || (Number.isInteger(h) && h >= 1 && h <= MAX_PRUNE_HOURS), 'prune hours')
      return [opTask(b, d, shJoin(['docker', 'image', 'prune', '-f', ...(h === undefined ? [] : ['--filter', `until=${h}h`])]))]
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
    for (const d of targets) {
      const items = op.items.flatMap((i) => (i.type === 'step' ? [stepTask(d, i.step, null)] : builtinTasks(i, d)))
      tasks.push(block(d, 'operation', items, rescueRelease(d), steps))
    }
    plays.push({ name: `operation ${sanitizeIdent(h.alias)}`, hosts: h.alias, gather_facts: false, strategy: 'linear', vars, tasks })
  }
  return JSON.stringify(plays, null, 2)
}
