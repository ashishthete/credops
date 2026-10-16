import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_IMPORT_ALIASES } from '../../src/shared/inventory'
import { globMatch, parseSshConfig, readSshIncludes } from '../../src/main/inventory/ssh-config'

const FIX = join(__dirname, '../fixtures/ssh')
const opts = { home: '/home/t', sshDir: '/home/t/.ssh' }
const fixture = (n: string) => readFileSync(join(FIX, n), 'utf8')
const parse = (t: string) => parseSshConfig(t, opts)

describe('parseSshConfig', () => {
  it('parses basic.conf with fallbacks from Host *', () => {
    const { entries } = parse(fixture('basic.conf'))
    expect(entries.map((e) => e.alias)).toEqual(['web-1', 'db-1', 'bastion'])
    expect(entries[0]).toMatchObject({ port: 2222, user: 'deploy', identityFile: '/home/t/.ssh/id_ed25519', hostName: '10.0.0.5' })
    expect(entries[1]).toMatchObject({
      user: 'fallback',
      proxyJump: 'bastion',
      forwards: [{ type: 'L', spec: '5433 localhost:5432' }],
    })
    expect(entries[2]).toMatchObject({ hostName: '52.1.2.3', port: 22 })
  })

  it('first value wins', () => {
    const { entries } = parse('Host *\n User a\nHost web\n User b\n')
    expect(entries[0].user).toBe('a')
  })

  it('handles patterns, negation and tokens', () => {
    const { entries } = parse('Host !bad-* *.prod\n User p\nHost api.prod bad-1.prod\nHost app-x\n HostName %h.example.com%%\n')
    expect(entries.map((e) => e.alias)).toEqual(['api.prod', 'bad-1.prod', 'app-x'])
    expect(entries[0].user).toBe('p')
    expect(entries[1].user).toBeNull()
    expect(entries[2].hostName).toBe('app-x.example.com%')
  })

  it('accepts = syntax, quotes, tabs and CRLF', () => {
    const { entries } = parse('Host a b\r\n\tHostName=10.1.1.1\r\n\tIdentityFile "/home/t/.ssh/my key"\r\n')
    expect(entries.map((e) => e.alias)).toEqual(['a', 'b'])
    expect(entries[0].hostName).toBe('10.1.1.1')
    expect(entries[0].identityFile).toBe('/home/t/.ssh/my key')
  })

  it('turns hostile input into warnings', () => {
    const { entries, warnings } = parse(fixture('hostile.conf'))
    const by = (a: string) => entries.find((e) => e.alias === a)!
    expect(by('evil').hostName).toBe('-oProxyCommand=touch /tmp/pwned')
    expect(by('bigport').port).toBeNull()
    expect(by('bigport').warnings).toHaveLength(1)
    expect(by('shadow').identityFile).toBeNull()
    expect(by('shadow').warnings).toHaveLength(1)
    expect(entries.every((e) => e.user === null)).toBe(true)
    expect(warnings).toContain('Match blocks are not imported (line 7)')
    expect(warnings).toContain('Include not followed: /etc/*')
  })

  it('survives binary junk and a 2 MB input', () => {
    expect(() => parse('\u0000\u0001Host\n=\n"""\nHost \n')).not.toThrow()
    const big = parse('#'.repeat(2 * 1024 * 1024))
    expect(big).toEqual({ entries: [], warnings: ['ssh config is larger than 1 MiB'] })
  })
})

