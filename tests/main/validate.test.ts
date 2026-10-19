import { describe, expect, it } from 'vitest'
import { args, InvalidArgs, v } from '../../src/main/ipc/validate'
import { asFilter, VALIDATORS } from '../../src/main/ipc/validators'
import { DEFAULT_VAULT_ID, MAX_MASTER_PASSWORD } from '../../src/shared/vault'
import { MAX_VARIABLE_VALUE, MAX_VARIABLES, VARIABLE_NAME } from '../../src/shared/ops'

const ID = '11111111-2222-4333-8444-555555555555'
const ID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'

/** Runs `fn`, expects InvalidArgs, and returns its message. */
function failure(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidArgs)
    return (err as Error).message
  }
  throw new Error('expected InvalidArgs')
}

describe('validate', () => {
  it('checks shapes without echoing values', () => {
    const check = v.object({ name: v.str({ min: 1, max: 3 }) })
    let err: unknown
    try {
      check({ name: 'hunter22' }, '[0]')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(InvalidArgs)
    expect((err as Error).message).toMatch(/\[0\]\.name/)
    expect((err as Error).message).not.toContain('hunter22')
    expect(() => check({ name: 'ab', extra: 1 }, '[0]')).toThrow(InvalidArgs)
    expect(() => check({}, '[0]')).toThrow(/\[0\]\.name is required/)
    expect(() => v.uuid()('x', '[0]')).toThrow(InvalidArgs)
    expect(() => v.object({ a: v.str() })({ ['x'.repeat(3) + 'hunter22']: 1 }, '[0]')).toThrow(InvalidArgs)
  })

  it('nullable', () => {
    const check = v.object({ p: v.optional(v.nullable(v.int())) })
    expect(check({ p: null }, '[0]')).toEqual({ p: null })
    expect(check({}, '[0]')).toEqual({})
    expect(check({ p: 2 }, '[0]')).toEqual({ p: 2 })
    expect(() => check({ p: 'x' }, '[0]')).toThrow(InvalidArgs)
  })

  it('truncates extra args', () => {
    expect(args(v.int())([1, 'extra'])).toEqual([1])
  })

  it('asFilter', () => {
    expect(asFilter({ actions: ['app.start'], limit: 5 }, '[0]')).toEqual({ actions: ['app.start'], limit: 5 })
    expect(() => asFilter({ actions: ['nope'] }, '[0]')).toThrow(InvalidArgs)
    expect(() => asFilter({ limit: 0 }, '[0]')).toThrow(InvalidArgs)
    expect(() => asFilter({ limit: 1.5 }, '[0]')).toThrow(InvalidArgs)
  })

  it('asFilter accepts every field the audit page sends', () => {
    const full = {
      actions: ['audit.export'],
      outcome: 'failure',
      actor: 'tester',
      targetType: 'vault',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T23:59:59.999Z',
      text: 'abc',
      limit: 200,
      beforeId: 10,
    }
    expect(asFilter(full, '[0]')).toEqual(full)
    expect(asFilter({}, '[0]')).toEqual({})
  })

  it('vault channels', () => {
    const V = VALIDATORS
    expect(V['vault:unlock'](['pw'])).toEqual(['pw'])
    expect(() => V['vault:unlock']([''])).toThrow(InvalidArgs)
    expect(() => V['vault:setup'](['x'.repeat(MAX_MASTER_PASSWORD + 1)])).toThrow(/at most 1024/)
    expect(() => V['vault:changePassword'](['a'])).toThrow(/\[1\] must be a string/)
    expect(V['vault:create']([{ name: '  Prod ', color: '#A0b1C2' }])).toEqual([{ name: 'Prod', color: '#A0b1C2' }])
    expect(() => V['vault:create']([{ name: 'Prod', color: 'red' }])).toThrow(/color has an invalid format/)
    expect(() => V['vault:create']([{ name: ' ', color: '#000000' }])).toThrow(/name must be at least 1/)
    expect(() => V['vault:create']([{ name: 'x'.repeat(65), color: '#000000' }])).toThrow(InvalidArgs)
    expect(V['vault:update']([DEFAULT_VAULT_ID, { name: 'New' }])).toEqual([DEFAULT_VAULT_ID, { name: 'New' }])
    expect(() => V['vault:update']([DEFAULT_VAULT_ID, { wrapped_key: 'x' }])).toThrow(/not an allowed key/)
    expect(() => V['vault:delete'](['../etc'])).toThrow(/must be a uuid/)
    expect(V['vault:lock'](['extra'])).toEqual([])
    expect(V['vault:unlockQuick']([])).toEqual([])
    expect(V['vault:setQuickUnlock'](['touchId'])).toEqual(['touchId'])
    expect(() => V['vault:setQuickUnlock'](['face'])).toThrow(/not an allowed value/)
    expect(V['vault:setAutoLock']([null])).toEqual([null])
    expect(V['vault:setAutoLock']([60])).toEqual([60])
    expect(() => V['vault:setAutoLock']([7])).toThrow(/not an allowed value/)
    expect(() => V['vault:setAutoLock'](['5'])).toThrow(/not an allowed value/)
  })

  it('record builds a null-prototype copy and checks keys without echoing them', () => {
    const check = v.record(VARIABLE_NAME, v.str({ max: 3 }), { maxKeys: 2 })
    const out = check({ a: 'x', b_2: 'yz' }, '[0]')
    expect(out).toEqual({ a: 'x', b_2: 'yz' })
    expect(Object.getPrototypeOf(out)).toBeNull()
    const input = { a: 'x' }
    expect(check(input, '[0]')).not.toBe(input)
    expect(failure(() => check(JSON.parse('{"__proto__":"x"}'), '[0]'))).toBe('invalid arguments: [0] has an invalid key')
    expect(failure(() => check({ constructor: 'x' }, '[0]'))).toBe('invalid arguments: [0] has an invalid key')
    expect(failure(() => check({ 'Hunter22': 'x' }, '[0]'))).not.toContain('Hunter22')
    expect(failure(() => check({ a: 'x', b: 'y', c: 'z' }, '[0]'))).toBe('invalid arguments: [0] must have at most 2 keys')
    expect(failure(() => check({ a: 'hunter22' }, '[0]'))).toBe('invalid arguments: [0].a must be at most 3 chars')
    expect(failure(() => check({ a: 1 }, '[0]'))).toBe('invalid arguments: [0].a must be a string')
    expect(failure(() => check(['x'], '[0]'))).toBe('invalid arguments: [0] must be an object')
    expect(failure(() => check(null, '[0]'))).toBe('invalid arguments: [0] must be an object')
  })

  it('tagged picks the shape by its tag', () => {
    const check = v.tagged('kind', {
      a: v.object({ kind: v.oneOf(['a'] as const), n: v.int() }),
      b: v.object({ kind: v.oneOf(['b'] as const), s: v.str() }),
    })
    expect(check({ kind: 'a', n: 1 }, '[0]')).toEqual({ kind: 'a', n: 1 })
    expect(check({ kind: 'b', s: 'x' }, '[0]')).toEqual({ kind: 'b', s: 'x' })
    expect(failure(() => check({ kind: 'a', s: 'x' }, '[0]'))).toBe('invalid arguments: [0].s is not an allowed key')
    expect(failure(() => check({ kind: 'toString' }, '[0]'))).toBe('invalid arguments: [0].kind is not an allowed value')
    expect(failure(() => check({ kind: 'hunter22' }, '[0]'))).not.toContain('hunter22')
    expect(failure(() => check({}, '[0]'))).toBe('invalid arguments: [0].kind is not an allowed value')
    expect(failure(() => check('a', '[0]'))).toBe('invalid arguments: [0] must be an object')
  })

  it('ops validators reject out-of-range concurrency, unknown target kinds and bad container refs', () => {
    const V = VALIDATORS
    const run = (over: Record<string, unknown>) =>
      V['runs:start']([{ target: { kind: 'hosts', hostIds: [ID] }, command: { kind: 'text', text: 'uptime' }, ...over }])
    expect(failure(() => run({ concurrency: 0 }))).toBe('invalid arguments: [0].concurrency must be at least 1')
    expect(failure(() => run({ concurrency: 17 }))).toBe('invalid arguments: [0].concurrency must be at most 16')
    expect(failure(() => run({ timeoutSec: 3601 }))).toBe('invalid arguments: [0].timeoutSec must be at most 3600')
    expect(failure(() => run({ target: { kind: 'all' } }))).toBe('invalid arguments: [0].target.kind is not an allowed value')
    expect(failure(() => run({ target: { kind: 'hosts', hostIds: [] } }))).toBe(
      'invalid arguments: [0].target.hostIds must have at least 1 items',
    )
    expect(failure(() => run({ command: { kind: 'snippet', snippetId: ID, values: { prototype: 'x' } } }))).toBe(
      'invalid arguments: [0].command.values has an invalid key',
    )
    expect(failure(() => run({ command: { kind: 'text', text: '' } }))).toBe('invalid arguments: [0].command.text must be at least 1 chars')
    expect(failure(() => run({ command: { kind: 'text', text: 'x'.repeat(16_385) } }))).toBe(
      'invalid arguments: [0].command.text must be at most 16384 chars',
    )
    expect(
      failure(() => run({ command: { kind: 'snippet', snippetId: ID, values: { 'Bad Key': 'x' } } })),
    ).toBe('invalid arguments: [0].command.values has an invalid key')
    const big = 'x'.repeat(MAX_VARIABLE_VALUE + 1)
    expect(failure(() => run({ command: { kind: 'snippet', snippetId: ID, values: { v: big } } }))).toBe(
      `invalid arguments: [0].command.values.v must be at most ${MAX_VARIABLE_VALUE} chars`,
    )
    const many = Object.fromEntries(Array.from({ length: MAX_VARIABLES + 1 }, (_, i) => [`v${i}`, 'x']))
    expect(failure(() => run({ command: { kind: 'snippet', snippetId: ID, values: many } }))).toBe(
      `invalid arguments: [0].command.values must have at most ${MAX_VARIABLES} keys`,
    )

    const action = (ref: string) => V['containers:action']([ID, null, ref, 'stop'])
    for (const ref of ['a b', '-rm', 'a'.repeat(129), '$(x)']) {
      const message = failure(() => action(ref))
      expect(message).toBe('invalid arguments: [2] has an invalid format')
      expect(message).not.toContain(ref)
    }
    expect(failure(() => V['containers:action']([ID, null, 'web', 'kill']))).toBe('invalid arguments: [3] is not an allowed value')
    expect(failure(() => V['containers:logs']([ID, null, 'web', 5001]))).toBe('invalid arguments: [3] must be at most 5000')
    expect(failure(() => V['ssh:open']([{ hostId: ID, cols: 80, rows: 24, container: '$(x)' }]))).toBe(
      'invalid arguments: [0].container has an invalid format',
    )
    expect(failure(() => V['snippets:create']([{ label: 'x', script: 'uptime', destructive: 1 }]))).toBe(
      'invalid arguments: [0].destructive must be a boolean',
    )
    expect(failure(() => V['snippets:create']([{ label: 'x', script: 'uptime', defaults: { X: 'y' } }]))).toBe(
      'invalid arguments: [0].defaults has an invalid key',
    )
  })

  it('ops validators accept a minimal valid request for every new channel', () => {
    const V = VALIDATORS
    expect(V['snippets:list']([])).toEqual([])
    expect(V['snippets:create']([{ label: ' Restart ', script: 'systemctl restart {{unit}}' }])).toEqual([
      { label: 'Restart', script: 'systemctl restart {{unit}}' },
    ])
    const full = { label: 'x', script: 's', description: 'd', tags: ['ops'], defaults: { unit: null, n: '1' }, destructive: true }
    expect(V['snippets:update']([ID, full])).toEqual([ID, full])
    expect(V['snippets:delete']([ID])).toEqual([ID])
    expect(V['snippets:render']([ID, { unit: 'nginx' }])).toEqual([ID, { unit: 'nginx' }])
    expect(V['runs:start']([{ target: { kind: 'hosts', hostIds: [ID] }, command: { kind: 'text', text: 'uptime' } }])).toEqual([
      { target: { kind: 'hosts', hostIds: [ID] }, command: { kind: 'text', text: 'uptime' } },
    ])
    const env = {
      target: { kind: 'environment', environmentId: ID, role: 'db' },
      command: { kind: 'snippet', snippetId: ID2, values: {} },
      concurrency: 16,
      timeoutSec: 1,
      confirm: 'Prod',
    }
    expect(V['runs:start']([env])).toEqual([env])
    expect(V['runs:cancel']([ID])).toEqual([ID])
    expect(V['runs:list']([])).toEqual([])
    expect(V['runs:get']([ID])).toEqual([ID])
    expect(V['runs:dismiss']([ID])).toEqual([ID])
    expect(V['containers:list']([ID, null])).toEqual([ID, null])
    expect(V['containers:list']([ID, ID2])).toEqual([ID, ID2])
    expect(V['containers:action']([ID, null, 'web-1', 'restart'])).toEqual([ID, null, 'web-1', 'restart', undefined])
    expect(V['containers:action']([ID, ID2, 'a'.repeat(128), 'stop', 'Prod'])).toEqual([ID, ID2, 'a'.repeat(128), 'stop', 'Prod'])
    expect(V['containers:logs']([ID, null, 'web', 200])).toEqual([ID, null, 'web', 200])
    expect(V['containers:follow']([ID, null, 'web', 0])).toEqual([ID, null, 'web', 0])
    expect(V['containers:unfollow']([ID])).toEqual([ID])
    expect(V['ssh:open']([{ hostId: ID, cols: 80, rows: 24, container: 'app_web.1' }])).toEqual([
      { hostId: ID, cols: 80, rows: 24, container: 'app_web.1' },
    ])
  })
})
