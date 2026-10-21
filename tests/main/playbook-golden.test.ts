import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatePlaybook } from '../../src/main/deploy/generate'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { planFixture } from './deploy-helpers'
import { structureWithoutHooks } from './golden'

export type GoldenName = 'release-hooks' | 'release-plain' | 'rollback' | 'preflight' | 'version' | 'unlock' | 'release-services' | 'preflight-services'
const NAMES: GoldenName[] = ['release-hooks', 'release-plain', 'rollback', 'preflight', 'version', 'unlock', 'release-services', 'preflight-services']
const DIR = join(__dirname, 'fixtures/playbook-golden')

/** Selected compose services with a project name, commit bases and no previous commit (the alpha shape). */
function withServices(base: DeployPlan): DeployPlan {
  return {
    ...base,
    deployments: base.deployments.map((d, i) => ({
      ...d,
      preHookB64: null,
      postHookB64: null,
      previousCommit: null,
      composeProject: 'alpha-stack',
      services: i === 0 ? ['api', 'worker'] : ['web'],
      commitBases: i === 0 ? { shas: ['d'.repeat(40), 'e'.repeat(40)], tag: false } : { shas: ['f'.repeat(40)], tag: true },
    })),
  }
}

export function goldenPlan(name: GoldenName): DeployPlan {
  const base = planFixture()
  switch (name) {
    case 'release-hooks':
      return base
    case 'release-plain':
      return { ...base, deployments: base.deployments.map((d) => ({ ...d, preHookB64: null, postHookB64: null })) }
    case 'rollback':
      return { ...base, kind: 'rollback' }
    case 'preflight':
      return { ...base, kind: 'preflight' }
    case 'version':
      return { ...base, kind: 'version', version: 'v1.2.0' }
    case 'unlock':
      return { ...base, kind: 'unlock' }
    case 'release-services':
      return withServices(base)
    case 'preflight-services':
      return withServices({ ...base, kind: 'preflight' })
  }
}

describe('playbook golden fixtures (A4)', () => {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(DIR, { recursive: true })
    for (const n of NAMES) writeFileSync(join(DIR, `${n}.json`), generatePlaybook(goldenPlan(n)))
  }

  // Hooks became steps (Task 3): every fixture keeps its structure once hooks and steps are set aside (S2),
  // and a fixture without hooks, or a playbook that runs no hook, differs at most in the blanked hook vars.
  const SAME: GoldenName[] = ['release-plain', 'unlock', 'release-services', 'preflight-services']
  const blankHooks = (text: string): string => {
    const plays = JSON.parse(text) as Array<{ tasks: Array<Record<string, any>> }>
    for (const p of plays) for (const t of p.tasks) if (t.vars?.d) Object.assign(t.vars.d, { pre_hook: '', post_hook: '' })
    return JSON.stringify(plays, null, 2)
  }
  const fixture = (n: GoldenName): string => {
    const file = join(DIR, `${n}.json`)
    expect(existsSync(file)).toBe(true)
    return readFileSync(file, 'utf8')
  }

  for (const n of NAMES) {
    it(`${n} keeps its fixture's structure without hooks and steps`, () => {
      expect(structureWithoutHooks(generatePlaybook(goldenPlan(n)))).toEqual(structureWithoutHooks(fixture(n)))
    })
  }

  for (const n of SAME) {
    it(`${n} matches its fixture byte for byte`, () => {
      expect(generatePlaybook(goldenPlan(n))).toBe(fixture(n))
    })
  }

  for (const n of ['rollback', 'preflight', 'version'] as const) {
    it(`${n} matches its fixture with the hook vars blanked`, () => {
      expect(generatePlaybook(goldenPlan(n))).toBe(blankHooks(fixture(n)))
    })
  }

  it('release-hooks runs the pre-hook as c_0 where pre_hook was and the post-hook as c_1 after health', () => {
    const plays = JSON.parse(generatePlaybook(goldenPlan('release-hooks'))) as Array<{ tasks: Array<Record<string, any>> }>
    const old = JSON.parse(fixture('release-hooks')) as Array<{ tasks: Array<Record<string, any>> }>
    const blk = plays[0].tasks.find((t) => t.name === 'deployment dep1')!
    const was = old[0].tasks.find((t) => t.name === 'deployment dep1')!
    const names = (b: Record<string, any>) => (b.block as Array<{ name: string }>).map((t) => t.name)
    expect(names(blk)).toEqual(names(was).map((x) => x.replace(/^pre_hook /, 'c_0 ').replace(/^post_hook /, 'c_1 ')))
    const t = blk.block[5]
    expect(t.name).toBe('c_0 dep1')
    expect(blk.block[4].name.startsWith('env ')).toBe(true)
    expect(blk.block[6].name.startsWith('build ')).toBe(true)
    expect(t.timeout).toBe(600)
    expect(t.become).toBe(true)
    expect(t['ansible.builtin.shell'].chdir).toBe('{{ d.repo }}')
    const post = (blk.block as Array<Record<string, any>>).findIndex((x) => x.name === 'c_1 dep1')
    expect(blk.block[post - 1].name.startsWith('health ')).toBe(true)
    expect(blk.vars.d.pre_hook).toBe('')
    expect(blk.vars.d.post_hook).toBe('')
    expect(Object.keys(blk.vars.d.steps)).toEqual(['c_0', 'c_1'])
    expect(blk.vars.d.steps.c_0.script_b64).toBe(was.vars.d.pre_hook)
    expect(blk.vars.d.steps.c_1.script_b64).toBe(was.vars.d.post_hook)
  })
})
