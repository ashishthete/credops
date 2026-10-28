import { BACKUP_DIR, COMPOSE_AUTO, COMPOSE_FILE, COMPOSE_PROJECT, GIT_REF, MAX_URL, ORIGIN_MOVED_MESSAGE, REPO_PATH, RUNS_SUBDIR, SAFE_IDENT, STEP_LABEL, type StepKind } from '../../shared/deploy'
import { MAX_SERVICES } from '../../shared/services'
import { ENV_NAME, MAX_FLOW_STAGES, MAX_STEPS_PER_CHECKOUT, STEP_ANCHORS, deniedEnvName, effectiveSteps, stepLabel, validateStep, type StepAnchor } from '../../shared/steps'
import { shJoin } from '../ops/quote'
import { checkComposeServices, composeCommand } from './compose'
import { hostBecome, hostOd } from './host-vars'
import { ALIAS, B64, SECRET_KEY, b64, need, sanitizeIdent } from './quote'
import { generateOperation } from './generate-ops'
import type { DeployPlan, PlanDeployment, PlanFlow, PlanHost, PlanStep } from './runner'

export { generateAnsibleCfg, generateInventory, generateKnownHosts, generateSshConfig, knownHostsToken, socketPathFits } from './ssh-files'
export type { SshConfigOptions } from './ssh-files'

/*
 * Pure text generation. Nothing here touches the disk, the network or a secret value: the plan holds
 * references only, and the playbook reads values from OPSDECK_SECRETS on the controller at run time.
 *
 * Injection rules. Every user-derived value is either (a) rejected here unless it matches the shared
 * validators, or (b) carried as base64 (step scripts, when paths, params, lock content). Shell commands then read values only
 * through `{{ d.<field> | quote }}`, except compose command lines and commit bases, which are built here
 * from validated values: compose lines shJoin-quoted (none can hold a brace), commit bases SHA-checked hex
 * inserted unquoted. Task names never carry user text. Step secrets and params reach the host only as
 * `NAME=<base64>` lines on stdin; the env name (ENV_NAME, not deny-listed) is the only step value in plain text.
 */

type Task = Record<string, unknown>
type Play = Record<string, unknown>

const SHA = /^[0-9a-f]{40}$/
const RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const URL_SAFE = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/

const LOCK_FILE = '.opsdeck-deploy.lock'
const WHEN = 'not (od_failed | default(false))'
export const SECRETS_VAR = "{{ lookup('env','OPSDECK_SECRETS') | default('{}', true) | from_json }}"

// Timeouts (seconds)
const T_SHORT = 120
const T_BACKUP = 1800
const T_PREFLIGHT = 60

export const clampSec = (n: number, what: string): number => {
  need(Number.isInteger(n) && n >= 1 && n <= 86400, what)
  return n
}

// ---------------------------------------------------------------- plan -> validated view

/** The per-deployment variables a block binds as `d`. Only validated tokens and base64. */
function dVars(d: PlanDeployment, kind: DeployPlan['kind'], extraSteps: readonly PlanStep[] = []): Record<string, unknown> {
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
  need(d.whenBase === null || SHA.test(d.whenBase), 'when base')
  const head = d.expectOriginHead ?? null
  need(head === null || (kind === 'release' && SHA.test(head)), 'expected origin head')
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
  const out: Record<string, unknown> = {
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
    // Hooks run as steps now; the empty keys stay so a playbook keeps its shape (G3).
    pre_hook: '',
    post_hook: '',
    urls: d.urls.map((u) => ({ url: u.url, from: u.from })),
  }
  // Only the steps this playbook runs, and only when there are any: a step-free block is unchanged.
  const run = kind === 'release' || kind === 'rollback' ? stepsRun(kind, d) : [...extraSteps]
  if (run.length > 0) out.steps = Object.fromEntries(run.map((p) => [p.key, stepVars(p, d.whenBase)]))
  // Only with skips: a block without them is unchanged.
  if (head !== null) out.origin_head = head
  return out
}

// ---------------------------------------------------------------- custom steps

export const STEP_KEY = /^c_\d{1,2}$/
const PARAM_ENV = /^OD_PARAM_[A-Z0-9_]{1,55}$/

/** A checkout's steps: the plan's, or its legacy hooks migrated by effectiveSteps (so a hook is never dropped). */
export function planSteps(d: PlanDeployment): PlanStep[] {
  if (d.steps.length > 0) {
    need(d.preHookB64 === null && d.postHookB64 === null, 'hooks next to steps')
    return d.steps
  }
  const text = (x: string | null): string | null => (x === null ? null : Buffer.from(x, 'base64').toString('utf8'))
  return effectiveSteps({ steps: [], preHook: text(d.preHookB64), postHook: text(d.postHookB64) }).map(({ anchor, alsoOnRollback, ...step }, i) => ({
    key: `c_${i}`,
    label: stepLabel(step),
    step,
    anchor,
    alsoOnRollback,
    secretKeys: [],
    paramKeys: [],
  }))
}

/** Every step a release or rollback of this checkout runs. Throws on any value the playbook could not carry safely. */
function stepsRun(kind: 'release' | 'rollback', d: PlanDeployment): PlanStep[] {
  const all = planSteps(d)
  need(all.length <= MAX_STEPS_PER_CHECKOUT, 'step count')
  const keys = new Set<string>()
  for (const p of all) {
    need(STEP_KEY.test(p.key) && !keys.has(p.key), 'step key')
    keys.add(p.key)
    need(p.anchor !== null && STEP_ANCHORS.includes(p.anchor), 'step anchor')
    need(p.anchor !== 'before_fetch' || p.step.when.kind === 'always', 'when at before_fetch')
    checkStep(p)
  }
  return kind === 'rollback' ? all.filter((p) => p.alsoOnRollback === true) : all
}

/** A step's body, env names and keys: what the playbook could not carry safely throws. */
export function checkStep(p: PlanStep): void {
  // The editor's rules. The secret ids and service passed here are the step's own, so those two checks are no-ops:
  // the real guards are checkPlan (secretRefs) and checkComposeServices.
  validateStep(p.step, { allowedSecretIds: new Set(p.step.secrets.map((x) => x.secretId)), serviceNames: p.step.service === null ? [] : [p.step.service], body: true })
  if (p.step.run === 'compose-exec') checkComposeServices([p.step.service ?? ''])
  const names = new Set<string>()
  for (const e of [...p.secretKeys.map((x) => x.envName), ...p.paramKeys.map((x) => x.envName)]) {
    need(typeof e === 'string' && !names.has(e), 'step env name')
    names.add(e)
  }
  for (const x of p.secretKeys) need(ENV_NAME.test(x.envName) && !deniedEnvName(x.envName) && SECRET_KEY.test(x.key), 'step secret')
  for (const x of p.paramKeys) need(PARAM_ENV.test(x.envName) && typeof x.valueB64 === 'string' && B64.test(x.valueB64), 'step param')
}

function stepVars(p: PlanStep, base: string | null): Record<string, unknown> {
  const v: Record<string, unknown> = { script_b64: b64(p.step.script) }
  if (p.step.when.kind !== 'always') v.base = base ?? ''
  if (p.step.when.kind === 'paths') v.paths_b64 = b64(p.step.when.paths.join('\n'))
  if (p.paramKeys.length > 0) v.params = p.paramKeys.map((x) => x.valueB64)
  return v
}

