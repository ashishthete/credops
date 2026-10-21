import { describe, expect, it } from 'vitest'
import { DeployError } from '../../src/shared/deploy-error'
import {
  PARAM_PATTERN,
  RUNBOOK_TEMPLATES,
  isReadOnlyRunbook,
  validateParamValues,
  validateRunbook,
  type RunbookInput,
  type RunbookParam,
  type RunbookItem,
} from '../../src/shared/runbooks'
import {
  POST_HOOK_STEP_ID,
  PRE_HOOK_STEP_ID,
  STEP_ANCHORS,
  PREPARE_ANCHORS,
  deniedEnvName,
  effectiveSteps,
  stepLabel,
  validateStep,
  type Step,
} from '../../src/shared/steps'

const SECRET = '11111111-1111-4111-8111-111111111111'
const opts = { allowedSecretIds: new Set([SECRET]), serviceNames: ['web', 'api'] }

const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c_1',
  name: 'migrate',
  run: 'shell',
  script: 'echo hi',
  anchor: 'after_up',
  ...over,
})

function refusal(fn: () => unknown): DeployError {
  try {
    fn()
  } catch (e) {
    return e as DeployError
  }
  throw new Error('expected a throw')
}

describe('effectiveSteps', () => {
  it('migrates the hooks to steps with the fixed fields', () => {
    const out = effectiveSteps({ steps: [], preHook: 'echo pre', postHook: 'echo post' })
    const base = { run: 'shell', service: null, cwd: null, sudo: 'docker', timeoutSec: 600, onFailure: 'stop', when: { kind: 'always' }, secrets: [], alsoOnRollback: false }
    expect(out).toEqual([
      { ...base, id: PRE_HOOK_STEP_ID, name: 'pre-hook', script: 'echo pre', anchor: 'before_build' },
      { ...base, id: POST_HOOK_STEP_ID, name: 'post-hook', script: 'echo post', anchor: 'after_health' },
    ])
    expect(effectiveSteps({ steps: [], preHook: null, postHook: 'echo post' }).map((s) => s.id)).toEqual(['post-hook'])
    expect(effectiveSteps({ steps: [], preHook: null, postHook: null })).toEqual([])
  })

  it('returns saved steps untouched, ignoring the hooks', () => {
    const saved = [validateStep(step(), opts)]
    expect(effectiveSteps({ steps: saved, preHook: 'x', postHook: 'y' })).toBe(saved)
  })

  it('has the anchors in pipeline order with four prepare anchors', () => {
    expect(STEP_ANCHORS[0]).toBe('before_fetch')
    expect(STEP_ANCHORS.at(-1)).toBe('after_tag')
    expect(PREPARE_ANCHORS).toEqual(STEP_ANCHORS.slice(0, 4))
  })
})

