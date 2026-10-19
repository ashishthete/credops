import { BACKUP_DIR, COMPOSE_FILE, GIT_REF, MAX_URL, REPO_PATH, VERSION } from '../../shared/deploy'
import type { SshConfigMatch, SshConfigTarget } from '../inventory/ssh-config'
import { b64, lockJson, sanitizeIdent } from './quote'
import type { DeployPlan, PlanDeployment, PlanHop, PlanHost } from './runner'

/*
 * Pure text generation. Nothing here touches the disk, the network or a secret value: the plan holds
 * references only, and the playbook reads values from OPSDECK_SECRETS on the controller at run time.
 *
 * Injection rules. Every user-derived value is either (a) rejected here unless it matches the shared
 * validators, or (b) carried as base64 (hooks, lock content). Shell commands then read values only
 * through `{{ d.<field> | quote }}`; task names never carry user text.
 */

type Task = Record<string, unknown>
type Play = Record<string, unknown>

const SAFE_IDENT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const SHA = /^[0-9a-f]{40}$/
const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const ALIAS = /^od-\d{1,4}$/
const RELEASE_ID = /^[A-Za-z0-9-]{8,64}$/
const SSH_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/
const URL_SAFE = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/
const PATH_SAFE = /^\/[A-Za-z0-9._@+/-]*$/
const RUNDIR_SAFE = /^\/[A-Za-z0-9._@+/ -]+$/
const KEY_TYPE = /^[a-z0-9@.-]{1,64}$/
const KH_TOKEN = /^(?:\[[A-Za-z0-9.:_-]+\]:\d{1,5}|[A-Za-z0-9][A-Za-z0-9.:_-]*)$/

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`deploy plan: invalid ${what}`)
}

const LOCK_FILE = '.opsdeck-deploy.lock'
const WHEN = 'not (od_failed | default(false))'
const SECRETS_VAR = "{{ lookup('env','OPSDECK_SECRETS') | default('{}', true) | from_json }}"

// Timeouts (seconds)
const T_SHORT = 120
const T_BACKUP = 1800
const T_HOOK = 600
const T_PREFLIGHT = 60

const clampSec = (n: number, what: string): number => {
  need(Number.isInteger(n) && n >= 1 && n <= 86400, what)
  return n
}

// ---------------------------------------------------------------- plan -> validated view

/** The per-deployment variables a block binds as `d`. Only validated tokens and base64. */
function dVars(d: PlanDeployment, kind: DeployPlan['kind']): Record<string, unknown> {
  need(REPO_PATH.test(d.repoPath), 'repo path')
  need(GIT_REF.test(d.branch), 'branch')
  need(COMPOSE_FILE.test(d.composeFile), 'compose file')
  need(GIT_REF.test(d.deployTag), 'deploy tag')
  need(SAFE_IDENT.test(d.runId), 'run id')
  need(Number.isInteger(d.healthStatus) && d.healthStatus >= 100 && d.healthStatus <= 599, 'health status')
  need(d.preHookB64 === null || (B64.test(d.preHookB64) && d.preHookB64.length > 0), 'pre-hook')
  need(d.postHookB64 === null || (B64.test(d.postHookB64) && d.postHookB64.length > 0), 'post-hook')
  if (d.backup) {
    need(BACKUP_DIR.test(d.backup.dir), 'backup directory')
    need(SAFE_IDENT.test(d.backup.label), 'backup label')
  }
  for (const u of d.urls) {
    need(u.url.length <= MAX_URL && URL_SAFE.test(u.url) && !/\{|\}/.test(u.url), 'health url')
    need(u.from === 'host' || u.from === 'mac', 'health source')
  }
  if (kind === 'rollback') need(d.previousCommit !== null && SHA.test(d.previousCommit), 'previous commit')
  return {
    run: d.runId,
    name: sanitizeIdent(d.name) || 'deployment',
    repo: d.repoPath,
    branch: d.branch,
    compose: d.composeFile,
    tag: d.deployTag,
    prev: d.previousCommit ?? '',
    health_status: d.healthStatus,
    health_timeout: clampSec(d.healthTimeoutSec, 'health timeout'),
    backup_dir: d.backup?.dir ?? '',
    backup_label: d.backup?.label ?? '',
    pre_hook: d.preHookB64 ?? '',
    post_hook: d.postHookB64 ?? '',
    urls: d.urls.map((u) => ({ url: u.url, from: u.from })),
  }
}

