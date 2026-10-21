import { describe, expect, it } from 'vitest'
import { generatePlaybook } from '../../src/main/deploy/generate'
import { isHelperTask, playbookSteps, stepLabels } from '../../src/shared/playbook-steps'
import { planFixture } from './deploy-helpers'

describe('playbookSteps', () => {
  it('names each block by deployment, then its steps in playbook order, then rollback', () => {
    const plays = playbookSteps(generatePlaybook(planFixture()))
    expect(plays.map((p) => p.host)).toEqual(['od-1', 'od-2'])
    expect(plays[0].steps.map((s) => s.kind)).toEqual(['lock', 'lock'])
    expect(plays[0].deployments.map((d) => d.name)).toEqual(['dep1', 'dep2'])
    const [one, two] = plays[0].deployments
    expect(one.runId).toBe('0190a1b2-c3d4-7e5f-8a6b-000000000001')
    expect(one.steps.map((s) => s.kind)).toEqual(['record', 'backup', 'fetch', 'checkout', 'env', 'pre_hook', 'build', 'up', 'health', 'post_hook', 'tag'])
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

  it('text that is not a playbook gives no steps', () => {
    expect(playbookSteps('')).toEqual([])
    expect(playbookSteps('not json')).toEqual([])
    expect(playbookSteps('{"a":1}')).toEqual([])
    expect(playbookSteps('[{"hosts":"od-1","tasks":[null,{"block":"x"}]}]')).toEqual([{ host: 'od-1', steps: [], deployments: [] }])
  })
})
