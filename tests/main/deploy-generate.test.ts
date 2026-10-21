import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { matchSshConfig } from '../../src/main/inventory/ssh-config'
import { generateAnsibleCfg, generateInventory, generateKnownHosts, generatePlaybook, generateSshConfig, knownHostsToken, socketPathFits, stepList } from '../../src/main/deploy/generate'
import { b64, lockJson, sanitizeIdent } from '../../src/main/deploy/quote'
import type { DeployPlan, PlanDeployment, PlanFlow, PlanKind, PlanStep } from '../../src/main/deploy/runner'
import { COMPOSE_AUTO, COMPOSE_FILE, ORIGIN_MOVED_MESSAGE } from '../../src/shared/deploy'
import { MAX_SERVICES } from '../../src/shared/services'
import { ENV_NAME, deniedEnvName, type StepAnchor } from '../../src/shared/steps'
import { FIX, planFixture, shellWords, stepFixture } from './deploy-helpers'

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
/** The `docker …` words of a compose step, up to the end of its line. */
const dockerWords = (cmd: string): string[] => {
  const w = shellWords(cmd)
  const at = w.indexOf('docker')
  const end = w.indexOf(';', at)
  return w.slice(at, end < 0 ? undefined : end)
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
      'record', 'backup', 'fetch', 'checkout', 'env', 'c_0', 'build', 'up', 'health', 'c_1', 'tag',
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
    expect(by('c_0')).toBe(600)
  })

  it('takes become per docker mode', () => {
    const ps = plays(planFixture())
    const t = (i: number, k: string) => flat(ps[0].tasks).filter((x) => step(x) === k)[i]
    expect(t(0, 'build').become).toBe(true)
    expect(t(0, 'c_0').become).toBe(true)
    expect(t(1, 'up').become).toBe(true)
    expect(flat(ps[1].tasks).find((x) => step(x) === 'build')!.become).toBeUndefined()
    expect(t(0, 'fetch').become).toBeUndefined()
  })

  it('streams build, up, hooks and backup into stream.log with a run:kind prefix', () => {
    const ps = plays(planFixture())
    const build = cmdOf(flat(ps[0].tasks).find((t) => step(t) === 'build')!)
    expect(dockerWords(build)).toEqual(['docker', 'compose', '-f', FIX.compose, 'build'])
    expect(build).not.toContain('sed ')
    expect(build).toContain('while IFS= read -r l')
    expect(build).toContain("printf '%s\\t%s\\n' \"$P\" \"$l\"")
    expect(build).toContain('P="{{ d.run }}:build"')
    expect(build).toContain('${PIPESTATUS[0]}')
    expect(build).toContain('tail -n 40')
    const up = cmdOf(flat(ps[0].tasks).find((t) => step(t) === 'up')!)
    expect(dockerWords(up)).toEqual(['docker', 'compose', '-f', FIX.compose, 'up', '-d'])
    const pre = cmdOf(flat(ps[0].tasks).find((t) => step(t) === 'c_0')!)
    expect(pre).toContain('od_p="{{ d.run }}:c_0"')
    expect(pre).toContain('od_s=$(echo {{ d.steps.c_0.script_b64 | quote }} | base64 -d && printf .) || exit 2')
    expect(pre).toContain('bash -e -c "$od_s"')
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

describe('origin check (skipped services)', () => {
  const H = 'c'.repeat(40)
  const withHead = (head: string | null | undefined, kind: PlanKind = 'release'): DeployPlan => {
    const p = planFixture({ kind })
    return { ...p, deployments: p.deployments.map((d, i) => (i === 0 ? { ...d, expectOriginHead: head } : d)) }
  }

  it('runs only for a checkout with skips, after the fetch and before the checkout, as part of the fetch step', () => {
    const [p] = plays(withHead(H))
    const [blk] = p.tasks.filter((t) => t.block)
    const names = flat(blk.block!).map((t) => t.name as string)
    const at = names.findIndex((n) => n.startsWith('origin check '))
    expect(at).toBeGreaterThan(names.findIndex((n) => n.startsWith('fetch ')))
    expect(at).toBeLessThan(names.findIndex((n) => n.startsWith('checkout ')))
    const t = flat(blk.block!)[at]
    expect(step(t)).toBe('fetch')
    expect(cmdOf(t)).toBe(
      [
        'B={{ d.branch | quote }}',
        'E={{ d.origin_head | quote }}',
        'h=$(git rev-parse -q --verify "refs/remotes/origin/$B^{commit}" 2>/dev/null)',
        `if [ "$h" != "$E" ]; then echo '${ORIGIN_MOVED_MESSAGE}' >&2; exit 1; fi`,
      ].join('\n'),
    )
    expect(ORIGIN_MOVED_MESSAGE).toBe('origin moved since preview, preview again')
    // the head is a var, never shell text
    expect((blk.vars as { d: Record<string, unknown> }).d.origin_head).toBe(H)
    expect(cmdOf(t)).not.toContain(H)
    const r = spawnSync('/bin/bash', ['-n'], { input: cmdOf(t).replace(/\{\{[^}]*\}\}/g, 'x'), encoding: 'utf8' })
    expect(r.status).toBe(0)
    // the other checkout has no skips: no check, no var
    const other = p.tasks.filter((x) => x.block)[1]
    expect(flat(other?.block ?? []).some((x) => (x.name as string).startsWith('origin check'))).toBe(false)
  })

  it('a release without skips is byte-identical to one that never heard of the check', () => {
    expect(generatePlaybook(withHead(null))).toBe(generatePlaybook(planFixture()))
    expect(generatePlaybook(withHead(undefined))).toBe(generatePlaybook(planFixture()))
    expect(generatePlaybook(withHead(null))).not.toContain('origin_head')
  })

  it('refuses a head that is not a sha, or one on a plan that is not a release', () => {
    expect(() => generatePlaybook(withHead('main'))).toThrow()
    expect(() => generatePlaybook(withHead(`${H}; rm -rf /`))).toThrow()
    expect(() => generatePlaybook(withHead(H, 'rollback'))).toThrow()
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

  // The compose file, project and services are validated and shJoin-quoted at generate time (deploy-compose tests).
  it('repo path, branch and tag appear in commands only inside d.<field> | quote', () => {
    const plan = planFixture()
    for (const kind of ['release', 'rollback', 'preflight', 'version'] as PlanKind[]) {
      const p = { ...plan, kind }
      for (const play of plays(p)) for (const { t } of every(play.tasks)) {
        const c = JSON.stringify(Object.values(t).filter((v) => typeof v === 'object' && v !== null))
        const bare = c.replace(/\{\{ d\.[a-z_]+(?:\[\d+\](?:\.[a-z]+)?)? \| quote \}\}/g, '')
        for (const lit of [FIX.branch, FIX.tag, ...plan.deployments.map((d) => d.repoPath)]) {
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
    // origin's head, read-only, next to the list: the one fact a skip of an unchanged service trusts
    // the remote-tracking ref in full: a fetched tag named origin/<branch> must not shadow it
    expect(pf).toContain('o=$(git rev-parse -q --verify "refs/remotes/origin/$B^{commit}" 2>/dev/null)')
    expect(pf).toContain('echo "OD-PF commits log_b64=$out origin_head=$o"')
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
    for (const k of ['build', 'up', 'c_0', 'c_1']) for (const t of flat(p.tasks).filter((x) => step(x) === k)) expect(t.no_log, k).toBeUndefined()
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

  it('the version tag step is idempotent per git repository (row 40)', () => {
    const plan = planFixture({ kind: 'version' })
    expect(plan.deployments[0].repoPath).not.toBe(plan.deployments[1].repoPath)
    const p = plays(plan)[0]
    const tagTasks = flat(p.tasks).filter((t) => step(t) === 'version')
    expect(tagTasks.length).toBeGreaterThanOrEqual(2)
    for (const t of tagTasks) {
      const c = cmdOf(t)
      // exact shape: guard (HEAD must be non-empty), a plain log line, else tag + push
      expect(c.split('\n')).toEqual([
        'V={{ od.version | quote }}',
        'E={{ od.env | quote }}',
        'h=$(git rev-parse HEAD 2>/dev/null)',
        'if [ -n "$h" ] && [ "$(git rev-parse -q --verify "refs/tags/$V^{commit}" 2>/dev/null)" = "$h" ]; then',
        '  echo "$V is already on HEAD in this repository; skipping the tag and push"',
        'else',
        expect.stringMatching(/^ {2}.*git tag -a "\$V" -m "\$E release \$V" && git push origin "\$V"$/),
        'fi',
      ])
      // not a marker line: OD-TAG means "the deploy tag failed" to the event translator
      expect(c).not.toContain('OD-TAG')
      // V reaches the shell only through `| quote`
      expect(c).toContain('V={{ od.version | quote }}')
      expect(c.replace('V={{ od.version | quote }}', '')).not.toContain('od.version')
    }
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

describe('compose service lists', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const taskOf = (plan: DeployPlan, kind: string, dep = 0): Task => {
    const runId = plan.deployments[dep].runId
    return plays(plan).flatMap((p) => flat(p.tasks)).find((t) => step(t) === kind && t.tags!.includes(`od_run=${runId}`))!
  }
  const partial = (kind: PlanKind, over: Partial<DeployPlan['deployments'][number]> = {}): DeployPlan => {
    const plan = planFixture({ kind })
    Object.assign(plan.deployments[0], { services: ['web', 'api'], ...over })
    return plan
  }
  const pfTask = (plan: DeployPlan, check: string, dep = 0): Task | undefined =>
    plays(plan).flatMap((p) => every(p.tasks).map((x) => x.t)).find((t) => t.name === `preflight ${check} ${plan.deployments[dep].name}`)

  it('whole checkout builds and ups with no service list', () => {
    const plan = planFixture()
    expect(dockerWords(cmdOf(taskOf(plan, 'build')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'build'])
    expect(dockerWords(cmdOf(taskOf(plan, 'up')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'up', '-d'])
  })

  it('partial selection builds the list and ups with --no-deps in the given order', () => {
    const plan = partial('release', { services: ['worker', 'web'] })
    expect(dockerWords(cmdOf(taskOf(plan, 'build')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'build', 'worker', 'web'])
    expect(dockerWords(cmdOf(taskOf(plan, 'up')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'up', '-d', '--no-deps', 'worker', 'web'])
    // the other checkouts stay whole; become stays Ansible's, so no sudo in the string
    expect(dockerWords(cmdOf(taskOf(plan, 'up', 1)))).toEqual(['docker', 'compose', '-f', FIX.compose, 'up', '-d'])
    expect(cmdOf(taskOf(plan, 'up'))).not.toContain('sudo')
  })

  it('rollback rebuilds in the same form the release used', () => {
    const plan = partial('rollback')
    expect(dockerWords(cmdOf(taskOf(plan, 'rb_build')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'build', 'web', 'api'])
    expect(dockerWords(cmdOf(taskOf(plan, 'rb_up')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'up', '-d', '--no-deps', 'web', 'api'])
    const whole = planFixture({ kind: 'rollback' })
    expect(dockerWords(cmdOf(taskOf(whole, 'rb_up')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'up', '-d'])
  })

  it('-p appears in build, up, rb_build and rb_up only when composeProject is set', () => {
    for (const kind of ['release', 'rollback'] as PlanKind[]) {
      const steps = kind === 'release' ? ['build', 'up'] : ['rb_build', 'rb_up']
      const set = partial(kind, { composeProject: 'shop_prod' })
      for (const k of steps) {
        const w = dockerWords(cmdOf(taskOf(set, k)))
        expect(w.slice(0, 6)).toEqual(['docker', 'compose', '-f', FIX.compose, '-p', 'shop_prod'])
        expect(w.filter((x) => x === '-p')).toHaveLength(1)
        expect(dockerWords(cmdOf(taskOf(set, k, 1)))).not.toContain('-p')
      }
    }
  })

  it('a service named --rm is refused by the generator', () => {
    for (const kind of ['release', 'rollback', 'preflight'] as PlanKind[]) {
      expect(() => generatePlaybook(partial(kind, { services: ['web', '--rm'] }))).toThrow(/compose service/)
      expect(() => generatePlaybook(partial(kind, { services: ['web', 'web'] }))).toThrow(/compose service/)
      expect(() => generatePlaybook(partial(kind, { services: [] }))).toThrow(/service list/)
      expect(() => generatePlaybook(partial(kind, { services: Array.from({ length: MAX_SERVICES + 1 }, (_, i) => `s${i}`) }))).toThrow(/service list/)
      expect(() => generatePlaybook(partial(kind, { composeProject: '-p x' }))).toThrow(/compose project/)
    }
  })

  it('deps check is emitted for partial checkouts only', () => {
    const plan = partial('preflight')
    const deps = pfTask(plan, 'deps')!
    const w = shellWords(cmdOf(deps).replace(/\{\{[^}]*\}\}/g, 'x'))
    expect(w).toContain('OD-PF deps config_b64=$c ps_b64=$p')
    const at = (seq: string[]): boolean => w.some((_, i) => seq.every((x, j) => w[i + j] === x))
    expect(at(['compose', '-f', FIX.compose, 'config', '--no-interpolate', '--format', 'json'])).toBe(true)
    expect(at(['compose', '-f', FIX.compose, 'ps', '--status', 'running', '--format', 'json'])).toBe(true)
    expect(at(['D=sudo -n docker'])).toBe(true)
    for (const dep of [1, 2]) expect(pfTask(plan, 'deps', dep)).toBeUndefined()
    expect(pfTask(planFixture({ kind: 'preflight' }), 'deps')).toBeUndefined()
    // the compose check lists the file's services for every checkout
    for (const dep of [0, 1, 2]) {
      const cw = shellWords(cmdOf(pfTask(plan, 'compose', dep)!).replace(/\{\{[^}]*\}\}/g, 'x'))
      expect(cw).toContain('OD-PF compose exists=1 services_b64=$s')
      expect(cw.join(' ')).toContain(`compose -f ${FIX.compose} config --services`)
    }
  })

  it('commits range uses merge-base of the service bases when given', () => {
    const words = (plan: DeployPlan): string[] => shellWords(cmdOf(pfTask(plan, 'commits')!).replace(/\{\{[^}]*\}\}/g, 'x'))
    const seq = (w: string[], s: string[]): boolean => w.some((_, i) => s.every((x, j) => w[i + j] === x))
    const tag = words(partial('preflight', { commitBases: { shas: [A, B], tag: true } }))
    expect(seq(tag, ['M=$(git', 'merge-base', '--octopus', A, B, '$X', '2>/dev/null)'])).toBe(true)
    expect(tag).toContain('R=$M..origin/$B')
    // the tag range stays as the fallback
    expect(tag).toContain('R=$c..origin/$B')
    const noTag = words(partial('preflight', { commitBases: { shas: [A], tag: false } }))
    expect(seq(noTag, ['M=$(git', 'merge-base', '--octopus', A, '2>/dev/null)'])).toBe(true)
    expect(noTag).not.toContain('$X')
    expect(noTag).toContain('R=$c..origin/$B')
    // no shas: today's tag logic, no merge-base
    expect(words(planFixture({ kind: 'preflight' }))).not.toContain('merge-base')
    expect(() => generatePlaybook(partial('preflight', { commitBases: { shas: ['HEAD'], tag: true } }))).toThrow(/commit bases/)
    expect(() => generatePlaybook(partial('preflight', { commitBases: { shas: [`${A};id`], tag: true } }))).toThrow(/commit bases/)
  })

  it.each(['preflight', 'release', 'rollback'] as PlanKind[])('%s with services, a project and commit bases parses with bash -n (parse only)', (kind) => {
    const plan = partial(kind, { composeProject: 'shop', commitBases: { shas: [A, B], tag: true } })
    plan.deployments[1].commitBases = { shas: [A], tag: false }
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

describe('compose file auto (row 11)', () => {
  const planWith = (kind: PlanKind, composeFile: string): DeployPlan => {
    const plan = planFixture({ kind })
    plan.deployments[0].composeFile = composeFile
    return plan
  }
  const taskNamed = (plan: DeployPlan, step_: string): Task =>
    plays(plan).flatMap((p) => flat(p.tasks)).find((t) => step(t) === step_ && t.tags!.includes(`od_run=${plan.deployments[0].runId}`))!

  it("'' omits -f from build, up, rb_build and rb_up", () => {
    for (const [kind, steps_] of [['release', ['build', 'up']], ['rollback', ['rb_build', 'rb_up']]] as [PlanKind, string[]][]) {
      const plan = planWith(kind, '')
      for (const s of steps_) {
        const words = dockerWords(cmdOf(taskNamed(plan, s)))
        expect(words.slice(0, 2), s).toEqual(['docker', 'compose'])
        expect(words, s).not.toContain('-f')
      }
    }
  })

  it('a named compose file still generates -f exactly as before', () => {
    expect(dockerWords(cmdOf(taskNamed(planWith('release', 'docker-compose.yml'), 'build')))).toEqual(['docker', 'compose', '-f', 'docker-compose.yml', 'build'])
    expect(dockerWords(cmdOf(taskNamed(planWith('release', 'docker-compose.yml'), 'up')))).toEqual(['docker', 'compose', '-f', 'docker-compose.yml', 'up', '-d'])
  })

  it("the preflight for '' checks the four default names; a named file keeps the single -f check", () => {
    const pfCmd = (cf: string): string =>
      cmdOf(plays(planWith('preflight', cf)).flatMap((p) => every(p.tasks).map((x) => x.t)).find((t) => t.name === 'preflight compose dep1')!)
    const auto = pfCmd('')
    for (const n of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) expect(auto).toContain(`[ -f ${n} ]`)
    expect(auto).not.toContain('"$C"')
    expect(auto).toContain('$D compose config')
    expect(pfCmd('docker-compose.yml')).toContain('if [ -f "$C" ]; then')
  })

  it('COMPOSE_FILE accepts the empty auto value and still rejects bad tokens', () => {
    expect(COMPOSE_FILE.test(COMPOSE_AUTO)).toBe(true)
    expect(COMPOSE_AUTO).toBe('')
    for (const bad of ['-f', '/etc/x', '../x', 'a b', '{{x}}']) expect(COMPOSE_FILE.test(bad), bad).toBe(false)
  })
})

describe('custom steps', () => {
  const ANCHORS: StepAnchor[] = ['before_fetch', 'after_checkout', 'before_build', 'after_build', 'after_up', 'after_health', 'after_tag']
  /** dep1 (backup, env, health, sudo-password docker) without hooks, with the given steps. */
  const withSteps = (steps: PlanStep[], over: Partial<DeployPlan> = {}, dep: Partial<PlanDeployment> = {}): DeployPlan => {
    const plan = planFixture(over)
    plan.deployments[0] = { ...plan.deployments[0], preHookB64: null, postHookB64: null, steps, ...dep }
    return plan
  }
  const dep1 = (plan: DeployPlan): Task & { vars: { d: Record<string, any> } } =>
    plays(plan)[0].tasks.find((t) => t.name === 'deployment dep1') as never
  const task = (plan: DeployPlan, key: string): Task => flat(dep1(plan).block!).find((t) => step(t) === key)!
  const shellOf = (t: Task) => t['ansible.builtin.shell'] as { cmd: string; chdir?: string; stdin?: string; stdin_add_newline?: boolean }

  it('puts a step at each anchor in its slot, in the order the step list gives', () => {
    const plan = withSteps(ANCHORS.map((a, i) => stepFixture(i, a)))
    expect(flat(dep1(plan).block!).map(step)).toEqual([
      'record', 'backup', 'c_0', 'fetch', 'checkout', 'c_1', 'env', 'c_2', 'build', 'c_3', 'up', 'c_4', 'health', 'c_5', 'tag', 'c_6',
    ])
    const list = stepList('release', plan.deployments).get(plan.deployments[0].runId)!
    expect(list.map((s) => s.key)).toEqual(flat(dep1(plan).block!).map(step))
    expect(list.find((s) => s.key === 'c_2')).toEqual({ key: 'c_2', kind: 'custom', label: 'step2' })
    expect(list[0]).toEqual({ key: 'record', kind: 'record', label: 'Record' })
    // health is one entry however many URLs the playbook checks
    const two = withSteps([], {}, { urls: [{ url: 'https://a.example.com/h', from: 'mac' }, { url: 'https://b.example.com/h', from: 'mac' }] })
    expect(stepList('release', two.deployments).get(two.deployments[0].runId)!.filter((s) => s.kind === 'health')).toHaveLength(1)
  })

  it('a rollback runs only the steps marked alsoOnRollback, at their anchors', () => {
    const steps = ANCHORS.map((a, i) => stepFixture(i, a, {}, { alsoOnRollback: i % 2 === 0 }))
    const plan = withSteps(steps, { kind: 'rollback' })
    expect(flat(dep1(plan).block!).map(step)).toEqual(['c_0', 'rb_checkout', 'rb_env', 'c_2', 'rb_build', 'rb_up', 'c_4', 'rb_tag', 'c_6'])
    expect(Object.keys(dep1(plan).vars.d.steps)).toEqual(['c_0', 'c_2', 'c_4', 'c_6'])
    expect(stepList('rollback', plan.deployments).get(plan.deployments[0].runId)!.map((s) => s.key)).toEqual(flat(dep1(plan).block!).map(step))
    // preflight and version run no step, so they carry none
    for (const kind of ['preflight', 'version'] as const) expect(generatePlaybook(withSteps(steps, { kind }))).not.toContain('script_b64')
  })

  it('names a step task by its key, streams it as c_<n>, and takes timeout, chdir and sudo from the step', () => {
    const plan = withSteps([
      stepFixture(0, 'after_up', { sudo: 'docker', timeoutSec: 42, cwd: '/srv/apps/alpha1/tools' }),
      stepFixture(1, 'after_up', { sudo: 'yes' }),
      stepFixture(2, 'after_up', { sudo: 'no' }),
    ])
    const t0 = task(plan, 'c_0')
    expect(t0.name).toBe('c_0 dep1')
    expect(t0.timeout).toBe(42)
    expect(t0.when).toBe('not (od_failed | default(false))')
    expect(shellOf(t0).chdir).toBe('/srv/apps/alpha1/tools')
    expect(shellOf(t0).cmd).toContain('od_p="{{ d.run }}:c_0"')
    expect(t0.become).toBe(true)
    expect(task(plan, 'c_1').become).toBe(true)
    expect(task(plan, 'c_2').become).toBeUndefined()
    expect(shellOf(task(plan, 'c_2')).chdir).toBe('{{ d.repo }}')
    // docker sudo follows the deployment's docker mode
    const plain = plays(withSteps([stepFixture(0, 'after_up')], {}, { docker: 'plain' }))[0]
    expect(flat(plain.tasks).find((t) => step(t) === 'c_0')!.become).toBeUndefined()
  })

  it('a step that continues on failure never fails the host and reports OD-STEP; so does any after_tag step', () => {
    const plan = withSteps([stepFixture(0, 'after_up', { onFailure: 'continue' }), stepFixture(1, 'after_up'), stepFixture(2, 'after_tag')])
    const c0 = task(plan, 'c_0')
    expect(c0.failed_when).toBe(false)
    // on stdout, and as a stream line the log tap reads even under no_log: only the marker and rc
    expect(shellOf(c0).cmd).toContain(`if [ "$rc" -ne 0 ]; then echo "OD-STEP rc=$rc"; printf '%s\\t%s\\n' "$od_p" "OD-STEP rc=$rc" >> "$od_l"; fi`)
    expect(task(plan, 'c_1').failed_when).toBeUndefined()
    expect(shellOf(task(plan, 'c_1')).cmd).not.toContain('OD-STEP')
    expect(task(plan, 'c_2').failed_when).toBe(false)
  })

  it('when changed and when paths skip with OD-SKIP when nothing changed since the base, globs carried as base64', () => {
    const base = 'f'.repeat(40)
    const plan = withSteps(
      [stepFixture(0, 'before_build', { when: { kind: 'changed' } }), stepFixture(1, 'before_build', { when: { kind: 'paths', paths: ['db/migrations/*', 'package.json'] } }), stepFixture(2, 'before_build')],
      {},
      { whenBase: base },
    )
    const d = dep1(plan).vars.d.steps
    expect(d.c_0).toEqual({ script_b64: b64('echo step 0'), base })
    expect(d.c_1).toEqual({ script_b64: b64('echo step 1'), base, paths_b64: b64('db/migrations/*\npackage.json') })
    expect(d.c_2).toEqual({ script_b64: b64('echo step 2') })
    const changed = shellOf(task(plan, 'c_0')).cmd
    expect(changed).toContain('od_b={{ d.steps.c_0.base | quote }}')
    expect(changed).toContain('rev-parse HEAD')
    expect(changed).toContain(`echo "OD-SKIP"; printf '%s\\t%s\\n' "$od_p" "OD-SKIP" >> "$od_l"; exit 0`)
    // a check git cannot make says so, and the step runs
    expect(changed).toContain(`printf '%s\\t%s\\n' "$od_p" "when check unavailable, running step" >> "$od_l"`)
    // dep1 runs docker under sudo, where git needs the repo marked safe
    expect(changed).toContain('git -c safe.directory={{ d.repo | quote }} -C {{ d.repo | quote }} rev-parse HEAD')
    const paths = shellOf(task(plan, 'c_1')).cmd
    expect(paths).toContain('echo {{ d.steps.c_1.paths_b64 | quote }} | base64 -d')
    expect(paths).toContain('od_a+=(":(glob)$od_g")')
    expect(paths).toContain('diff --quiet "$od_b" HEAD -- "${od_a[@]}"; then echo "OD-SKIP";')
    // the skip check runs once the log is set up and before the body, outside the streamed subshell
    expect(paths.indexOf('od_l=')).toBeLessThan(paths.indexOf('OD-SKIP'))
    expect(paths.indexOf('OD-SKIP')).toBeLessThan(paths.indexOf('\n(\n'))
    expect(JSON.stringify(dep1(plan))).not.toContain('db/migrations')
    expect(shellOf(task(plan, 'c_2')).cmd).not.toContain('OD-SKIP')
    // no base: the step always counts as changed
    expect(dep1(withSteps([stepFixture(0, 'before_build', { when: { kind: 'changed' } })])).vars.d.steps.c_0.base).toBe('')
  })

  const secretPlan = () => {
    const p = withSteps([
      stepFixture(0, 'after_up', { script: `curl -H "x: $API_TOKEN" '{{ 9*9 }}' $(whoami)`, secrets: [{ envName: 'API_TOKEN', secretId: 'sec-9' }] }, {
        secretKeys: [{ envName: 'API_TOKEN', key: 'step_1_0' }],
        paramKeys: [{ envName: 'OD_PARAM_REGION', valueB64: b64('eu-west-1;rm -rf /') }],
      }),
      stepFixture(1, 'after_up', { run: 'compose-exec', service: 'api', script: 'php artisan migrate', secrets: [{ envName: 'DB_PASSWORD', secretId: 'sec-8' }] }, {
        secretKeys: [{ envName: 'DB_PASSWORD', key: 'step_1_1' }],
      }),
      stepFixture(2, 'after_up', {}, { paramKeys: [{ envName: 'OD_PARAM_N', valueB64: b64('7') }] }),
    ])
    p.secretRefs = { ...p.secretRefs, step_1_0: { secretId: 'sec-9' }, step_1_1: { secretId: 'sec-8' } }
    return p
  }

  it('hands secrets and params to a step on stdin by reference, never in environment or argv', () => {
    const plan = secretPlan()
    const raw = generatePlaybook(plan)
    expect(raw).not.toContain('{{ 9*9 }}')
    expect(raw).not.toContain('$(whoami)')
    expect(raw).not.toContain('php artisan')
    expect(raw).not.toContain('eu-west-1')
    expect(raw).not.toContain('sec-9')
    expect(raw).not.toMatch(/"environment"/)
    const c0 = task(plan, 'c_0')
    expect(shellOf(c0).stdin).toBe('API_TOKEN={{ s.step_1_0 }}\nOD_PARAM_REGION={{ d.steps.c_0.params[0] }}\n')
    expect(shellOf(c0).stdin_add_newline).toBe(false)
    expect(c0.no_log).toBe(true)
    expect(dep1(plan).vars.d.steps.c_0.params).toEqual([b64('eu-west-1;rm -rf /')])
    // a step name or env name appears only in its stdin line
    for (const name of ['API_TOKEN', 'DB_PASSWORD', 'OD_PARAM_REGION']) expect(raw.split(name).length - 1, name).toBe(1)
    const c1 = shellOf(task(plan, 'c_1')).cmd
    expect(dockerWords(c1.slice(c1.lastIndexOf('docker compose')))).toEqual(['docker', 'compose', '-f', FIX.compose, 'exec', '-T', '${od_e[@]}', 'api', 'sh', '-c', '$od_s'])
    expect(c1).not.toMatch(/\| *docker/)
    // a step with params only is not hidden from the log: no secret flows through it
    expect(task(plan, 'c_2').no_log).toBeUndefined()
    expect(shellOf(task(plan, 'c_2')).cmd).toContain('export "$od_k=${od_x%.}"')
  })

  it('every step body parses with bash -n (parse only, nothing runs)', () => {
    const plan = secretPlan()
    plan.deployments[0].steps.push(
      stepFixture(3, 'after_build', { onFailure: 'continue', when: { kind: 'changed' } }),
      stepFixture(4, 'after_checkout', { when: { kind: 'paths', paths: ['a/**', 'b.txt'] } }),
    )
    plan.deployments[0].whenBase = 'a'.repeat(40)
    for (const kind of ['release', 'rollback'] as PlanKind[]) {
      const p = { ...plan, kind, deployments: plan.deployments.map((d) => ({ ...d, steps: d.steps.map((s) => ({ ...s, alsoOnRollback: true })) })) }
      const bodies = flat(plays(p)[0].tasks).filter((t) => /^c_\d+$/.test(step(t)))
      expect(bodies).toHaveLength(5)
      for (const t of bodies) {
        const cmd = cmdOf(t).replace(/\{\{[^}]*\}\}/g, 'x')
        const r = spawnSync('/bin/bash', ['-n'], { input: cmd, encoding: 'utf8' })
        expect(r.stderr, cmd).toBe('')
        expect(r.status).toBe(0)
      }
      expect(generatePlaybook(p).replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\{[%#]/)
    }
  })

  it('no variable the generator sets in a step body can be a step env name (a secret named E or S stays out of argv)', () => {
    const plan = secretPlan()
    plan.deployments[0].steps[1].secretKeys = [{ envName: 'E', key: 'step_1_1' }, { envName: 'S', key: 'step_1_0' }]
    plan.deployments[0].steps[1].step.secrets = [{ envName: 'E', secretId: 'sec-8' }, { envName: 'S', secretId: 'sec-9' }]
    plan.deployments[0].steps.push(stepFixture(3, 'after_build', { onFailure: 'continue', when: { kind: 'paths', paths: ['a/*'] } }), stepFixture(4, 'after_checkout', { when: { kind: 'changed' } }))
    plan.deployments[0].whenBase = 'a'.repeat(40)
    const bodies = flat(plays(plan)[0].tasks).filter((t) => /^c_\d+$/.test(step(t))).map(cmdOf)
    expect(bodies).toHaveLength(5)
    for (const cmd of bodies) {
      // assignments (`x=`, `x+=`, `IFS= read`), read targets and export targets other than the reader's own "$od_k"
      const assigned = new Set([
        ...[...cmd.matchAll(/(?:^|[\s;(])([A-Za-z_][A-Za-z0-9_]*)\+?=/gm)].map((m) => m[1]),
        ...[...cmd.matchAll(/\bread -r ([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
      ])
      expect(assigned.size).toBeGreaterThan(3)
      for (const v of assigned) expect(ENV_NAME.test(v) && !deniedEnvName(v), `${v} in ${cmd}`).toBe(false)
    }
    const c1 = shellOf(task(plan, 'c_1'))
    expect(c1.stdin).toBe('E={{ s.step_1_1 }}\nS={{ s.step_1_0 }}\n')
    expect(c1.cmd).toContain('"${od_e[@]}" api sh -c "$od_s"')
    expect(c1.cmd).not.toMatch(/\$\{?[ES]\b/)
  })

  it('a no_log step still reports OD-SKIP and OD-STEP as stream lines, with no value in them', () => {
    const plan = secretPlan()
    plan.deployments[0].steps[0].step.onFailure = 'continue'
    plan.deployments[0].steps[0].step.when = { kind: 'changed' }
    plan.deployments[0].whenBase = 'a'.repeat(40)
    const t = task(plan, 'c_0')
    expect(t.no_log).toBe(true)
    const lines = cmdOf(t).split('\n').filter((l) => l.includes('>> "$od_l"') && !l.includes('PIPESTATUS'))
    expect(lines.length).toBe(3)
    for (const l of lines) {
      const printed = [...l.matchAll(/printf '%s\\t%s\\n' "\$od_p" "([^"]*)" >> "\$od_l"/g)].map((m) => m[1])
      expect(printed.length).toBe(1)
      expect(['OD-SKIP', 'OD-STEP rc=$rc', 'when check unavailable, running step']).toContain(printed[0])
    }
  })

  it('rejects a when other than always at before_fetch, where the new commit is not fetched yet', () => {
    const plan = withSteps([stepFixture(0, 'before_fetch', { when: { kind: 'changed' } })], {}, { whenBase: 'a'.repeat(40) })
    expect(() => generatePlaybook(plan)).toThrow(/before_fetch/)
    expect(() => generatePlaybook(withSteps([stepFixture(0, 'before_fetch')]))).not.toThrow()
  })

  it('rejects step data the playbook could not carry safely', () => {
    const bad = (mut: (p: DeployPlan) => void) => {
      const p = secretPlan()
      mut(p)
      expect(() => generatePlaybook(p)).toThrow()
    }
    const s0 = (p: DeployPlan) => p.deployments[0].steps[0]
    bad((p) => { p.deployments[0].preHookB64 = b64('echo hi') })
    bad((p) => { s0(p).key = 'c_x' })
    bad((p) => { p.deployments[0].steps[1].key = 'c_0' })
    bad((p) => { s0(p).anchor = null })
    bad((p) => { s0(p).anchor = 'after_lunch' as StepAnchor })
    bad((p) => { s0(p).secretKeys[0].envName = 'LD_PRELOAD' })
    bad((p) => { s0(p).secretKeys[0].envName = 'api token' })
    bad((p) => { s0(p).secretKeys[0].key = 'step_9' })
    bad((p) => { s0(p).secretKeys[0].key = 'a.b' })
    bad((p) => { s0(p).paramKeys[0].envName = 'REGION' })
    bad((p) => { s0(p).paramKeys[0].envName = 'API_TOKEN' })
    bad((p) => { s0(p).paramKeys[0].valueB64 = '$(id)' })
    bad((p) => { s0(p).step.timeoutSec = 5 })
    bad((p) => { s0(p).step.cwd = '/srv/a b' })
    bad((p) => { s0(p).step.name = 'a b' })
    bad((p) => { s0(p).step.when = { kind: 'paths', paths: ['$(id)'] } })
    bad((p) => { p.deployments[0].steps[1].step.service = 'api;id' })
    bad((p) => { p.deployments[0].whenBase = 'HEAD' })
    bad((p) => { p.deployments[0].steps = Array.from({ length: 21 }, (_, i) => stepFixture(i, 'after_up')) })
  })
})

describe('release flow stages', () => {
  // backend (dep1, od-1) -> migrate (a step on backend's checkout) -> frontend (dep3, od-2) || fastapi (dep2, od-1)
  const flowPlan = (over: Partial<PlanFlow> = {}): DeployPlan => {
    const base = planFixture()
    const [d1, d2, d3] = base.deployments
    d1.preHookB64 = null
    d1.postHookB64 = null
    d1.services = ['backend']
    d2.services = ['fastapi']
    d3.services = ['frontend']
    const migrate = stepFixture(21, 'after_up', { name: 'migrate', script: 'echo migrate', secrets: [{ envName: 'DB_PASS', secretId: 'sec-db' }] }, {
      anchor: null,
      secretKeys: [{ envName: 'DB_PASS', key: 'FLOW_1_0' }],
    })
    return {
      ...base,
      secretRefs: { ...base.secretRefs, FLOW_1_0: { secretId: 'sec-db' } },
      flow: {
        stages: [
          { kind: 'services', parts: [{ runId: d1.runId, services: ['backend'], urls: [0] }] },
          { kind: 'step', runId: d1.runId, step: migrate },
          { kind: 'services', parts: [{ runId: d3.runId, services: ['frontend'], urls: [] }, { runId: d2.runId, services: ['fastapi'], urls: [0] }] },
        ],
        onFailure: 'stop-all',
        ...over,
      },
    }
  }
  /** od_step tags of a play's leaf tasks; untagged tasks (the gate, the stage marker) show their name. */
  const tagsOf = (p: Play): string[] => flat(p.tasks).map((t) => (t.tags ?? []).find((x) => x.startsWith('od_step='))?.slice(8) ?? `<${String(t.name)}>`)
  const blocks = (p: Play): Task[] => p.tasks.filter((t) => t.block)

  it('no flow: the release playbook is the per-host one, linear and without host vars in the inventory', () => {
    const ps = plays(planFixture())
    expect(ps.map((p) => p.strategy)).toEqual(['linear', 'linear'])
    expect(generateInventory(planFixture())).not.toContain(' od=')
  })

  it('gives a prepare play, one play per stage in flow order over its hosts, and a tag play', () => {
    const ps = plays(flowPlan())
    expect(ps.map((p) => p.name)).toEqual(['release prepare', 'release stage 0', 'release stage 1', 'release stage 2', 'release tag'])
    expect(ps.map((p) => p.hosts)).toEqual(['od-1:od-2', 'od-1', 'od-1', 'od-1:od-2', 'od-1:od-2'])
    for (const p of ps) {
      expect(p.gather_facts).toBe(false)
      expect(Object.keys(p.vars)).toEqual(['s'])
    }
    // prepare: prep and lock (both tagged lock) per host, then every checkout's prepare; no up, no tag
    expect(ps[0].tasks.filter((t) => (t.tags ?? []).includes('od_step=lock')).map((t) => t.when)).toEqual([
      "inventory_hostname == 'od-1'",
      "inventory_hostname == 'od-1'",
      "inventory_hostname == 'od-2'",
      "inventory_hostname == 'od-2'",
    ])
    const t0 = tagsOf(ps[0])
    expect(t0.filter((x) => x === 'checkout')).toHaveLength(3)
    expect(t0.filter((x) => x === 'build')).toHaveLength(3)
    expect(t0.some((x) => x === 'up' || x === 'health' || x === 'tag')).toBe(false)
    expect(t0.at(-1)).toBe('<flow play 0 done>')
    // stage 0: backend's up and health only
    expect(tagsOf(ps[1])).toEqual(['<flow gate 1>', 'up', 'health', '<flow play 1 done>'])
    // stage 1: the step alone, on backend's host
    expect(tagsOf(ps[2])).toEqual(['<flow gate 2>', 'c_21', '<flow play 2 done>'])
    expect(blocks(ps[2]).map((b) => b.when)).toEqual(["inventory_hostname == 'od-1'"])
    // stage 2: frontend on od-2 and fastapi on od-1, each bound to its host
    const b3 = blocks(ps[3])
    expect(b3.map((b) => b.name)).toEqual(['deployment dep3', 'deployment dep2'])
    expect(b3.map((b) => b.when)).toEqual(["inventory_hostname == 'od-2'", "inventory_hostname == 'od-1'"])
    expect(tagsOf(ps[3]).filter((x) => x === 'up')).toHaveLength(2)
    expect(tagsOf(ps[3]).some((x) => x === 'tag')).toBe(false)
    // tag: behind a gate, every checkout's tag, no marker after it
    expect(tagsOf(ps[4])).toEqual(['<flow gate 4>', 'tag', 'tag', 'tag'])
    expect(blocks(ps[4]).map((b) => b.name)).toEqual(['deployment dep1', 'deployment dep2', 'deployment dep3'])
    // every block and per-host task names its host
    for (const p of ps) for (const t of p.tasks) if (!String(t.name).startsWith('flow ')) expect(t.when).toMatch(/^inventory_hostname == 'od-\d+'$/)
  })

  it('ups only the stage\'s services and checks only its urls', () => {
    const ps = plays(flowPlan())
    const ups = ps.flatMap((p) => flat(p.tasks).filter((t) => (t.tags ?? []).includes('od_step=up')))
    expect(ups.map((t) => dockerWords(cmdOf(t)).slice(-2))).toEqual([['--no-deps', 'backend'], ['--no-deps', 'frontend'], ['--no-deps', 'fastapi']])
    const health = (p: Play) => flat(p.tasks).filter((t) => (t.tags ?? []).includes('od_step=health'))
    expect(ps.map((p) => health(p).length)).toEqual([0, 1, 0, 1, 0])
  })

  it('the gate stops a play when a host did not finish the one it was last in', () => {
    const ps = plays(flowPlan())
    const clause = (a: string, k: number) => `(hostvars['${a}'].od_stage | default(-1)) != ${k} or (hostvars['${a}'].od_failed | default(false))`
    expect(ps[1].tasks[0]).toEqual({
      name: 'flow gate 1',
      'ansible.builtin.fail': { msg: 'OpsDeck flow stopped: a host did not finish an earlier stage' },
      when: `${clause('od-1', 0)} or ${clause('od-2', 0)}`,
    })
    // od-2 sat stages 0 and 1 out: it is still held to the prepare play
    expect(ps[3].tasks[0].when).toBe(`${clause('od-1', 2)} or ${clause('od-2', 0)}`)
    expect(ps[4].tasks[0].when).toBe(`${clause('od-1', 3)} or ${clause('od-2', 3)}`)
    for (const p of ps.slice(1)) expect(p.tasks[0].tags).toBeUndefined()
  })

  it('stop-all runs each play linear with any_errors_fatal; continue-other-hosts runs it free without', () => {
    const stop = plays(flowPlan())
    expect(stop.every((p) => p.strategy === 'linear' && p.any_errors_fatal === true)).toBe(true)
    const cont = plays(flowPlan({ onFailure: 'continue-other-hosts' }))
    expect(cont.every((p) => p.strategy === 'free' && !('any_errors_fatal' in p))).toBe(true)
  })

  it('the playbook parses and every command passes bash -n (parse only, nothing runs)', () => {
    for (const onFailure of ['stop-all', 'continue-other-hosts'] as const)
      for (const p of plays(flowPlan({ onFailure })))
        for (const { t } of every(p.tasks)) {
          const cmd = cmdOf(t).replace(/\{\{[^}]*\}\}/g, 'x')
          if (!cmd) continue
          const r = spawnSync('/bin/bash', ['-n'], { input: cmd, encoding: 'utf8' })
          expect(r.stderr, cmd).toBe('')
          expect(r.status).toBe(0)
        }
  })

  it('the flow step reads its secret from OPSDECK_SECRETS, never inline', () => {
    const text = generatePlaybook(flowPlan())
    expect(text).toContain('FLOW_1_0')
    expect(text).not.toContain('sec-db')
    const p1 = plays(flowPlan())[2]
    const b = blocks(p1)[0] as Task & { vars: { d: { steps: Record<string, unknown> } } }
    expect(Object.keys(b.vars.d.steps)).toContain('c_21')
    for (const { t } of every(p1.tasks)) expect(t.environment ?? {}).not.toHaveProperty('DB_PASS')
  })

  it('the inventory carries od and become per host, as references only', () => {
    const plan = flowPlan()
    const inv = generateInventory(plan)
    const line = (alias: string) => inv.split('\n').find((l) => l.startsWith(`${alias} `))!
    const od = (alias: string) => JSON.parse(/ od='([^']*)'/.exec(line(alias))![1]) as Record<string, unknown>
    expect(od('od-1')).toEqual({ rel: FIX.releaseId, env: 'prod_east', lock_repos: [`${FIX.repo}1`, `${FIX.repo}2`], lock_b64: b64(lockJson(plan)), version: 'v1.2.3' })
    expect(od('od-2').lock_repos).toEqual([`${FIX.repo}3`])
    expect(line('od-1')).toContain("ansible_become_password='{{ (s.become_1 | b64decode) if s.become_1 is defined else omit }}'")
    expect(line('od-2')).not.toContain('ansible_become_password')
    // every templated value is a {{ }} reference; nothing else templated, no secret id or value
    for (const m of inv.matchAll(/\{[{%#]/g)) expect(m[0]).toBe('{{')
    expect(inv).not.toContain('sec-1')
    expect(inv).not.toContain('sec-db')
  })

  it('rejects a flow that does not partition each run, or names an unknown run', () => {
    const bad = (f: (p: DeployPlan) => void) => {
      const p = flowPlan()
      f(p)
      expect(() => generatePlaybook(p)).toThrow()
    }
    bad((p) => { p.flow!.stages.splice(2, 1) }) // dep2 and dep3 never up
    bad((p) => { (p.flow!.stages[0] as { parts: { urls: number[] }[] }).parts[0].urls = [] }) // dep1's url unchecked
    bad((p) => { (p.flow!.stages[0] as { parts: { runId: string }[] }).parts[0].runId = 'nope' })
    bad((p) => { (p.flow!.stages[1] as { step: PlanStep }).step.key = 'c_1;id' })
    bad((p) => { p.kind = 'rollback' })
  })

  it('the step list follows the flow: prepare, then stage by stage, the tag last', () => {
    const plan = flowPlan()
    const list = stepList('release', plan.deployments, plan.flow)
    expect(list.get(plan.deployments[0].runId)!.map((x) => x.key)).toEqual(['record', 'backup', 'fetch', 'checkout', 'env', 'build', 'up', 'health', 'c_21', 'tag'])
  })
})