function checkPlan(plan: DeployPlan): void {
  need(RELEASE_ID.test(plan.releaseId), 'release id')
  for (const h of plan.hosts) {
    need(ALIAS.test(h.alias), 'host alias')
    need(SAFE_IDENT.test(h.hostId), 'host id')
  }
  for (const d of plan.deployments) {
    for (const k of [d.envSecretKey, d.becomeSecretKey]) {
      if (k === null) continue
      need(SECRET_KEY.test(k) && k in plan.secretRefs, 'secret reference')
    }
  }
}

// ---------------------------------------------------------------- task builders

const tagsOf = (kind: string, run: string): string[] => [`od_step=${kind}`, `od_run=${run}`]

interface ShOpts {
  timeout: number
  chdir?: string
  become?: boolean
  noLog?: boolean
  stdin?: string
  failedWhen?: false
  guarded?: boolean
}

/** One shell task. `name` is built from the step kind and sanitized identifiers only. */
function sh(name: string, kind: string, run: string, cmd: string, o: ShOpts): Task {
  const mod: Record<string, unknown> = { cmd, executable: '/bin/bash' }
  if (o.chdir !== undefined) mod.chdir = o.chdir
  if (o.stdin !== undefined) {
    mod.stdin = o.stdin
    mod.stdin_add_newline = false
  }
  const t: Task = { name, 'ansible.builtin.shell': mod, timeout: o.timeout, tags: tagsOf(kind, run) }
  if (o.become) t.become = true
  if (o.noLog) t.no_log = true
  if (o.failedWhen === false) t.failed_when = false
  if (o.guarded) t.when = WHEN
  return t
}

const IN_REPO = '{{ d.repo }}'
const becomes = (d: PlanDeployment): boolean => d.docker !== 'plain'
/** Tasks that run under become and carry the sudo password variable must not log. */
const quiet = (d: PlanDeployment): boolean => d.docker === 'sudo-password'

/**
 * The user's home even under sudo: root's $HOME would put the log in the wrong place.
 * (`getent` is present on the Linux hosts OpsDeck deploys to; falls back to $HOME.)
 */
const LOG_SETUP = [
  'U="${SUDO_USER:-$(id -un)}"',
  'H=$(getent passwd "$U" 2>/dev/null | cut -d: -f6); H="${H:-$HOME}"',
  'L="$H/.opsdeck/runs/{{ od.rel }}/stream.log"',
  'umask 022',
].join('\n')

/**
 * Runs `body` with its output appended to stream.log, each line prefixed `<run>:<kind>\t`. The exit code
 * is the body's. On failure the step's own last 40 lines are printed so the failure carries context.
 */
function streamed(kind: string, body: string): string {
  const prefix = `{{ d.run }}:${kind}`
  return [
    LOG_SETUP,
    `(`,
    body,
    `) 2>&1 | sed -u "s/^/${prefix}\\t/" >> "$L"; rc=\${PIPESTATUS[0]}`,
    `if [ "$rc" -ne 0 ]; then grep -F "${prefix}"$'\\t' "$L" | tail -n 40; fi`,
    `exit "$rc"`,
  ].join('\n')
}

const SOURCE_ENV = 'set -a; [ -f .env ] && . ./.env; set +a'

function runOf(d: PlanDeployment): string {
  return d.runId
}
const nm = (kind: string, d: PlanDeployment): string => `${kind} ${sanitizeIdent(d.name)}`

