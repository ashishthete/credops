import { describe, expect, it } from 'vitest'
import {
  BACKUP_DIR,
  GIT_REF,
  REPO_PATH,
  STEP_LABEL,
  bumpVersion,
  filterReverts,
  lockHolderText,
  parseEnvTemplate,
  renderEnvTemplate,
  type CommitInfo,
} from '../../src/shared/deploy'

const c = (subject: string, sha = subject): CommitInfo => ({ sha, subject, author: 'a', date: 'd', deploymentId: 'd1' })
const UUID = '123e4567-e89b-42d3-a456-426614174000'

describe('bumpVersion', () => {
  it.each([
    [null, 'none', null],
    [null, 'minor', 'v0.1.0'],
    [null, 'major', 'v1.0.0'],
    [null, 'patch', 'v0.0.1'],
    ['v1.4.2', 'major', 'v2.0.0'],
    ['v1.4.2', 'minor', 'v1.5.0'],
    ['v1.4.2', 'patch', 'v1.4.3'],
    ['v1.4.2', 'none', 'v1.4.2'],
  ] as const)('%s + %s = %s', (cur, bump, out) => {
    expect(bumpVersion(cur, bump)).toBe(out)
  })
})

describe('filterReverts', () => {
  it('removes a bracketed pair', () => {
    const r = filterReverts([c('[x] Revert "Y"', 'r'), c('[x] Y', 'o'), c('other')])
    expect(r.kept.map((k) => k.sha)).toEqual(['other'])
    expect(r.hiddenPairs).toBe(1)
  })
  it('removes a plain pair', () => {
    const r = filterReverts([c('Revert "Y"', 'r'), c('Y', 'o')])
    expect(r.kept).toEqual([])
    expect(r.hiddenPairs).toBe(1)
  })
  it('keeps a revert without an original', () => {
    const r = filterReverts([c('Revert "Y"'), c('Z')])
    expect(r.kept).toHaveLength(2)
    expect(r.hiddenPairs).toBe(0)
  })
  it('lets one revert remove only one original', () => {
    const r = filterReverts([c('Revert "Y"', 'r'), c('Y', 'o1'), c('Y', 'o2')])
    expect(r.kept.map((k) => k.sha)).toEqual(['o2'])
    expect(r.hiddenPairs).toBe(1)
  })
  it('lets two reverts of one original remove only one original', () => {
    const r = filterReverts([c('Revert "Y"', 'r1'), c('Revert "Y"', 'r2'), c('Y', 'o')])
    expect(r.kept.map((k) => k.sha)).toEqual(['r2']) // newest-first: r1 takes the original, r2 stays unpaired
    expect(r.hiddenPairs).toBe(1)
  })
})

describe('parseEnvTemplate', () => {
  it('parses text, secret, comment and blank lines', () => {
    const r = parseEnvTemplate(`# c\n\nA=1\nB=\${secret:${UUID}}\n`)
    expect(r.errors).toEqual([])
    expect(r.secretIds).toEqual([UUID])
    expect(r.lines.filter((l) => 'key' in l)).toEqual([
      { key: 'A', value: { kind: 'text', text: '1' } },
      { key: 'B', value: { kind: 'secret', secretId: UUID } },
    ])
  })
  it('flags sensitive keys without leaking the value', () => {
    const r = parseEnvTemplate('DB_PASSWORD=hunter2')
    expect(r.errors).toEqual(['line 1: DB_PASSWORD looks sensitive; use a vault secret'])
    expect(r.errors.join()).not.toContain('hunter2')
  })
  it('rejects a bad secret id, bad lines and duplicates', () => {
    expect(parseEnvTemplate('A=${secret:not-a-uuid}').errors).toHaveLength(1)
    expect(parseEnvTemplate('nonsense').errors).toEqual(['line 1: not KEY=value'])
    expect(parseEnvTemplate('A=1\nA=2').errors).toEqual(['line 2: duplicate A'])
  })
})

describe('renderEnvTemplate', () => {
  it('single-quotes values', () => {
    const { lines } = parseEnvTemplate(`A=it's\nB=\${secret:${UUID}}`)
    expect(renderEnvTemplate(lines, new Map([[UUID, "p'w"]]))).toBe(`A='it'\\''s'\nB='p'\\''w'\n`)
  })
})

describe('regexes', () => {
  it.each(['/srv/app', '/home/deploy/esg'])('REPO_PATH accepts %s', (s) => {
    expect(REPO_PATH.test(s)).toBe(true)
    expect(BACKUP_DIR.test(s)).toBe(true)
  })
  it.each(['srv/app', '/srv/../etc', '/srv/app;rm', '/srv/{a}', '/srv/a b', '/srv/$HOME', '/srv/app/'])('REPO_PATH rejects %s', (s) => {
    expect(REPO_PATH.test(s)).toBe(false)
  })
  it.each(['main', 'release/2026.10', 'backend_prod'])('GIT_REF accepts %s', (s) => expect(GIT_REF.test(s)).toBe(true))
  it.each(['a..b', '-x', 'a b', 'a;b', 'x.lock'])('GIT_REF rejects %s', (s) => expect(GIT_REF.test(s)).toBe(false))
})

describe('misc', () => {
  it('lockHolderText', () => {
    expect(
      lockHolderText(
        { releaseId: 'r', user: 'ana', machine: 'mbp', environment: 'prod', version: 'v1.5.0', startedAt: '2026-10-19T10:00:00.000Z' },
        Date.parse('2026-10-19T10:05:00.000Z'),
      ),
    ).toBe('ana@mbp is deploying v1.5.0 since 2026-10-19T10:00:00.000Z')
  })
  it('labels every step kind', () => {
    expect(STEP_LABEL.rb_checkout).toBe('Rollback checkout')
    expect(STEP_LABEL.finalize_notes).toBe('Release notes')
  })
})
