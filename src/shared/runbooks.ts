// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import { DeployError } from './deploy-error'
import { LOG_TAIL_DEFAULT, LOG_TAIL_MAX, VARIABLE_NAME } from './ops'
import { MAX_STEPS_PER_CHECKOUT, validateStep, type StepBody } from './steps'

export type BuiltinKind = 'restart' | 'stop' | 'start' | 'logs' | 'status' | 'prune-images' | 'backup-db' | 'pull-only'
export const BUILTINS: readonly BuiltinKind[] = ['restart', 'stop', 'start', 'logs', 'status', 'prune-images', 'backup-db', 'pull-only']
/** A built-in's name in step rows and pickers. */
export const BUILTIN_LABEL: Record<BuiltinKind, string> = {
  restart: 'Restart',
  stop: 'Stop',
  start: 'Start',
  logs: 'Logs',
  status: 'Status',
  'prune-images': 'Prune images',
  'backup-db': 'Backup DB',
  'pull-only': 'Pull',
}
/** Built-ins whose step rows reuse a release step's key (backup, fetch, checkout): one of each per runbook. */
export const ONCE_BUILTINS: readonly BuiltinKind[] = ['backup-db', 'pull-only']

export type RunbookItem = { type: 'step'; step: StepBody } | { type: 'builtin'; builtin: BuiltinKind; tail?: number; untilHours?: number }

export interface RunbookParam {
  name: string
  label: string
  type: 'text' | 'choice'
  pattern: 'identifier' | 'number' | 'path' | 'free'
  choices: string[]
}

export interface Runbook {
  id: string
  environmentId: string
  name: string
  description: string
  targetServiceIds: string[]
  items: RunbookItem[]
  params: RunbookParam[]
  lock: boolean
  notify: boolean
  createdAt: string
  updatedAt: string
}
export type RunbookInput = Omit<Runbook, 'id' | 'createdAt' | 'updatedAt'>
/** `runbook:save`: an id updates that runbook, none creates one. */
export type RunbookSaveInput = RunbookInput & { id?: string }

/** `release:preflightOperation`: run a runbook on some of its target services with these param values. */
export interface OperationRequest {
  environmentId: string
  runbookId: string
  serviceIds: string[]
  params: Record<string, string>
}

export const MAX_PARAMS = 10
export const MAX_RUNBOOKS = 100
export const MAX_RUNBOOK_NAME = 64
export const MAX_RUNBOOK_DESCRIPTION = 500
const MAX_CHOICES = 50
const MAX_CHOICE = 100
export const MAX_UNTIL_HOURS = 168

export const PARAM_PATTERN: Record<RunbookParam['pattern'], RegExp> = {
  identifier: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  number: /^[0-9]{1,12}$/,
  path: /^[A-Za-z0-9._/-]{1,200}$/,
  free: /^[^\u0000-\u001f\u007f]{0,1000}$/,
}

/** What a run of a runbook records on its release. */
export interface OperationMeta {
  runbookId: string
  name: string
  params: Record<string, string>
  readOnly: boolean
  lock: boolean
  targetServiceIds: string[]
}

/** True only when every item is the `logs` or `status` built-in (and there is at least one). */
export function isReadOnlyRunbook(r: Pick<Runbook, 'items'>): boolean {
  return r.items.length > 0 && r.items.every((i) => i.type === 'builtin' && (i.builtin === 'logs' || i.builtin === 'status'))
}

