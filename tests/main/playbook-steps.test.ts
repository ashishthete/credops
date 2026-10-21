import { describe, expect, it } from 'vitest'
import { generatePlaybook } from '../../src/main/deploy/generate'
import { isHelperTask, playbookSteps, stepLabels } from '../../src/shared/playbook-steps'
import { planFixture } from './deploy-helpers'

describe('playbookSteps', () => {
  it('names each block by deployment, then its steps in playbook order, then rollback', () => {
    const plays = playbookSteps(generatePlaybook(planFixture()))
    expect(plays.map((p) => p.hosts[0])).toEqual(['od-1', 'od-2'])
    expect(plays[0].steps.map((s) => s.kind)).toEqual(['lock', 'lock'])
    expect(plays[0].deployments.map((d) => d.name)).toEqual(['dep1', 'dep2'])
    const [one, two] = plays[0].deployments
    expect(one.runId).toBe('0190a1b2-c3d4-7e5f-8a6b-000000000001')
    expect(one.steps.map((s) => s.kind)).toEqual(['record', 'backup', 'fetch', 'checkout', 'env', 'c_0', 'build', 'up', 'health', 'c_1', 'tag'])
    expect(two.steps.map((s) => s.label)).toEqual(['Record', 'Fetch', 'Checkout', 'Build', 'Up', 'Health', 'Tag'])
    expect(one.steps[2]).toEqual({ kind: 'fetch', label: 'Fetch', name: 'fetch dep1', stepId: `${one.runId}:fetch` })
    expect(one.rollback).toBe(true)
    expect(plays[1].deployments.map((d) => d.name)).toEqual(['dep3'])
  })

  it('a step of several tasks numbers them, as the review and the release view both show', () => {
    const plan = planFixture()
    plan.deployments[0].urls = [{ url: 'http://127.0.0.1:8080/up', from: 'host' }, { url: 'http://127.0.0.1:8080/ready', from: 'host' }]
    const [play] = playbookSteps(generatePlaybook(plan))
    const steps = play.deployments[0].steps
    expect(stepLabels(steps).filter((l) => l.startsWith('Health'))).toEqual(['Health 1', 'Health 2'])
    expect(stepLabels(play.steps.filter((s) => !isHelperTask(s.name)))).toEqual(['Lock'])
  })

  it('a rollback playbook lists its rollback steps', () => {
    const [play] = playbookSteps(generatePlaybook(planFixture({ kind: 'rollback', hosts: planFixture().hosts.slice(1), deployments: planFixture().deployments.slice(2) })))
    expect(play.deployments[0].steps.map((s) => s.kind)).toEqual(['rb_checkout', 'rb_build', 'rb_up', 'rb_tag'])
    expect(play.deployments[0].rollback).toBe(false)
  })

  it('a play of several hosts is one play with all its hosts and a stage index', () => {
    const text = JSON.stringify([
      { hosts: ['od-1', 'od-2'], tasks: [{ name: 'lock od-1', tags: ['od_step=lock', 'od_run=host:h1'] }] },
      { hosts: 'od-3', tasks: [] },
    ])
    const plays = playbookSteps(text)
    expect(plays).toHaveLength(2)
    expect(plays[0]).toMatchObject({ hosts: ['od-1', 'od-2'], stage: 0 })
    expect(plays[0].hosts[0]).toBe('od-1')
    expect(plays[1]).toMatchObject({ hosts: ['od-3'], stage: 1 })
    expect(playbookSteps('[{"hosts":"od-1:od-2","tasks":[]}]')[0].hosts).toEqual(['od-1', 'od-2'])
  })

  it('launch and gate tasks are helpers, like the lock prep', () => {
    expect(isHelperTask('build launch dep1')).toBe(true)
    expect(isHelperTask('od gate 2')).toBe(true)
    expect(isHelperTask('lock prep od-1')).toBe(true)
    expect(isHelperTask('flow gate 2')).toBe(true)
    expect(isHelperTask('flow play 0 done')).toBe(true)
    expect(isHelperTask('build dep1')).toBe(false)
  })

  it('a custom step takes its own name when the caller has it', () => {
    const steps = [
      { kind: 'c_0', label: 'c_0', stepId: 'r:c_0' },
      { kind: 'build', label: 'Build', stepId: 'r:build' },
    ]
    expect(stepLabels(steps)).toEqual(['c_0', 'Build'])
    expect(stepLabels(steps, { c_0: 'Migrate db' })).toEqual(['Migrate db', 'Build'])
  })

  it('text that is not a playbook gives no steps', () => {
    expect(playbookSteps('')).toEqual([])
    expect(playbookSteps('not json')).toEqual([])
    expect(playbookSteps('{"a":1}')).toEqual([])
    expect(playbookSteps('[{"hosts":"od-1","tasks":[null,{"block":"x"}]}]')).toEqual([{ name: '', hosts: ['od-1'], stage: 0, steps: [], deployments: [] }])
  })
})
