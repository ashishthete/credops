// Imported by the renderer: keep runtime code to plain constants and pure functions (no node or electron imports).
import { DeployError } from './deploy-error'
import { REPO_PATH, SAFE_IDENT, STEP_TIMEOUT_RANGE, sanitizeIdent } from './deploy'

export type StepAnchor = 'before_fetch' | 'after_checkout' | 'before_build' | 'after_build' | 'after_up' | 'after_health' | 'after_tag'
/** In pipeline order. */
export const STEP_ANCHORS: readonly StepAnchor[] = ['before_fetch', 'after_checkout', 'before_build', 'after_build', 'after_up', 'after_health', 'after_tag']
/** The anchors that run before the containers change (prepare can run them in parallel across hosts). */
export const PREPARE_ANCHORS: readonly StepAnchor[] = STEP_ANCHORS.slice(0, 4)

export type StepSudo = 'docker' | 'yes' | 'no'
export type StepWhen = { kind: 'always' } | { kind: 'changed' } | { kind: 'paths'; paths: string[] }
export interface StepSecret {
  envName: string
  secretId: string
}
export interface StepBody {
  id: string
  name: string
  run: 'shell' | 'compose-exec'
  service: string | null
  script: string
  cwd: string | null
  sudo: StepSudo
  timeoutSec: number
  onFailure: 'stop' | 'continue'
  when: StepWhen
  secrets: StepSecret[]
}
export interface Step extends StepBody {
  anchor: StepAnchor
  alsoOnRollback: boolean
}

export const PRE_HOOK_STEP_ID = 'pre-hook'
export const POST_HOOK_STEP_ID = 'post-hook'

