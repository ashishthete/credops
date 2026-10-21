import { describe, expect, it } from 'vitest'
import { REPO_URL, hasRepoCredentials, isLegacyRepoUrl, isParsableRepoUrl, maskRepoUrl, stripRepoCredentials } from '../../src/shared/inventory'

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
  ['ssh://u%3Ap@h/r', true],
  ['ssh://u%3ap@h/r', true],
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
    // Rejected outright or flagged, and either way stripped clean (the export reads legacy rows the pattern refuses).
    if (REPO_URL.test(url)) expect(hasRepoCredentials(url)).toBe(true)
    const clean = stripRepoCredentials(url)
    expect(clean).not.toMatch(/tok|pw|u:p|u%3Ap|x%40y/i)
    expect(hasRepoCredentials(clean)).toBe(false)
  })

  it('refuses the extra-slash and scp bypass forms at the pattern', () => {
    for (const u of ['httpſ://tok:pw@host/r', 'ſſh://u:p@h/r', 'git@\u212Aost:r', 'https:///a@h/r', 'ssh:///u:p@h/r', 'https:\\\\a@h/r', 'git@:repo', 'git@https://tok:pw@h/a']) expect(REPO_URL.test(u), u).toBe(false)
  })

  it('keeps an ssh user when stripping its password', () => {
    expect(stripRepoCredentials('ssh://u:p@h/r')).toBe('ssh://u@h/r')
    expect(stripRepoCredentials('https://tok:pw@h/r')).toBe('https://h/r')
  })

  it('allows ssh-config aliases with underscores and bracketed IPv6 in the scp form', () => {
    for (const u of ['git@github_work:org/r.git', 'git@[::1]:r', 'git@[fe80::1]:org/r']) {
      expect(REPO_URL.test(u), u).toBe(true)
      expect(hasRepoCredentials(u), u).toBe(false)
    }
  })

  it('refuses control and format characters', () => {
    for (const u of ['https://host/a\u200Bb', 'https://host/\u202Er', 'git@host:a\u0085b']) expect(REPO_URL.test(u), u).toBe(false)
  })

  it('http(s) values must parse as URLs', () => {
    expect(isParsableRepoUrl('https://host/r')).toBe(true)
    expect(isParsableRepoUrl('git@host:r')).toBe(true)
    expect(isParsableRepoUrl('https://host%40x/r')).toBe(false)
  })

  it('masks legacy values for display', () => {
    expect(maskRepoUrl('https://tok:pw@host/r')).toBe('https://host/r')
    expect(maskRepoUrl('git@https://tok:pw@host/a')).not.toMatch(/tok|pw/)
    expect(maskRepoUrl('git@host:r')).toBe('git@host:r')
    expect(isLegacyRepoUrl('https://tok@host/r')).toBe(true)
    expect(isLegacyRepoUrl('git@https://tok:pw@host/a')).toBe(true)
    expect(isLegacyRepoUrl('https://host/r')).toBe(false)
  })
})
