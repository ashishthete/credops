import { describe, expect, it } from 'vitest'
import { COMPOSE_AUTO } from '../../src/shared/deploy'
import { checkAgainstScript, scriptPreset, type ScriptDeployment, type ScriptEnv } from '../../src/shared/script-parity'

const env = (over: Partial<ScriptEnv> = {}): ScriptEnv => ({
  name: 'alpha',
  versioned: false,
  protected: false,
  qa: { repo: 'acme/qa', workflow: 'playwright.yml', ref: 'main' },
  qaOnDeploy: true,
  qaWait: true,
  ...over,
})
const dep = (over: Partial<ScriptDeployment> & { id: string }): ScriptDeployment => ({
  name: over.id,
  composeFile: COMPOSE_AUTO,
  useSudo: 'yes',
  buildTimeoutSec: 3600,
  composeTimeoutSec: 900,
  ...over,
})
const level = (e: ScriptEnv, ds: ScriptDeployment[], id: string) => checkAgainstScript(e, ds).find((c) => c.id === id)?.level

describe('checkAgainstScript', () => {
  it('lists every check once, in a fixed order', () => {
    expect(checkAgainstScript(env(), [dep({ id: 'api' })]).map((c) => c.id)).toEqual([
      'timeouts',
      'sudo',
      'versioned',
      'compose',
      'qa-env-name',
      'qa-wait',
      'strict-build',
      'rollback',
    ])
  })

  it('timeouts: risk below 1800 s build or 600 s up; the fix raises only the short one', () => {
    expect(level(env(), [dep({ id: 'a', buildTimeoutSec: 1800, composeTimeoutSec: 600 })], 'timeouts')).toBe('ok')
    expect(level(env(), [dep({ id: 'a', buildTimeoutSec: 1799 })], 'timeouts')).toBe('risk')
    expect(level(env(), [dep({ id: 'a', composeTimeoutSec: 599 })], 'timeouts')).toBe('risk')
    const c = checkAgainstScript(env(), [dep({ id: 'a', buildTimeoutSec: 300, composeTimeoutSec: 120 }), dep({ id: 'b', composeTimeoutSec: 120 })])[0]
    expect(c.fix?.deployments).toEqual({ a: { buildTimeoutSec: 3600, composeTimeoutSec: 900 }, b: { composeTimeoutSec: 900 } })
    expect(c.opsdeck).toContain('a')
    expect(c.opsdeck).toContain('300 s')
  })

  it('sudo: differs unless every deployment is yes', () => {
    expect(level(env(), [dep({ id: 'a' })], 'sudo')).toBe('ok')
    for (const useSudo of ['auto', 'no'] as const) expect(level(env(), [dep({ id: 'a', useSudo })], 'sudo')).toBe('differs')
    const c = checkAgainstScript(env(), [dep({ id: 'a', useSudo: 'auto' }), dep({ id: 'b' })]).find((x) => x.id === 'sudo')!
    expect(c.fix?.deployments).toEqual({ a: { useSudo: 'yes' } })
  })

  it('versioned: risk outside prod; no fix on a protected or prod environment', () => {
    expect(level(env(), [], 'versioned')).toBe('ok')
    expect(level(env({ name: 'prod', versioned: true }), [], 'versioned')).toBe('ok')
    const alpha = checkAgainstScript(env({ versioned: true }), []).find((c) => c.id === 'versioned')!
    expect(alpha.level).toBe('risk')
    expect(alpha.fix?.env).toEqual({ versioned: false })
    const guarded = checkAgainstScript(env({ versioned: true, protected: true }), []).find((c) => c.id === 'versioned')!
    expect(guarded.level).toBe('risk')
    expect(guarded.fix).toBeUndefined()
  })

  it('compose: differs unless auto', () => {
    expect(level(env(), [dep({ id: 'a' })], 'compose')).toBe('ok')
    const c = checkAgainstScript(env(), [dep({ id: 'a', composeFile: 'docker-compose.yml' })]).find((x) => x.id === 'compose')!
    expect(c.level).toBe('differs')
    expect(c.fix?.deployments).toEqual({ a: { composeFile: COMPOSE_AUTO } })
  })

  const check = (e: ScriptEnv, id: string) => checkAgainstScript(e, []).find((x) => x.id === id)!

  it('qa-env-name: ok when the workflow is set and starts on deploy, with the environment name it gets', () => {
    const c = check(env(), 'qa-env-name')
    expect(c.level).toBe('ok')
    expect(c.opsdeck).toContain('"alpha"')
    expect(c.fix).toBeUndefined()
  })

  it('qa-env-name: differs with the Notifications link when no workflow is set', () => {
    const c = check(env({ qa: null }), 'qa-env-name')
    expect(c).toMatchObject({ level: 'differs', fix: { open: 'notifications' } })
    expect(c.opsdeck).toBe('No QA workflow is set for this environment.')
  })

  it('qa-env-name: differs with the link when the workflow is set but does not start on deploy', () => {
    const c = check(env({ qaOnDeploy: false }), 'qa-env-name')
    expect(c).toMatchObject({ level: 'differs', fix: { open: 'notifications' } })
    expect(c.opsdeck).not.toMatch(/^Starts/)
    expect(c.opsdeck).toContain('not started after a deploy')
  })

  it('qa-env-name on prod: ok when nothing is started, differs when a workflow starts on deploy', () => {
    for (const quiet of [env({ name: 'prod', qa: null }), env({ name: 'prod', qaOnDeploy: false })]) {
      const c = check(quiet, 'qa-env-name')
      expect(c.level).toBe('ok')
      expect(c.fix).toBeUndefined()
    }
    const c = check(env({ name: 'prod' }), 'qa-env-name')
    expect(c).toMatchObject({ level: 'differs', fix: { open: 'notifications' } })
    expect(c.script).toBe('The script never starts QA on prod.')
  })

  it('qa-wait: differs below 45 minutes; unset means 45', () => {
    expect(level(env(), [], 'qa-wait')).toBe('ok')
    expect(level(env({ qa: { repo: 'a/b', workflow: 'q.yml', ref: 'main', waitMinutes: 45 } }), [], 'qa-wait')).toBe('ok')
    const c = check(env({ qa: { repo: 'a/b', workflow: 'q.yml', ref: 'main', waitMinutes: 30 } }), 'qa-wait')
    expect(c.level).toBe('differs')
    expect(c.fix).toMatchObject({ open: 'notifications' })
    expect(c.fix?.env).toBeUndefined()
  })

  it('qa-wait: differs with the link when OpsDeck does not wait', () => {
    const c = check(env({ qaWait: false }), 'qa-wait')
    expect(c).toMatchObject({ level: 'differs', opsdeck: 'OpsDeck does not wait for the QA result.', fix: { open: 'notifications' } })
  })

  it('qa-wait: not applicable when QA is not started (no workflow or off on deploy) or on prod', () => {
    for (const e of [env({ qa: null }), env({ qaOnDeploy: false }), env({ name: 'prod', qaOnDeploy: false })]) {
      const c = check(e, 'qa-wait')
      expect(c).toMatchObject({ level: 'ok', opsdeck: 'Not applicable: QA is not started.' })
      expect(c.fix).toBeUndefined()
    }
    // Prod with QA on: the difference is reported once, on the QA workflow row.
    for (const e of [env({ name: 'prod' }), env({ name: 'prod', qaWait: false })]) {
      expect(check(e, 'qa-wait')).toMatchObject({ level: 'ok', opsdeck: 'Not applicable: the script never starts QA on prod.' })
    }
  })

  it('strict-build always differs with no fix; rollback is always ok', () => {
    const cs = checkAgainstScript(env(), [])
    expect(cs.find((c) => c.id === 'strict-build')).toMatchObject({ level: 'differs', opsdeck: 'OpsDeck stops and rolls back.' })
    expect(cs.find((c) => c.id === 'strict-build')!.fix).toBeUndefined()
    expect(cs.find((c) => c.id === 'rollback')).toMatchObject({ level: 'ok', opsdeck: 'OpsDeck also moves deploy tags back.' })
  })

  it('never says parity', () => {
    const all = checkAgainstScript(env({ versioned: true, qa: null }), [dep({ id: 'a', useSudo: 'auto', composeFile: 'x.yml', buildTimeoutSec: 10 })])
    expect(JSON.stringify(all)).not.toMatch(/parity/i)
  })
})

