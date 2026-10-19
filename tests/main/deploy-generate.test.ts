import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { matchSshConfig } from '../../src/main/inventory/ssh-config'
import { generateAnsibleCfg, generateInventory, generateKnownHosts, generatePlaybook, generateSshConfig, knownHostsToken, socketPathFits } from '../../src/main/deploy/generate'
import { b64, lockJson, sanitizeIdent } from '../../src/main/deploy/quote'
import type { DeployPlan, PlanKind } from '../../src/main/deploy/runner'
import { FIX, planFixture } from './deploy-helpers'

type Task = Record<string, unknown> & { block?: Task[]; rescue?: Task[]; tags?: string[]; no_log?: boolean }
type Play = Record<string, unknown> & { hosts: string; tasks: Task[]; vars: Record<string, unknown> }

const plays = (plan: DeployPlan): Play[] => JSON.parse(generatePlaybook(plan)) as Play[]
const step = (t: Task): string => (t.tags ?? []).find((x) => x.startsWith('od_step='))!.slice(8)
/** Leaf tasks of the main path (block bodies inline, rescues excluded). */
const flat = (tasks: Task[]): Task[] => tasks.flatMap((t) => (t.block ? flat(t.block) : [t]))
const steps = (p: Play): string[] => flat(p.tasks).map(step)
/** Every leaf task, rescues too, with whether a block above it set no_log. */
function every(tasks: Task[], inherited = false): { t: Task; noLog: boolean }[] {
  return tasks.flatMap((t) => {
    const nl = inherited || t.no_log === true
    return t.block || t.rescue ? [...every(t.block ?? [], nl), ...every(t.rescue ?? [], nl)] : [{ t, noLog: nl }]
  })
}
const cmdOf = (t: Task): string => {
  const m = (t['ansible.builtin.shell'] ?? t['ansible.builtin.command'] ?? t['ansible.builtin.uri']) as { cmd?: string } | undefined
  return m?.cmd ?? ''
}

