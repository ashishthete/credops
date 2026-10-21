import { describe, expect, it } from 'vitest'
import { validQa } from '../src/notify/finalize'

const base = { repo: 'acme/web', workflow: 'qa.yml', ref: 'main' }

describe('validQa waitMinutes (row 46)', () => {
  it('passes a whole number of minutes in 5..180 through', () => {
    for (const w of [5, 45, 180]) expect(validQa({ ...base, waitMinutes: w })).toEqual({ ...base, waitMinutes: w })
  })
  it('leaves the workflow as before when no wait time is set', () => {
    expect(validQa(base)).toEqual(base)
    expect(Object.keys(validQa(base) as object)).toEqual(['repo', 'workflow', 'ref'])
  })
  it('rejects a wait time outside 5..180, fractional or not a number', () => {
    for (const w of [4, 181, 0, -5, 1.5, NaN, Infinity, '45', null]) expect(validQa({ ...base, waitMinutes: w }), String(w)).toBeNull()
  })
})
