import { describe, expect, it } from 'vitest'
import { REPO_URL, hasRepoCredentials, stripRepoCredentials } from '../../src/shared/inventory'

// Fake values only. `carries` is whether the URL holds a credential.
const rows: [string, boolean][] = [
  ['https:///tok:pw@github.com/a/b.git', true],
  ['https:////tok@github.com/a', true],
  ['ssh:///u:p@h/r', true],
  ['git@https://tok:pw@github.com/a', true],
  ['HTTPS://tok@host/r', true],
  ['https:\\\\tok:pw@github.com/a', true],
  ['https:/\\tok@github.com/a', true],
  ['https://x%40y@host/r', true],
  ['ssh://u:p@h/r', true],
  ['https://host/a%40b', false],
  ['git@host:repo', false],
  ['ssh://git@host/repo', false],
  ['https://host/repo', false],
]

describe('repo URL credentials', () => {
  it.each(rows)('%s', (url, carries) => {
    if (!carries) {
      expect(REPO_URL.test(url)).toBe(true)
      expect(hasRepoCredentials(url)).toBe(false)
      expect(stripRepoCredentials(url)).toBe(url)
      return
    }
    // Rejected outright, or flagged and stripped clean.
    if (!REPO_URL.test(url)) return
    expect(hasRepoCredentials(url)).toBe(true)
    const clean = stripRepoCredentials(url)
    expect(hasRepoCredentials(clean)).toBe(false)
    expect(clean).not.toMatch(/tok|pw|u:p|x%40y/)
  })

  it('refuses the extra-slash and scp bypass forms at the pattern', () => {
    for (const u of ['https:///a@h/r', 'ssh:///u:p@h/r', 'https:\\\\a@h/r', 'git@:repo', 'git@https://tok:pw@h/a']) expect(REPO_URL.test(u), u).toBe(false)
  })

  it('keeps an ssh user when stripping its password', () => {
    expect(stripRepoCredentials('ssh://u:p@h/r')).toBe('ssh://u@h/r')
    expect(stripRepoCredentials('https://tok:pw@h/r')).toBe('https://h/r')
  })
})