describe('release playbook', () => {
  it('has one play per host and steps in order', () => {
    const ps = plays(planFixture())
    expect(ps.map((p) => p.hosts)).toEqual(['od-1', 'od-2'])
    expect(ps[0].vars.s).toBe("{{ lookup('env','OPSDECK_SECRETS') | default('{}', true) | from_json }}")
    expect(ps[0].gather_facts).toBe(false)
    expect(ps[0].strategy).toBe('linear')
    expect(steps(ps[0])).toEqual([
      'lock', 'lock',
      'record', 'backup', 'fetch', 'checkout', 'env', 'pre_hook', 'build', 'up', 'health', 'post_hook', 'tag',
      'record', 'fetch', 'checkout', 'build', 'up', 'health', 'tag',
    ])
    expect(steps(ps[1])).toEqual(['lock', 'lock', 'record', 'fetch', 'checkout', 'build', 'up', 'tag'])
    expect(ps[0].vars.ansible_become_password).toContain('s.become_1')
    expect(ps[1].vars.ansible_become_password).toBeUndefined()
  })

  it("omits steps that don't apply", () => {
    const plan = planFixture()
    const d = plan.deployments[2]
    expect(steps(plays(plan)[1]).slice(2)).toEqual(['record', 'fetch', 'checkout', 'build', 'up', 'tag'])
    expect(d.backup).toBeNull()
  })

  it('wraps each deployment in a block whose rescue marks the host failed and re-raises', () => {
    const p = plays(planFixture())[0]
    const blocks = p.tasks.filter((t) => t.block)
    expect(blocks).toHaveLength(2)
    for (const b of blocks) {
      expect(b.rescue![0]).toMatchObject({ 'ansible.builtin.set_fact': { od_failed: true } })
      expect(Object.keys(b.rescue![1])).toContain('ansible.builtin.fail')
      for (const t of b.block!) expect(t.when).toBe('not (od_failed | default(false))')
    }
  })

  it('tags every shell task and gives it bash, chdir and a timeout', () => {
    for (const p of plays(planFixture()))
      for (const { t } of every(p.tasks)) {
        if (!t['ansible.builtin.shell']) continue
        const m = t['ansible.builtin.shell'] as Record<string, unknown>
        if (!t.rescue) {
          expect(m.executable).toBe('/bin/bash')
          expect(m.chdir).toBeTruthy()
          expect(typeof t.timeout).toBe('number')
          expect(t.tags!.some((x) => x.startsWith('od_run='))).toBe(true)
        }
      }
  })

  it('uses the configured build and up timeouts and the fixed ones elsewhere', () => {
    const ps = plays(planFixture())
    const by = (k: string) => flat(ps[0].tasks).filter((t) => step(t) === k)[0].timeout
    expect(by('build')).toBe(300)
    expect(by('up')).toBe(120)
    expect(by('fetch')).toBe(120)
    expect(by('backup')).toBe(1800)
    expect(by('pre_hook')).toBe(600)
  })

  it('takes become per docker mode', () => {
    const ps = plays(planFixture())
    const t = (i: number, k: string) => flat(ps[0].tasks).filter((x) => step(x) === k)[i]
    expect(t(0, 'build').become).toBe(true)
    expect(t(0, 'pre_hook').become).toBe(true)
    expect(t(1, 'up').become).toBe(true)
    expect(flat(ps[1].tasks).find((x) => step(x) === 'build')!.become).toBeUndefined()
    expect(t(0, 'fetch').become).toBeUndefined()
  })

  it('streams build, up, hooks and backup into stream.log with a run:kind prefix', () => {
    const ps = plays(planFixture())
    const build = cmdOf(flat(ps[0].tasks).find((t) => step(t) === 'build')!)
    expect(build).toContain('docker compose -f {{ d.compose | quote }} build')
    expect(build).not.toContain('sed ')
    expect(build).toContain('while IFS= read -r l')
    expect(build).toContain("printf '%s\\t%s\\n' \"$P\" \"$l\"")
    expect(build).toContain('P="{{ d.run }}:build"')
    expect(build).toContain('${PIPESTATUS[0]}')
    expect(build).toContain('tail -n 40')
    const up = cmdOf(flat(ps[0].tasks).find((t) => step(t) === 'up')!)
    expect(up).toContain('docker compose -f {{ d.compose | quote }} up -d')
    const pre = cmdOf(flat(ps[0].tasks).find((t) => step(t) === 'pre_hook')!)
    expect(pre).toContain('| base64 -d | bash -e')
    const backup = cmdOf(flat(ps[0].tasks).find((t) => step(t) === 'backup')!)
    expect(backup).not.toContain('. ./.env')
    expect(backup).not.toContain('set -a')
    expect(backup).toContain('DB_USER|DB_HOST|DB_PORT|DB_NAME|DB_PASS')
    expect(backup).toContain('PGPASSWORD="$DB_PASS" pg_dump -Fc -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -f "$F.part"')
    expect(backup).toContain('F={{ d.backup_dir | quote }}/{{ d.backup_label | quote }}-{{ d.run }}.dump')
    expect(backup).toContain('-f "$F.part" || { rm -f "$F.part"; exit 1; }')
    expect(backup).toContain('mv -f "$F.part" "$F"')
    expect(backup).not.toContain('rm -f "$F";')
    expect(backup).toContain('"${DB_PASS-}"')
    expect(backup).not.toContain('DB_PASS:?')
    expect(backup).not.toMatch(/pg_dump[^\n]*(DATABASE_URL|\$DB_PASS)/)
    expect(backup).toContain('OD-BACKUP')
  })

  it('health from host is a curl loop; from mac is uri delegated to localhost', () => {
    const ps = plays(planFixture())
    const mac = flat(ps[0].tasks).find((t) => step(t) === 'health')!
    expect(mac.delegate_to).toBe('localhost')
    expect(mac.connection).toBe('local')
    expect(mac['ansible.builtin.uri']).toMatchObject({ status_code: [200] })
    expect(mac.until).toBe('r.status == 200')
    expect(mac.delay).toBe(2)
    const host = flat(ps[0].tasks).filter((t) => step(t) === 'health')[1]
    const c = cmdOf(host)
    expect(c).toContain("curl -sS -o /dev/null -w '%{http_code}' --max-time 10")
    expect(c).toContain('| quote }}')
    expect(c).toContain('sleep 2')
  })

  it('writes the managed .env through stdin, never copy content', () => {
    const ps = plays(planFixture())
    const env = flat(ps[0].tasks).find((t) => step(t) === 'env')!
    const m = env['ansible.builtin.shell'] as Record<string, string>
    expect(m.stdin).toBe('{{ s.env_1 }}')
    expect(m.cmd).toContain('base64 -d > .env.opsdeck-new')
    expect(m.cmd).toContain('chmod 600')
    expect(env.no_log).toBe(true)
    expect(m.cmd).toContain('cp -p .env .env.opsdeck-prev')
    expect(m.cmd).toContain('chmod 600 .env.opsdeck-prev')
    expect(m.cmd).toContain('.env.opsdeck-none')
    // the release marker is written after prev/marker and before the new .env lands
    const i = m.cmd.indexOf('.env.opsdeck-rel')
    expect(i).toBeGreaterThan(m.cmd.indexOf(': > .env.opsdeck-none'))
    expect(i).toBeLessThan(m.cmd.indexOf('base64 -d'))
    expect(m.cmd).toContain('printf \'%s\' {{ od.rel | quote }} > .env.opsdeck-rel')
  })
})