/** The order a release or rollback runs: built-in steps, with each anchor's custom steps at its place. */
const RELEASE_SLOTS = ['record', 'backup', 'before_fetch', 'fetch', 'checkout', 'after_checkout', 'env', 'before_build', 'build', 'after_build', 'up', 'after_up', 'health', 'after_health', 'tag', 'after_tag'] as const
const ROLLBACK_SLOTS = ['before_fetch', 'rb_checkout', 'after_checkout', 'rb_env', 'before_build', 'rb_build', 'after_build', 'rb_up', 'after_up', 'rb_health', 'after_health', 'rb_tag', 'after_tag'] as const
type Builtin = Exclude<(typeof RELEASE_SLOTS)[number] | (typeof ROLLBACK_SLOTS)[number], StepAnchor>
const isAnchor = (x: string): x is StepAnchor => (STEP_ANCHORS as readonly string[]).includes(x)

/** What the step order needs to know of a checkout: a PlanDeployment, or the same facts before a plan exists. */
export interface StepListDeployment {
  runId: string
  backup: object | null
  envSecretKey: string | null
  urls: readonly unknown[]
  steps: readonly Pick<PlanStep, 'key' | 'label' | 'anchor' | 'alsoOnRollback'>[]
}

type Slot<S> = { builtin: Builtin } | { step: S }

/** The one ordering both the playbook and the step list follow. A rollback runs only `alsoOnRollback` steps. */
function sequence<S extends StepListDeployment['steps'][number]>(kind: 'release' | 'rollback', d: Omit<StepListDeployment, 'steps'>, steps: readonly S[]): Slot<S>[] {
  const run = kind === 'rollback' ? steps.filter((s) => s.alsoOnRollback === true) : steps
  const has = (b: Builtin): boolean => (b === 'backup' ? d.backup !== null : b === 'env' || b === 'rb_env' ? d.envSecretKey !== null : b === 'health' || b === 'rb_health' ? d.urls.length > 0 : true)
  const out: Slot<S>[] = []
  for (const slot of kind === 'release' ? RELEASE_SLOTS : ROLLBACK_SLOTS) {
    if (isAnchor(slot)) for (const s of run) if (s.anchor === slot) out.push({ step: s })
    if (!isAnchor(slot) && has(slot)) out.push({ builtin: slot })
  }
  return out
}

type StepRef = StepListDeployment['steps'][number]
/** A flow's slots besides Slot: one services part's up (null: the whole checkout) and health URLs (indices). */
type FlowSlot<S> = Slot<S> | { up: string[] | null } | { health: number[] }

/**
 * A run's place in a release flow, as (stage, slot) pairs. Stage -1 is the prepare phase, everything before up, which
 * the first play runs for every checkout. Then, per stage the run is in: a services part ups its services and checks
 * its URLs, the run's last part adding the after_up and after_health steps; a step stage runs its step. The tag and
 * after_tag steps come after every stage (stage `flow.stages.length`), so no checkout is tagged before the whole
 * flow ran.
 */
function flowSequence<S extends StepRef>(d: Omit<StepListDeployment, 'steps'>, steps: readonly S[], flow: PlanFlow): { stage: number; slot: FlowSlot<S | PlanStep> }[] {
  const seq = sequence('release', d, steps)
  const at = seq.findIndex((x) => 'builtin' in x && x.builtin === 'up')
  const mine = flow.stages.flatMap((st, i) => (st.kind === 'services' && st.parts.some((p) => p.runId === d.runId) ? [i] : []))
  need(at >= 0 && mine.length > 0, 'flow parts')
  const lastPart = mine[mine.length - 1]
  const out: { stage: number; slot: FlowSlot<S | PlanStep> }[] = seq.slice(0, at).map((slot) => ({ stage: -1, slot }))
  const anchored = (stage: number, a: StepAnchor) => steps.filter((s) => s.anchor === a).map((step) => ({ stage, slot: { step } }))
  flow.stages.forEach((st, i) => {
    if (st.kind === 'step') {
      if (st.runId === d.runId) out.push({ stage: i, slot: { step: st.step } })
      return
    }
    const parts = st.parts.filter((p) => p.runId === d.runId)
    need(parts.length <= 1, 'flow parts')
    for (const p of parts) {
      out.push({ stage: i, slot: { up: p.services } })
      if (i === lastPart) out.push(...anchored(i, 'after_up'))
      if (p.urls.length > 0) out.push({ stage: i, slot: { health: p.urls } })
      if (i === lastPart) out.push(...anchored(i, 'after_health'))
    }
  })
  const end = flow.stages.length
  out.push({ stage: end, slot: { builtin: 'tag' } }, ...anchored(end, 'after_tag'))
  return out
}

/**
 * Per run id, the steps a release or rollback playbook runs, in order (health once, however many URLs). With a
 * flow (a release only), in the flow's order: up and health once each however many parts, then each step stage.
 */
export function stepList(
  kind: 'release' | 'rollback',
  deps: readonly StepListDeployment[],
  flow: PlanFlow | null = null,
): Map<string, { key: string; kind: StepKind; label: string }[]> {
  const entry = (x: FlowSlot<StepRef>): { key: string; kind: StepKind; label: string } =>
    'builtin' in x
      ? { key: x.builtin, kind: x.builtin, label: STEP_LABEL[x.builtin] }
      : 'step' in x
        ? { key: x.step.key, kind: 'custom', label: x.step.label }
        : 'up' in x
          ? { key: 'up', kind: 'up', label: STEP_LABEL.up }
          : { key: 'health', kind: 'health', label: STEP_LABEL.health }
  return new Map(
    deps.map((d) => {
      const slots = kind === 'release' && flow !== null ? flowSequence(d, d.steps, flow).map((x) => x.slot) : sequence(kind, d, d.steps)
      const list = slots.map(entry)
      return [d.runId, list.filter((x, i) => list.findIndex((y) => y.key === x.key) === i)]
    }),
  )
}

