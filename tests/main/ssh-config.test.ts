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
    expect(entries[0].forwards).toEqual([
      { type: 'D', spec: '1080' },
      { type: 'R', spec: '9000 localhost:3000' },
    ])
    expect(entries[2]).toMatchObject({ hostName: '52.1.2.3', port: 22 })
  })

  it('parses DynamicForward', () => {
    expect(parse('Host a\n DynamicForward 1080\n').entries[0].forwards).toEqual([{ type: 'D', spec: '1080' }])
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

  it('caps wildcard blocks so adversarial configs do not stall', () => {
    const wild = Array.from({ length: 25000 }, () => 'Host *a*a*a*a*b').join('\n')
    const hosts = Array.from({ length: 2000 }, (_, i) => `Host ${String(i).padStart(4, '0')}${'a'.repeat(196)}`).join('\n')
    const text = `${hosts}\n${wild}`.slice(0, 1024 * 1024 - 10)
    expect(text.length).toBeGreaterThan(700 * 1024)
    const t0 = Date.now()
    const { entries, warnings } = parse(text)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(entries.length).toBeGreaterThan(1000)
    expect(warnings.some((w) => w.includes('wildcard Host blocks'))).toBe(true)
  })

  it('bounds wildcard matching work across the whole parse', () => {
    const hosts = Array.from({ length: 2000 }, (_, i) => `Host ${String(i).padStart(4, '0')}${'a'.repeat(96)}`).join('\n')
    const pat = `*${'a'.repeat(80)}b*`
    const wild = Array.from({ length: 150 }, (_, i) => `Host ${Array(i < 50 ? 14 : 13).fill(pat).join(' ')}\n User w`).join('\n')
    const text = `${hosts}\n${wild}\n`
    expect(text.length).toBeLessThan(1024 * 1024)
    const t0 = Date.now()
    const { entries, warnings } = parse(text)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(entries).toHaveLength(2000)
    expect(warnings.filter((w) => w.includes('wildcard Host patterns'))).toHaveLength(1)
    expect(warnings.filter((w) => w.includes('Wildcard Host matching'))).toHaveLength(1)
  })

  it('applies a huge Host * body once, not once per host', () => {
    const hosts = Array.from({ length: 2000 }, (_, i) => `Host h${i}`).join('\n')
    const body = 'a\n'.repeat(Math.floor((1024 * 1024 - hosts.length - 32) / 2))
    const text = `${hosts}\nHost *\n User shared\n${body}`
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024)
    const t0 = Date.now()
    const { entries } = parse(text)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(entries).toHaveLength(2000)
    expect(entries.every((e) => e.user === 'shared')).toBe(true)
  })

  it('caps forwards per host', () => {
    const hosts = Array.from({ length: 2000 }, (_, i) => `Host h${i}`).join('\n')
    const fwd = Array.from({ length: 20000 }, (_, i) => ` LocalForward ${10000 + i} db:5432`).join('\n')
    const t0 = Date.now()
    const { entries, warnings } = parse(`${hosts}\nHost h0\n RemoteForward 9000 localhost:9000\nHost *\n${fwd}\n`)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(entries).toHaveLength(2000)
    expect(entries.every((e) => e.forwards.length === 64)).toBe(true)
    expect(entries[0].forwards[0]).toEqual({ type: 'R', spec: '9000 localhost:9000' })
    expect(entries[1].forwards[0]).toEqual({ type: 'L', spec: '10000 db:5432' })
    expect(warnings.filter((w) => w.includes('port forwards'))).toEqual(['More than 64 port forwards for a host; the rest are ignored'])
  })

  it('ignores over-long wildcard patterns, and a block whose negation is too long', () => {
    const long = `*${'x'.repeat(300)}*`
    const { entries, warnings } = parse(`Host ${long} web*\n User a\nHost * !${long}\n Port 2200\nHost web\n`)
    expect(entries[0]).toMatchObject({ user: 'a', port: null })
    expect(warnings.filter((w) => w.includes('longer than 256'))).toHaveLength(1)
  })

  it('dedupes parse warnings and caps the list at 200', () => {
    const many = Array.from({ length: 300 }, () => 'Match all').join('\n')
    const { warnings } = parse(`Include x\nInclude x\n${many}\n`)
    expect(warnings.filter((w) => w === 'Include not followed: x')).toHaveLength(1)
    expect(warnings).toHaveLength(201)
    expect(warnings[200]).toBe('…and 101 more warnings')
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

  it('does not report a diamond include as a loop', () => {
    const { sshDir } = setup()
    writeFileSync(join(sshDir, 'a.conf'), 'Include shared.conf\n')
    writeFileSync(join(sshDir, 'b.conf'), 'Include shared.conf\n')
    writeFileSync(join(sshDir, 'shared.conf'), 'Host shared\n')
    const { entries, warnings } = parseSshConfig('Include a.conf\nInclude b.conf\n', {
      home: '/home/t',
      sshDir,
      include: readSshIncludes(sshDir),
    })
    expect(entries.map((e) => e.alias)).toEqual(['shared'])
    expect(warnings.filter((w) => w.includes('loop'))).toEqual([])
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
    const chunk = '#'.repeat(700 * 1024)
    const files = Array.from({ length: 6 }, (_, i) => ({ path: join(sshDir, `c${i}`), text: chunk }))
    const { warnings } = parseSshConfig('Include x\n', { home: '/home/t', sshDir, include: () => ({ files, warnings: [] }) })
    expect(warnings.filter((w) => w.startsWith('Include budget'))).toHaveLength(1)
    const many = Array.from({ length: 300 }, (_, i) => ({ path: join(sshDir, `m${i}`), text: 'Host q\n' }))
    const r = parseSshConfig('Include x\n', { home: '/home/t', sshDir, include: () => ({ files: many, warnings: [] }) })
    expect(r.warnings.filter((w) => w.startsWith('Include budget'))).toHaveLength(1)
  })

  it('stops reading includes once the budget is spent', () => {
    const { sshDir } = setup()
    writeFileSync(join(sshDir, 'big'), '#'.repeat(1000 * 1000))
    const t0 = Date.now()
    const { warnings } = parseSshConfig('Include big\n'.repeat(20000), {
      home: '/home/t',
      sshDir,
      include: readSshIncludes(sshDir),
    })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(warnings.filter((w) => w.startsWith('Include budget'))).toHaveLength(1)
    expect(warnings.filter((w) => w.includes('Include directives'))).toHaveLength(1)
  })

  it('caps Include directives at 1000', () => {
    let calls = 0
    const { warnings } = parseSshConfig('Include none\n'.repeat(1500), {
      ...opts,
      include: () => (calls++, { files: [], warnings: [] }),
    })
    expect(calls).toBe(1000)
    expect(warnings).toContain('More than 1000 Include directives, the rest are ignored')
  })

  it('the reader stops at the remaining budget before reading', () => {
    const { sshDir } = setup()
    mkdirSync(join(sshDir, 'many'))
    for (let i = 0; i < 5; i++) writeFileSync(join(sshDir, 'many', `${i}.conf`), `Host m${i}\n`)
    const byFiles = readSshIncludes(sshDir)('many/*.conf', { files: 3, bytes: 1e9 })
    expect(byFiles.files).toHaveLength(3)
    expect(byFiles.exhausted).toBe(true)
    const byBytes = readSshIncludes(sshDir)('many/*.conf', { files: 100, bytes: 12 })
    expect(byBytes.files).toHaveLength(1)
    expect(byBytes.exhausted).toBe(true)
  })

  it('caps the folder entries Include looks at per parse', () => {
    const { sshDir } = setup()
    const many = join(sshDir, 'many')
    mkdirSync(many)
    for (let i = 0; i < 3000; i++) mkdirSync(join(many, `d${i}`))
    const t0 = Date.now()
    const { warnings } = parseSshConfig('Include many/*\n'.repeat(1000), {
      home: '/home/t',
      sshDir,
      include: readSshIncludes(sshDir),
    })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(warnings).toContain('Include looked at more than 10000 folder entries; the rest are skipped')
  })

  it('warns about wildcards in folder names', () => {
    const { sshDir } = setup()
    const r = readSshIncludes(sshDir)('conf*/x.conf')
    expect(r.files).toEqual([])
    expect(r.warnings).toEqual(["Include conf*/x.conf: wildcards in folder names aren't supported"])
  })
})