describe('invariants across every plan kind', () => {
  const kinds: PlanKind[] = ['preflight', 'release', 'rollback', 'version', 'unlock', 'break-lock']
  const planOf = (kind: PlanKind) =>
    planFixture({ kind, lock: { expectRaw: { 'host-od-1': '{"releaseId":"x"}', 'host-od-2': '{"releaseId":"y"}' } } })

  it.each(kinds)('%s: every task referencing s. or OPSDECK_SECRETS is no_log', (kind) => {
    for (const p of plays(planOf(kind)))
      for (const { t, noLog } of every(p.tasks)) {
        const text = JSON.stringify(t)
        if (/\bs\.[A-Za-z_]/.test(text.replace(/"(?:[^"\\]|\\.)*"\s*:/g, (k) => (/\bs\./.test(k) ? '' : k))) || text.includes('OPSDECK_SECRETS'))
          expect(noLog, `${kind}: ${text}`).toBe(true)
      }
  })

  it.each(kinds)('%s: no copy with content', (kind) => {
    const raw = generatePlaybook(planOf(kind))
    for (const p of plays(planOf(kind))) for (const { t } of every(p.tasks)) {
      for (const k of ['copy', 'ansible.builtin.copy']) expect((t as Record<string, unknown>)[k]).toBeUndefined()
    }
    expect(raw).not.toMatch(/"content"\s*:/)
  })

  it.each(kinds)('%s: generated files never contain secret values and are consistent JSON/INI', (kind) => {
    const plan = planOf(kind)
    const rundir = '/tmp/od-abc123'
    const files = [
      generatePlaybook(plan),
      generateInventory(plan),
      generateSshConfig(plan, { privateAgent: `${rundir}/a.sock`, userAgent: '/tmp/user.sock' }, rundir),
      generateAnsibleCfg(plan, rundir),
    ]
    for (const f of files) {
      expect(f).not.toContain('S3cr3t-Value-xyz')
      expect(f).not.toContain('B3come-pw-123')
    }
  })

  it.each(kinds)('%s: no raw jinja block or comment openers outside our expressions', (kind) => {
    const raw = generatePlaybook(planOf(kind))
    const stripped = raw.replace(/\{\{[^}]*\}\}/g, '')
    expect(stripped).not.toMatch(/\{[%#]/)
  })

  it.each(kinds)('%s: task names carry no user text', (kind) => {
    for (const p of plays(planOf(kind))) for (const { t } of every(p.tasks)) expect(String(t.name)).toMatch(/^[A-Za-z0-9._@: -]+$/)
  })
})

describe('shell syntax', () => {
  it.each(['preflight', 'release', 'rollback', 'version', 'unlock', 'break-lock'] as PlanKind[])('%s: every command parses with bash -n (parse only, nothing runs)', (kind) => {
    const plan = planFixture({ kind, lock: { expectRaw: { 'host-od-1': 'a', 'host-od-2': 'b' } } })
    for (const p of plays(plan))
      for (const { t } of every(p.tasks)) {
        const cmd = cmdOf(t).replace(/\{\{[^}]*\}\}/g, 'x')
        if (!cmd) continue
        const r = spawnSync('/bin/bash', ['-n'], { input: cmd, encoding: 'utf8' })
        expect(r.stderr, `${kind}: ${cmd}`).toBe('')
        expect(r.status).toBe(0)
      }
  })
})

describe('user values', () => {
  it('hooks reach bash byte-exact via base64 and never appear raw', () => {
    const plan = planFixture()
    const raw = generatePlaybook(plan)
    expect(raw).not.toContain('{{ 7*7 }}')
    expect(raw).not.toContain('$(id)')
    const b = b64(FIX.hook)
    expect(raw).toContain(b)
    expect(Buffer.from(b, 'base64').toString()).toBe(FIX.hook)
    const d = JSON.stringify(plays(plan)[0].tasks)
    expect(d.split(b).length - 1).toBe(1)
  })

  it('repo path, branch and tag appear in commands only inside d.<field> | quote', () => {
    const plan = planFixture()
    for (const kind of ['release', 'rollback', 'preflight', 'version'] as PlanKind[]) {
      const p = { ...plan, kind }
      for (const play of plays(p)) for (const { t } of every(play.tasks)) {
        const c = JSON.stringify(Object.values(t).filter((v) => typeof v === 'object' && v !== null))
        const bare = c.replace(/\{\{ d\.[a-z_]+(?:\[\d+\](?:\.[a-z]+)?)? \| quote \}\}/g, '')
        for (const lit of [FIX.branch, FIX.tag, FIX.compose, ...plan.deployments.map((d) => d.repoPath)]) {
          const withoutChdir = bare.replace(/"chdir":"\{\{ [^}]+\}\}"/g, '')
          expect(withoutChdir, `${kind} leaks ${lit}`).not.toContain(lit)
        }
      }
    }
  })

  it('puts plan data in block vars as validated tokens', () => {
    const p = plays(planFixture())[0]
    const b = p.tasks.find((t) => t.block) as Task & { vars: { d: Record<string, unknown> } }
    expect(b.vars.d.repo).toBe(`${FIX.repo}1`)
    expect(b.vars.d.branch).toBe(FIX.branch)
  })

  it('rejects values that could break out', () => {
    const bad = (mut: (p: DeployPlan) => void) => {
      const p = planFixture()
      mut(p)
      expect(() => generatePlaybook(p)).toThrow()
    }
    bad((p) => { p.deployments[0].repoPath = '/srv/a b' })
    bad((p) => { p.deployments[0].branch = 'x;rm -rf /' })
    bad((p) => { p.deployments[0].composeFile = '{{ x }}' })
    bad((p) => { p.deployments[0].deployTag = 'a$(id)' })
    bad((p) => { p.deployments[0].urls = [{ url: 'http://x/{{ 1 }}', from: 'host' }] })
    bad((p) => { p.deployments[0].urls = [{ url: "http://x/'\n", from: 'host' }] })
    bad((p) => { p.deployments[0].preHookB64 = '$(id)' })
    bad((p) => { p.deployments[0].envSecretKey = 'a.b' })
    bad((p) => { p.releaseId = '../..' })
    bad((p) => { p.deployments[0].previousCommit = 'abc' ; p.kind = 'rollback' })
  })

  it('carries free text in the lock only as base64', () => {
    const plan = planFixture({ actor: { osUser: 'a"{{ 1 }}', machine: "m\n#'" } })
    expect(JSON.parse(lockJson(plan))).toMatchObject({ user: 'a____1___', machine: 'm___' })
    const raw = generatePlaybook(plan)
    expect(raw).not.toContain('{{ 1 }}')
    const play = plays(plan)[0]
    expect(Buffer.from(play.vars.od ? String((play.vars.od as Record<string, string>).lock_b64) : '', 'base64').toString()).toBe(lockJson(plan))
  })

})

describe('other kinds', () => {
  it('release: lock is exclusive and reentrant', () => {
    const lock = flat(plays(planFixture())[0].tasks).filter((t) => step(t) === 'lock')[1]
    const c = cmdOf(lock)
    expect(c).toContain('set -C')
    expect(c).toContain('OD-LOCK')
    expect(c).toContain('exit 42')
    expect(c).toContain('.opsdeck-deploy.lock')
    expect(lock.tags).toContain('od_run=host:host-od-1')
    expect(lock.timeout).toBe(120)
  })

  it('rollback runs in the given order and continues past a failure', () => {
    const plan = planFixture({ kind: 'rollback' })
    plan.deployments = [plan.deployments[1], plan.deployments[0], plan.deployments[2]]
    const p = plays(plan)[0]
    expect(steps(p)).toEqual([
      'lock', 'lock',
      'rb_checkout', 'rb_build', 'rb_up', 'rb_tag',
      'rb_checkout', 'rb_env', 'rb_build', 'rb_up', 'rb_tag',
    ])
    const blocks = p.tasks.filter((t) => t.block)
    expect(blocks.map((b) => (b.vars as { d: { name: string } }).d.name)).toEqual(['dep2', 'dep1'])
    for (const b of blocks) {
      expect(b.rescue).toHaveLength(1)
      expect(b.rescue![0]).toMatchObject({ 'ansible.builtin.set_fact': { rollback_failed: true } })
    }
    const checkout = cmdOf(flat(p.tasks).find((t) => step(t) === 'rb_checkout')!)
    expect(checkout).toContain('{{ d.prev | quote }}')
  })

  it('preflight never acquires the lock and every check is read-only and tolerant', () => {
    const ps = plays(planFixture({ kind: 'preflight' }))
    for (const p of ps) for (const { t } of every(p.tasks)) {
      expect(step(t)).toBe('preflight')
      expect(t.failed_when).toBe(false)
      expect(t.timeout).toBe(60)
      expect(cmdOf(t)).not.toContain('set -C')
      expect(cmdOf(t)).not.toContain('printf')
    }
    const all = ps.flatMap((p) => every(p.tasks).map(({ t }) => cmdOf(t))).join('\n')
    for (const needle of ['command -v', 'docker info', '.git', 'git update-index -q --refresh', 'git diff-index --quiet HEAD --', 'git fetch --force --tags origin', 'show-ref --verify', 'df -Pk', '.opsdeck-deploy.lock', '--max-count=501', '%H%x1f%s%x1f%an%x1f%aI%x1e', 'OD-PF']) expect(all).toContain(needle)
    expect(all).toContain('pg_dump')
    expect(all).toContain('R="$c..origin/$B"')
  })

  it('preflight lists origin/<branch> alone when the deploy tag does not exist (decided on the host)', () => {
    const plan = planFixture({ kind: 'preflight' })
    plan.deployments[2].previousCommit = null
    const all = every(plays(plan)[1].tasks).map(({ t }) => cmdOf(t)).join('\n')
    expect(all).toContain('R="origin/$B"')
  })

  it('version tags each repo once and pushes', () => {
    const plan = planFixture({ kind: 'version' })
    plan.deployments[1].repoPath = plan.deployments[0].repoPath
    const p = plays(plan)[0]
    expect(steps(p)).toEqual(['lock', 'lock', 'version'])
    const c = cmdOf(flat(p.tasks).find((t) => step(t) === 'version')!)
    expect(c).toContain('git tag -a')
    expect(c).toContain('git push origin')
    expect(() => generatePlaybook({ ...plan, version: null })).toThrow()
  })

  it('unlock removes the lock only if ours; break-lock only if it matches; both remove the run dir', () => {
    const un = plays(planFixture({ kind: 'unlock' }))[0]
    const c = cmdOf(flat(un.tasks).find((t) => step(t) === 'unlock')!)
    expect(c).toContain('releaseId')
    expect(c).toContain('rm -f "$f"')
    expect(c).toContain('.opsdeck/runs/')
    const bl = plays(planFixture({ kind: 'break-lock', lock: { expectRaw: { 'host-od-1': 'RAW1', 'host-od-2': 'RAW2' } } }))[0]
    const t = flat(bl.tasks).find((x) => step(x) === 'unlock')!
    expect(cmdOf(t)).toContain('{{ od.expect_b64 | quote }}')
    expect((bl.vars.od as Record<string, string>).expect_b64).toBe(b64('RAW1'))
    expect(() => generatePlaybook(planFixture({ kind: 'break-lock', lock: {} }))).toThrow()
  })
})

describe('inventory, ssh_config, known_hosts, cfg', () => {
  const rundir = '/tmp/od-abc123'
  const socks = { privateAgent: '/tmp/od-abc123/p.sock', userAgent: '/tmp/user/agent.sock' }
  const block = (text: string, alias: string) => text.split(/\n(?=Host )/).find((b) => b.startsWith(`Host ${alias}\n`))!

  it('inventory holds aliases only', () => {
    expect(generateInventory(planFixture())).toBe('[deploy]\nod-1 ansible_python_interpreter=auto_silent\nod-2 ansible_python_interpreter=auto_silent\n')
  })

  it('chains ProxyJump and selects the agent per hop', () => {
    const t = generateSshConfig(planFixture(), socks, rundir)
    const b0 = block(t, 'od-0')
    const b1 = block(t, 'od-1')
    expect(b0).toContain(`IdentityAgent ${socks.userAgent}`)
    expect(b0).not.toContain('ProxyJump')
    expect(b0).not.toContain('IdentitiesOnly')
    expect(b1).toContain('ProxyJump od-0')
    expect(b1).toContain(`IdentityAgent ${socks.privateAgent}`)
    expect(b1).not.toContain('IdentitiesOnly')
    expect(b1).toContain('IdentityFile none')
    for (const b of [b0, b1]) {
      expect(b).toContain('StrictHostKeyChecking yes')
      expect(b).toContain(`UserKnownHostsFile ${rundir}/known_hosts`)
      expect(b).toContain('GlobalKnownHostsFile /dev/null')
      expect(b).toContain('PreferredAuthentications publickey')
      expect(b).toContain('PasswordAuthentication no')
      expect(b).toContain('KbdInteractiveAuthentication no')
      expect(b).toContain('BatchMode yes')
      expect(b).toContain('ServerAliveInterval 15')
      expect(b).toContain('ControlMaster auto')
      expect(b).toContain(`ControlPath ${rundir}/cp/%C`)
      expect(b).toContain('ControlPersist 60')
    }
    expect(t.match(/^Host /gm)).toHaveLength(3)
    expect(b1).toMatch(/HostName 10\.0\.0\.1\n/)
    expect(b1).toContain('User deploy')
  })

  it('default hop lists the ~/.ssh/config IdentityFiles from an injected sshConfig', () => {
    const home = '/Users/ana'
    const cfgText = 'Host label od-2\n  HostName 10.0.0.2\n  IdentityFile ~/.ssh/work_key\n  IdentityFile /keys/other\n'
    const sshConfig = (target: { label: string; address: string }) => matchSshConfig(cfgText, { home, sshDir: `${home}/.ssh` }, target)
    const plan = planFixture()
    plan.hosts[1].hops[1].label = 'label'
    plan.hosts[1].hops[1].address = '10.0.0.2'
    const t = generateSshConfig(plan, socks, rundir, { sshConfig })
    const b = block(t, 'od-2')
    const ids = b.split('\n').filter((l) => l.includes('IdentityFile')).map((l) => l.trim())
    expect(ids).toEqual(['IdentityFile /Users/ana/.ssh/work_key', 'IdentityFile /keys/other', 'IdentityFile ~/.ssh/id_ed25519', 'IdentityFile ~/.ssh/id_rsa'])
    expect(b).not.toContain('IdentitiesOnly')
    expect(b).toContain(`IdentityAgent ${socks.userAgent}`)
    // key hop never lists files
    expect(block(t, 'od-1')).not.toContain('id_ed25519')
    // paths only: no key material
    expect(t).not.toMatch(/PRIVATE KEY/)
  })

  it('does not let a label, address or path inject directives or Jinja', () => {
    const mk = (over: Partial<{ address: string; user: string; port: number }>) => {
      const plan = planFixture()
      Object.assign(plan.hosts[0].hops[1], over)
      return () => generateSshConfig(plan, socks, rundir)
    }
    expect(mk({ address: 'a\nProxyCommand evil' })).toThrow()
    expect(mk({ address: 'a #x' })).toThrow()
    expect(mk({ address: 'a"b' })).toThrow()
    expect(mk({ address: '{{ 1 }}' })).toThrow()
    expect(mk({ user: 'x\nHost *' })).toThrow()
    expect(mk({ user: '-oProxyCommand=x' })).toThrow()
    expect(mk({ port: 0 })).toThrow()
    expect(mk({ port: 22.5 })).toThrow()
    const plan = planFixture()
    plan.hosts[0].hops[1].label = 'evil\nProxyCommand x # {{ 1 }} "'
    const t = generateSshConfig(plan, socks, rundir)
    expect(t).not.toContain('evil')
    expect(t).not.toContain('ProxyCommand')
    const sshConfig = () => ({ user: null, identityFiles: ['/ok/key', '/bad path/k', '/x"\nProxyCommand y', '/a#b', '/a%d'] })
    const t2 = generateSshConfig(planFixture(), socks, rundir, { sshConfig })
    expect(t2).toContain('IdentityFile /ok/key')
    expect(t2).not.toContain('ProxyCommand')
    expect(t2).not.toContain('/bad path')
    expect(() => generateSshConfig(planFixture(), socks, '/tmp/od x\n')).toThrow()
    expect(() => generateAnsibleCfg(planFixture(), '/tmp/o"d')).toThrow()
    expect(() => generateSshConfig(planFixture(), { ...socks, privateAgent: '/tmp/x\nHost y' }, rundir)).toThrow()
  })

  it('quotes a run directory that contains a space', () => {
    const rd = '/Users/ana/Library/Application Support/od'
    const t = generateSshConfig(planFixture(), { privateAgent: '/tmp/p', userAgent: '/tmp/u' }, rd)
    expect(t).toContain(`UserKnownHostsFile "${rd}/known_hosts"`)
  })

  it('keeps the longest control socket under the 104-byte sun_path limit', () => {
    const rd = '/tmp/od-abc123'
    const longest = `${rd}/cp/${'f'.repeat(40)}.${'x'.repeat(16)}`
    expect(Buffer.byteLength(longest)).toBeLessThan(104)
    expect(socketPathFits(rd)).toBe(true)
    expect(socketPathFits('/var/folders/zz/abcdefghijklmnopqrstuvwxyz012345/T/od-abc123')).toBe(false)
    expect(socketPathFits('/' + 'a'.repeat(41))).toBe(true)
    expect(socketPathFits('/' + 'a'.repeat(42))).toBe(false)
    expect(() => generateSshConfig(planFixture(), socks, '/var/folders/zz/abcdefghijklmnopqrstuvwxyz012345/T/od-abc123')).toThrow(/socket/)
  })

  it('known_hosts uses [addr]:port tokens for non-22', () => {
    expect(knownHostsToken('10.0.0.1', 22)).toBe('10.0.0.1')
    expect(knownHostsToken('10.0.0.1', 2222)).toBe('[10.0.0.1]:2222')
    const text = generateKnownHosts([
      { token: knownHostsToken('10.0.0.1', 22), keyType: 'ssh-ed25519', keyBase64: 'AAAAC3Nz' },
      { token: knownHostsToken('h.example', 2222), keyType: 'ssh-rsa', keyBase64: 'AAAAB3Nz+/==' },
    ])
    expect(text).toBe('10.0.0.1 ssh-ed25519 AAAAC3Nz\n[h.example]:2222 ssh-rsa AAAAB3Nz+/==\n')
    expect(() => generateKnownHosts([{ token: 'a b', keyType: 'ssh-rsa', keyBase64: 'AA' }])).toThrow()
    expect(() => generateKnownHosts([{ token: 'a', keyType: 'ssh-rsa', keyBase64: 'A\nA' }])).toThrow()
  })

  it('cfg pins callback, pipelining and ssh_args', () => {
    const t = generateAnsibleCfg(planFixture(), rundir)
    expect(t).toBe(
      [
        '[defaults]',
        'stdout_callback = opsdeck_jsonl',
        `callback_plugins = ${rundir}/callback_plugins`,
        'callbacks_enabled =',
        'host_key_checking = True',
        'retry_files_enabled = False',
        'interpreter_python = auto_silent',
        'forks = 2',
        'timeout = 30',
        '[ssh_connection]',
        'pipelining = True',
        `ssh_args = -F ${rundir}/ssh_config`,
        `control_path_dir = ${rundir}/cp`,
        '',
      ].join('\n'),
    )
  })

  it('helpers sanitize', () => {
    expect(sanitizeIdent('a b/c;d')).toBe('a_b_c_d')
    expect(sanitizeIdent('x'.repeat(100))).toHaveLength(64)
  })
})

describe('fix round 1', () => {
  const PREV = (plan: DeployPlan) => plays(plan).map((p) => (p.vars.od as { lock_repos: string[] }).lock_repos)

  it('locks every repo on a host, sorted, in one task that releases what it took when one is busy', () => {
    const plan = planFixture()
    plan.deployments[1].repoPath = '/srv/apps/aaa'
    const p = plays(plan)[0]
    expect((p.vars.od as { lock_repos: string[] }).lock_repos).toEqual(['/srv/apps/aaa', `${FIX.repo}1`])
    const lock = flat(p.tasks).filter((t) => step(t) === 'lock')[1]
    const c = cmdOf(lock)
    expect(c).toContain("for r in {{ od.lock_repos | map('quote') | join(' ') }}; do")
    expect(c).toContain('set -C')
    expect(c).toContain('for a in $acq; do rm -f "$a/.opsdeck-deploy.lock"; done')
    expect(c).toContain('exit 42')
  })

  it('release, rollback (reverse order), unlock and break-lock touch the same lock set per host', () => {
    const base = planFixture()
    const rev = planFixture({ kind: 'rollback' })
    rev.deployments = [...rev.deployments].reverse()
    const raw = { 'host-od-1': 'a', 'host-od-2': 'b' }
    const sets = [
      PREV(base),
      PREV(rev),
      PREV(planFixture({ kind: 'unlock' })),
      PREV(planFixture({ kind: 'break-lock', lock: { expectRaw: raw } })),
      PREV(planFixture({ kind: 'preflight' })),
    ]
    for (const s of sets) expect(s).toEqual(sets[0])
    expect(sets[0][0]).toEqual([`${FIX.repo}1`, `${FIX.repo}2`])
  })

  it('unlock, break-lock and preflight iterate every repo', () => {
    for (const kind of ['unlock', 'break-lock', 'preflight'] as PlanKind[]) {
      const plan = planFixture({ kind, lock: { expectRaw: { 'host-od-1': 'a', 'host-od-2': 'b' } } })
      const t = every(plays(plan)[0].tasks).map(({ t }) => cmdOf(t)).find((c) => c.includes('opsdeck-deploy.lock'))!
      expect(t).toContain("for r in {{ od.lock_repos | map('quote') | join(' ') }}; do")
    }
  })

  it('backup reads DB_* without sourcing and keeps the password out of argv', () => {
    const c = cmdOf(flat(plays(planFixture())[0].tasks).find((t) => step(t) === 'backup')!)
    expect(c).toContain('while IFS= read -r')
    expect(c).toContain('printf -v "$k"')
    expect(c).not.toMatch(/(^|\n)\s*\.\s/)
  })

  it('env keeps the previous .env and rb_env restores it (or removes the new one)', () => {
    const plan = planFixture({ kind: 'rollback' })
    const rb = flat(plays(plan)[0].tasks).find((t) => step(t) === 'rb_env')!
    const m = rb['ansible.builtin.shell'] as Record<string, string>
    expect(m.stdin).toBeUndefined()
    expect(JSON.stringify(rb)).not.toMatch(/\bs\./)
    expect(rb.no_log).toBeUndefined()
    expect(m.cmd).toContain('mv -f .env.opsdeck-prev .env')
    expect(m.cmd).toContain('.env.opsdeck-none')
    expect(m.cmd).toContain('rm -f .env')
  })

  it('rb_env acts only when .env.opsdeck-rel names this release, and cleans up', () => {
    const rb = flat(plays(planFixture({ kind: 'rollback' }))[0].tasks).find((t) => step(t) === 'rb_env')!
    const c = cmdOf(rb)
    expect(c).toContain('if [ "$(cat .env.opsdeck-rel 2>/dev/null)" = {{ od.rel | quote }} ]; then')
    expect(c).toContain('OD-ENV skipped')
    expect(c).toContain('rm -f .env.opsdeck-rel .env.opsdeck-prev .env.opsdeck-none')
    // the restore sits inside the guard
    expect(c.indexOf('mv -f .env.opsdeck-prev .env')).toBeGreaterThan(c.indexOf('if [ "$(cat'))
    expect(c.indexOf('mv -f .env.opsdeck-prev .env')).toBeLessThan(c.indexOf('OD-ENV skipped'))
  })

  it('checks the rel marker write and the backup mv, and flags unknown commits', () => {
    const all = every(plays(planFixture())[0].tasks).map(({ t }) => cmdOf(t)).join('\n')
    expect(all).toContain('> .env.opsdeck-rel || exit 1')
    expect(all).toContain('mv -f "$F.part" "$F" || exit 1')
    const pf = every(plays(planFixture({ kind: 'preflight' }))[0].tasks).map(({ t }) => cmdOf(t)).join('\n')
    expect(pf).toContain('OD-PF commits unknown')
    expect(pf).toContain('if [ "$ok" = 0 ]; then echo "OD-PF commits unknown"; else')
  })

  it('ls-remote failure is reported as unknown, not as no tag', () => {
    const rec = cmdOf(flat(plays(planFixture())[0].tasks).find((t) => step(t) === 'record')!)
    expect(rec).toContain('OD-PREV unknown')
    const pf = every(plays(planFixture({ kind: 'preflight' }))[0].tasks).map(({ t }) => cmdOf(t)).join('\n')
    expect(pf).toContain('OD-PF tag exists=unknown')
  })

  it('tag and rb_tag are annotated, forced and pushed; OD-PREV and the range read origin', () => {
    const rel = flat(plays(planFixture())[0].tasks).find((t) => step(t) === 'tag')!
    expect(cmdOf(rel)).toContain('git tag -fa "$T" -m "OpsDeck deploy" HEAD && git push -f origin "refs/tags/$T"')
    const rb = flat(plays(planFixture({ kind: 'rollback' }))[0].tasks).find((t) => step(t) === 'rb_tag')!
    expect(cmdOf(rb)).toContain('git tag -fa "$T" -m "OpsDeck rollback" "$P" && git push -f origin "refs/tags/$T"')
    const rec = cmdOf(flat(plays(planFixture())[0].tasks).find((t) => step(t) === 'record')!)
    expect(rec).toContain('git ls-remote origin "refs/tags/$T" "refs/tags/$T^{}"')
    const pf = every(plays(planFixture({ kind: 'preflight' }))[0].tasks).map(({ t }) => cmdOf(t)).join('\n')
    expect(pf).toContain('git ls-remote origin "refs/tags/$T" "refs/tags/$T^{}"')
  })

  it('useSudo no never probes sudo; tag and rb_tag never fail the host and mark their failure', () => {
    const no = planFixture({ kind: 'preflight' })
    no.deployments[0].useSudo = 'no'
    const dk = every(plays(no)[0].tasks).map(({ t }) => t).find((t) => String(t.name) === 'preflight docker dep1')!
    expect(cmdOf(dk)).not.toContain('sudo -n')
    expect(cmdOf(dk)).toContain('s=skip')
    expect(cmdOf(dk)).toContain('use=no')
    const auto = every(plays(planFixture({ kind: 'preflight' }))[0].tasks).map(({ t }) => t).find((t) => String(t.name) === 'preflight docker dep1')!
    expect(cmdOf(auto)).toContain('sudo -n docker info')
    const rel = flat(plays(planFixture())[0].tasks).find((t) => step(t) === 'tag')!
    const rb = flat(plays(planFixture({ kind: 'rollback' }))[0].tasks).find((t) => step(t) === 'rb_tag')!
    for (const t of [rel, rb]) {
      expect(t.failed_when).toBe(false)
      expect(cmdOf(t)).toContain('|| echo "OD-TAG failed rc=$?"')
    }
  })

  it('the clean count is tracked files only', () => {
    const c = every(plays(planFixture({ kind: 'preflight' }))[0].tasks).map(({ t }) => cmdOf(t)).join('\n')
    expect(c).toContain('git status --porcelain --untracked-files=no')
  })

  it('no_log only where a secret value flows; become tasks stay visible', () => {
    const plan = planFixture()
    const p = plays(plan)[0]
    for (const k of ['build', 'up', 'pre_hook', 'post_hook']) for (const t of flat(p.tasks).filter((x) => step(x) === k)) expect(t.no_log, k).toBeUndefined()
    expect(flat(p.tasks).find((t) => step(t) === 'env')!.no_log).toBe(true)
    expect(p.vars.ansible_become_password).toContain('s.become_1')
    const pfs = every(plays({ ...plan, kind: 'preflight' })[0].tasks).map(({ t }) => t)
    const become = pfs.find((t) => String(t.name).startsWith('preflight docker-become'))!
    expect(become.become).toBe(true)
    expect(become.no_log).toBeUndefined()
    // no becomeSecretKey: no become probe and no password var
    const none = planFixture({ kind: 'preflight' })
    none.deployments[0].becomeSecretKey = null
    const q = plays(none)[0]
    expect(every(q.tasks).some(({ t }) => String(t.name).startsWith('preflight docker-become'))).toBe(false)
    expect(q.vars.ansible_become_password).toBeUndefined()
    // useSudo no: no become probe
    const no = planFixture({ kind: 'preflight' })
    no.deployments[0].useSudo = 'no'
    expect(every(plays(no)[0].tasks).some(({ t }) => String(t.name).startsWith('preflight docker-become'))).toBe(false)
  })

  it('rejects differing become secrets on one host and bad enums', () => {
    const a = planFixture()
    a.secretRefs.become_2 = { secretId: 'sec-2' }
    a.deployments[1].becomeSecretKey = 'become_2'
    expect(() => generatePlaybook(a)).toThrow()
    const b = planFixture()
    ;(b.deployments[0] as { docker: string }).docker = 'x"; id #'
    expect(() => generatePlaybook(b)).toThrow()
    const c = planFixture()
    ;(c.deployments[0] as { useSudo: string }).useSudo = 'maybe'
    expect(() => generatePlaybook(c)).toThrow()
  })

  it('OD-PF tools missing= is space-free', () => {
    const c = every(plays(planFixture({ kind: 'preflight' }))[0].tasks).map(({ t }) => cmdOf(t)).find((x) => x.includes('tools missing'))!
    expect(c).toContain('missing=${miss#,}')
    expect(c).toContain('miss="$miss,$t"')
  })

  it('version tag message names the environment (sanitised), not free text', () => {
    const plan = planFixture({ kind: 'version' })
    const p = plays(plan)[0]
    expect((p.vars.od as { env: string }).env).toBe('prod_east')
    expect(cmdOf(flat(p.tasks).find((t) => step(t) === 'version')!)).toContain('-m "$E release $V"')
  })

  it('the rundir length error reports bytes', () => {
    expect(() => generateAnsibleCfg(planFixture(), '/var/folders/zz/abcdefghijklmnopqrstuvwxyz012345/T/od-abc123')).toThrow(/\d+ bytes/)
  })
})

describe('.env is never sourced', () => {
  it.each(['preflight', 'release', 'rollback', 'version', 'unlock', 'break-lock'] as PlanKind[])('%s: no command sources .env', (kind) => {
    const plan = planFixture({ kind, lock: { expectRaw: { 'host-od-1': 'a', 'host-od-2': 'b' } } })
    for (const p of plays(plan))
      for (const { t } of every(p.tasks)) {
        const c = cmdOf(t)
        expect(c, kind).not.toMatch(/(^|[\s;&|(])(source|\.)\s+(\.\/)?\.env\b/)
        expect(c, kind).not.toContain('set -a')
      }
  })
})