describe('robustness', () => {
  it('matches pathological globs in linear-ish time', () => {
    const t0 = Date.now()
    expect(globMatch('*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false)
    expect(parse(`Host *a*a*a*a*a*a*b\n User x\nHost ${'a'.repeat(300)}\n`).entries).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(100)
    expect(globMatch('a*b?d', 'aXXbcd')).toBe(true)
    expect(globMatch('*', '')).toBe(true)
    expect(globMatch('a?', 'a')).toBe(false)
  })

  it('caps aliases and stays fast on many Host lines', () => {
    const text = Array.from({ length: 150000 }, (_, i) => `Host a${i}`).join('\n').slice(0, 1024 * 1024 - 100)
    const t0 = Date.now()
    const { entries, warnings } = parse(text + '\nHost *\n User z\n')
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(entries).toHaveLength(MAX_IMPORT_ALIASES)
    expect(entries[0].user).toBe('z')
    expect(warnings.some((w) => w.includes('More than'))).toBe(true)
  })

  it('strips trailing comments and dedupes shared-block warnings', () => {
    const { entries, warnings } = parse('Host a b c\n User u # note\nHost *\n Port 0\n')
    expect(entries[0].user).toBe('u')
    expect(entries.every((e) => e.warnings.length === 0)).toBe(true)
    expect(warnings.filter((w) => w.startsWith('Invalid Port'))).toHaveLength(1)
  })
})

const tmps: string[] = []
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Include handling', () => {
  function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sshcfg-')))
    tmps.push(root)
    const sshDir = join(root, '.ssh')
    cpSync(join(FIX, 'include'), sshDir, { recursive: true })
    const outside = join(root, 'outside.conf')
    writeFileSync(outside, 'Host leaked\n')
    symlinkSync(outside, join(sshDir, 'config.d', 'out.conf'))
    return { root, sshDir }
  }

  it('stays inside sshDir and stops loops', () => {
    const { sshDir } = setup()
    const rootPath = join(sshDir, 'config')
    const { entries, warnings } = parseSshConfig(readFileSync(rootPath, 'utf8'), {
      home: '/home/t',
      sshDir,
      include: readSshIncludes(sshDir),
      rootPath,
    })
    expect(entries.map((e) => e.alias).sort()).toEqual(['root-host', 'work'])
    expect(warnings.some((w) => w.startsWith('Include loop skipped'))).toBe(true)
    expect(warnings.some((w) => w.includes('out.conf'))).toBe(true)
    expect(warnings.some((w) => w.includes('outside'))).toBe(true)
  })

  it('refuses a glob directory outside sshDir with one warning', () => {
    const { sshDir } = setup()
    const r = readSshIncludes(sshDir)('/etc/*')
    expect(r.files).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })

  it('limits nesting depth', () => {
    const { sshDir } = setup()
    mkdirSync(join(sshDir, 'n'))
    for (let i = 0; i < 6; i++) writeFileSync(join(sshDir, 'n', `${i}.conf`), `Include n/${i + 1}.conf\n`)
    const { warnings } = parseSshConfig('Include n/0.conf\n', { home: '/home/t', sshDir, include: readSshIncludes(sshDir) })
    expect(warnings.some((w) => w.includes('nested too deeply'))).toBe(true)
  })

  it('caps matches at 100 and skips oversized includes', () => {
    const { sshDir } = setup()
    mkdirSync(join(sshDir, 'many'))
    for (let i = 0; i < 105; i++) writeFileSync(join(sshDir, 'many', `${String(i).padStart(3, '0')}.conf`), `Host m${i}\n`)
    const r = readSshIncludes(sshDir)('many/*.conf')
    expect(r.files).toHaveLength(100)
    expect(r.warnings.some((w) => w.includes('too many files'))).toBe(true)
    writeFileSync(join(sshDir, 'big.conf'), '#'.repeat(1024 * 1024 + 1))
    const big = readSshIncludes(sshDir)('big.conf')
    expect(big.files).toEqual([])
    expect(big.warnings[0]).toContain('larger than 1 MiB')
  })

  it('enforces the aggregate include budget', () => {
    const { sshDir } = setup()
    const chunk = '#'.repeat(900 * 1024)
    const files = Array.from({ length: 6 }, (_, i) => ({ path: join(sshDir, `c${i}`), text: chunk }))
    const { warnings } = parseSshConfig('Include x\n', { home: '/home/t', sshDir, include: () => ({ files, warnings: [] }) })
    expect(warnings.filter((w) => w.startsWith('Include budget'))).toHaveLength(1)
    const many = Array.from({ length: 300 }, (_, i) => ({ path: join(sshDir, `m${i}`), text: 'Host q\n' }))
    const r = parseSshConfig('Include x\n', { home: '/home/t', sshDir, include: () => ({ files: many, warnings: [] }) })
    expect(r.warnings.filter((w) => w.startsWith('Include budget'))).toHaveLength(1)
  })
})
