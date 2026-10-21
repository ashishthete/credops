import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { generatePlaybook } from '../../src/main/deploy/generate'
import { generateOperation } from '../../src/main/deploy/generate-ops'
import type { DeployPlan, PlanOperation } from '../../src/main/deploy/runner'
import { LOG_TAIL_MAX } from '../../src/shared/ops'
import { MAX_UNTIL_HOURS, validateRunbook, type BuiltinKind } from '../../src/shared/runbooks'
import { FIX, depFixture, planFixture, shellWords, stepFixture } from './deploy-helpers'

type Task = Record<string, unknown> & { block?: Task[]; rescue?: Task[]; tags?: string[]; no_log?: boolean; name: string }
type Play = Record<string, unknown> & { hosts: string; tasks: Task[]; vars: Record<string, unknown> }

const flat = (tasks: Task[]): Task[] => tasks.flatMap((t) => (t.block ? flat(t.block) : [t]))
const every = (tasks: Task[]): Task[] => tasks.flatMap((t) => (t.block || t.rescue ? [...every(t.block ?? []), ...every(t.rescue ?? [])] : [t]))
const kindOf = (t: Task): string => (t.tags ?? []).find((x) => x.startsWith('od_step='))!.slice(8)
const cmdOf = (t: Task): string => ((t['ansible.builtin.shell'] as { cmd?: string } | undefined)?.cmd ?? '')

const OP_ID = FIX.releaseId
const RUN1 = '0190a1b2-c3d4-7e5f-8a6b-000000000001'
const RUN2 = '0190a1b2-c3d4-7e5f-8a6b-000000000002'

function opPlan(items: PlanOperation['items'], over: Partial<PlanOperation> = {}, plan: Partial<DeployPlan> = {}): DeployPlan {
  const base = planFixture()
  return {
    ...base,
    releaseId: OP_ID,
    kind: 'operation',
    version: null,
    deployments: base.deployments.slice(0, 2),
    operation: { runbookId: 'rb-1', name: 'my runbook', lock: true, items, targets: [{ runId: RUN1, services: ['web', 'db'] }, { runId: RUN2, services: [] }], ...over },
    ...plan,
  }
}
const parse = (plan: DeployPlan): Play[] => JSON.parse(generateOperation(plan)) as Play[]
const bi = (builtin: BuiltinKind, extra: Partial<{ tail: number; untilHours: number }> = {}): PlanOperation['items'][number] => ({ type: 'builtin', builtin, ...extra })

