import { BACKUP_DIR, COMPOSE_AUTO, COMPOSE_FILE, COMPOSE_PROJECT, GIT_REF, MAX_URL, REPO_PATH, RUNS_SUBDIR, VERSION } from '../../shared/deploy'
import { MAX_SERVICES } from '../../shared/services'
import { checkComposeServices, composeCommand } from './compose'
import { ALIAS, B64, b64, lockJson, need, sanitizeIdent } from './quote'
import type { DeployPlan, PlanDeployment, PlanHost } from './runner'

export { generateAnsibleCfg, generateInventory, generateKnownHosts, generateSshConfig, knownHostsToken, socketPathFits } from './ssh-files'
export type { SshConfigOptions } from './ssh-files'

/*
 * Pure text generation. Nothing here touches the disk, the network or a secret value: the plan holds
 * references only, and the playbook reads values from OPSDECK_SECRETS on the controller at run time.
 *
 * Injection rules. Every user-derived value is either (a) rejected here unless it matches the shared
 * validators, or (b) carried as base64 (hooks, lock content). Shell commands then read values only
 * through `{{ d.<field> | quote }}`, except compose command lines and commit bases, which are built here
 * from validated values: compose lines shJoin-quoted (none can hold a brace), commit bases SHA-checked hex
 * inserted unquoted. Task names never carry user text.
 */

type Task = Record<string, unknown>
type Play = Record<string, unknown>

const SAFE_IDENT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const SHA = /^[0-9a-f]{40}$/
const RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const URL_SAFE = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/

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
  need(d.docker === 'plain' || d.docker === 'sudo' || d.docker === 'sudo-password', 'docker mode')
  need(d.useSudo === 'auto' || d.useSudo === 'yes' || d.useSudo === 'no', 'sudo setting')
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
  need(d.composeProject === null || COMPOSE_PROJECT.test(d.composeProject), 'compose project')
  if (d.services !== null) {
    need(Array.isArray(d.services) && d.services.length >= 1 && d.services.length <= MAX_SERVICES, 'service list')
    checkComposeServices(d.services)
  }
  const bases = d.commitBases
  need(
    typeof bases?.tag === 'boolean' && Array.isArray(bases.shas) && bases.shas.length <= MAX_SERVICES && bases.shas.every((x) => typeof x === 'string' && SHA.test(x)),
    'commit bases',
  )
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
/**
 * The user's home even under sudo: root's $HOME would put the log in the wrong place.
 * Without SUDO_USER we are the user, so $HOME is right; no getent, so BusyBox hosts work.
 */
const LOG_SETUP = [
  'U="${SUDO_USER:-}"',
  'if [ -n "$U" ]; then H=$(awk -F: -v u="$U" \'$1==u {print $6; exit}\' /etc/passwd 2>/dev/null); fi',
  'H="${H:-$HOME}"',
  `L="$H/${RUNS_SUBDIR}/{{ od.rel }}/stream.log"`,
  'umask 022',
].join('\n')

/**
 * Runs `body` with its output appended to stream.log, each line prefixed `<run>:<kind>\t` (a plain bash
 * read loop: no GNU sed -u). The exit code is the body's. On failure the step's own last 40 lines are
 * printed so the failure carries context; `post` runs only on success, outside the log.
 */
function streamed(kind: string, body: string, o: { pre?: string; post?: string } = {}): string {
  return [
    ...(o.pre ? [o.pre] : []),
    LOG_SETUP,
    `P="{{ d.run }}:${kind}"`,
    '(',
    body,
    `) 2>&1 | while IFS= read -r l || [ -n "$l" ]; do printf '%s\\t%s\\n' "$P" "$l"; done >> "$L"; rc=\${PIPESTATUS[0]}`,
    `if [ "$rc" -ne 0 ]; then grep -F "$P"$'\\t' "$L" | tail -n 40; fi`,
    ...(o.post ? [`if [ "$rc" -eq 0 ]; then ${o.post}; fi`] : []),
    'exit "$rc"',
  ].join('\n')
}

function runOf(d: PlanDeployment): string {
  return d.runId
}
const nm = (kind: string, d: PlanDeployment): string => `${kind} ${sanitizeIdent(d.name)}`

