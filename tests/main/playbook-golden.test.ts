import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatePlaybook } from '../../src/main/deploy/generate'
import type { DeployPlan } from '../../src/main/deploy/runner'
import { planFixture } from './deploy-helpers'

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

  for (const n of NAMES) {
    it(`${n} matches its fixture byte for byte`, () => {
      const file = join(DIR, `${n}.json`)
      expect(existsSync(file)).toBe(true)
      expect(generatePlaybook(goldenPlan(n))).toBe(readFileSync(file, 'utf8'))
    })
  }

  it('pre_hook sits at index 5 of dep1 block with timeout, become and chdir', () => {
    const plays = JSON.parse(generatePlaybook(goldenPlan('release-hooks'))) as Array<{ tasks: Array<Record<string, any>> }>
    const blk = plays[0].tasks.find((t) => t.name === 'deployment dep1')!
    const t = blk.block[5]
    expect(t.name).toBe('pre_hook dep1')
    expect(blk.block[4].name.startsWith('env ')).toBe(true)
    expect(t.timeout).toBe(600)
    expect(t.become).toBe(true)
    expect(t['ansible.builtin.shell'].chdir).toBe('{{ d.repo }}')
  })
})