describe('operation playbook', () => {
  it('dispatches from generatePlaybook and gives one play per host', () => {
    const plan = opPlan([bi('status')])
    expect(generatePlaybook(plan)).toBe(generateOperation(plan))
    const p = parse(plan)
    expect(p.map((x) => x.hosts)).toEqual(['od-1'])
  })

  it.each([
    ['restart', 'op_restart', ['restart', 'web', 'db']],
    ['stop', 'op_stop', ['stop', 'web', 'db']],
    ['start', 'op_start', ['start', 'web', 'db']],
    ['status', 'op_status', ['ps', 'web', 'db']],
  ] as [BuiltinKind, string, string[]][])('%s runs compose with the target services', (b, kind, words) => {
    const t = flat(parse(opPlan([bi(b)]))[0].tasks).find((x) => kindOf(x) === kind && x.name.includes('dep1'))!
    const w = shellWords(cmdOf(t))
    const d = w.indexOf('docker')
    expect(w.slice(d, d + 3)).toEqual(['docker', 'compose', '-f'])
    const at = w.indexOf(words[0], d + 3)
    expect(w.slice(at, at + words.length)).toEqual(words)
    expect(cmdOf(t)).toContain(`P="{{ d.run }}:${kind}"`)
  })

  it('a target with no services acts on the whole checkout', () => {
    const t = flat(parse(opPlan([bi('restart')]))[0].tasks).find((x) => kindOf(x) === 'op_restart' && x.name.includes('dep2'))!
    const w = shellWords(cmdOf(t))
    const at = w.indexOf('restart')
    expect(at).toBeGreaterThan(0)
    expect(w[at + 1]).toBe(';')
  })

  it('logs takes --tail', () => {
    const t = flat(parse(opPlan([bi('logs', { tail: 300 })]))[0].tasks).find((x) => kindOf(x) === 'op_logs')!
    expect(shellWords(cmdOf(t))).toEqual(expect.arrayContaining(['logs', '--tail', '300']))
  })

  it('logs without a tail uses the default, and a tail over the maximum is refused', () => {
    expect(() => generateOperation(opPlan([bi('logs')]))).not.toThrow()
    expect(() => generateOperation(opPlan([bi('logs', { tail: LOG_TAIL_MAX })]))).not.toThrow()
    expect(() => generateOperation(opPlan([bi('logs', { tail: 6000 })]))).toThrow(/logs tail/)
    expect(() => generatePlaybook(opPlan([bi('logs', { tail: 6000 })]))).toThrow(/logs tail/)
    for (const tail of [0, -1, 1.5, Number.NaN]) expect(() => generateOperation(opPlan([bi('logs', { tail })]))).toThrow(/logs tail/)
  })

  it('prune-images runs docker image prune -f, with an until filter when asked', () => {
    const plain = flat(parse(opPlan([bi('prune-images')]))[0].tasks).find((x) => kindOf(x) === 'op_prune_images')!
    expect(shellWords(cmdOf(plain))).toEqual(expect.arrayContaining(['docker', 'image', 'prune', '-f']))
    expect(cmdOf(plain)).not.toContain('until')
    const timed = flat(parse(opPlan([bi('prune-images', { untilHours: 24 })]))[0].tasks).find((x) => kindOf(x) === 'op_prune_images')!
    expect(shellWords(cmdOf(timed))).toEqual(expect.arrayContaining(['--filter', 'until=24h']))
    for (const untilHours of [0, 1.5, 100000, Number.NaN]) expect(() => generateOperation(opPlan([bi('prune-images', { untilHours })]))).toThrow(/prune hours/)
  })

  it('backup-db and pull-only reuse the backup, fetch and checkout tasks', () => {
    const plan = opPlan([bi('backup-db'), bi('pull-only')], { targets: [{ runId: RUN1, services: [] }] })
    const kinds = flat(parse(plan)[0].tasks).map(kindOf)
    expect(kinds).toEqual(expect.arrayContaining(['backup', 'fetch', 'checkout']))
    const t = flat(parse(plan)[0].tasks).find((x) => kindOf(x) === 'backup')!
    expect(cmdOf(t)).toContain('pg_dump')
    expect(cmdOf(t)).toContain('P="{{ d.run }}:backup"')
  })

  it('backup-db needs a backup setting on the checkout', () => {
    const plan = opPlan([bi('backup-db')], { targets: [{ runId: RUN2, services: [] }] })
    expect(() => generateOperation(plan)).toThrow(/backup/)
  })

  it('runs items in order inside one block per target checkout, with the release rescue', () => {
    const p = parse(opPlan([bi('stop'), bi('start')]))[0]
    const blocks = p.tasks.filter((t) => t.block)
    expect(blocks.map((b) => b.name)).toEqual(['deployment dep1', 'deployment dep2'])
    expect(blocks[0].block!.map(kindOf)).toEqual(['op_stop', 'op_start'])
    expect(blocks[0].rescue!.length).toBe(2)
    expect(blocks[0].vars).toBeDefined()
  })

  it('only targeted checkouts get a block', () => {
    const p = parse(opPlan([bi('status')], { targets: [{ runId: RUN1, services: ['web'] }] }))[0]
    expect(p.tasks.filter((t) => t.block).map((b) => b.name)).toEqual(['deployment dep1'])
    expect(() => generateOperation(opPlan([bi('status')], { targets: [{ runId: '0190a1b2-c3d4-7e5f-8a6b-0000000000ff', services: [] }] }))).toThrow(/target/)
  })

  it('lock: true prepares and takes the lock; lock: false has no lock or unlock task', () => {
    const locked = parse(opPlan([bi('restart')]))[0]
    expect(locked.tasks.slice(0, 2).map((t) => t.name)).toEqual(['lock prep od-1', 'lock od-1'])
    const free = parse(opPlan([bi('status')], { lock: false }))[0]
    const names = every(free.tasks).map((t) => t.name)
    expect(names.filter((n) => /^(lock|unlock) od-/.test(n))).toEqual([])
    expect(names.some((n) => n.startsWith('unlock'))).toBe(false)
    // the run directory the streams write to still exists
    expect(names[0]).toBe('lock prep od-1')
  })

  it('lock tasks equal the release play\'s', () => {
    const op = parse(opPlan([bi('restart')]))[0]
    const rel = JSON.parse(generatePlaybook(planFixture({ deployments: planFixture().deployments.slice(0, 2) }))) as Play[]
    expect(op.tasks[0]).toEqual(rel[0].tasks[0])
    expect(op.tasks[1]).toEqual(rel[0].tasks[1])
  })

  it('a custom step runs as c_<n> and a param value reaches the host only as base64', () => {
    const value = '$(id)'
    const p = stepFixture(0, 'after_checkout', {}, { anchor: null, paramKeys: [{ envName: 'OD_PARAM_NAME', valueB64: Buffer.from(value).toString('base64') }] })
    const text = generateOperation(opPlan([{ type: 'step', step: p }, bi('status')]))
    expect(text).not.toContain(value)
    expect(text).toContain(Buffer.from(value).toString('base64'))
    const t = flat((JSON.parse(text) as Play[])[0].tasks).find((x) => kindOf(x) === 'c_0')!
    expect(t['ansible.builtin.shell']).toMatchObject({ stdin: 'OD_PARAM_NAME={{ d.steps.c_0.params[0] }}\n' })
    expect(cmdOf(t)).toContain('base64 -d')
  })

  it('a step with a bad key, an anchor or a when other than always is refused', () => {
    expect(() => generateOperation(opPlan([{ type: 'step', step: stepFixture(0, 'after_checkout') }]))).toThrow(/step anchor/)
    expect(() => generateOperation(opPlan([{ type: 'step', step: { ...stepFixture(0, 'after_checkout'), anchor: null, key: 'x; id' } }]))).toThrow(/step key/)
    const w = { ...stepFixture(0, 'after_checkout', { when: { kind: 'changed' } }), anchor: null }
    expect(() => generateOperation(opPlan([{ type: 'step', step: w }]))).toThrow(/when/)
    const dup = { ...stepFixture(0, 'after_checkout'), anchor: null }
    expect(() => generateOperation(opPlan([{ type: 'step', step: dup }, { type: 'step', step: dup }]))).toThrow(/step key/)
  })

  it('a step secret must be a plan secret reference', () => {
    const p = stepFixture(0, 'after_checkout', {}, { anchor: null, secretKeys: [{ envName: 'TOKEN', key: 'sec_x' }] })
    expect(() => generateOperation(opPlan([{ type: 'step', step: p }]))).toThrow(/secret reference/)
    const ok = opPlan([{ type: 'step', step: p }], {}, { secretRefs: { ...planFixture().secretRefs, sec_x: { secretId: 'sec-9' } } })
    const t = flat(parse(ok)[0].tasks).find((x) => kindOf(x) === 'c_0')!
    expect(t.no_log).toBe(true)
  })

  it('has no environment key anywhere', () => {
    const p = stepFixture(0, 'after_checkout', {}, { anchor: null, paramKeys: [{ envName: 'OD_PARAM_N', valueB64: 'eA==' }] })
    const text = generateOperation(opPlan([{ type: 'step', step: p }, bi('logs', { tail: 10 }), bi('restart'), bi('prune-images', { untilHours: 2 })]))
    expect(text).not.toMatch(/"environment"\s*:/)
  })

  it('every body parses with bash -n (parse only, nothing runs)', () => {
    const p = stepFixture(0, 'after_checkout', {}, { anchor: null, paramKeys: [{ envName: 'OD_PARAM_N', valueB64: 'eA==' }] })
    const items = [{ type: 'step' as const, step: p }, bi('restart'), bi('stop'), bi('start'), bi('status'), bi('logs', { tail: 50 }), bi('prune-images', { untilHours: 12 }), bi('backup-db'), bi('pull-only')]
    for (const play of parse(opPlan(items, { targets: [{ runId: RUN1, services: ['web'] }] })))
      for (const t of every(play.tasks)) {
        const cmd = cmdOf(t).replace(/\{\{[^}]*\}\}/g, 'x')
        if (!cmd) continue
        const r = spawnSync('/bin/bash', ['-n'], { input: cmd, encoding: 'utf8' })
        expect(r.stderr, cmd).toBe('')
        expect(r.status).toBe(0)
      }
  })

  it('a non-operation plan cannot carry an operation, and an operation plan needs one', () => {
    expect(() => generateOperation(planFixture())).toThrow(/operation/)
    const p = opPlan([bi('status')])
    expect(() => generatePlaybook({ ...p, kind: 'release' })).toThrow(/operation/)
    const rel = planFixture()
    expect(generatePlaybook({ ...rel, operation: null })).toBe(generatePlaybook(rel))
  })

  it('an operation plan cannot also carry a flow or a parallel prepare', () => {
    expect(() => generateOperation(opPlan([bi('status')], {}, { prepare: { cap: 2 } }))).toThrow(/operation/)
    expect(() => generateOperation(opPlan([bi('status')], {}, { flow: { stages: [], onFailure: 'stop-all' } }))).toThrow(/operation/)
  })

  it('prune-images runs once per host, on the first target', () => {
    const tasks = flat(parse(opPlan([bi('prune-images', { untilHours: 6 }), bi('status')]))[0].tasks)
    expect(tasks.filter((t) => kindOf(t) === 'op_prune_images').map((t) => t.name)).toEqual(['prune_images dep1'])
    expect(tasks.filter((t) => kindOf(t) === 'op_status').length).toBe(2)
  })

  it('a saved prune-images runbook keeps untilHours and generates the filter', () => {
    const o = { allowedSecretIds: new Set<string>(), serviceIds: ['s1'], serviceNames: ['web'] }
    const input = { environmentId: 'e', name: 'prune', targetServiceIds: ['s1'], items: [{ type: 'builtin', builtin: 'prune-images', untilHours: MAX_UNTIL_HOURS }] }
    const saved = validateRunbook(input, o)
    expect(saved.items).toEqual([{ type: 'builtin', builtin: 'prune-images', untilHours: MAX_UNTIL_HOURS }])
    expect(() => validateRunbook({ ...input, items: [{ type: 'builtin', builtin: 'prune-images', untilHours: MAX_UNTIL_HOURS + 1 }] }, o)).toThrow(/hours/)
    expect(() => validateRunbook({ ...input, items: [{ type: 'builtin', builtin: 'prune-images', untilHours: 0 }] }, o)).toThrow(/hours/)
    const text = generateOperation(opPlan(saved.items as PlanOperation['items']))
    expect(text).toContain(`until=${MAX_UNTIL_HOURS}h`)
  })
})
