import { beforeEach, describe, expect, it, vi } from 'vitest'

let uuidv7: typeof import('../../src/main/deploy/uuidv7').uuidv7
let uuidv7Time: typeof import('../../src/main/deploy/uuidv7').uuidv7Time

// The generator keeps module state (last ms, counter), so each test gets a fresh module.
beforeEach(async () => {
  vi.resetModules()
  ;({ uuidv7, uuidv7Time } = await import('../../src/main/deploy/uuidv7'))
})

describe('uuidv7', () => {
  it('has version 7 and variant 10', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('round-trips the timestamp', () => {
    const t = 1760868000123
    expect(uuidv7Time(uuidv7(() => t))).toBe(t)
  })
  it('is strictly increasing within one millisecond', () => {
    const now = () => 1760868000123
    const ids = Array.from({ length: 1000 }, () => uuidv7(now))
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true)
  })
  it('stays increasing when the clock steps back', () => {
    const a = uuidv7(() => 2000)
    expect(uuidv7(() => 1000) > a).toBe(true)
  })
  it('borrows the next ms when the counter is exhausted', () => {
    const now = () => 1760868000999
    const ids = Array.from({ length: 5000 }, () => uuidv7(now))
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true)
  })
})