function bad(what: string): never {
  throw new DeployError('VALIDATION', what)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const CONTROL = /[\u0000-\u001f\u007f]/

export interface RunbookValidationOptions {
  allowedSecretIds: ReadonlySet<string>
  serviceIds: readonly string[]
  serviceNames: readonly string[]
}

function validateParam(p: unknown): RunbookParam {
  if (!isObj(p)) return bad('param must be an object')
  if (typeof p.name !== 'string' || !VARIABLE_NAME.test(p.name)) bad('param name must be lower-case letters, digits and underscores')
  if (typeof p.label !== 'string' || p.label.trim() === '' || p.label.length > 64 || CONTROL.test(p.label)) bad('param label is not valid')
  if (p.type !== 'text' && p.type !== 'choice') bad('param type must be text or choice')
  const pattern = p.pattern ?? 'free'
  if (pattern !== 'identifier' && pattern !== 'number' && pattern !== 'path' && pattern !== 'free') bad('param pattern is not valid')
  const choices = p.choices ?? []
  if (!Array.isArray(choices) || choices.length > MAX_CHOICES) bad('param choices are not valid')
  for (const c of choices as unknown[]) if (typeof c !== 'string' || c === '' || c.length > MAX_CHOICE || CONTROL.test(c)) bad('param choice is not valid')
  if (p.type === 'choice' && (choices as unknown[]).length === 0) bad('a choice param needs at least one choice')
  return {
    name: p.name as string,
    label: (p.label as string).trim(),
    type: p.type as RunbookParam['type'],
    pattern: pattern as RunbookParam['pattern'],
    choices: p.type === 'choice' ? [...(choices as string[])] : [],
  }
}

function validateItem(it: unknown, o: RunbookValidationOptions): RunbookItem {
  if (!isObj(it)) return bad('item must be an object')
  if (it.type === 'step') {
    const step = validateStep(it.step, { allowedSecretIds: o.allowedSecretIds, serviceNames: o.serviceNames, body: true })
    if (step.when.kind !== 'always') bad('a runbook step always runs; when is not supported')
    return { type: 'step', step }
  }
  if (it.type !== 'builtin' || !BUILTINS.includes(it.builtin as BuiltinKind)) return bad('item must be a step or a built-in')
  const builtin = it.builtin as BuiltinKind
  const out: RunbookItem = { type: 'builtin', builtin }
  if (builtin === 'logs') {
    const tail = it.tail ?? LOG_TAIL_DEFAULT
    if (!Number.isInteger(tail) || (tail as number) < 1 || (tail as number) > LOG_TAIL_MAX) bad(`logs tail must be 1-${LOG_TAIL_MAX}`)
    out.tail = tail as number
  }
  if (builtin === 'prune-images' && it.untilHours !== undefined) {
    if (!Number.isInteger(it.untilHours) || (it.untilHours as number) < 1 || (it.untilHours as number) > MAX_UNTIL_HOURS) bad(`prune hours must be 1-${MAX_UNTIL_HOURS}`)
    out.untilHours = it.untilHours as number
  }
  return out
}

/** Messages name the rule, never a value. Locks are forced on unless the runbook only reads. */
export function validateRunbook(input: unknown, o: RunbookValidationOptions): RunbookInput {
  if (!isObj(input)) return bad('runbook must be an object')
  if (typeof input.environmentId !== 'string') bad('runbook environment is required')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '' || name.length > MAX_RUNBOOK_NAME || CONTROL.test(name)) bad(`runbook name is required (at most ${MAX_RUNBOOK_NAME} characters)`)
  const description = input.description ?? ''
  if (typeof description !== 'string' || description.length > MAX_RUNBOOK_DESCRIPTION) bad(`description must be at most ${MAX_RUNBOOK_DESCRIPTION} characters`)
  const targets = input.targetServiceIds
  if (!Array.isArray(targets) || targets.length === 0) return bad('pick at least one service')
  const known = new Set(o.serviceIds)
  for (const t of targets) if (typeof t !== 'string' || !known.has(t)) bad('a target service is not in this environment')
  const items = input.items
  if (!Array.isArray(items) || items.length === 0) return bad('a runbook needs at least one item')
  if (items.length > MAX_STEPS_PER_CHECKOUT) bad(`too many items (${MAX_STEPS_PER_CHECKOUT})`)
  const checked = items.map((i) => validateItem(i, o))
  for (const b of ONCE_BUILTINS) if (checked.filter((i) => i.type === 'builtin' && i.builtin === b).length > 1) bad(`${BUILTIN_LABEL[b]} can be in a runbook only once`)
  const stepIds = checked.flatMap((i) => (i.type === 'step' ? [i.step.id] : []))
  if (new Set(stepIds).size !== stepIds.length) bad('step ids must be unique')
  const rawParams = input.params ?? []
  if (!Array.isArray(rawParams) || rawParams.length > MAX_PARAMS) bad(`too many params (${MAX_PARAMS})`)
  const params = rawParams.map(validateParam)
  if (new Set(params.map((p) => p.name)).size !== params.length) bad('param names must be unique')
  if (input.notify !== undefined && typeof input.notify !== 'boolean') bad('notify must be true or false')
  const out = {
    environmentId: input.environmentId as string,
    name,
    description: description.trim(),
    targetServiceIds: [...new Set(targets as string[])],
    items: checked,
    params,
    lock: true,
    notify: input.notify === undefined ? false : input.notify,
  }
  return { ...out, lock: isReadOnlyRunbook(out) ? input.lock !== false : true }
}

/** One value per declared param, each matching its pattern (or its choices). Unknown or missing names are refused. */
export function validateParamValues(params: RunbookParam[], values: Record<string, string>): Record<string, string> {
  if (!isObj(values)) return bad('param values must be an object')
  const known = new Set(params.map((p) => p.name))
  for (const k of Object.keys(values)) if (!known.has(k)) bad('unknown param')
  const out: Record<string, string> = {}
  for (const p of params) {
    const v = Object.prototype.hasOwnProperty.call(values, p.name) ? values[p.name] : undefined
    if (typeof v !== 'string') return bad(`param ${p.name} is required`)
    if (p.type === 'choice') {
      if (!p.choices.includes(v)) bad(`param ${p.name} is not one of its choices`)
    } else if (!PARAM_PATTERN[p.pattern].test(v)) bad(`param ${p.name} has a value that does not match its pattern`)
    out[p.name] = v
  }
  return out
}

const shellItem = (id: string, name: string, script: string): RunbookItem => ({
  type: 'step',
  step: { id, name, run: 'shell', service: null, script, cwd: null, sudo: 'docker', timeoutSec: 600, onFailure: 'stop', when: { kind: 'always' }, secrets: [] },
})

/** environmentId is filled by the caller. */
export const RUNBOOK_TEMPLATES: { id: 'restart' | 'logs' | 'migrate' | 'prune' | 'backup'; name: string; build(serviceIds: string[]): RunbookInput }[] = [
  { id: 'restart', name: 'Restart services', build: (s) => tpl('Restart services', s, [{ type: 'builtin', builtin: 'restart' }]) },
  { id: 'logs', name: 'Show logs', build: (s) => tpl('Show logs', s, [{ type: 'builtin', builtin: 'logs', tail: LOG_TAIL_DEFAULT }]) },
  {
    id: 'migrate',
    name: 'Run migrations',
    build: (s) => tpl('Run migrations', s, [shellItem('migrate', 'migrate', 'echo "Replace this with your migration command"')]),
  },
  { id: 'prune', name: 'Prune images', build: (s) => tpl('Prune images', s, [{ type: 'builtin', builtin: 'prune-images' }]) },
  { id: 'backup', name: 'Back up databases', build: (s) => tpl('Back up databases', s, [{ type: 'builtin', builtin: 'backup-db' }]) },
]

function tpl(name: string, serviceIds: string[], items: RunbookItem[]): RunbookInput {
  const base = { environmentId: '', name, description: '', targetServiceIds: serviceIds, items, params: [], notify: false }
  return { ...base, lock: !isReadOnlyRunbook(base) }
}
