import { describe, expect, it } from 'vitest'
import { args, InvalidArgs, v } from '../../src/main/ipc/validate'
import { asFilter } from '../../src/main/ipc/validators'

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
})
