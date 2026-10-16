import { describe, expect, it } from 'vitest'
import { args, InvalidArgs, v } from '../../src/main/ipc/validate'
import { asFilter, VALIDATORS } from '../../src/main/ipc/validators'
import { DEFAULT_VAULT_ID, MAX_MASTER_PASSWORD } from '../../src/shared/vault'

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
})
