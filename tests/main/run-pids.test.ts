import { describe, expect, it } from 'vitest'
import { RunPids } from '../../src/main/deploy/run-pids'

function rig(groups: Set<number>, text: string | null = null) {
  const file = { text }
  const make = () =>
    new RunPids({
      read: () => file.text,
      write: (t) => void (file.text = t),
      kill: (pid) => {
        if (!groups.has(-pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      },
    })
  return { file, make }
}

describe('RunPids', () => {
  it('knows nothing of a release it never saw', () => {
    expect(rig(new Set()).make().alive('r1')).toBeNull()
  })

  it('a run that closed is not alive; one left behind is judged by its process group, across a restart', () => {
    const groups = new Set([41])
    const r = rig(groups)
    const a = r.make()
    a.started('r1', 41)
    a.started('r2', 42)
    a.ended('r2', 42)
    const b = r.make() // the next launch reads the file
    expect(b.alive('r1')).toBe(true)
    expect(b.alive('r2')).toBe(false)
    groups.delete(41)
    expect(b.alive('r1')).toBe(false)
  })

  it('a close of an earlier process does not hide the one running now', () => {
    const r = rig(new Set([8]))
    const a = r.make()
    a.started('r1', 7)
    a.started('r1', 8)
    a.ended('r1', 7)
    expect(a.alive('r1')).toBe(true)
  })

  it('a group it may not signal counts as alive, and a broken file as nothing known', () => {
    const p = new RunPids({
      read: () => '{"r1":5}',
      write: () => undefined,
      kill: () => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
      },
    })
    expect(p.alive('r1')).toBe(true)
    expect(rig(new Set(), 'not json').make().alive('r1')).toBeNull()
  })
})