export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
// Case-sensitive: ENV_NAME is uppercase only. Names the shell, the loader or the generator's own environment read.
const DENIED_ENV = /^(?:LD_|DYLD_|BASH_|GIT_|DOCKER_|COMPOSE_|CREDOPS_|SUDO_|OD_)|^(?:PATH|IFS|ENV|PS4|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|HOME|CDPATH|GLOBIGNORE)$/
export function deniedEnvName(name: string): boolean {
  return DENIED_ENV.test(name)
}
export const WHEN_PATH = /^[A-Za-z0-9._/*-]{1,200}$/
export const MAX_STEPS_PER_CHECKOUT = 20
export const MAX_STEP_SCRIPT = 16000
/** Most stages in a release flow. */
export const MAX_FLOW_STAGES = 50
export const MAX_WHEN_PATHS = 20
const MAX_STEP_SECRETS = 10
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const COMPOSE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

/** The step's name as logs and the step list show it (sanitizeIdent). */
export const stepLabel = (s: StepBody): string => sanitizeIdent(s.name)

/** The saved steps, or the legacy hooks migrated to steps when there are none. */
export function effectiveSteps(d: { steps: Step[]; preHook: string | null; postHook: string | null }): Step[] {
  if (d.steps.length > 0) return d.steps
  const hook = (id: string, name: string, script: string, anchor: StepAnchor): Step => ({
    id,
    name,
    run: 'shell',
    service: null,
    script,
    cwd: null,
    sudo: 'docker',
    timeoutSec: 600,
    onFailure: 'stop',
    when: { kind: 'always' },
    secrets: [],
    anchor,
    alsoOnRollback: false,
  })
  const out: Step[] = []
  if (d.preHook !== null) out.push(hook(PRE_HOOK_STEP_ID, 'pre-hook', d.preHook, 'before_build'))
  if (d.postHook !== null) out.push(hook(POST_HOOK_STEP_ID, 'post-hook', d.postHook, 'after_health'))
  return out
}

function bad(what: string): never {
  throw new DeployError('VALIDATION', what)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface StepValidationOptions {
  allowedSecretIds: ReadonlySet<string>
  serviceNames: readonly string[]
  /** Validate a StepBody (no anchor, no rollback flag), as a runbook or flow step. */
  body?: boolean
}

/** Messages name the rule and the field, never a value: a script or a name is not echoed. */
export function validateStep(input: unknown, o: StepValidationOptions & { body: true }): StepBody
export function validateStep(input: unknown, o: StepValidationOptions): Step
export function validateStep(input: unknown, o: StepValidationOptions): Step | StepBody {
  if (!isObj(input)) return bad('step must be an object')
  const id = input.id
  if (typeof id !== 'string' || !STEP_ID.test(id)) bad('step id is not valid')
  const name = input.name
  if (typeof name !== 'string' || !SAFE_IDENT.test(name)) bad('step name must be letters, digits, dots, dashes, underscores or @ (at most 64)')
  const run = input.run ?? 'shell'
  if (run !== 'shell' && run !== 'compose-exec') bad('step run must be shell or compose-exec')
  let service: string | null = null
  if (run === 'compose-exec') {
    if (typeof input.service !== 'string' || !o.serviceNames.includes(input.service)) bad('a compose-exec step must name a service of this checkout')
    service = input.service as string
  }
  const script = input.script
  if (typeof script !== 'string' || script.trim() === '') bad('step script is required')
  if ((script as string).length > MAX_STEP_SCRIPT) bad(`step script is too long (${MAX_STEP_SCRIPT})`)
  if ((script as string).includes('\0')) bad('step script has a null character')
  const cwd = input.cwd ?? null
  if (cwd !== null && (typeof cwd !== 'string' || !REPO_PATH.test(cwd))) bad('step cwd must be an absolute path without spaces or shell characters')
  const sudo = input.sudo ?? 'docker'
  if (sudo !== 'docker' && sudo !== 'yes' && sudo !== 'no') bad('step sudo must be docker, yes or no')
  const timeoutSec = input.timeoutSec ?? 600
  if (!Number.isInteger(timeoutSec) || (timeoutSec as number) < STEP_TIMEOUT_RANGE[0] || (timeoutSec as number) > STEP_TIMEOUT_RANGE[1]) {
    bad(`step timeout must be ${STEP_TIMEOUT_RANGE[0]}-${STEP_TIMEOUT_RANGE[1]}`)
  }
  let onFailure = input.onFailure ?? 'stop'
  if (onFailure !== 'stop' && onFailure !== 'continue') bad('step on failure must be stop or continue')

  const w = input.when ?? { kind: 'always' }
  let when: StepWhen
  if (!isObj(w)) return bad('step when is not valid')
  if (w.kind === 'always' || w.kind === 'changed') when = { kind: w.kind }
  else if (w.kind === 'paths') {
    const paths = w.paths
    if (!Array.isArray(paths) || paths.length === 0) return bad('step when needs at least one path')
    if (paths.length > MAX_WHEN_PATHS) return bad(`step when has too many paths (${MAX_WHEN_PATHS})`)
    for (const p of paths) {
      if (typeof p !== 'string' || !WHEN_PATH.test(p) || p.split('/').includes('..') || p.startsWith('/')) bad('step when path is not valid')
    }
    when = { kind: 'paths', paths: [...(paths as string[])] }
  } else return bad('step when must be always, changed or paths')

  const rawSecrets = input.secrets ?? []
  if (!Array.isArray(rawSecrets)) return bad('step secrets must be a list')
  if (rawSecrets.length > MAX_STEP_SECRETS) bad(`step has too many secrets (${MAX_STEP_SECRETS})`)
  const seen = new Set<string>()
  const secrets = rawSecrets.map((s: unknown): StepSecret => {
    if (!isObj(s) || typeof s.envName !== 'string' || typeof s.secretId !== 'string') return bad('step secret is not valid')
    const envName = s.envName as string
    const secretId = s.secretId as string
    if (!ENV_NAME.test(envName) || deniedEnvName(envName)) bad('step secret env name is not allowed')
    if (seen.has(envName)) bad('step secret env names must be unique')
    seen.add(envName)
    if (!o.allowedSecretIds.has(secretId)) bad('step secret is not available to this checkout')
    return { envName, secretId }
  })

  const body: StepBody = {
    id: id as string,
    name: name as string,
    run: run as StepBody['run'],
    service,
    script: script as string,
    cwd: cwd as string | null,
    sudo: sudo as StepSudo,
    timeoutSec: timeoutSec as number,
    onFailure: onFailure as StepBody['onFailure'],
    when,
    secrets,
  }
  if (o.body) return body
  const anchor = input.anchor
  if (!STEP_ANCHORS.includes(anchor as StepAnchor)) bad('step anchor is not valid')
  const alsoOnRollback = input.alsoOnRollback ?? false
  if (typeof alsoOnRollback !== 'boolean') bad('step also-on-rollback must be true or false')
  // The tag is the last thing a release does: a failing step there cannot undo it.
  if (anchor === 'after_tag') onFailure = 'continue'
  // Before the fetch the new commit is not on the host, so `when` would compare the old commit with itself.
  if (anchor === 'before_fetch' && when.kind !== 'always') bad('a before_fetch step must always run (when needs the fetched commit)')
  return { ...body, onFailure: onFailure as StepBody['onFailure'], anchor: anchor as StepAnchor, alsoOnRollback: alsoOnRollback as boolean }
}