describe('validateStep', () => {
  it('accepts a full step and fills defaults', () => {
    const s = validateStep(step({ secrets: [{ envName: 'API_TOKEN', secretId: SECRET }], when: { kind: 'paths', paths: ['src/**', 'a.txt'] }, cwd: '/srv/app' }), opts)
    expect(s).toMatchObject({ sudo: 'docker', timeoutSec: 600, onFailure: 'stop', alsoOnRollback: false, cwd: '/srv/app', service: null })
    expect(stepLabel(s)).toBe('migrate')
  })

  it.each([
    ['a name with a brace', { name: 'a{b}' }],
    ['a name with a space', { name: 'a b' }],
    ['BASH_ENV', { secrets: [{ envName: 'BASH_ENV', secretId: SECRET }] }],
    ['OD_X', { secrets: [{ envName: 'OD_X', secretId: SECRET }] }],
    ['a lower-case env name', { secrets: [{ envName: 'token', secretId: SECRET }] }],
    ['a path with ..', { when: { kind: 'paths', paths: ['../x'] } }],
    ['an absolute glob', { when: { kind: 'paths', paths: ['/etc/*'] } }],
    ['a glob with a quote', { when: { kind: 'paths', paths: ["a'b"] } }],
    ['the 21st glob', { when: { kind: 'paths', paths: Array.from({ length: 21 }, (_, i) => `p${i}`) } }],
    ['a timeout of 5', { timeoutSec: 5 }],
    ['an unknown secret id', { secrets: [{ envName: 'TOKEN', secretId: '22222222-2222-4222-8222-222222222222' }] }],
    ['a relative cwd', { cwd: 'srv/app' }],
    ['a compose-exec step on an unknown service', { run: 'compose-exec', service: 'nope' }],
    ['a compose-exec step with no service', { run: 'compose-exec' }],
    ['an empty script', { script: '  ' }],
    ['an unknown anchor', { anchor: 'during_build' }],
  ])('rejects %s without echoing the script', (_what, over) => {
    const e = refusal(() => validateStep(step({ script: 'TOPSECRETSCRIPT', ...over }), opts))
    expect(e).toBeInstanceOf(DeployError)
    expect(e.code).toBe('VALIDATION')
    expect(e.message).not.toContain('TOPSECRETSCRIPT')
  })

  it('rejects a script over the limit', () => {
    expect(refusal(() => validateStep(step({ script: 'x'.repeat(16001) }), opts)).message).toMatch(/too long/)
  })

  it('accepts a compose-exec step on a known service', () => {
    expect(validateStep(step({ run: 'compose-exec', service: 'web' }), opts)).toMatchObject({ run: 'compose-exec', service: 'web' })
  })

  it('rejects when other than always at before_fetch, and accepts it at after_checkout', () => {
    for (const when of [{ kind: 'changed' }, { kind: 'paths', paths: ['src/*'] }]) {
      expect(() => validateStep(step({ anchor: 'before_fetch', when }), opts)).toThrow(/before_fetch/)
      expect(validateStep(step({ anchor: 'after_checkout', when }), opts).when).toEqual(when)
    }
    expect(validateStep(step({ anchor: 'before_fetch' }), opts).anchor).toBe('before_fetch')
  })

  it('forces an after_tag stop step to continue', () => {
    expect(validateStep(step({ anchor: 'after_tag', onFailure: 'stop' }), opts).onFailure).toBe('continue')
    expect(validateStep(step({ anchor: 'after_up', onFailure: 'stop' }), opts).onFailure).toBe('stop')
  })

  it('returns a body without anchor fields when asked', () => {
    const b = validateStep(step(), { ...opts, body: true })
    expect(b).not.toHaveProperty('anchor')
    expect(b).not.toHaveProperty('alsoOnRollback')
  })

  it('denies the listed env names', () => {
    for (const n of ['LD_PRELOAD', 'BASH_ENV', 'PATH', 'IFS', 'ENV', 'PS4', 'SHELLOPTS', 'GIT_DIR', 'DOCKER_HOST', 'COMPOSE_FILE', 'OPSDECK_X', 'SUDO_ASKPASS', 'OD_X', 'BASHOPTS', 'PROMPT_COMMAND', 'HOME', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']) {
      expect(deniedEnvName(n), n).toBe(true)
    }
    for (const n of ['API_TOKEN', 'PATHS', 'ENVIRONMENT', 'MY_LD_X', 'HOMEPAGE', 'MY_DYLD']) expect(deniedEnvName(n), n).toBe(false)
    // the reserved names are rejected by validateStep, which the store and IPC paths use
    for (const n of ['HOME', 'PROMPT_COMMAND', 'BASHOPTS', 'DYLD_X']) expect(() => validateStep(step({ secrets: [{ envName: n, secretId: SECRET }] }), opts), n).toThrow()
  })

  it('sanitizes the label', () => {
    expect(stepLabel({ name: 'a b{c}' } as Step)).toBe('a_b_c_')
  })
})

describe('runbooks', () => {
  const ro = (items: RunbookItem[]) => ({ items })
  const shell: RunbookItem = { type: 'step', step: validateStep(step(), { ...opts, body: true }) }
  const ro_ctx = { allowedSecretIds: new Set<string>(), serviceIds: ['s1', 's2'], serviceNames: ['web'] }
  const input = (over: Record<string, unknown> = {}) => ({
    environmentId: 'e1',
    name: 'Restart web',
    description: '',
    targetServiceIds: ['s1'],
    items: [{ type: 'builtin', builtin: 'restart' }],
    params: [],
    lock: false,
    notify: false,
    ...over,
  })

  it('isReadOnlyRunbook is true only for logs and status', () => {
    expect(isReadOnlyRunbook(ro([{ type: 'builtin', builtin: 'logs' }, { type: 'builtin', builtin: 'status' }]))).toBe(true)
    expect(isReadOnlyRunbook(ro([{ type: 'builtin', builtin: 'logs' }, shell]))).toBe(false)
    expect(isReadOnlyRunbook(ro([{ type: 'builtin', builtin: 'restart' }]))).toBe(false)
    expect(isReadOnlyRunbook(ro([]))).toBe(false)
  })

  it('forces the lock unless the runbook only reads', () => {
    expect(validateRunbook(input({ lock: false }), ro_ctx).lock).toBe(true)
    expect(validateRunbook(input({ items: [{ type: 'builtin', builtin: 'status' }], lock: false }), ro_ctx).lock).toBe(false)
    expect(validateRunbook(input({ items: [{ type: 'builtin', builtin: 'status' }], lock: true }), ro_ctx).lock).toBe(true)
  })

  it('bounds the log tail and requires always for steps', () => {
    expect(() => validateRunbook(input({ items: [{ type: 'builtin', builtin: 'logs', tail: 5001 }] }), ro_ctx)).toThrow(/tail/)
    expect(validateRunbook(input({ items: [{ type: 'builtin', builtin: 'logs', tail: 5000 }] }), ro_ctx).items[0]).toMatchObject({ tail: 5000 })
    const changed = { type: 'step', step: { ...(shell as { step: object }).step, when: { kind: 'changed' } } }
    expect(() => validateRunbook(input({ items: [changed] }), ro_ctx)).toThrow(/when/)
  })

  it('refuses targets outside the environment and too many params', () => {
    expect(() => validateRunbook(input({ targetServiceIds: ['other'] }), ro_ctx)).toThrow(/not in this environment/)
    const params = Array.from({ length: 11 }, (_, i) => ({ name: `p${i}`, label: 'P', type: 'text', pattern: 'free', choices: [] }))
    expect(() => validateRunbook(input({ params }), ro_ctx)).toThrow(/too many params/)
  })

  it('validates param values by pattern and choice', () => {
    const params: RunbookParam[] = [
      { name: 'count', label: 'Count', type: 'text', pattern: 'number', choices: [] },
      { name: 'mode', label: 'Mode', type: 'choice', pattern: 'free', choices: ['fast', 'slow'] },
    ]
    expect(validateParamValues(params, { count: '12', mode: 'fast' })).toEqual({ count: '12', mode: 'fast' })
    expect(() => validateParamValues(params, { count: '1;rm', mode: 'fast' })).toThrow(/pattern/)
    expect(() => validateParamValues(params, { count: '1', mode: 'other' })).toThrow(/choices/)
    expect(() => validateParamValues(params, { count: '1' })).toThrow(/required/)
    expect(() => validateParamValues(params, { count: '1', mode: 'fast', extra: 'x' })).toThrow(/unknown/)
    expect(PARAM_PATTERN.identifier.test('a b')).toBe(false)
    expect(PARAM_PATTERN.path.test('/srv/../x')).toBe(true)
  })

  it('every template validates', () => {
    const ctx = { allowedSecretIds: new Set<string>(), serviceIds: ['s1'], serviceNames: [] }
    for (const t of RUNBOOK_TEMPLATES) {
      const built: RunbookInput = { ...t.build(['s1']), environmentId: 'e1' }
      expect(() => validateRunbook(built, ctx), t.id).not.toThrow()
    }
    expect(RUNBOOK_TEMPLATES.map((t) => t.id)).toEqual(['restart', 'logs', 'migrate', 'prune', 'backup'])
  })
})