// ---- release steps
// ok=0 when ls-remote itself fails (network, auth): that is "unknown", not "no tag".
const REMOTE_TAG = [
  'if o=$(git ls-remote origin "refs/tags/$T" "refs/tags/$T^{}" 2>/dev/null); then ok=1; c=$(echo "$o" | awk \'END {print $1}\'); else ok=0; c=""; fi',
].join('\n')
const GIT_ID = 'GIT_COMMITTER_NAME=OpsDeck GIT_COMMITTER_EMAIL=opsdeck@localhost'

/** The deployed commit is read from origin (peeled), so a stale local tag or a fetch cannot change it. */
const taskRecord = (d: PlanDeployment): Task =>
  sh(nm('record', d), 'record', runOf(d), [
    'T={{ d.tag | quote }}',
    REMOTE_TAG,
    'if [ "$ok" = 0 ]; then echo "OD-PREV unknown"; elif [ -n "$c" ]; then echo "OD-PREV $c"; else echo "OD-PREV none"; fi',
  ].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

const taskBackup = (d: PlanDeployment): Task => {
  // DB_* are read as KEY=VALUE lines (quotes stripped, nothing executed): the .env is never sourced.
  const body = [
    'CR=$(printf \'\\r\')',
    'while IFS= read -r l || [ -n "$l" ]; do',
    '  l="${l%"$CR"}"',
    '  case "$l" in \'\'|\'#\'*) continue;; esac',
    '  l="${l#export }"',
    '  k="${l%%=*}"; v="${l#*=}"',
    '  case "$v" in \\"*\\") v="${v#\\"}"; v="${v%\\"}";; \\\'*\\\') v="${v#\\\'}"; v="${v%\\\'}";; esac',
    '  case "$k" in DB_USER|DB_HOST|DB_PORT|DB_NAME|DB_PASS) printf -v "$k" \'%s\' "$v";; esac',
    'done < .env',
    ': "${DB_USER:?DB_USER is not set in .env}" "${DB_HOST:?DB_HOST is not set in .env}" "${DB_NAME:?DB_NAME is not set in .env}" "${DB_PASS-}"',
    'umask 077',
    'mkdir -p {{ d.backup_dir | quote }}',
    'PGPASSWORD="$DB_PASS" pg_dump -Fc -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -f "$F.part" || { rm -f "$F.part"; exit 1; }',
    'mv -f "$F.part" "$F" || exit 1',
    'echo "backup written: $F"',
  ].join('\n')
  return sh(
    nm('backup', d),
    'backup',
    runOf(d),
    streamed('backup', body, { pre: 'F={{ d.backup_dir | quote }}/{{ d.backup_label | quote }}-{{ d.run }}.dump', post: 'echo "OD-BACKUP $F"' }),
    { timeout: T_BACKUP, chdir: IN_REPO, guarded: true },
  )
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

/**
 * Writes .env from the base64 secret on stdin; mode 0600 from creation. The previous file is kept as
 * .env.opsdeck-prev (0600), or a marker records that there was none, so rb_env can undo exactly this.
 */
const ENV_CMD = [
  'umask 077',
  'rm -f .env.opsdeck-none',
  'if [ -f .env ]; then cp -p .env .env.opsdeck-prev && chmod 600 .env.opsdeck-prev || exit 1; else rm -f .env.opsdeck-prev; : > .env.opsdeck-none; fi',
  // scopes the backup to this release: rb_env restores only when this names the release being rolled back
  "printf '%s' {{ od.rel | quote }} > .env.opsdeck-rel || exit 1",
  'base64 -d > .env.opsdeck-new && chmod 600 .env.opsdeck-new && mv -f .env.opsdeck-new .env',
].join('\n')
const RB_ENV_CMD = [
  'umask 077',
  'if [ "$(cat .env.opsdeck-rel 2>/dev/null)" = {{ od.rel | quote }} ]; then',
  '  if [ -f .env.opsdeck-prev ]; then mv -f .env.opsdeck-prev .env',
  '  elif [ -f .env.opsdeck-none ]; then rm -f .env',
  '  fi',
  '  echo "OD-ENV restored"',
  'else',
  '  echo "OD-ENV skipped: .env was not written by this release"',
  'fi',
  'rm -f .env.opsdeck-rel .env.opsdeck-prev .env.opsdeck-none',
].join('\n')

function envTask(kind: 'env' | 'rb_env', d: PlanDeployment): Task {
  if (kind === 'rb_env') return sh(nm(kind, d), kind, runOf(d), RB_ENV_CMD, { timeout: T_SHORT, chdir: IN_REPO })
  return sh(nm(kind, d), kind, runOf(d), ENV_CMD, { timeout: T_SHORT, chdir: IN_REPO, noLog: true, stdin: `{{ s.${d.envSecretKey} }}`, guarded: true })
}
const taskEnv = (d: PlanDeployment): Task => envTask('env', d)

function hookTask(kind: 'pre_hook' | 'post_hook', d: PlanDeployment): Task {
  const field = kind === 'pre_hook' ? 'pre_hook' : 'post_hook'
  return sh(nm(kind, d), kind, runOf(d), streamed(kind, `echo {{ d.${field} | quote }} | base64 -d | bash -e`), {
    timeout: T_HOOK,
    chdir: IN_REPO,
    become: becomes(d),
    guarded: true,
  })
}

const composeOf = (d: PlanDeployment) => ({ composeFile: d.composeFile, composeProject: d.composeProject })

/**
 * Build and up, for the whole checkout or for its selected services; a rollback uses the same form as the
 * release. A partial up takes --no-deps, so services that were not selected are never recreated.
 */
function composeTask(kind: 'build' | 'up' | 'rb_build' | 'rb_up', d: PlanDeployment): Task {
  const sub = kind.endsWith('build') ? ['build'] : d.services !== null ? ['up', '-d', '--no-deps'] : ['up', '-d']
  // docker compose reads the project's .env itself; the file is never sourced. Become is Ansible's: no sudo here.
  const body = composeCommand(composeOf(d), sub, d.services ?? [])
  return sh(nm(kind, d), kind, runOf(d), streamed(kind, body), {
    timeout: kind.endsWith('build') ? clampSec(d.buildTimeoutSec, 'build timeout') : clampSec(d.composeTimeoutSec, 'compose timeout'),
    chdir: IN_REPO,
    become: becomes(d),
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

const PUSH_TAG = 'git push -f origin "refs/tags/$T"'
// Tagging is best effort: the deploy already happened. The task never fails the host; a failure is
// reported through OD-TAG so the translator can warn without the playbook rescuing.
const TAG_FAILED = '|| echo "OD-TAG failed rc=$?"'
const taskTag = (d: PlanDeployment): Task =>
  sh(nm('tag', d), 'tag', runOf(d), ['T={{ d.tag | quote }}', `{ ${GIT_ID} git tag -fa "$T" -m "OpsDeck deploy" HEAD && ${PUSH_TAG}; } ${TAG_FAILED}`].join('\n'), {
    timeout: T_SHORT,
    chdir: IN_REPO,
    failedWhen: false,
    guarded: true,
  })

// ---- rollback steps
const taskRbCheckout = (d: PlanDeployment): Task =>
  sh(nm('rb_checkout', d), 'rb_checkout', runOf(d), ['P={{ d.prev | quote }}', 'git checkout -q --detach "$P" || exit $?', 'echo "OD-HEAD $(git rev-parse HEAD)"'].join('\n'), {
    timeout: T_SHORT,
    chdir: IN_REPO,
    guarded: true,
  })
const taskRbEnv = (d: PlanDeployment): Task => envTask('rb_env', d)
const taskRbTag = (d: PlanDeployment): Task =>
  sh(nm('rb_tag', d), 'rb_tag', runOf(d), ['T={{ d.tag | quote }}', 'P={{ d.prev | quote }}', `{ ${GIT_ID} git tag -fa "$T" -m "OpsDeck rollback" "$P" && ${PUSH_TAG}; } ${TAG_FAILED}`].join('\n'), {
    timeout: T_SHORT,
    chdir: IN_REPO,
    failedWhen: false,
    guarded: true,
  })

// ---- host-level steps (lock, unlock)
const hostRun = (h: PlanHost): string => `host:${h.hostId}`
const odRunDir = `"$HOME/${RUNS_SUBDIR}/{{ od.rel }}"`

const REPOS = "{{ od.lock_repos | map('quote') | join(' ') }}"
const HOST_CWD = '/'

function taskPrep(h: PlanHost): Task {
  const cmd = ['umask 077', `mkdir -p ${odRunDir}`, `touch ${odRunDir}/stream.log`].join('\n')
  return sh(`lock prep ${sanitizeIdent(h.alias)}`, 'lock', hostRun(h), cmd, { timeout: T_SHORT, chdir: HOST_CWD })
}

/**
 * Takes the lock in every repo of the host (sorted by the caller). Exclusive by `set -C` (O_EXCL);
 * reentrant per repo when the holder is this release. On a busy repo it releases what this task took and
 * exits 42, so a refusal never leaves a partial lock set behind.
 */
function taskLock(h: PlanHost): Task {
  const cmd = [
    'J=$(echo {{ od.lock_b64 | quote }} | base64 -d)',
    'umask 077',
    'acq=""',
    `for r in ${REPOS}; do`,
    `  f="$r/${LOCK_FILE}"`,
    '  if ( set -C; printf \'%s\' "$J" > "$f" ) 2>/dev/null; then acq="$acq $r"; echo "OD-LOCK $J"; continue; fi',
    '  cur=$(cat "$f" 2>/dev/null)',
    '  echo "OD-LOCK $cur"',
    '  case "$cur" in *\'"releaseId":"{{ od.rel }}"\'*) continue;; esac',
    `  for a in $acq; do rm -f "$a/${LOCK_FILE}"; done`,
    '  [ -n "$cur" ] && exit 42',
    '  echo "OD-LOCK-ERROR cannot create the lock in $r"; exit 2',
    'done',
    'exit 0',
  ].join('\n')
  return sh(`lock ${sanitizeIdent(h.alias)}`, 'lock', hostRun(h), cmd, { timeout: T_SHORT, chdir: HOST_CWD })
}

/** Unlock releases only locks this release holds; break-lock only locks whose content equals the expected raw. */
function taskUnlock(h: PlanHost, breakLock: boolean): Task {
  const guard = breakLock
    ? '[ "$cur" = "$(echo {{ od.expect_b64 | quote }} | base64 -d)" ]'
    : 'case "$cur" in *\'"releaseId":"{{ od.rel }}"\'*) true;; *) false;; esac'
  const cmd = [
    'rc=0',
    `for r in ${REPOS}; do`,
    `  f="$r/${LOCK_FILE}"`,
    '  cur=$(cat "$f" 2>/dev/null)',
    '  [ -n "$cur" ] || continue',
    '  echo "OD-LOCK $cur"',
    `  if ${guard}; then rm -f "$f"; echo "OD-UNLOCK released $r"; else echo "OD-UNLOCK kept $r"; ${breakLock ? 'rc=43' : ':'}; fi`,
    'done',
    `rm -rf ${odRunDir}`,
    'exit "$rc"',
  ].join('\n')
  return sh(`unlock ${sanitizeIdent(h.alias)}`, 'unlock', hostRun(h), cmd, { timeout: T_SHORT, chdir: HOST_CWD })
}

// ---- version
const taskVersion = (d: PlanDeployment): Task =>
  sh(nm('version', d), 'version', runOf(d), ['V={{ od.version | quote }}', 'E={{ od.env | quote }}', `${GIT_ID} git tag -a "$V" -m "$E release $V" && git push origin "$V"`].join('\n'), {
    timeout: T_SHORT,
    chdir: IN_REPO,
  })

// ---- preflight
function pf(d: PlanDeployment, check: string, cmd: string, o: { chdir?: boolean; become?: boolean } = {}): Task {
  return sh(`preflight ${check} ${sanitizeIdent(d.name)}`, 'preflight', runOf(d), cmd, {
    timeout: T_PREFLIGHT,
    chdir: o.chdir === false ? undefined : IN_REPO,
    failedWhen: false,
    become: o.become,
  })
}

function preflightTasks(plan: DeployPlan, d: PlanDeployment): Task[] {
  const tools = ['git', 'docker', 'curl', ...(d.backup ? ['pg_dump'] : [])]
  const out: Task[] = []
  out.push(
    pf(d, 'tools', [`miss=""`, `for t in ${tools.join(' ')}; do command -v "$t" >/dev/null 2>&1 || miss="$miss,$t"; done`, 'echo "OD-PF tools missing=${miss#,}"'].join('\n'), { chdir: false }),
    pf(d, 'docker', [
      'docker info >/dev/null 2>&1 && p=ok || p=fail',
      d.useSudo === 'no' ? 's=skip' : 'sudo -n docker info >/dev/null 2>&1 && s=ok || s=fail',
      `echo "OD-PF docker plain=$p sudo=$s mode=${d.docker} use=${d.useSudo}"`,
    ].join('\n'), { chdir: false }),
  )
  if (d.becomeSecretKey !== null && d.useSudo !== 'no')
    out.push(pf(d, 'docker-become', 'if docker info >/dev/null 2>&1; then echo "OD-PF docker become=ok"; else echo "OD-PF docker become=fail"; fi', { chdir: false, become: true }))
  out.push(
    pf(d, 'repo', ['R={{ d.repo | quote }}', 'if [ -d "$R/.git" ]; then echo "OD-PF repo exists=1 git=1"; elif [ -d "$R" ]; then echo "OD-PF repo exists=1 git=0"; else echo "OD-PF repo exists=0 git=0"; fi'].join('\n'), { chdir: false }),
    pf(d, 'clean', ['git update-index -q --refresh', 'if git diff-index --quiet HEAD --; then echo "OD-PF clean ok=1"; else echo "OD-PF clean ok=0 files=$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d \' \')"; fi'].join('\n')),
    pf(d, 'fetch', [
      'B={{ d.branch | quote }}',
      `if ${FETCH} >/dev/null 2>&1; then f=1; else f=0; fi`,
      'if git show-ref --verify --quiet "refs/remotes/origin/$B"; then v=1; else v=0; fi',
      'echo "OD-PF branch fetched=$f exists=$v"',
    ].join('\n')),
    pf(d, 'compose', [
      ...(d.composeFile === COMPOSE_AUTO
        ? ['if [ -f compose.yaml ] || [ -f compose.yml ] || [ -f docker-compose.yaml ] || [ -f docker-compose.yml ]; then']
        : ['C={{ d.compose | quote }}', 'if [ -f "$C" ]; then']),
      `  s=$(${composeCommand(composeOf(d), ['config', '--services'], [], { sudo: 'auto' })} 2>/dev/null | base64 | tr -d '\\n')`,
      '  echo "OD-PF compose exists=1 services_b64=$s"',
      'else echo "OD-PF compose exists=0"; fi',
    ].join('\n')),
    pf(d, 'disk', ['a=$(df -Pk . | awk \'NR==2 {print $4}\')', 'echo "OD-PF disk avail_kb=${a:-0}"'].join('\n')),
    pf(d, 'tag', [
      'T={{ d.tag | quote }}',
      REMOTE_TAG,
      'if [ "$ok" = 0 ]; then echo "OD-PF tag exists=unknown commit="; elif [ -n "$c" ]; then echo "OD-PF tag exists=1 commit=$c"; else echo "OD-PF tag exists=0 commit="; fi',
    ].join('\n')),
  )
  // Partial checkouts only: --no-deps won't start what the selection depends on, so preflight warns.
  if (d.services !== null)
    out.push(pf(d, 'deps', [
      `c=$(${composeCommand(composeOf(d), ['config', '--no-interpolate', '--format', 'json'], [], { sudo: 'auto' })} 2>/dev/null | base64 | tr -d '\\n')`,
      `p=$(${composeCommand(composeOf(d), ['ps', '--status', 'running', '--format', 'json'], [], { sudo: 'auto' })} 2>/dev/null | base64 | tr -d '\\n')`,
      'echo "OD-PF deps config_b64=$c ps_b64=$p"',
    ].join('\n')))
  if (plan.version !== null)
    out.push(pf(d, 'version-tag', ['V={{ od.version | quote }}', 'if git rev-parse -q --verify "refs/tags/$V" >/dev/null; then echo "OD-PF version-tag exists=1"; else echo "OD-PF version-tag exists=0"; fi'].join('\n')))
  out.push(pf(d, 'commits', commitsCmd(d)))
  return out
}

/**
 * The commits to deploy. With commit bases, the range starts at their merge-base (plus the tag's commit when
 * `tag`), so a service deployed further back shows its commits too; when merge-base fails, or there are no
 * bases, it is the tag range: tag commit..origin/<branch>, or all of origin/<branch> on a first deploy.
 */
function commitsCmd(d: PlanDeployment): string {
  const { shas, tag } = d.commitBases
  const LOG = [
    '  out=$(git log --no-merges --max-count=501 --pretty=tformat:%H%x1f%s%x1f%an%x1f%aI%x1e "$R" 2>/dev/null | base64 | tr -d \'\\n\')',
    '  echo "OD-PF commits log_b64=$out"',
  ]
  const TAG_RANGE = '  if [ -n "$c" ] && git cat-file -e "$c^{commit}" 2>/dev/null; then R="$c..origin/$B"; X="$c"; else R="origin/$B"; X=""; fi'
  // shas are SHA-validated in dVars: plain hex words, safe unquoted.
  const base = shas.join(' ')
  if (shas.length === 0 || tag) {
    return [
      'T={{ d.tag | quote }}',
      'B={{ d.branch | quote }}',
      REMOTE_TAG,
      'if [ "$ok" = 0 ]; then echo "OD-PF commits unknown"; else',
      TAG_RANGE,
      // $X is the tag commit or empty, and unquoted on purpose so an empty one drops out.
      ...(shas.length ? [`  if M=$(git merge-base --octopus ${base} $X 2>/dev/null) && [ -n "$M" ]; then R="$M..origin/$B"; fi`] : []),
      ...LOG,
      'fi',
    ].join('\n')
  }
  return [
    'T={{ d.tag | quote }}',
    'B={{ d.branch | quote }}',
    `if M=$(git merge-base --octopus ${base} 2>/dev/null) && [ -n "$M" ]; then ok=1; R="$M..origin/$B"; else`,
    REMOTE_TAG,
    '  if [ "$ok" = 1 ]; then',
    TAG_RANGE,
    '  fi',
    'fi',
    'if [ "$ok" = 0 ]; then echo "OD-PF commits unknown"; else',
    ...LOG,
    'fi',
  ].join('\n')
}

function taskPreflightLock(h: PlanHost): Task {
  return sh(`preflight lock ${sanitizeIdent(h.alias)}`, 'preflight', hostRun(h), [
    `for r in ${REPOS}; do`,
    `  f="$r/${LOCK_FILE}"`,
    '  if [ -f "$f" ]; then echo "OD-PF lock repo=$r held=1 raw_b64=$(base64 < "$f" | tr -d \'\\n\')"; else echo "OD-PF lock repo=$r held=0 raw_b64="; fi',
    'done',
  ].join('\n'), { timeout: T_PREFLIGHT, chdir: HOST_CWD, failedWhen: false })
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
    env: sanitizeIdent(plan.environment.name) || 'env',
    // Every repo the plan touches on this host, sorted: lock, unlock and the lock check all walk this list.
    lock_repos: [...new Set(deps.map((d) => d.repoPath))].sort(),
    lock_b64: b64(lockJson(plan)),
  }
  for (const r of od.lock_repos as string[]) need(REPO_PATH.test(r), 'repo path')
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
  // One become password per host: differing keys on one host cannot both apply.
  const keys = new Set(deps.map((d) => d.becomeSecretKey).filter((k): k is string => k !== null))
  need(keys.size <= 1, 'become secrets (one per host)')
  for (const k of keys) vars.ansible_become_password = `{{ (s.${k} | b64decode) if s.${k} is defined else omit }}`

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