// ---- release steps
const taskRecord = (d: PlanDeployment): Task =>
  sh(nm('record', d), 'record', runOf(d), [
    'T={{ d.tag | quote }}',
    'if p=$(git rev-parse -q --verify "refs/tags/$T^{commit}"); then echo "OD-PREV $p"; else echo "OD-PREV none"; fi',
  ].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

const taskBackup = (d: PlanDeployment): Task => {
  const body = [
    'set -a; . ./.env; set +a',
    'set -o pipefail',
    'umask 077',
    'mkdir -p {{ d.backup_dir | quote }}',
    'f={{ d.backup_dir | quote }}/{{ d.backup_label | quote }}-$(date +%Y%m%d-%H%M%S).sql.gz',
    '[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL is not set in .env"; exit 2; }',
    'pg_dump "$DATABASE_URL" | gzip > "$f" || { rm -f "$f"; exit 1; }',
    'echo "backup written: $f"',
  ].join('\n')
  return sh(nm('backup', d), 'backup', runOf(d), streamed('backup', body), { timeout: T_BACKUP, chdir: IN_REPO, guarded: true })
}

const FETCH = 'git fetch --force --tags origin "refs/heads/$B:refs/remotes/origin/$B"'
const taskFetch = (d: PlanDeployment): Task =>
  sh(nm('fetch', d), 'fetch', runOf(d), ['B={{ d.branch | quote }}', FETCH].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

const taskCheckout = (d: PlanDeployment): Task =>
  sh(nm('checkout', d), 'checkout', runOf(d), [
    'B={{ d.branch | quote }}',
    'git checkout -q -B "$B" "refs/remotes/origin/$B" || exit $?',
    'echo "OD-HEAD $(git rev-parse HEAD)"',
  ].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

/** Writes .env from the base64 secret on stdin; mode 0600 from creation. */
function envTask(kind: 'env' | 'rb_env', d: PlanDeployment): Task {
  return sh(nm(kind, d), kind, runOf(d), 'umask 077; base64 -d > .env.opsdeck-new && chmod 600 .env.opsdeck-new && mv -f .env.opsdeck-new .env', {
    timeout: T_SHORT,
    chdir: IN_REPO,
    noLog: true,
    stdin: `{{ s.${d.envSecretKey} }}`,
    guarded: true,
  })
}
const taskEnv = (d: PlanDeployment): Task => envTask('env', d)

function hookTask(kind: 'pre_hook' | 'post_hook', d: PlanDeployment): Task {
  const field = kind === 'pre_hook' ? 'pre_hook' : 'post_hook'
  return sh(nm(kind, d), kind, runOf(d), streamed(kind, `echo {{ d.${field} | quote }} | base64 -d | bash -e`), {
    timeout: T_HOOK,
    chdir: IN_REPO,
    become: becomes(d),
    noLog: quiet(d),
    guarded: true,
  })
}

function composeTask(kind: 'build' | 'up' | 'rb_build' | 'rb_up', d: PlanDeployment): Task {
  const verb = kind.endsWith('build') ? 'build' : 'up -d'
  const body = [SOURCE_ENV, `docker compose -f {{ d.compose | quote }} ${verb}`].join('\n')
  return sh(nm(kind, d), kind, runOf(d), streamed(kind, body), {
    timeout: kind.endsWith('build') ? clampSec(d.buildTimeoutSec, 'build timeout') : clampSec(d.composeTimeoutSec, 'compose timeout'),
    chdir: IN_REPO,
    become: becomes(d),
    noLog: quiet(d),
    guarded: kind.startsWith('rb_') ? false : true,
  })
}
const taskBuild = (d: PlanDeployment): Task => composeTask('build', d)
const taskUp = (d: PlanDeployment): Task => composeTask('up', d)

/** One task per URL. */
function taskHealth(d: PlanDeployment, i: number): Task {
  const u = d.urls[i]
  const timeout = clampSec(d.healthTimeoutSec, 'health timeout')
  const ref = `d.urls[${i}].url`
  if (u.from === 'mac') {
    return {
      name: `${nm('health', d)} ${i}`,
      'ansible.builtin.uri': { url: `{{ ${ref} }}`, method: 'GET', status_code: [d.healthStatus], timeout: 10 },
      delegate_to: 'localhost',
      connection: 'local',
      become: false,
      register: 'r',
      retries: Math.max(1, Math.ceil(timeout / 2)),
      delay: 2,
      until: `r.status == ${d.healthStatus}`,
      tags: tagsOf('health', runOf(d)),
      when: WHEN,
    }
  }
  const cmd = [
    `U={{ ${ref} | quote }}`,
    'end=$((SECONDS + {{ d.health_timeout }}))',
    'while :; do',
    "  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \"$U\" 2>/dev/null || true)",
    '  [ "$code" = "{{ d.health_status }}" ] && { echo "OD-HEALTH ok $code"; exit 0; }',
    '  [ "$SECONDS" -ge "$end" ] && { echo "OD-HEALTH timeout last=${code:-none}"; exit 1; }',
    '  sleep 2',
    'done',
  ].join('\n')
  return sh(`${nm('health', d)} ${i}`, 'health', runOf(d), cmd, { timeout: timeout + 30, chdir: IN_REPO, guarded: true })
}

const taskTag = (d: PlanDeployment): Task =>
  sh(nm('tag', d), 'tag', runOf(d), ['T={{ d.tag | quote }}', 'git tag -f "$T" HEAD'].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

// ---- rollback steps
const taskRbCheckout = (d: PlanDeployment): Task =>
  sh(nm('rb_checkout', d), 'rb_checkout', runOf(d), ['P={{ d.prev | quote }}', 'git checkout -q --detach "$P" || exit $?', 'echo "OD-HEAD $(git rev-parse HEAD)"'].join('\n'), {
    timeout: T_SHORT,
    chdir: IN_REPO,
    guarded: true,
  })
const taskRbEnv = (d: PlanDeployment): Task => envTask('rb_env', d)
const taskRbTag = (d: PlanDeployment): Task =>
  sh(nm('rb_tag', d), 'rb_tag', runOf(d), ['T={{ d.tag | quote }}', 'P={{ d.prev | quote }}', 'git tag -f "$T" "$P"'].join('\n'), {
    timeout: T_SHORT,
    chdir: IN_REPO,
    guarded: true,
  })

// ---- host-level steps (lock, unlock)
const hostRun = (h: PlanHost): string => `host:${h.hostId}`
const odRunDir = '"$HOME/.opsdeck/runs/{{ od.rel }}"'

function taskPrep(h: PlanHost): Task {
  const cmd = ['umask 077', `mkdir -p ${odRunDir}`, `touch ${odRunDir}/stream.log`].join('\n')
  return sh(`lock prep ${sanitizeIdent(h.alias)}`, 'lock', hostRun(h), cmd, { timeout: T_SHORT, chdir: '{{ od.lock_repo }}' })
}

/** Exclusive by `set -C` (O_EXCL); reentrant when the holder is this release; exit 42 when busy. */
function taskLock(h: PlanHost): Task {
  const cmd = [
    `f=${LOCK_FILE}`,
    'J=$(echo {{ od.lock_b64 | quote }} | base64 -d)',
    'umask 077',
    'if ( set -C; printf \'%s\' "$J" > "$f" ) 2>/dev/null; then echo "OD-LOCK $J"; exit 0; fi',
    'cur=$(cat "$f" 2>/dev/null)',
    'echo "OD-LOCK $cur"',
    'case "$cur" in *\'"releaseId":"{{ od.rel }}"\'*) exit 0;; esac',
    'exit 42',
  ].join('\n')
  return sh(`lock ${sanitizeIdent(h.alias)}`, 'lock', hostRun(h), cmd, { timeout: T_SHORT, chdir: '{{ od.lock_repo }}' })
}

function taskUnlock(h: PlanHost, breakLock: boolean): Task {
  const guard = breakLock
    ? '[ "$cur" = "$(echo {{ od.expect_b64 | quote }} | base64 -d)" ]'
    : 'case "$cur" in *\'"releaseId":"{{ od.rel }}"\'*) true;; *) false;; esac'
  const cmd = [
    `f=${LOCK_FILE}`,
    'cur=$(cat "$f" 2>/dev/null)',
    'echo "OD-LOCK $cur"',
    `if ${guard}; then rm -f ${LOCK_FILE}; echo "OD-UNLOCK released"; else echo "OD-UNLOCK kept"; ${breakLock ? 'rc=43' : 'rc=0'}; fi`,
    `rm -rf ${odRunDir}`,
    'exit "${rc:-0}"',
  ].join('\n')
  return sh(`unlock ${sanitizeIdent(h.alias)}`, 'unlock', hostRun(h), cmd, { timeout: T_SHORT, chdir: '{{ od.lock_repo }}' })
}

// ---- version
const taskVersion = (d: PlanDeployment): Task =>
  sh(nm('version', d), 'version', runOf(d), ['V={{ od.version | quote }}', 'git tag -a "$V" -m "OpsDeck release $V" && git push origin "$V"'].join('\n'), {
    timeout: T_SHORT,
    chdir: IN_REPO,
  })

// ---- preflight
function pf(d: PlanDeployment, check: string, cmd: string, o: { chdir?: boolean; become?: boolean; noLog?: boolean } = {}): Task {
  return sh(`preflight ${check} ${sanitizeIdent(d.name)}`, 'preflight', runOf(d), cmd, {
    timeout: T_PREFLIGHT,
    chdir: o.chdir === false ? undefined : IN_REPO,
    failedWhen: false,
    become: o.become,
    noLog: o.noLog,
  })
}

function preflightTasks(plan: DeployPlan, d: PlanDeployment): Task[] {
  const tools = ['git', 'docker', 'curl', ...(d.backup ? ['pg_dump'] : [])]
  const out: Task[] = []
  out.push(
    pf(d, 'tools', [`miss=""`, `for t in ${tools.join(' ')}; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done`, 'echo "OD-PF tools missing=${miss# }"'].join('\n'), { chdir: false }),
    pf(d, 'docker', [
      'docker info >/dev/null 2>&1 && p=ok || p=fail',
      'sudo -n docker info >/dev/null 2>&1 && s=ok || s=fail',
      `echo "OD-PF docker plain=$p sudo=$s mode=${d.docker} use=${d.useSudo}"`,
    ].join('\n'), { chdir: false }),
  )
  if (d.docker === 'sudo-password')
    out.push(pf(d, 'docker-become', 'if docker info >/dev/null 2>&1; then echo "OD-PF docker become=ok"; else echo "OD-PF docker become=fail"; fi', { chdir: false, become: true, noLog: true }))
  out.push(
    pf(d, 'repo', ['R={{ d.repo | quote }}', 'if [ -d "$R/.git" ]; then echo "OD-PF repo exists=1 git=1"; elif [ -d "$R" ]; then echo "OD-PF repo exists=1 git=0"; else echo "OD-PF repo exists=0 git=0"; fi'].join('\n'), { chdir: false }),
    pf(d, 'clean', ['git update-index -q --refresh', 'if git diff-index --quiet HEAD --; then echo "OD-PF clean ok=1"; else echo "OD-PF clean ok=0"; fi'].join('\n')),
    pf(d, 'fetch', [
      'B={{ d.branch | quote }}',
      `if ${FETCH} >/dev/null 2>&1; then f=1; else f=0; fi`,
      'if git show-ref --verify --quiet "refs/remotes/origin/$B"; then v=1; else v=0; fi',
      'echo "OD-PF branch fetched=$f exists=$v"',
    ].join('\n')),
    pf(d, 'compose', ['C={{ d.compose | quote }}', 'if [ -f "$C" ]; then echo "OD-PF compose exists=1"; else echo "OD-PF compose exists=0"; fi'].join('\n')),
    pf(d, 'disk', ['a=$(df -Pk . | awk \'NR==2 {print $4}\')', 'echo "OD-PF disk avail_kb=${a:-0}"'].join('\n')),
    pf(d, 'tag', [
      'T={{ d.tag | quote }}',
      'if c=$(git rev-parse -q --verify "refs/tags/$T^{commit}"); then echo "OD-PF tag exists=1 commit=$c"; else echo "OD-PF tag exists=0 commit="; fi',
    ].join('\n')),
  )
  if (plan.version !== null)
    out.push(pf(d, 'version-tag', ['V={{ od.version | quote }}', 'if git rev-parse -q --verify "refs/tags/$V" >/dev/null; then echo "OD-PF version-tag exists=1"; else echo "OD-PF version-tag exists=0"; fi'].join('\n')))
  out.push(
    pf(d, 'commits', [
      'T={{ d.tag | quote }}',
      'B={{ d.branch | quote }}',
      'if git rev-parse -q --verify "refs/tags/$T^{commit}" >/dev/null; then R="$T..origin/$B"; else R="origin/$B"; fi',
      'out=$(git log --no-merges --max-count=501 --pretty=tformat:%H%x1f%s%x1f%an%x1f%aI%x1e "$R" 2>/dev/null | base64 | tr -d \'\\n\')',
      'echo "OD-PF commits log_b64=$out"',
    ].join('\n')),
  )
  return out
}

function taskPreflightLock(h: PlanHost): Task {
  return sh(`preflight lock ${sanitizeIdent(h.alias)}`, 'preflight', hostRun(h), [
    `f=${LOCK_FILE}`,
    'if [ -f "$f" ]; then echo "OD-PF lock held=1 raw_b64=$(base64 < "$f" | tr -d \'\\n\')"; else echo "OD-PF lock held=0 raw_b64="; fi',
  ].join('\n'), { timeout: T_PREFLIGHT, chdir: '{{ od.lock_repo }}', failedWhen: false })
}

// ---------------------------------------------------------------- plays

function block(d: PlanDeployment, kind: DeployPlan['kind'], tasks: Task[], rescue: Task[]): Task {
  return { name: `deployment ${sanitizeIdent(d.name)}`, vars: { d: dVars(d, kind) }, block: tasks, rescue }
}

const rescueRelease = (d: PlanDeployment): Task[] => [
  { name: `mark failed ${sanitizeIdent(d.name)}`, 'ansible.builtin.set_fact': { od_failed: true } },
  { name: `fail ${sanitizeIdent(d.name)}`, 'ansible.builtin.fail': { msg: `OpsDeck step failed for ${sanitizeIdent(d.runId)}` } },
]
const rescueRollback = (d: PlanDeployment): Task[] => [
  { name: `rollback failed ${sanitizeIdent(d.name)}`, 'ansible.builtin.set_fact': { rollback_failed: true } },
]

function releaseTasks(d: PlanDeployment): Task[] {
  const steps: (Task | null)[] = [
    taskRecord(d),
    d.backup ? taskBackup(d) : null,
    taskFetch(d),
    taskCheckout(d),
    d.envSecretKey ? taskEnv(d) : null,
    d.preHookB64 ? hookTask('pre_hook', d) : null,
    taskBuild(d),
    taskUp(d),
    ...d.urls.map((_, i) => taskHealth(d, i)),
    d.postHookB64 ? hookTask('post_hook', d) : null,
    taskTag(d),
  ]
  return steps.filter((t): t is Task => t !== null)
}

function rollbackTasks(d: PlanDeployment): Task[] {
  const steps: (Task | null)[] = [
    taskRbCheckout(d),
    d.envSecretKey ? taskRbEnv(d) : null,
    composeTask('rb_build', d),
    composeTask('rb_up', d),
    taskRbTag(d),
  ]
  return steps.filter((t): t is Task => t !== null)
}

function playFor(plan: DeployPlan, h: PlanHost, deps: PlanDeployment[]): Play {
  const od: Record<string, unknown> = {
    rel: plan.releaseId,
    lock_repo: deps[0].repoPath,
    lock_b64: b64(lockJson(plan)),
  }
  need(REPO_PATH.test(deps[0].repoPath), 'repo path')
  if (plan.version !== null) {
    need(VERSION.test(plan.version), 'version')
    od.version = plan.version
  }
  if (plan.kind === 'break-lock') {
    const raw = plan.lock.expectRaw?.[h.hostId]
    need(typeof raw === 'string', 'expected lock content')
    od.expect_b64 = b64(raw as string)
  }
  const vars: Record<string, unknown> = { od, s: SECRETS_VAR }
  const sudo = deps.find((d) => d.docker === 'sudo-password' && d.becomeSecretKey)
  if (sudo) vars.ansible_become_password = `{{ (s.${sudo.becomeSecretKey} | b64decode) if s.${sudo.becomeSecretKey} is defined else omit }}`

  const tasks: Task[] = []
  switch (plan.kind) {
    case 'release':
      tasks.push(taskPrep(h), taskLock(h))
      for (const d of deps) tasks.push(block(d, plan.kind, releaseTasks(d), rescueRelease(d)))
      break
    case 'rollback':
      tasks.push(taskPrep(h), taskLock(h))
      for (const d of deps) tasks.push(block(d, plan.kind, rollbackTasks(d), rescueRollback(d)))
      break
    case 'preflight':
      tasks.push(taskPreflightLock(h))
      for (const d of deps) tasks.push(block(d, plan.kind, preflightTasks(plan, d), []))
      break
    case 'version': {
      need(plan.version !== null, 'version')
      tasks.push(taskPrep(h), taskLock(h))
      const seen = new Set<string>()
      for (const d of deps) {
        if (seen.has(d.repoPath)) continue
        seen.add(d.repoPath)
        tasks.push(block(d, plan.kind, [taskVersion(d)], []))
      }
      break
    }
    case 'unlock':
    case 'break-lock':
      tasks.push(taskUnlock(h, plan.kind === 'break-lock'))
      break
  }
  return { name: `${plan.kind} ${sanitizeIdent(h.alias)}`, hosts: h.alias, gather_facts: false, strategy: 'linear', vars, tasks }
}

const depsOf = (plan: DeployPlan, h: PlanHost): PlanDeployment[] => plan.deployments.filter((d) => d.hostId === h.hostId)

export function generatePlaybook(plan: DeployPlan): string {
  checkPlan(plan)
  const plays: Play[] = []
  for (const h of plan.hosts) {
    const deps = depsOf(plan, h)
    if (deps.length === 0) continue
    plays.push(playFor(plan, h, deps))
  }
  return JSON.stringify(plays, null, 2)
}

// ---------------------------------------------------------------- inventory

export function generateInventory(plan: DeployPlan): string {
  const lines = plan.hosts.map((h) => {
    need(ALIAS.test(h.alias), 'host alias')
    return `${h.alias} ansible_python_interpreter=auto_silent`
  })
  return `[deploy]\n${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- ssh_config

const MAX_SOCKET = 103
const CP_AND_SUFFIX = 4 + 40 + 17

/** The longest control socket is `<rundir>/cp/<40 hex>` plus ssh's 17-byte temp suffix; macOS allows 103 bytes. */
export function socketPathFits(rundir: string): boolean {
  return Buffer.byteLength(rundir) + CP_AND_SUFFIX <= MAX_SOCKET
}

function checkRundir(rundir: string): void {
  need(RUNDIR_SAFE.test(rundir) && !rundir.includes('..') && !rundir.endsWith('/'), 'run directory')
  if (!socketPathFits(rundir)) throw new Error(`run directory is too long for a control socket (${rundir.length} bytes); use a shorter one such as /tmp/od-XXXXXX`)
}

/** A path as an ssh_config / ssh argument value: bare when plain, double-quoted when it holds a space. */
function pathValue(p: string): string {
  return p.includes(' ') ? `"${p}"` : p
}

export interface SshConfigOptions {
  /** The user's own ~/.ssh/config, injected; the default reads nothing. */
  sshConfig?: (target: SshConfigTarget) => SshConfigMatch | null
}

const DEFAULT_KEYS = ['~/.ssh/id_ed25519', '~/.ssh/id_rsa']

function hopBlock(hop: PlanHop, prev: PlanHop | null, socks: { privateAgent: string | null; userAgent: string | null }, rundir: string, opts: SshConfigOptions): string {
  need(ALIAS.test(hop.alias), 'hop alias')
  need(SSH_ADDRESS.test(hop.address), 'hop address')
  need(SSH_USER.test(hop.user), 'hop user')
  need(Number.isInteger(hop.port) && hop.port >= 1 && hop.port <= 65535, 'hop port')
  const lines = [`Host ${hop.alias}`, `  HostName ${hop.address}`, `  Port ${hop.port}`, `  User ${hop.user}`]
  if (prev) lines.push(`  ProxyJump ${prev.alias}`)
  if (hop.auth === 'key') {
    need(socks.privateAgent !== null && PATH_SAFE.test(socks.privateAgent.replace(/ /g, '')), 'private agent socket')
    lines.push(`  IdentityAgent ${pathValue(socks.privateAgent!)}`, '  IdentitiesOnly yes', '  IdentityFile none')
  } else {
    if (socks.userAgent === null) lines.push('  IdentityAgent none')
    else {
      need(PATH_SAFE.test(socks.userAgent.replace(/ /g, '')), 'agent socket')
      lines.push(`  IdentityAgent ${pathValue(socks.userAgent)}`)
    }
    const fromConfig = opts.sshConfig?.({ label: hop.label, address: hop.address })?.identityFiles ?? []
    const seen = new Set<string>()
    for (const f of [...fromConfig, ...DEFAULT_KEYS]) {
      if (seen.has(f) || !(f.startsWith('~/') ? PATH_SAFE.test(f.slice(1)) : PATH_SAFE.test(f)) || f.includes('%')) continue
      seen.add(f)
      lines.push(`  IdentityFile ${f}`)
    }
  }
  lines.push(
    '  PreferredAuthentications publickey',
    '  PasswordAuthentication no',
    '  KbdInteractiveAuthentication no',
    '  BatchMode yes',
    '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${pathValue(`${rundir}/known_hosts`)}`,
    '  GlobalKnownHostsFile /dev/null',
    '  ServerAliveInterval 15',
    '  ControlMaster auto',
    `  ControlPath ${pathValue(`${rundir}/cp/%C`)}`,
    '  ControlPersist 60',
  )
  return lines.join('\n')
}

export function generateSshConfig(
  plan: DeployPlan,
  socks: { privateAgent: string | null; userAgent: string | null },
  rundir: string,
  opts: SshConfigOptions = {},
): string {
  checkRundir(rundir)
  const blocks = new Map<string, { hop: PlanHop; prev: PlanHop | null }>()
  for (const h of plan.hosts)
    h.hops.forEach((hop, i) => {
      const prev = i > 0 ? h.hops[i - 1] : null
      const have = blocks.get(hop.alias)
      if (have && (have.prev?.alias !== prev?.alias || have.hop.address !== hop.address || have.hop.port !== hop.port || have.hop.user !== hop.user || have.hop.auth !== hop.auth))
        throw new Error(`deploy plan: alias ${hop.alias} is used for two different hops`)
      if (!have) blocks.set(hop.alias, { hop, prev })
    })
  return [...blocks.values()].map(({ hop, prev }) => hopBlock(hop, prev, socks, rundir, opts)).join('\n\n') + '\n'
}

// ---------------------------------------------------------------- known_hosts, cfg

/** known_hosts matches a non-22 port as `[addr]:port`. */
export function knownHostsToken(address: string, port: number): string {
  need(SSH_ADDRESS.test(address) && Number.isInteger(port) && port >= 1 && port <= 65535, 'known_hosts host')
  return port === 22 ? address : `[${address}]:${port}`
}

export function generateKnownHosts(entries: { token: string; keyType: string; keyBase64: string }[]): string {
  return entries
    .map((e) => {
      need(KH_TOKEN.test(e.token), 'known_hosts token')
      need(KEY_TYPE.test(e.keyType), 'key type')
      need(e.keyBase64.length > 0 && B64.test(e.keyBase64), 'host key')
      return `${e.token} ${e.keyType} ${e.keyBase64}`
    })
    .join('\n')
    .concat(entries.length ? '\n' : '')
}

export function generateAnsibleCfg(plan: DeployPlan, rundir: string): string {
  checkRundir(rundir)
  const forks = Math.max(1, Math.min(plan.hosts.length, 10))
  return [
    '[defaults]',
    'stdout_callback = opsdeck_jsonl',
    `callback_plugins = ${rundir}/callback_plugins`,
    'callbacks_enabled =',
    'host_key_checking = True',
    'retry_files_enabled = False',
    'interpreter_python = auto_silent',
    `forks = ${forks}`,
    'timeout = 30',
    '[ssh_connection]',
    'pipelining = True',
    `ssh_args = -F ${pathValue(`${rundir}/ssh_config`)}`,
    `control_path_dir = ${rundir}/cp`,
    '',
  ].join('\n')
}
