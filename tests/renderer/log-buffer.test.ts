import { describe, expect, it } from 'vitest'
import { parseAnsi, stripAnsi } from '../../src/renderer/src/deploy/ansi'
import { LOG_CAP, LogBuffer } from '../../src/renderer/src/deploy/log-buffer'
import type { RunEvent } from '../../src/shared/deploy'

let seq = 0
const log = (line: string, stepId: string | null = 'r1:build', hostId: string | null = 'h1', stream: 'out' | 'err' | 'ansible' = 'out'): RunEvent => ({
  id: `l${++seq}`,
  runId: 'rel-1',
  seq,
  at: '2026-10-19T10:00:00.000Z',
  type: 'log',
  stepId,
  hostId,
  stream,
  line,
})
const texts = (b: LogBuffer, from = 0, to = b.size, filter = {}) => b.slice(from, to, filter).map((l) => l.text)

describe('LogBuffer', () => {
  it('ring drops oldest past cap and reports hidden count', () => {
    const b = new LogBuffer(5)
    b.push(Array.from({ length: 8 }, (_, i) => log(`line ${i}`)))
    expect(b.size).toBe(5)
    expect(b.hidden).toBe(3)
    expect(texts(b)).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7'])
    b.push([{ id: 'x', runId: 'rel-1', seq: 99, at: '2026-10-19T10:00:00.000Z', type: 'log.truncated', dropped: 40 }])
    expect(b.hidden).toBe(43)
    expect(b.size).toBe(5)
    expect(LOG_CAP).toBe(50000)
  })

  it('filters by step, host and run', () => {
    const b = new LogBuffer()
    b.push([
      log('a', 'r1:build', 'h1'),
      log('b', 'r3:build', 'h2'),
      log('c', 'r1:up', 'h1'),
      log('d', 'host:h2:lock', 'h2'),
      log('e', null, null, 'ansible'),
      log('f', 'r1:build', 'h1', 'err'),
    ])
    expect(texts(b, 0, 10, { stepId: 'r1:build' })).toEqual(['a', 'f'])
    expect(texts(b, 0, 10, { hostId: 'h2' })).toEqual(['b', 'd'])
    expect(texts(b, 0, 10, { runId: 'r1' })).toEqual(['a', 'c', 'f'])
    expect(texts(b, 0, 10, { runId: 'r1', stepId: 'r1:up' })).toEqual(['c'])
    expect(b.count({ hostId: 'h1' })).toBe(3)
    expect(b.count({})).toBe(6)
    expect(texts(b, 1, 2, { runId: 'r1' })).toEqual(['c'])
    expect(b.slice(0, 1, { stepId: 'r1:build' })[0]).toMatchObject({ stepId: 'r1:build', hostId: 'h1', runId: 'r1', stream: 'out' })
  })

  it("filters by task: a task's own lines, which main tags with its name", () => {
    const b = new LogBuffer()
    const tagged = (line: string, task?: string): RunEvent => ({ ...log(line, 'r1:health', 'h1'), ...(task ? { task } : {}) }) as RunEvent
    b.push([tagged('a', 'health core 0'), tagged('b', 'health core 1'), tagged('c'), tagged('d', 'health core 1')])
    expect(texts(b, 0, 10, { taskKey: 'r1:health|health core 1' })).toEqual(['b', 'd'])
    expect(texts(b, 0, 10, { taskKey: 'r1:health|health core 0' })).toEqual(['a'])
    expect(texts(b, 0, 10, { stepId: 'r1:health' })).toEqual(['a', 'b', 'c', 'd'])
  })

  it('filters stay right once the ring has dropped lines', () => {
    const b = new LogBuffer(3)
    b.push([log('a', 's1'), log('b', 's2'), log('c', 's1'), log('d', 's2'), log('e', 's1')])
    expect(texts(b, 0, 10, { stepId: 's1' })).toEqual(['c', 'e'])
    expect(b.count({ stepId: 's2' })).toBe(1)
  })

  it('search returns indexes', () => {
    const b = new LogBuffer()
    b.push([log('Building api'), log('other', 'r3:build', 'h2'), log('\u001b[32mbuilt\u001b[0m api'), log('done')])
    expect(b.search('api', {})).toEqual([0, 2])
    expect(b.search('BUILT', {})).toEqual([2])
    expect(b.search('api', { hostId: 'h1' })).toEqual([0, 1])
    expect(b.search('', {})).toEqual([])
  })

  it('colours and bold parsed, unknown escapes stripped', () => {
    expect(parseAnsi('plain')).toEqual([{ text: 'plain' }])
    expect(parseAnsi('\u001b[31mred\u001b[39m then \u001b[1;92mbold green\u001b[22m green\u001b[0m end')).toEqual([
      { text: 'red', fg: 'red' },
      { text: ' then ' },
      { text: 'bold green', fg: 'bright-green', bold: true },
      { text: ' green', fg: 'bright-green' },
      { text: ' end' },
    ])
    expect(parseAnsi('\u001b[2Ka\u001b]0;title\u0007b\u001b[?25lc\u001b[4md')).toEqual([{ text: 'abcd' }])
    expect(stripAnsi('\u001b[33mwarn\u001b[m')).toBe('warn')
  })

  it('50k lines push and filter under 50 ms', () => {
    const lines = Array.from({ length: LOG_CAP }, (_, i) => log(`line ${i}`, `r${i % 5}:build`, `h${i % 3}`))
    const b = new LogBuffer()
    const t0 = performance.now()
    b.push(lines)
    const n = b.count({ hostId: 'h1' })
    const page = b.slice(n - 50, n, { hostId: 'h1' })
    const ms = performance.now() - t0
    expect(page).toHaveLength(50)
    expect(ms).toBeLessThan(50)
  })
})