export function checkPlan(plan: DeployPlan): void {
  need(RELEASE_ID.test(plan.releaseId), 'release id')
  need((plan.kind === 'operation') === ((plan.operation ?? null) !== null), 'operation')
  for (const h of plan.hosts) {
    need(ALIAS.test(h.alias), 'host alias')
    need(SAFE_IDENT.test(h.hostId), 'host id')
  }
  const flowKeys = (plan.flow?.stages ?? []).flatMap((st) => (st.kind === 'step' ? st.step.secretKeys.map((x) => x.key) : []))
  const opKeys = (plan.operation?.items ?? []).flatMap((i) => (i.type === 'step' ? i.step.secretKeys.map((x) => x.key) : []))
  for (const k of [...opKeys, ...plan.deployments.flatMap((d) => [d.envSecretKey, d.becomeSecretKey, ...d.steps.flatMap((p) => p.secretKeys.map((x) => x.key))]), ...flowKeys]) {
    if (k === null) continue
    need(SECRET_KEY.test(k) && k in plan.secretRefs, 'secret reference')
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
export function sh(name: string, kind: string, run: string, cmd: string, o: ShOpts): Task {
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

export const IN_REPO = '{{ d.repo }}'
export const becomes = (d: PlanDeployment): boolean => d.docker !== 'plain'
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
export function streamed(kind: string, body: string, o: { pre?: string; post?: string } = {}): string {
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
export const nm = (kind: string, d: PlanDeployment): string => `${kind} ${sanitizeIdent(d.name)}`

// ---- release steps
// ok=0 when ls-remote itself fails (network, auth): that is "unknown", not "no tag".
const REMOTE_TAG = [
  'if o=$(git ls-remote origin "refs/tags/$T" "refs/tags/$T^{}" 2>/dev/null); then ok=1; c=$(echo "$o" | awk \'END {print $1}\'); else ok=0; c=""; fi',
].join('\n')
const GIT_ID = 'GIT_COMMITTER_NAME=CredOps GIT_COMMITTER_EMAIL=credops@localhost'

/**
 * The deployed commit is read from origin (peeled), so a stale local tag or a fetch cannot change it. The server's
 * HEAD before the checkout comes with it: when a tag push failed, the tag lags behind what is running.
 */
const taskRecord = (d: PlanDeployment): Task =>
  sh(nm('record', d), 'record', runOf(d), [
    'T={{ d.tag | quote }}',
    REMOTE_TAG,
    'h=$(git rev-parse -q --verify HEAD 2>/dev/null)',
    'if [ "$ok" = 0 ]; then echo "OD-PREV unknown head=$h"; elif [ -n "$c" ]; then echo "OD-PREV $c head=$h"; else echo "OD-PREV none head=$h"; fi',
  ].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

export const taskBackup = (d: PlanDeployment): Task => {
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
export const taskFetch = (d: PlanDeployment): Task =>
  sh(nm('fetch', d), 'fetch', runOf(d), ['B={{ d.branch | quote }}', FETCH].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

/**
 * With skipped services only, right after the fetch: origin must still be at the head preflight saw, else the
 * skips were decided on code that is no longer what gets checked out. Part of the fetch step.
 */
const taskOriginCheck = (d: PlanDeployment): Task =>
  sh(nm('origin check', d), 'fetch', runOf(d), [
    'B={{ d.branch | quote }}',
    'E={{ d.origin_head | quote }}',
    'h=$(git rev-parse -q --verify "refs/remotes/origin/$B^{commit}" 2>/dev/null)',
    `if [ "$h" != "$E" ]; then echo '${ORIGIN_MOVED_MESSAGE}' >&2; exit 1; fi`,
  ].join('\n'), { timeout: T_SHORT, chdir: IN_REPO, guarded: true })

export const taskCheckout = (d: PlanDeployment): Task =>
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
// A manual rollback names the release it undoes (od.env_rel); a backup another release wrote is left for that one.
const RB_ENV_CMD = [
  'umask 077',
  'if [ "$(cat .env.opsdeck-rel 2>/dev/null)" = {{ od.env_rel | default(od.rel) | quote }} ]; then',
  '  if [ -f .env.opsdeck-prev ]; then mv -f .env.opsdeck-prev .env',
  '  elif [ -f .env.opsdeck-none ]; then rm -f .env',
  '  fi',
  '  rm -f .env.opsdeck-rel .env.opsdeck-prev .env.opsdeck-none',
  '  echo "OD-ENV restored"',
  'else',
  '  echo "OD-ENV skipped: .env was not written by the release being rolled back"',
  'fi',
].join('\n')

function envTask(kind: 'env' | 'rb_env', d: PlanDeployment): Task {
  if (kind === 'rb_env') return sh(nm(kind, d), kind, runOf(d), RB_ENV_CMD, { timeout: T_SHORT, chdir: IN_REPO })
  return sh(nm(kind, d), kind, runOf(d), ENV_CMD, { timeout: T_SHORT, chdir: IN_REPO, noLog: true, stdin: `{{ s.${d.envSecretKey} }}`, guarded: true })
}
const taskEnv = (d: PlanDeployment): Task => envTask('env', d)

export const composeOf = (d: PlanDeployment) => ({ composeFile: d.composeFile, composeProject: d.composeProject })

/*
 * Custom step text. Every shell variable the generator sets here is lowercase (`od_*`, `rc`): a step's env names
 * pass ENV_NAME, which is uppercase only, so a secret named `E` or `P` can never overwrite one of them.
 */

/** Appends one line to the step's own stream lines, which the log tap reads whatever no_log is (markers only, never a value). */
const streamLine = (text: string): string => `printf '%s\\t%s\\n' "$od_p" "${text}" >> "$od_l"`

/**
 * Reads the step's `NAME=<base64>` stdin lines into its environment (and `-e NAME` for compose exec, so the
 * value never reaches an argv). The names were checked at generate time; the shell checks them again.
 */
const STEP_ENV = [
  'od_e=()',
  'while IFS= read -r od_l1 || [ -n "$od_l1" ]; do',
  '  od_k="${od_l1%%=*}"',
  '  case "$od_k" in [A-Z]*) ;; *) exit 2;; esac',
  '  case "$od_k" in *[!A-Z0-9_]*) exit 2;; esac',
  '  od_x=$(printf \'%s\' "${od_l1#*=}" | base64 -d && printf .) || exit 2',
  '  export "$od_k=${od_x%.}"',
  '  od_e+=(-e "$od_k")',
  'done',
  'unset od_l1 od_k od_x',
].join('\n')

/**
 * Prints OD-SKIP (to stdout and to the stream lines, so a no_log step still shows it) and ends the task when `when`
 * finds nothing changed since the base commit. No base counts as changed; a check git cannot make says so and runs.
 * No `${#...}` here: `{#` opens a Jinja comment.
 */
function whenCheck(p: PlanStep, become: boolean): string | undefined {
  const w = p.step.when
  if (w.kind === 'always') return undefined
  const ref = `d.steps.${p.key}`
  // under sudo, git refuses a repo another user owns unless told it is safe
  const g = `git ${become ? '-c safe.directory={{ d.repo | quote }} ' : ''}-C {{ d.repo | quote }}`
  const skip = `echo "OD-SKIP"; ${streamLine('OD-SKIP')}; exit 0`
  const test =
    w.kind === 'changed'
      ? [`    if [ "$od_h" = "$od_b" ]; then ${skip}; fi`]
      : [
          '    od_a=()',
          `    while IFS= read -r od_g; do [ -n "$od_g" ] && od_a+=(":(glob)$od_g"); done < <(echo {{ ${ref}.paths_b64 | quote }} | base64 -d)`,
          `    if [ -n "\${od_a[*]}" ] && ${g} diff --quiet "$od_b" HEAD -- "\${od_a[@]}"; then ${skip}; fi`,
        ]
  return [
    `od_b={{ ${ref}.base | quote }}`,
    'if [ -n "$od_b" ]; then',
    `  if ${g} cat-file -e "$od_b^{commit}" 2>/dev/null && od_h=$(${g} rev-parse HEAD 2>/dev/null); then`,
    ...test,
    '  else',
    `    echo "when check unavailable, running step"; ${streamLine('when check unavailable, running step')}`,
    '  fi',
    'fi',
  ].join('\n')
}

/**
 * streamed() for a custom step, with lowercase names: output goes to stream.log as `<run>:c_<n>\t` lines. The
 * `when` check runs after the log is set up and before the body. A `continue` failure reports OD-STEP on stdout
 * and as a stream line.
 */
function stepStreamed(key: string, body: string, o: { pre?: string; cont: boolean }): string {
  return [
    'od_u="${SUDO_USER:-}"',
    'if [ -n "$od_u" ]; then od_hm=$(awk -F: -v u="$od_u" \'$1==u {print $6; exit}\' /etc/passwd 2>/dev/null); fi',
    'od_hm="${od_hm:-$HOME}"',
    `od_l="$od_hm/${RUNS_SUBDIR}/{{ od.rel }}/stream.log"`,
    'umask 022',
    `od_p="{{ d.run }}:${key}"`,
    ...(o.pre ? [o.pre] : []),
    '(',
    body,
    `) 2>&1 | while IFS= read -r od_l1 || [ -n "$od_l1" ]; do printf '%s\\t%s\\n' "$od_p" "$od_l1"; done >> "$od_l"; rc=\${PIPESTATUS[0]}`,
    `if [ "$rc" -ne 0 ]; then grep -F "$od_p"$'\\t' "$od_l" | tail -n 40; fi`,
    ...(o.cont ? [`if [ "$rc" -ne 0 ]; then echo "OD-STEP rc=$rc"; ${streamLine('OD-STEP rc=$rc')}; fi`] : []),
    'exit "$rc"',
  ].join('\n')
}

/** A custom step, with its own kind `c_<n>`. `continue` never fails the host and reports OD-STEP. A flow step has no anchor. */
export function stepTask(d: PlanDeployment, p: PlanStep, anchor: StepAnchor | null): Task {
  const s = p.step
  const env = p.secretKeys.length + p.paramKeys.length > 0
  const become = s.sudo === 'docker' ? becomes(d) : s.sudo === 'yes'
  const script = `od_s=$(echo {{ d.steps.${p.key}.script_b64 | quote }} | base64 -d && printf .) || exit 2\nod_s="\${od_s%.}"`
  const run =
    s.run === 'compose-exec'
      ? `${composeCommand(composeOf(d), ['exec', '-T'])}${env ? ' "${od_e[@]}"' : ''} ${shJoin(checkComposeServices([s.service ?? '']))} sh -c "$od_s"`
      : 'bash -e -c "$od_s"'
  const body = [...(env ? [STEP_ENV] : []), script, run].join('\n')
  // An after_tag step cannot fail the release: the tag is already pushed (validateStep forces this for a saved step too).
  const cont = s.onFailure === 'continue' || anchor === 'after_tag'
  const stdin = [
    ...p.secretKeys.map((x) => `${x.envName}={{ s.${x.key} }}`),
    ...p.paramKeys.map((x, i) => `${x.envName}={{ d.steps.${p.key}.params[${i}] }}`),
  ]
  return sh(`${p.key} ${sanitizeIdent(d.name)}`, p.key, runOf(d), stepStreamed(p.key, body, { pre: whenCheck(p, become), cont }), {
    timeout: s.timeoutSec,
    chdir: s.cwd ?? IN_REPO,
    become,
    ...(env && { stdin: `${stdin.join('\n')}\n` }),
    noLog: p.secretKeys.length > 0,
    failedWhen: cont ? false : undefined,
    guarded: true,
  })
}

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

/** One task per URL. A rollback checks the same URLs, status and timeout as its release, reported as `rb_health`. */
function taskHealth(d: PlanDeployment, i: number, kind: 'health' | 'rb_health' = 'health'): Task {
  const u = d.urls[i]
  const timeout = clampSec(d.healthTimeoutSec, 'health timeout')
  const ref = `d.urls[${i}].url`
  if (u.from === 'mac') {
    return {
      name: `${nm(kind, d)} ${i}`,
      'ansible.builtin.uri': { url: `{{ ${ref} }}`, method: 'GET', status_code: [d.healthStatus], timeout: 10 },
      delegate_to: 'localhost',
      connection: 'local',
      become: false,
      register: 'r',
      retries: Math.max(1, Math.ceil(timeout / 2)),
      delay: 2,
      until: `r.status == ${d.healthStatus}`,
      tags: tagsOf(kind, runOf(d)),
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
  return sh(`${nm(kind, d)} ${i}`, kind, runOf(d), cmd, { timeout: timeout + 30, chdir: IN_REPO, guarded: true })
}

const PUSH_TAG = 'git push -f origin "refs/tags/$T"'
// Tagging is best effort: the deploy already happened. The task never fails the host; a failure is
// reported through OD-TAG so the translator can warn without the playbook rescuing.
const TAG_FAILED = '|| echo "OD-TAG failed rc=$?"'
const taskTag = (d: PlanDeployment): Task =>
  sh(nm('tag', d), 'tag', runOf(d), ['T={{ d.tag | quote }}', `{ ${GIT_ID} git tag -fa "$T" -m "CredOps deploy" HEAD && ${PUSH_TAG}; } ${TAG_FAILED}`].join('\n'), {
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
  sh(nm('rb_tag', d), 'rb_tag', runOf(d), ['T={{ d.tag | quote }}', 'P={{ d.prev | quote }}', `{ ${GIT_ID} git tag -fa "$T" -m "CredOps rollback" "$P" && ${PUSH_TAG}; } ${TAG_FAILED}`].join('\n'), {
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

/**
 * `G` = the checkout that holds `from`: the nearest folder at or above it with a `.git` (a deployment can sit in a
 * subfolder of a monorepo), else `/`.
 */
const gitRootOf = (from: string) => `G=${from}; while [ ! -e "$G/.git" ] && [ "$G" != / ] && [ -n "$G" ]; do G=$(dirname "$G"); done`

/**
 * Opens a loop over the checkouts that hold the host's repos, each once: `G` is the checkout (the git root above a
 * monorepo subfolder, else the repo path) and `f` its lock file, so deployments in one clone share one lock.
 */
const EACH_CHECKOUT = [
  'seen=" "',
  `for r in ${REPOS}; do`,
  `  ${gitRootOf('"$r"')}`,
  '  [ -e "$G/.git" ] || G="$r"',
  '  case "$seen" in *" $G "*) continue;; esac',
  '  seen="$seen$G "',
  `  f="$G/${LOCK_FILE}"`,
]

export function taskPrep(h: PlanHost): Task {
  const cmd = ['umask 077', `mkdir -p ${odRunDir}`, `touch ${odRunDir}/stream.log`].join('\n')
  return sh(`lock prep ${sanitizeIdent(h.alias)}`, 'lock', hostRun(h), cmd, { timeout: T_SHORT, chdir: HOST_CWD })
}

/**
 * Takes the lock in every repo of the host (sorted by the caller). Exclusive by `set -C` (O_EXCL);
 * reentrant per repo when the holder is this release. On a busy repo it releases what this task took and
 * exits 42, so a refusal never leaves a partial lock set behind.
 */
export function taskLock(h: PlanHost): Task {
  const cmd = [
    'J=$(echo {{ od.lock_b64 | quote }} | base64 -d)',
    'umask 077',
    'acq=""',
    ...EACH_CHECKOUT,
    '  if ( set -C; printf \'%s\' "$J" > "$f" ) 2>/dev/null; then acq="$acq $G"; echo "OD-LOCK $J"; continue; fi',
    '  cur=$(cat "$f" 2>/dev/null)',
    '  echo "OD-LOCK $cur"',
    '  case "$cur" in *\'"releaseId":"{{ od.rel }}"\'*) continue;; esac',
    `  for a in $acq; do rm -f "$a/${LOCK_FILE}"; done`,
    '  [ -n "$cur" ] && exit 42',
    '  echo "OD-LOCK-ERROR cannot create the lock in $G"; exit 2',
    'done',
    'exit 0',
  ].join('\n')
  return sh(`lock ${sanitizeIdent(h.alias)}`, 'lock', hostRun(h), cmd, { timeout: T_SHORT, chdir: HOST_CWD })
}

/**
 * Stops the builds a parallel prepare launched on the host (each recorded its process group, `od.kill_pids`) and
 * removes their pid files, before any lock goes. Each file is listed as `<repo>/.git/…` and looked up in the checkout
 * that holds the repo, where the launch wrote it. A group is signalled (as the user, then with sudo) only while it is
 * still that build's: some member's argv names the run's pid file (the launch's own shell does), and it is not this
 * task's group. Anything else (no plain number above 1, a group gone or reused) only loses its stale pid file.
 */
const KILL_BUILDS = [
  "me=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')",
  "for p in {{ od.kill_pids | map('quote') | join(' ') }}; do",
  '  m="${p##*/}"',
  `  ${gitRootOf('"${p%/.git/*}"')}`,
  '  p="$G/.git/$m"',
  '  g=$(cat "$p" 2>/dev/null)',
  '  ours=',
  '  case "$g" in \'\'|*[!0-9]*) ;; *) if [ "$g" -gt 1 ] && [ "$g" != "$me" ] && ps -eo pgid=,args= 2>/dev/null | awk -v g="$g" \'$1 == g\' | grep -qF -- "$m"; then ours=1; fi;; esac',
  '  if [ -n "$ours" ]; then',
  '    kill -TERM -- "-$g" 2>/dev/null || sudo -n kill -TERM -- "-$g" 2>/dev/null || true',
  '    echo "stopped build process group $g"',
  '  elif [ -n "$g" ]; then',
  '    echo "build process group $g is no longer this build\'s: not stopped"',
  '  fi',
  '  rm -f "$p" 2>/dev/null || sudo -n rm -f "$p" 2>/dev/null || true',
  'done',
].join('\n')

/** Unlock releases only locks this release holds; break-lock only locks whose content equals the expected raw. */
export function taskUnlock(h: PlanHost, breakLock: boolean, kill = false): Task {
  const guard = breakLock
    ? '[ "$cur" = "$(echo {{ od.expect_b64 | quote }} | base64 -d)" ]'
    : 'case "$cur" in *\'"releaseId":"{{ od.rel }}"\'*) true;; *) false;; esac'
  const cmd = [
    ...(kill ? [KILL_BUILDS] : []),
    'rc=0',
    ...EACH_CHECKOUT,
    '  cur=$(cat "$f" 2>/dev/null)',
    '  [ -n "$cur" ] || continue',
    '  echo "OD-LOCK $cur"',
    `  if ${guard}; then rm -f "$f"; echo "OD-UNLOCK released $G"; else echo "OD-UNLOCK kept $G"; ${breakLock ? 'rc=43' : ':'}; fi`,
    'done',
    `rm -rf ${odRunDir}`,
    'exit "$rc"',
  ].join('\n')
  return sh(`unlock ${sanitizeIdent(h.alias)}`, 'unlock', hostRun(h), cmd, { timeout: T_SHORT, chdir: HOST_CWD })
}

// ---- version
const taskVersion = (d: PlanDeployment): Task =>
  sh(nm('version', d), 'version', runOf(d), [
      'V={{ od.version | quote }}',
      'E={{ od.env | quote }}',
      // Deployments in different directories can share one git repo (the second would hit "tag already exists"):
      // a tag already on HEAD is done. A tag at another commit falls through to `git tag`, which fails as before.
      'h=$(git rev-parse HEAD 2>/dev/null)',
      'if [ -n "$h" ] && [ "$(git rev-parse -q --verify "refs/tags/$V^{commit}" 2>/dev/null)" = "$h" ]; then',
      // a plain line, not an OD- marker: the event translator would swallow it (OD-TAG means the deploy tag failed)
      '  echo "$V is already on HEAD in this repository; skipping the tag and push"',
      'else',
      `  ${GIT_ID} git tag -a "$V" -m "$E release $V" && git push origin "$V"`,
      'fi',
    ].join('\n'), {
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
    // A repo path may be a subfolder of its checkout (a monorepo): git works from there, so that is a git repository too.
    pf(d, 'repo', [
      'R={{ d.repo | quote }}',
      'if [ -d "$R" ]; then',
      `  ${gitRootOf('"$R"')}`,
      '  if [ -e "$G/.git" ]; then echo "OD-PF repo exists=1 git=1 root=$G"; else echo "OD-PF repo exists=1 git=0"; fi',
      'else echo "OD-PF repo exists=0 git=0"; fi',
    ].join('\n'), { chdir: false }),
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
    // origin's head (read-only): a service at it has nothing new, whatever order the log lists commits in
    '  o=$(git rev-parse -q --verify "refs/remotes/origin/$B^{commit}" 2>/dev/null)',
    '  echo "OD-PF commits log_b64=$out origin_head=$o"',
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
    ...EACH_CHECKOUT,
    '  if [ -f "$f" ]; then echo "OD-PF lock repo=$G held=1 raw_b64=$(base64 < "$f" | tr -d \'\\n\')"; else echo "OD-PF lock repo=$G held=0 raw_b64="; fi',
    'done',
  ].join('\n'), { timeout: T_PREFLIGHT, chdir: HOST_CWD, failedWhen: false })
}

// ---------------------------------------------------------------- plays

export function block(d: PlanDeployment, kind: DeployPlan['kind'], tasks: Task[], rescue: Task[], extraSteps: readonly PlanStep[] = []): Task {
  return { name: `deployment ${sanitizeIdent(d.name)}`, vars: { d: dVars(d, kind, extraSteps) }, block: tasks, rescue }
}

export const rescueRelease = (d: PlanDeployment): Task[] => [
  { name: `mark failed ${sanitizeIdent(d.name)}`, 'ansible.builtin.set_fact': { od_failed: true } },
  { name: `fail ${sanitizeIdent(d.name)}`, 'ansible.builtin.fail': { msg: `CredOps step failed for ${sanitizeIdent(d.runId)}` } },
]
const rescueRollback = (d: PlanDeployment): Task[] => [
  { name: `rollback failed ${sanitizeIdent(d.name)}`, 'ansible.builtin.set_fact': { rollback_failed: true } },
]

const BUILTIN: Record<Builtin, (d: PlanDeployment) => Task[]> = {
  record: (d) => [taskRecord(d)],
  backup: (d) => [taskBackup(d)],
  fetch: (d) => [taskFetch(d), ...(d.expectOriginHead ? [taskOriginCheck(d)] : [])],
  checkout: (d) => [taskCheckout(d)],
  env: (d) => [taskEnv(d)],
  build: (d) => [taskBuild(d)],
  up: (d) => [taskUp(d)],
  health: (d) => d.urls.map((_, i) => taskHealth(d, i)),
  tag: (d) => [taskTag(d)],
  rb_checkout: (d) => [taskRbCheckout(d)],
  rb_env: (d) => [taskRbEnv(d)],
  rb_build: (d) => [composeTask('rb_build', d)],
  rb_up: (d) => [composeTask('rb_up', d)],
  rb_health: (d) => d.urls.map((_, i) => taskHealth(d, i, 'rb_health')),
  rb_tag: (d) => [taskRbTag(d)],
}

function deploymentTasks(kind: 'release' | 'rollback', d: PlanDeployment): Task[] {
  return sequence(kind, d, stepsRun(kind, d)).flatMap((x) => ('builtin' in x ? BUILTIN[x.builtin](d) : [stepTask(d, x.step, x.step.anchor)]))
}

function playFor(plan: DeployPlan, h: PlanHost, deps: PlanDeployment[]): Play {
  const vars: Record<string, unknown> & { od: Record<string, unknown> } = { od: hostOd(plan, h, deps), s: SECRETS_VAR }
  const become = hostBecome(deps)
  if (become !== undefined) vars.ansible_become_password = become

  const tasks: Task[] = []
  switch (plan.kind) {
    case 'release':
      tasks.push(taskPrep(h), taskLock(h))
      for (const d of deps) tasks.push(block(d, plan.kind, deploymentTasks('release', d), rescueRelease(d)))
      break
    case 'rollback':
      tasks.push(taskPrep(h), taskLock(h))
      for (const d of deps) tasks.push(block(d, plan.kind, deploymentTasks('rollback', d), rescueRollback(d)))
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
      tasks.push(taskUnlock(h, plan.kind === 'break-lock', 'kill_pids' in vars.od))
      break
  }
  return { name: `${plan.kind} ${sanitizeIdent(h.alias)}`, hosts: h.alias, gather_facts: false, strategy: 'linear', vars, tasks }
}

export const depsOf = (plan: DeployPlan, h: PlanHost): PlanDeployment[] => plan.deployments.filter((d) => d.hostId === h.hostId)

export function generatePlaybook(plan: DeployPlan): string {
  checkPlan(plan)
  if (plan.kind === 'operation') return generateOperation(plan)
  const flow = plan.flow ?? null
  if (flow !== null) return JSON.stringify(flowPlays(plan, flow), null, 2)
  if (plan.kind === 'release' && (plan.prepare ?? null) !== null) return JSON.stringify(preparedPlays(plan), null, 2)
  const plays: Play[] = []
  for (const h of plan.hosts) {
    const deps = depsOf(plan, h)
    if (deps.length === 0) continue
    plays.push(playFor(plan, h, deps))
  }
  return JSON.stringify(plays, null, 2)
}

// ---------------------------------------------------------------- release flow

const onHost = (h: PlanHost): string => `inventory_hostname == '${h.alias}'`
const FLOW_STOPPED = 'CredOps flow stopped: a host did not finish an earlier stage'

function checkFlow(plan: DeployPlan, flow: PlanFlow): void {
  need(plan.kind === 'release', 'flow outside a release')
  need(flow.onFailure === 'stop-all' || flow.onFailure === 'continue-other-hosts', 'flow on failure')
  // the flow's own stages, plus one for the checkouts it never names
  need(Array.isArray(flow.stages) && flow.stages.length >= 1 && flow.stages.length <= MAX_FLOW_STAGES + 1, 'flow stages')
  const runs = new Map(plan.deployments.map((d) => [d.runId, d]))
  const urls = new Map<string, number[]>()
  for (const st of flow.stages) {
    if (st.kind === 'step') {
      need(runs.has(st.runId), 'flow step run')
      continue
    }
    need(st.kind === 'services' && Array.isArray(st.parts) && st.parts.length >= 1, 'flow stage')
    const seen = new Set<string>()
    for (const p of st.parts) {
      const d = runs.get(p.runId)
      need(d !== undefined && !seen.has(p.runId), 'flow part')
      seen.add(p.runId)
      if (p.services !== null) {
        need(Array.isArray(p.services) && p.services.length >= 1 && p.services.length <= MAX_SERVICES, 'flow part services')
        checkComposeServices(p.services)
      }
      need(Array.isArray(p.urls) && p.urls.every((n) => Number.isInteger(n) && n >= 0 && n < (d as PlanDeployment).urls.length), 'flow health url')
      urls.set(p.runId, [...(urls.get(p.runId) ?? []), ...p.urls])
    }
  }
  // each health URL is checked exactly once
  for (const d of plan.deployments) {
    const u = (urls.get(d.runId) ?? []).sort((a, b) => a - b)
    need(u.length === d.urls.length && u.every((n, i) => n === i), 'flow health urls')
  }
}

/** The flow's step stages of one run, checked like its own steps; their keys never clash with the run's. */
function flowStepsOf(flow: PlanFlow, d: PlanDeployment, own: readonly PlanStep[]): PlanStep[] {
  const keys = new Set(own.map((p) => p.key))
  const out: PlanStep[] = []
  for (const st of flow.stages) {
    if (st.kind !== 'step' || st.runId !== d.runId) continue
    const p = st.step
    need(STEP_KEY.test(p.key) && !keys.has(p.key) && p.anchor === null, 'flow step key')
    keys.add(p.key)
    checkStep(p)
    out.push(p)
  }
  return out
}

function flowSlotTasks(d: PlanDeployment, x: FlowSlot<PlanStep>): Task[] {
  if ('builtin' in x) return BUILTIN[x.builtin](d)
  if ('step' in x) return [stepTask(d, x.step, x.step.anchor)]
  if ('up' in x) return [composeTask('up', { ...d, services: x.up })]
  return x.health.map((i) => taskHealth(d, i))
}

/**
 * Fails every host of a later play unless each host that was in an earlier play finished the last one it was in
 * (`od_stage`, set as a play's last task) without a failed deployment. Ansible leaves a failed or unreachable host
 * out of later plays on its own; this stops the hosts that are left, which `free` (continue-other-hosts) needs and
 * `linear` with any_errors_fatal (stop-all) gets as a second guard. The condition names aliases (ALIAS-checked) and
 * play indexes only.
 */
function flowGate(i: number, lastPlay: ReadonlyMap<string, number>): Task {
  const when = [...lastPlay]
    .map(([a, k]) => `(hostvars['${a}'].od_stage | default(-1)) != ${k} or (hostvars['${a}'].od_failed | default(false))`)
    .join(' or ')
  return { name: `flow gate ${i}`, 'ansible.builtin.fail': { msg: FLOW_STOPPED }, when }
}

/**
 * A release in flow order, one play per phase, each play bound to the hosts it touches and every block to its host
 * by `when`:
 * - `release prepare` (every host): each host's lock, then each checkout's prepare phase (everything before up);
 * - `release stage <i>` per flow stage: its parts' up and health, or its one step, on those runs' hosts;
 * - `release tag` (every host): each checkout's tag and after_tag steps.
 * Every play after the first opens with a gate (flowGate), so no service goes up unless every host prepared, and no
 * checkout is tagged unless every stage finished. stop-all runs each play `linear` with any_errors_fatal, so a
 * failure also stops the other hosts mid-play; continue-other-hosts runs it `free`, letting them finish the play
 * before the next gate stops them. `od` and become are inventory host vars here (generateInventory), so play vars
 * hold the secrets lookup only.
 */
function flowPlays(plan: DeployPlan, flow: PlanFlow): Play[] {
  checkFlow(plan, flow)
  const prepare = plan.prepare ?? null
  const hostOf = new Map(plan.hosts.map((h) => [h.hostId, h]))
  const hosts = plan.hosts.filter((h) => depsOf(plan, h).length > 0)
  for (const h of hosts) {
    hostOd(plan, h, depsOf(plan, h))
    hostBecome(depsOf(plan, h))
  }
  const runs = new Map(
    plan.deployments.map((d) => {
      const own = stepsRun('release', d)
      const extra = flowStepsOf(flow, d, own)
      const vars = dVars(d, 'release')
      if (extra.length > 0) vars.steps = { ...((vars.steps as Record<string, unknown> | undefined) ?? {}), ...Object.fromEntries(extra.map((p) => [p.key, stepVars(p, d.whenBase)])) }
      const host = hostOf.get(d.hostId)
      need(host !== undefined, 'deployment host')
      return [d.runId, { d, host: host as PlanHost, vars, slots: flowSequence(d, own, flow) }]
    }),
  )
  const blockAt = (runId: string, stage: number): Task[] => {
    const r = runs.get(runId)
    if (!r) return []
    const tasks = r.slots.filter((x) => x.stage === stage).flatMap((x) => flowSlotTasks(r.d, x.slot as FlowSlot<PlanStep>))
    if (tasks.length === 0) return []
    return [{ name: `deployment ${sanitizeIdent(r.d.name)}`, when: onHost(r.host), vars: { d: r.vars }, block: tasks, rescue: rescueRelease(r.d) }]
  }
  const all = plan.deployments.map((d) => d.runId)
  // [name, the flow stage its blocks come from (-1 prepare, stages.length tag), its runs in block order]
  const phases: [string, number, string[]][] = [
    ['release prepare', -1, all],
    ...flow.stages.map((st, i): [string, number, string[]] => [`release stage ${i}`, i, st.kind === 'step' ? [st.runId] : st.parts.map((x) => x.runId)]),
    ['release tag', flow.stages.length, all],
  ]
  const lastPlay = new Map<string, number>()
  return phases.map(([name, stage, ids], p) => {
    const here = hosts.filter((h) => ids.some((id) => runs.get(id)?.host === h))
    const tasks: Task[] = []
    // A parallel prepare replaces the prepare play's lock and blocks; it always runs linear (its gate reads every host).
    const parallel = p === 0 && prepare !== null
    if (p > 0) tasks.push(flowGate(p, lastPlay))
    if (parallel)
      tasks.push(
        ...prepareTasks(
          prepare,
          here,
          plan.deployments.map((d) => {
            const r = runs.get(d.runId) as { d: PlanDeployment; host: PlanHost; vars: Record<string, unknown>; slots: { stage: number; slot: FlowSlot<PlanStep> }[] }
            return { d, host: r.host, vars: r.vars, slots: r.slots.filter((x) => x.stage === -1).map((x) => x.slot) }
          }),
        ),
      )
    else if (p === 0) for (const h of here) tasks.push({ ...taskPrep(h), when: onHost(h) }, { ...taskLock(h), when: onHost(h) })
    if (!parallel) for (const id of ids) tasks.push(...blockAt(id, stage))
    if (p < phases.length - 1) tasks.push({ name: `flow play ${p} done`, 'ansible.builtin.set_fact': { od_stage: p } })
    for (const h of here) lastPlay.set(h.alias, p)
    const stopAll = flow.onFailure === 'stop-all' || parallel
    return {
      name,
      hosts: here.map((h) => h.alias).join(':'),
      gather_facts: false,
      strategy: stopAll ? 'linear' : 'free',
      ...(stopAll ? { any_errors_fatal: true } : {}),
      vars: { s: SECRETS_VAR },
      tasks,
    }
  })
}

// ---------------------------------------------------------------- parallel prepare

const PREPARE_STOPPED = 'CredOps prepare stopped: a checkout did not prepare'

/**
 * Per host, waves of at most `cap` checkouts, in plan order; a wave holds every host's next group. Deployments that
 * share a checkout on a host (one repo path, or monorepo subfolders of one clone) go in successive waves, so one's
 * fetch and checkout never run while another's build reads that tree.
 */
export function prepareSchedule(deps: readonly PlanDeployment[], cap: number): string[][] {
  need(Number.isInteger(cap) && cap >= 1 && cap <= 8, 'prepare cap')
  const waves: string[][] = []
  const used = new Map<string, number>()
  const lastOfRepo = new Map<string, number>()
  for (const d of deps) {
    const repo = `${d.hostId}\0${d.checkout ?? d.repoPath}`
    let w = (lastOfRepo.get(repo) ?? -1) + 1
    while ((used.get(`${w}\0${d.hostId}`) ?? 0) >= cap) w++
    used.set(`${w}\0${d.hostId}`, (used.get(`${w}\0${d.hostId}`) ?? 0) + 1)
    lastOfRepo.set(repo, w)
    ;(waves[w] ??= []).push(d.runId)
  }
  return waves
}

/**
 * The build, launched in the background (`async`, `poll: 0`) so a wave's builds run at once on every host. The
 * shell records its process group in its checkout's `.git/opsdeck-build-<run>.pid` (removed when the build ends), so an
 * unlock after a cancel can stop it. A helper task: the build step is settled by its async_status poll.
 */
function taskBuildLaunch(d: PlanDeployment, n: number): Task {
  const pid = '"$G/.git/opsdeck-build-{{ d.run }}.pid"'
  const warn = `echo "CredOps warning: cancel can't stop this build: its process group could not be recorded in $G/.git"`
  const cmd = [
    // the process group: from ps, else /proc (BusyBox ps has no -o pgid), else the shell's own pid
    "g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')",
    "case \"$g\" in ''|*[!0-9]*) g=$(sed 's/.*) //' /proc/$$/stat 2>/dev/null | cut -d' ' -f3);; esac",
    "case \"$g\" in ''|*[!0-9]*) g=$$;; esac",
    // a .git that is a file (a worktree, a submodule) cannot hold it: the build goes on, with a warning in its log
    'W=1',
    gitRootOf('"$PWD"'),
    `if [ "$g" -gt 1 ] && printf '%s' "$g" > ${pid} 2>/dev/null; then W=; fi`,
    '(',
    streamed('build', [`if [ -n "$W" ]; then ${warn}; fi`, composeCommand(composeOf(d), ['build'], d.services ?? [])].join('\n')),
    ')',
    'rc=$?',
    `rm -f ${pid} 2>/dev/null`,
    'exit "$rc"',
  ].join('\n')
  const t = sh(`build launch ${sanitizeIdent(d.name)}`, 'build', runOf(d), cmd, { timeout: T_SHORT, chdir: IN_REPO, become: becomes(d), guarded: true })
  return { ...t, async: clampSec(d.buildTimeoutSec, 'build timeout'), poll: 0, register: `od_bj_${n}` }
}

/** Waits for a launched build (every 5s, up to its timeout): the build step's own task. */
function taskBuildPoll(d: PlanDeployment, n: number): Task {
  const t: Task = {
    name: nm('build', d),
    'ansible.builtin.async_status': { jid: `{{ od_bj_${n}.ansible_job_id }}` },
    register: `od_bs_${n}`,
    until: `od_bs_${n}.finished`,
    retries: Math.ceil(clampSec(d.buildTimeoutSec, 'build timeout') / 5),
    delay: 5,
    timeout: T_SHORT,
    tags: tagsOf('build', runOf(d)),
  }
  // the job's status file is the launching user's
  if (becomes(d)) t.become = true
  return { ...t, when: WHEN }
}

/** Removes the job's status file (it holds the build's failure tail) whatever the poll did; never fails. */
function taskBuildCleanup(d: PlanDeployment, n: number): Task {
  const t: Task = {
    name: `build cleanup ${sanitizeIdent(d.name)}`,
    'ansible.builtin.async_status': { jid: `{{ od_bj_${n}.ansible_job_id }}`, mode: 'cleanup' },
    failed_when: false,
    timeout: T_SHORT,
  }
  if (becomes(d)) t.become = true
  return t
}

/**
 * After a failed prepare whose checkout ran (`od_co_<n>`, registered by it): the checkout back on the previous commit,
 * the deploy tag (what the record step read from origin, local since the fetch), with rb_checkout's detached checkout;
 * then, with a managed .env, the previous one when this release wrote it (rb_env's check). A first deploy has no tag
 * and is left as it is. It reports through OD-RESTORE and never fails the host: under any_errors_fatal a failure would
 * stop every other host's restore.
 */
function taskPrepRestore(d: PlanDeployment, n: number): Task {
  const cmd = [
    'T={{ d.tag | quote }}',
    'P=$(git rev-parse -q --verify "refs/tags/$T^{commit}" 2>/dev/null)',
    'if [ -z "$P" ]; then echo "OD-RESTORE first"; exit 0; fi',
    'git checkout -q --detach "$P" || { echo "OD-RESTORE failed rc=$?"; exit 0; }',
    ...(d.envSecretKey !== null ? [RB_ENV_CMD] : []),
    'echo "OD-RESTORE ok $(git rev-parse HEAD)"',
  ].join('\n')
  return { ...sh(nm('restore', d), 'restore', runOf(d), cmd, { timeout: T_SHORT, chdir: IN_REPO, failedWhen: false }), when: `od_co_${n} is defined and od_co_${n} is not skipped` }
}

/** A prepare failure marks the host, puts its checkout back and lets the play go on: the gate at its end stops every host. */
const rescuePrepare = (d: PlanDeployment, n: number): Task[] => [
  { name: `mark prepare failed ${sanitizeIdent(d.name)}`, 'ansible.builtin.set_fact': { od_prep_failed: true } },
  taskPrepRestore(d, n),
]

/** Fails every host unless each one finished the prepare play without a failed checkout. Aliases only (ALIAS-checked). */
function prepareGate(hosts: readonly PlanHost[]): Task {
  const when = hosts.map((h) => `not (hostvars['${h.alias}'].od_prepared | default(false)) or (hostvars['${h.alias}'].od_prep_failed | default(false))`).join(' or ')
  return { name: 'od gate', 'ansible.builtin.fail': { msg: PREPARE_STOPPED }, when }
}

interface PrepRun {
  d: PlanDeployment
  host: PlanHost
  vars: Record<string, unknown>
  /** Everything before up, the build among them. */
  slots: FlowSlot<PlanStep>[]
}

/**
 * The prepare play's tasks: each host's lock, then wave by wave (prepareSchedule) each checkout's steps up to its
 * build launch, then each one's build poll and after_build steps. Every block is bound to its host by `when`; a
 * poll block runs only where its launch did. Last, a marker and the gate (prepareGate).
 */
function prepareTasks(prepare: { cap: number }, hosts: readonly PlanHost[], runs: readonly PrepRun[]): Task[] {
  const byRun = new Map(runs.map((r, n) => [r.d.runId, { ...r, n }]))
  const tasks: Task[] = []
  for (const h of hosts) tasks.push({ ...taskPrep(h), when: onHost(h) }, { ...taskLock(h), when: onHost(h) })
  const blk = (r: PrepRun & { n: number }, when: string, body: Task[]): Task => ({ name: `deployment ${sanitizeIdent(r.d.name)}`, when, vars: { d: r.vars }, block: body, rescue: rescuePrepare(r.d, r.n) })
  // the checkout registers that it ran: a restore follows only a checkout that did
  const before = (r: PrepRun & { n: number }): Task[] =>
    r.slots.slice(0, at(r)).flatMap((x) => flowSlotTasks(r.d, x).map((t) => ('builtin' in x && x.builtin === 'checkout' ? { ...t, register: `od_co_${r.n}` } : t)))
  const at = (r: PrepRun): number => {
    const i = r.slots.findIndex((x) => 'builtin' in x && x.builtin === 'build')
    need(i >= 0, 'prepare build')
    return i
  }
  for (const wave of prepareSchedule(runs.map((r) => r.d), prepare.cap)) {
    const here = wave.map((id) => byRun.get(id) as PrepRun & { n: number })
    for (const r of here) tasks.push(blk(r, onHost(r.host), [...before(r), taskBuildLaunch(r.d, r.n)]))
    for (const r of here) {
      const when = `${onHost(r.host)} and (od_bj_${r.n} | default({})).ansible_job_id is defined`
      tasks.push({ ...blk(r, when, [taskBuildPoll(r.d, r.n), ...r.slots.slice(at(r) + 1).flatMap((x) => flowSlotTasks(r.d, x))]), always: [taskBuildCleanup(r.d, r.n)] })
    }
  }
  tasks.push({ name: 'od prepared', 'ansible.builtin.set_fact': { od_prepared: true } }, prepareGate(hosts))
  return tasks
}

/**
 * A release with a parallel prepare and no flow: the prepare play over every host (prepareTasks), then one play per
 * host for the rest (up, health, the tag and their steps), in plan order. `od` and become are inventory host vars.
 */
function preparedPlays(plan: DeployPlan): Play[] {
  const prepare = plan.prepare as { cap: number }
  const hosts = plan.hosts.filter((h) => depsOf(plan, h).length > 0)
  for (const h of hosts) {
    hostOd(plan, h, depsOf(plan, h))
    hostBecome(depsOf(plan, h))
  }
  const hostOf = new Map(plan.hosts.map((h) => [h.hostId, h]))
  const runs = plan.deployments.map((d) => {
    const seq = sequence('release', d, stepsRun('release', d))
    const up = seq.findIndex((x) => 'builtin' in x && x.builtin === 'up')
    const host = hostOf.get(d.hostId)
    need(up >= 0 && host !== undefined, 'deployment host')
    return { d, host: host as PlanHost, vars: dVars(d, 'release'), slots: seq.slice(0, up) as FlowSlot<PlanStep>[], rest: seq.slice(up) }
  })
  const plays: Play[] = [
    { name: 'release prepare', hosts: hosts.map((h) => h.alias).join(':'), gather_facts: false, strategy: 'linear', any_errors_fatal: true, vars: { s: SECRETS_VAR }, tasks: prepareTasks(prepare, hosts, runs) },
  ]
  for (const h of hosts) {
    const tasks = runs
      .filter((r) => r.host === h)
      .map((r) => ({ name: `deployment ${sanitizeIdent(r.d.name)}`, vars: { d: r.vars }, block: r.rest.flatMap((x) => flowSlotTasks(r.d, x)), rescue: rescueRelease(r.d) }))
    plays.push({ name: `release ${sanitizeIdent(h.alias)}`, hosts: h.alias, gather_facts: false, strategy: 'linear', vars: { s: SECRETS_VAR }, tasks })
  }
  return plays
}
