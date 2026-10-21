import { describe, expect, it } from 'vitest'
import { VALIDATORS } from '../../src/main/ipc/validators'

const ID = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'

const body = (over: Record<string, unknown> = {}) => ({
  id: 'c_1',
  name: 'migrate',
  run: 'shell',
  service: null,
  script: 'echo hi',
  cwd: null,
  sudo: 'docker',
  timeoutSec: 600,
  onFailure: 'stop',
  when: { kind: 'always' },
  secrets: [],
  ...over,
})
const step = (over: Record<string, unknown> = {}) => body({ anchor: 'after_up', alsoOnRollback: false, ...over })

const update = (patch: unknown) => () => VALIDATORS['deploy:update']([ID, patch])
const settings = (patch: unknown) => () => VALIDATORS['deploy:updateSettings']([ID, patch])
const confirm = (c: unknown) => () => VALIDATORS['release:start']([ID, c])

describe('deployment steps', () => {
  it('accepts a list of steps', () => {
    expect(update({ steps: [step(), step({ id: 'c_2', when: { kind: 'paths', paths: ['src/**'] }, secrets: [{ envName: 'TOKEN', secretId: SID }] })] })).not.toThrow()
    expect(update({ steps: [] })).not.toThrow()
  })

  it.each([
    ['a non-list', 'x'],
    ['21 steps', Array.from({ length: 21 }, (_, i) => step({ id: `c_${i}` }))],
    ['an unknown anchor', [step({ anchor: 'during' })]],
    ['a timeout of 5', [step({ timeoutSec: 5 })]],
    ['a string timeout', [step({ timeoutSec: '60' })]],
    ['an unknown run', [step({ run: 'ssh' })]],
    ['a bad env name', [step({ secrets: [{ envName: 'token', secretId: SID }] })]],
    ['a non-uuid secret id', [step({ secrets: [{ envName: 'TOKEN', secretId: 'x' }] })]],
    ['a bad when kind', [step({ when: { kind: 'sometimes' } })]],
    ['a glob with a quote', [step({ when: { kind: 'paths', paths: ["a'b"] } })]],
    ['21 globs', [step({ when: { kind: 'paths', paths: Array.from({ length: 21 }, (_, i) => `p${i}`) } })]],
    ['a script over the cap', [step({ script: 'x'.repeat(16001) })]],
    ['an extra key', [step({ value: 'plain' })]],
    ['a missing anchor', [body()]],
  ])('rejects %s', (_what, steps) => {
    expect(update({ steps })).toThrow()
  })
})

describe('environment settings', () => {
  const flow = { onFailure: 'stop-all', stages: [{ kind: 'services', serviceIds: [SID] }, { kind: 'step', serviceId: SID, step: body() }] }

  it('accepts parallel prepare, the cap and a flow, and a null flow', () => {
    expect(settings({ parallelPrepare: false, prepareCap: 8, flow })).not.toThrow()
    expect(settings({ flow: null })).not.toThrow()
  })

  it.each([
    ['a string parallelPrepare', { parallelPrepare: 'yes' }],
    ['a cap of 0', { prepareCap: 0 }],
    ['a cap of 9', { prepareCap: 9 }],
    ['a fractional cap', { prepareCap: 2.5 }],
    ['a flow with a bad onFailure', { flow: { ...flow, onFailure: 'ignore' } }],
    ['a flow with a bad stage kind', { flow: { ...flow, stages: [{ kind: 'parallel' }] } }],
    ['a flow with 51 stages', { flow: { ...flow, stages: Array.from({ length: 51 }, () => ({ kind: 'services', serviceIds: [SID] })) } }],
    ['a flow step carrying an anchor key', { flow: { ...flow, stages: [{ kind: 'step', serviceId: SID, step: step() }] } }],
    ['a flow step with a bad service id', { flow: { ...flow, stages: [{ kind: 'step', serviceId: 'x', step: body() }] } }],
  ])('rejects %s', (_what, patch) => {
    expect(settings(patch)).toThrow()
  })
})

describe('release confirm and service patch', () => {
  it('accepts an edited playbook up to 256 KB and rejects more or a non-string', () => {
    expect(confirm({ editedPlaybook: '[]' })).not.toThrow()
    expect(confirm({ editedPlaybook: 'x'.repeat(256 * 1024) })).not.toThrow()
    expect(confirm({ editedPlaybook: 'x'.repeat(256 * 1024 + 1) })).toThrow()
    expect(confirm({ editedPlaybook: 5 })).toThrow()
  })

  it('accepts skipUnchanged as a boolean on create and update only', () => {
    const create = { kind: 'service', environmentId: ID, name: 'web', deploymentId: null }
    expect(() => VALIDATORS['service:create']([{ ...create, skipUnchanged: true }])).not.toThrow()
    expect(() => VALIDATORS['service:create']([{ ...create, skipUnchanged: 'yes' }])).toThrow()
    expect(() => VALIDATORS['service:update']([ID, { skipUnchanged: false }])).not.toThrow()
    expect(() => VALIDATORS['service:update']([ID, { skipUnchanged: 1 }])).toThrow()
  })
})