describe('scriptPreset', () => {
  it('merges every fix per deployment and for the environment', () => {
    const p = scriptPreset(env({ versioned: true }), [
      dep({ id: 'a', useSudo: 'auto', composeFile: 'docker-compose.yml', buildTimeoutSec: 300, composeTimeoutSec: 120 }),
      dep({ id: 'b' }),
    ])
    expect(p).toEqual({
      env: { versioned: false },
      deployments: { a: { buildTimeoutSec: 3600, composeTimeoutSec: 900, useSudo: 'yes', composeFile: COMPOSE_AUTO } },
    })
  })

  it('never sets versioned on a protected or prod environment', () => {
    expect(scriptPreset(env({ versioned: true, protected: true }), []).env).toEqual({})
    expect(scriptPreset(env({ name: 'prod', versioned: true }), []).env).toEqual({})
    expect(scriptPreset(env({ name: 'PROD', versioned: true }), []).env).toEqual({})
  })

  it('says prod versioning is on without claiming it matches the script', () => {
    expect(checkAgainstScript(env({ name: 'prod', versioned: true }), []).find((c) => c.id === 'versioned')!.opsdeck).toBe(
      'Versioned releases are on for prod; the script also tags prod only.',
    )
  })

  it('is a no-op on an already compatible environment', () => {
    expect(scriptPreset(env(), [dep({ id: 'a' }), dep({ id: 'b' })])).toEqual({ env: {}, deployments: {} })
  })
})
