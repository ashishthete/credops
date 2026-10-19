import { describe, expect, it } from 'vitest'
import { OutputRing } from '../../src/main/ops/output-ring'

describe('OutputRing', () => {
  it('is truncated once it holds more than its cap, before the slack forces a trim', () => {
    const ring = new OutputRing(8)
    ring.append('12345678', 'out')
    expect(ring.truncated).toBe(false)
    ring.append('9', 'out')
    expect(ring.length).toBe(9)
    expect(ring.truncated).toBe(true)
    expect(ring.snapshot().text).toBe('23456789')
  })

  it('trims from the front and shifts, clips and drops stderr ranges', () => {
    const ring = new OutputRing(10, 4096, 0)
    ring.append('aaaa', 'out')
    ring.append('EEEE', 'err')
    ring.append('bb', 'out')
    expect(ring.snapshot()).toEqual({ text: 'aaaaEEEEbb', errRanges: [[4, 8]] })
    expect(ring.truncated).toBe(false)
    ring.append('cccccc', 'out')
    expect(ring.snapshot()).toEqual({ text: 'EEbbcccccc', errRanges: [[0, 2]] })
    expect(ring.truncated).toBe(true)
    ring.append('ddd', 'out')
    expect(ring.snapshot()).toEqual({ text: 'bccccccddd', errRanges: [] })
  })

  it('merges adjacent stderr chunks and caps the range count by merging the oldest', () => {
    const ring = new OutputRing(1000, 3, 0)
    ring.append('e1', 'err')
    ring.append('e2', 'err')
    expect(ring.snapshot().errRanges).toEqual([[0, 4]])
    for (const s of ['o', 'E', 'o', 'E', 'o', 'E']) ring.append(s, s === 'E' ? 'err' : 'out')
    expect(ring.snapshot().errRanges).toEqual([
      [0, 6],
      [7, 8],
      [9, 10],
    ])
  })

  it('never splits a surrogate pair when trimming', () => {
    const ring = new OutputRing(3, 4096, 0)
    ring.append('a😀b', 'out')
    ring.append('c', 'out')
    expect(ring.snapshot().text).toBe('bc')
  })
})
