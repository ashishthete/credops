# Playbook Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Let a user run complex operations through OpsDeck without side scripts:
- custom steps on every checkout;
- a per-environment release flow, with stages, skip-if-unchanged and parallel prepare;
- runbooks (ops actions without a deploy);
- a one-off, validated playbook edit.

Every one of these is reviewed, locked, logged, audited and permission-checked like a release, on the desktop app and the Hub alike.

**Architecture.**
- Everything is built once in `src/shared` and `src/main/deploy`. The Hub adds storage, a manifest schema, permissions and routes.
- A pure step model (`src/shared/steps.ts`) feeds the existing generator (`generate.ts`). The generator gains the following, while the no-flow, parallel-off output stays byte-identical:
  - custom-step tasks at anchors;
  - stage plays;
  - an async build phase;
  - operation plays.
- Operations are release rows with a nullable `operation` JSON column.
- An edited playbook is parsed, checked against an allow-list grammar plus the regenerated playbook, and re-serialized. The canonical text is what runs, is hashed and is stored.

**Tech Stack.** Electron 44, React 19, TypeScript, vitest, node:sqlite, Fastify (Hub). No new dependencies.

**Spec:** `.superpowers/sdd/playbook-ops-design.md`.
- The sections "Builder-check rulings" and "Product-owner answers" are binding and override anything above them.
- Every G1–G24 and S1–S12 pick in `.superpowers/sdd/playbook-ops-builder-check.md` is adopted, except where the product owner overrode it:
  - parallel prepare is on for all environments;
  - a prepare failure leaves the code at the new commit (this overrides G15).

## Global Constraints

- **Dependencies.** No new dependencies anywhere: no `pnpm add`, no YAML library. Playbooks are edited as JSON (G22).
- **Secrets.** No secret value in plaintext anywhere: playbook, preview, stored playbook, logs, stream lines, audit, IPC, errors, exports.
  - A secret's base64 form counts as plaintext too, so it is redacted as well (S6).
  - The playbook holds secret *references* only, as today.
- **Generated text.** Generated playbook and shell text is tested at parse level only (`JSON.parse`, `/bin/bash -n` via `spawnSync`) and is never executed.
- **Isolation.** Tests never touch real ssh, docker, ansible or network beyond localhost. Use FakeAnsible, memFs, fakePrepare and release-rig as today.
- **User text** never reaches the shell or Jinja raw.
  - Scripts, param values and `when` globs travel as base64 in `d`.
  - Task names come from `sanitizeIdent` only (S10).
  - Step, param and secret names never enter playbook text, except env-var names that pass `ENV_NAME` and the deny-list (S11).
  - Secrets and params reach the host on stdin with `no_log`, never through `environment:`.
- **Protected environments.** Starting a release, an operation or an edited playbook on a protected environment requires the typed environment name, enforced in main, not only in the UI.
- **AI** never auto-executes anything. No AI path may start, edit or approve a run.
- **Audit** stores names, ids and counts, never hosts, addresses, script text or param values.
  - `ops.run` records action name, service count and outcome.
  - `playbook.edited` records only the line delta.
- **Migrations** are additive only: new tables, new columns with defaults. The `releases.kind` CHECK is never rebuilt. App migration **13**, Hub migration **11** (Hub 10 is reserved by regions).
- **A4 golden.** With parallel prepare off and no flow, playbooks equal the Task 1 golden fixtures byte for byte. The only exception is hook tasks, which become `c_<n>` steps.
- **Commits.** Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- **Commands.**
  - App tests: `./node_modules/.bin/vitest run --maxWorkers=3 --testTimeout=30000 <path>`.
  - Hub tests: `cd hub && ../node_modules/.bin/vitest run <path>`.
  - Typechecks: `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json`, `-p tsconfig.web.json` and `-p hub/tsconfig.json`.

## Review Focus

These are failure modes that no single task's happy path exercises. Each one gets a test in the task that owns it.

1. **A secret's base64 form leaks into an edited playbook or the logs.**
   - Scenario: an edited task `debug: {msg: "{{ s.env_1 }}"}`, or a step that prints `$SECRET`.
   - Expected: rejected by the validator, or redacted in stream lines, in both forms.
   - Test: in Task 10, `tests/main/playbook-validate.test.ts` covers "rejects any reference to `s` outside the generated strings" and "rejects removing no_log from a secret-stdin task". In Task 3, `tests/main/release-mask.test.ts` covers "a step echoing a secret and its base64 is redacted in stream lines".
2. **A prepare failure triggers auto-rollback or starts `up` on another host.**
   - Cause: `reachedCheckout` is set in phase 1, and the old auto-rollback treats that as "something went up".
   - Test: in Task 7, `tests/main/release-service.test.ts` covers "prepare-only failure: no up anywhere, no auto-rollback run, PREPARE_FAILED_MESSAGE names the service".
3. **Cancel during an async build leaves the build running and unlocks anyway.**
   - Test: in Task 7, `tests/main/deploy-generate.test.ts` covers "the unlock plan kills recorded build pids before rm of the lock file" (task order). `tests/main/release-service.test.ts` covers "cancel mid-build runs the unlock plan with killBuilds".
4. **A multi-host stage play confuses the translator.**
   - The risk: another host's skipped per-host task marks this run's step skipped, or interleaved hosts swap `current` and `tagNote`.
   - Test: in Task 4, `tests/main/deploy-events.test.ts` covers "two hosts interleaved in one play keep separate step state and drop foreign-host results".
5. **An operation is treated as a release by a kind branch.**
   - The branches at risk: rollback eligibility, version retry, latest-per-environment, release notes, QA, notifications and tag finalize.
   - Test: in Task 9, `tests/main/release-service.test.ts` covers "an operation row is excluded from rollback, retryVersion, latestPerEnvironment and version tagging". `tests/main/release-store.test.ts` covers "latest per environment ignores operation rows".

## Execution tracks

- **Foundation (sequential):** Task 1, then Task 2. Every later task depends on them.
- **Generator core (sequential, one worktree):** 3 → 4 → 5 → 6 → 7 → 8 → 9. These share `generate.ts`, `events.ts`, `release-service.ts`, `runner.ts` and `local-runner.ts`.
- **Validator (parallel worktree after 3):** Task 10. Its validator file is new. Its edited-run wiring in `release-service.ts` lands last, after 9, and is rebased onto the core track.
- **Hub (parallel worktree after 2):** Task 11 (`hub/**`), then Task 12 (`src/main/hub/**`). Rebase the routes onto Tasks 9 and 10 before merging.
- **Renderer (parallel worktrees):**
  - Task 13 after 2;
  - Task 14 after 6;
  - Task 15 after 9;
  - Task 16 after 10.
  - 14 and 15 both edit `EnvironmentView.tsx`, so merge 14 first.
- **Shared-file conflicts:**
  - `src/shared/deploy.ts` and `src/shared/ipc.ts`: append-only after Task 2. IPC channels are added in Tasks 9, 10, 13 and 15.
  - `src/preload/index.ts` follows `ipc.ts`.
  - `src/shared/audit.ts`: Task 2 adds every new action up front.

---

### Task 1: A4 golden fixtures (before any change)

**Files:**
- Create: `tests/main/fixtures/playbook-golden/{release-hooks,release-plain,rollback,preflight,version,unlock}.json`
- Create: `tests/main/playbook-golden.test.ts`
- Modify: none.

**Interfaces.**
- Consumes: `generatePlaybook(plan: DeployPlan): string` (generate.ts:642), plus `planFixture()` and `depFixture()` (tests/main/deploy-helpers.ts).
- Produces `goldenPlan(name: GoldenName): DeployPlan`, exported from the test file:
  - `GoldenName = 'release-hooks' | 'release-plain' | 'rollback' | 'preflight' | 'version' | 'unlock'`.
  - `release-plain` is planFixture with every `preHookB64` and `postHookB64` set to null.
  - `version` is planFixture with `version: '1.2.0'`.
  - Fixed `startedAt` and runIds.
- Produces `structureWithoutHooks(text: string): unknown` in `tests/main/golden.ts`. It parses the playbook and removes:
  - the hook tasks, matched by name prefix `pre_hook `, `post_hook ` or `c_<n> `;
  - the `pre_hook`, `post_hook` and `steps` keys under each block's `vars.d`.
  - It returns the remaining structure.

- [ ] **Write the capture.** Generate each fixture with today's code: `UPDATE_GOLDEN=1 vitest run tests/main/playbook-golden.test.ts` writes them. The test reads them back and asserts `generatePlaybook(goldenPlan(n)) === readFileSync(fixture)` for all six. It also checks the `pre_hook` task in `release-hooks`:
  - it has index 6 in dep1's block, after `env`;
  - it has `timeout: 600`, `become: true` and `chdir` equal to the repo.
- [ ] **Run.** Expect PASS on master, since the fixtures were just captured. Then remove one fixture byte and confirm it FAILs. Restore the byte.
- [ ] **Commit.** `test(deploy): golden playbooks for the A4 guarantee`.

### Task 2: Shared model, app migration 13 and stores

**Files:**
- Create: `src/shared/steps.ts`, `src/shared/runbooks.ts`, `src/main/deploy/runbook-store.ts`, `tests/main/steps.test.ts`, `tests/main/runbook-store.test.ts`.
- Modify:
  - `src/shared/deploy.ts`: DeploymentMeta, DeploymentInput, EnvDeploySettings and its Patch, StepKind, STEP_LABEL, DeploymentRunMeta steps, ReleaseSummary, ReleaseDetail, ReleaseConfirm, ReleaseListFilter.
  - `src/shared/audit.ts`
  - `src/main/db/migrations.ts`
  - `src/main/deploy/deploy-store.ts`
  - `src/main/deploy/service-store.ts`
  - `src/main/deploy/release-store.ts`
- Test: `tests/main/db.test.ts`, `tests/main/deploy-store.test.ts`, `tests/main/service-store.test.ts`, `tests/main/release-store.test.ts`.

**Interfaces.** Produces the following (exact names; later tasks consume them).

From `src/shared/steps.ts`:
- `type StepAnchor = 'before_fetch' | 'after_checkout' | 'before_build' | 'after_build' | 'after_up' | 'after_health' | 'after_tag'` and `STEP_ANCHORS: readonly StepAnchor[]`, in pipeline order.
- `PREPARE_ANCHORS`, the first four anchors.
- `type StepSudo = 'docker' | 'yes' | 'no'`.
- `type StepWhen = { kind: 'always' } | { kind: 'changed' } | { kind: 'paths'; paths: string[] }`.
- `interface StepSecret { envName: string; secretId: string }`.
- `interface StepBody { id: string; name: string; run: 'shell' | 'compose-exec'; service: string | null; script: string; cwd: string | null; sudo: StepSudo; timeoutSec: number; onFailure: 'stop' | 'continue'; when: StepWhen; secrets: StepSecret[] }`.
- `interface Step extends StepBody { anchor: StepAnchor; alsoOnRollback: boolean }`.
- `PRE_HOOK_STEP_ID = 'pre-hook'` and `POST_HOOK_STEP_ID = 'post-hook'`.
- `effectiveSteps(d: { steps: Step[]; preHook: string | null; postHook: string | null }): Step[]`. It returns `steps` when non-empty. Otherwise it migrates the hooks:
  - the pre-hook becomes id `pre-hook`, anchor `before_build`;
  - the post-hook becomes id `post-hook`, anchor `after_health`;
  - both get run `shell`, sudo `docker`, timeout 600, `stop`, `always`, no secrets and no rollback.
- `ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/`.
- `deniedEnvName(name: string): boolean`. It denies `LD_*`, `BASH_*`, `PATH`, `IFS`, `ENV`, `PS4`, `SHELLOPTS`, `GIT_*`, `DOCKER_*`, `COMPOSE_*`, `OPSDECK_*`, `SUDO_*` and `OD_*`.
- `WHEN_PATH = /^[A-Za-z0-9._\/*-]{1,200}$/`.
- `MAX_STEPS_PER_CHECKOUT = 20`, `MAX_STEP_SCRIPT = 16000`, `MAX_WHEN_PATHS = 20`.
- `validateStep(input: unknown, o: { allowedSecretIds: ReadonlySet<string>; serviceNames: readonly string[]; body?: boolean }): Step` (or a `StepBody` when `body`). It throws `DeployError('VALIDATION', …)`, and the message never echoes script text. Its checks:
  - the name goes through `SAFE_IDENT`;
  - the timeout is within `STEP_TIMEOUT_RANGE`;
  - `cwd` matches `REPO_PATH`;
  - a compose-exec step names one of `serviceNames`;
  - `after_tag` forces `onFailure: 'continue'`.
- `stepLabel(s: StepBody): string`, which returns `sanitizeIdent(s.name)`.

From `src/shared/runbooks.ts`:
- `type BuiltinKind = 'restart' | 'stop' | 'start' | 'logs' | 'status' | 'prune-images' | 'backup-db' | 'pull-only'`.
- `type RunbookItem = { type: 'step'; step: StepBody } | { type: 'builtin'; builtin: BuiltinKind; tail?: number; untilHours?: number }`.
- `interface RunbookParam { name: string; label: string; type: 'text' | 'choice'; pattern: 'identifier' | 'number' | 'path' | 'free'; choices: string[] }`.
- `interface Runbook { id; environmentId; name; description; targetServiceIds: string[]; items: RunbookItem[]; params: RunbookParam[]; lock: boolean; notify: boolean; createdAt; updatedAt }`.
- `RunbookInput = Omit<Runbook, 'id' | 'createdAt' | 'updatedAt'>`.
- `MAX_PARAMS = 10`.
- `PARAM_PATTERN: Record<RunbookParam['pattern'], RegExp>`.
- `isReadOnlyRunbook(r: Pick<Runbook, 'items'>): boolean`. It is true only when every item is the `logs` or `status` built-in.
- `validateRunbook(input: unknown, o: { allowedSecretIds; serviceIds: readonly string[]; serviceNames }): RunbookInput`. It forces `lock = true` unless the runbook is read-only. `logs.tail` must be ≤ `LOG_TAIL_MAX`, and `when` must be `always`.
- `validateParamValues(params: RunbookParam[], values: Record<string, string>): Record<string, string>`.
- `RUNBOOK_TEMPLATES: { id: 'restart' | 'logs' | 'migrate' | 'prune' | 'backup'; name: string; build(serviceIds: string[]): RunbookInput }[]`.
- `interface OperationMeta { runbookId: string; name: string; params: Record<string, string>; readOnly: boolean; lock: boolean; targetServiceIds: string[] }`.

From `src/shared/deploy.ts`:
- `type FlowStage = { kind: 'services'; serviceIds: string[] } | { kind: 'step'; serviceId: string; step: StepBody }`.
- `interface ReleaseFlow { stages: FlowStage[]; onFailure: 'stop-all' | 'continue-other-hosts' }`.
- `EnvDeploySettings` gains `parallelPrepare: boolean; prepareCap: number; flow: ReleaseFlow | null`, and so does the Patch.
- `ServiceMeta` gains `skipUnchanged: boolean`.
- `DeploymentMeta` and `DeploymentInput` gain `steps: Step[]` (optional on input).
- `StepKind` gains `'custom'`, and `STEP_LABEL.custom = 'Step'`.
- Each `DeploymentRunMeta` step gains optional `label: string` and `key: string`.
- `ReleaseSummary` gains `operation: OperationMeta | null; playbookSource: 'generated' | 'edited'`.
- `ReleaseDetail` gains `playbookGenerated: string | null`.
- `ReleaseConfirm` gains `editedPlaybook?: string`.
- `ReleaseListFilter` gains `operations?: 'only' | 'exclude'`.

From `src/shared/audit.ts`, the new actions are `ops.run`, `ops.preflight`, `playbook.edited`, `runbook.create`, `runbook.update` and `runbook.delete`.

From `src/main/deploy/runbook-store.ts`, `RunbookStore`:
- `list(environmentId): Runbook[]`, `get(id): Runbook`;
- `create(input: RunbookInput, actor): Runbook`, `update(id, input, actor): Runbook`, `delete(id, actor): void`;
- audits carry names and counts only.

App migration 13 `playbook_ops` adds:
- `deployments.steps TEXT NOT NULL DEFAULT '[]'`;
- on `environments`: `release_flow TEXT NULL`, `parallel_prepare INTEGER NOT NULL DEFAULT 1 CHECK (parallel_prepare IN (0,1))` and `prepare_cap INTEGER NOT NULL DEFAULT 3 CHECK (prepare_cap BETWEEN 1 AND 8)`;
- `services.skip_unchanged INTEGER NOT NULL DEFAULT 0`;
- on `releases`: `operation TEXT NULL`, `playbook_source TEXT NULL` and `playbook_generated TEXT NULL`;
- table `runbooks(id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(environment_id, name))`.

The regions branch owns version 12. If it has not merged first, keep 13 and leave 12 to regions. The runner tolerates the gap because versions are applied in order of their number.

- [ ] **Write failing tests.**
  - `steps.test.ts`:
    - effectiveSteps migrates hooks with the exact fields above, and returns the saved steps untouched when present;
    - validateStep rejects a name with `{`, `BASH_ENV`, `OD_X`, a path `../x`, the 21st glob, a timeout of 5 and an unknown secret id;
    - an `after_tag` stop step becomes continue.
  - `runbooks.test.ts` is folded into `steps.test.ts`:
    - isReadOnlyRunbook is true for `[logs, status]` and false with any step;
    - validateRunbook forces the lock;
    - a `number` param rejects `1;rm`;
    - each template validates.
  - `db.test.ts`:
    - a v11 DB migrates to 13 with `parallel_prepare = 1` on existing environments;
    - an existing release keeps `operation IS NULL`;
    - the runbook unique name holds.
  - Store tests:
    - steps, flow, cap, skipUnchanged and the runbook CRUD round-trip;
    - `deploy.update` audit details hold field names only;
    - `list({operations:'only'})` filters.
- [ ] **Run.** `vitest run tests/main/steps.test.ts tests/main/db.test.ts tests/main/deploy-store.test.ts tests/main/service-store.test.ts tests/main/release-store.test.ts tests/main/runbook-store.test.ts` should FAIL, because the modules and columns are missing.
- [ ] **Implement** against the signatures above. Saving non-empty `steps` clears `pre_hook` and `post_hook` in the same transaction. `latestPerEnvironment` adds `AND operation IS NULL`.
- [ ] **Run again.** Expect PASS, and all three typechecks clean.
- [ ] **Commit.** `feat(deploy): step, flow and runbook model with migration 13`.

### Task 3: Generator custom steps and hook migration

**Files:**
- Modify: `src/main/deploy/runner.ts`, `src/main/deploy/generate.ts`, `src/main/deploy/markers.ts`, `src/main/deploy/mask.ts` (only if the `B64_VAR` regex misses `script_b64`).
- Test: `tests/main/deploy-generate.test.ts`, `tests/main/playbook-golden.test.ts`, `tests/main/release-mask.test.ts`.

**Interfaces.**
- Consumes `Step` and `effectiveSteps` from Task 2.
- Produces `interface PlanStep { key: string; label: string; step: StepBody; anchor: StepAnchor | null; secretKeys: { envName: string; key: string }[]; paramKeys: { envName: string; valueB64: string }[] }`. `key` is `c_<n>`, n being the index in the checkout's effective steps.
- `PlanDeployment` gains `steps: PlanStep[]` and `whenBase: string | null`, the SHA-checked previous commit for `when`.
- `preHookB64` and `postHookB64` stay. They are null whenever steps are used, so `d.pre_hook` and `d.post_hook` are emitted as `''` (G3).
- `MARK` gains `STEP: 'OD-STEP'` and `SKIP: 'OD-SKIP'`.
- Produces `stepList(plan: DeployPlan): Map<string, { key: string; kind: StepKind; label: string }[]>` in generate.ts. It gives, per runId, the ordered step list the playbook will run, and seedSteps uses it (Task 5).
- Task shape: `sh(\`${key} ${sanitizeIdent(d.name)}\`, key, run, streamed(key, body), { timeout: step.timeoutSec, chdir: cwd ?? IN_REPO, become, guarded: true })`. Here:
  - `become` is `becomes(d)` for `docker`, true for `yes` and false for `no`;
  - the body decodes `{{ d.steps.<key>.script_b64 | quote }}`;
  - the env lines come in on stdin as `NAME=<b64>` from `s.<key>` or `d.steps.<key>.params`, with `no_log: true` whenever stdin carries a secret;
  - the `when` wrapper uses `d.steps.<key>.base` and `paths_b64`, prints `OD-SKIP` and exits 0 when unchanged, and counts an unknown or empty base as changed;
  - `onFailure: continue` adds `failed_when: false`, and the body prints `OD-STEP rc=$rc` when rc ≠ 0;
  - compose-exec runs `composeCommand(... ['exec','-T', <svc>, 'sh', '-c', <decoded>])`.
- `d.steps` is emitted only when the checkout has steps, so hook-free goldens stay byte-identical.

- [ ] **Write failing tests** in `deploy-generate.test.ts`:
  - `release-hooks` puts `c_0` at the old pre_hook index (after env, before build) and `c_1` after health. Each has `timeout: 600` and the same become and chdir as golden. In the golden test, `structureWithoutHooks(new) deep-equals structureWithoutHooks(golden)`.
  - The other five fixtures are byte-identical to golden.
  - A step at each of the 7 anchors lands in the right slot.
  - `bash -n` passes on every step body.
  - No raw script, param value or secret name-value appears in the text. The env name appears only inside a stdin line.
  - A continue step has `failed_when: false`.
  - `when: paths` emits `git diff --quiet` with globs from base64.
  - Rollback emits only `alsoOnRollback` steps.
  - In `release-mask.test.ts`, a stream line echoing a secret and its base64 is redacted (Review Focus 1).
- [ ] **Run** `vitest run tests/main/deploy-generate.test.ts tests/main/playbook-golden.test.ts tests/main/release-mask.test.ts`. It should FAIL.
- [ ] **Implement.** In `releaseTasks`, step tasks are inserted per anchor. Today's `hookTask` path goes away, because hooks arrive as steps through `effectiveSteps` in plan() (Task 5). Until Task 5, tests build `steps` directly.
- [ ] **Run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(deploy): generate custom steps at anchors; hooks become steps`.

### Task 4: Translator and step parsing for custom kinds, scoped markers and multiple hosts

**Files:**
- Modify: `src/main/deploy/events.ts`, `src/shared/playbook-steps.ts`, `src/main/deploy/local-runner.ts` (RunOutcome fields).
- Test: `tests/main/deploy-events.test.ts`, `tests/main/playbook-steps.test.ts`.

**Interfaces.**
- `EventTranslator` keys its active state by `${host}|${stepId}`. It replaces the single `current` and `tagNote` with per-host maps. In multi-host plays it drops results whose host alias is not the run's host (G5).
- A step key matching `/^c_\d{1,3}$/` maps to `kind: 'custom'`, and `step.started.name` is the PlanStep label.
- Markers are scoped (G13):
  - PREV comes only from `record`;
  - HEAD only from `checkout` and `rb_checkout`;
  - BACKUP only from `backup`;
  - TAG only from `tag`;
  - `OD-STEP rc=` settles the step as `warn`;
  - `OD-SKIP` settles it as `skipped`.
- The deployment succeeds on the last counted task of its block, not on `tag` (G11).
- `RunOutcome` gains `reachedUp: string[]`, the runs whose `up` step started.
- `playbook-steps.ts`:
  - `PlaybookPlay` becomes `{ hosts: string[]; stage: number; steps; deployments }`;
  - `isHelperTask` also matches the prefixes `build launch ` and `od gate`;
  - `stepLabels` resolves the labels of `c_<n>` steps from task names.

- [ ] **Write failing tests.**
  - `deploy-events.test.ts`:
    - a custom step started, then ok, settles ok with its label;
    - `OD-STEP rc=3` gives warn;
    - `OD-SKIP` gives skipped;
    - an `OD-PREV` line inside a custom step's stdout is ignored;
    - success arrives after an `after_tag` step;
    - two hosts interleaved in one play keep separate step state and drop foreign-host results (Review Focus 4);
    - `reachedUp` is filled.
  - `playbook-steps.test.ts`: a play with `hosts: ['od-1','od-2']` parses into one PlaybookPlay with both hosts and stage index 0, and launch and gate tasks are helpers.
- [ ] **Run** `vitest run tests/main/deploy-events.test.ts tests/main/playbook-steps.test.ts`. It should FAIL.
- [ ] **Implement.** The renderer callers of `PlaybookPlay.host` are updated in Task 14. Keep a `host` getter shim (`hosts[0]`) until then so `tsconfig.web` still passes.
- [ ] **Run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(deploy): translate custom steps, scope markers, key state by host`.

### Task 5: Release service wiring: steps, secrets, skip-unchanged, nothing selected

**Files:**
- Modify: `src/main/deploy/release-service.ts` (`plan()` :1142, `seedSteps` :1300, `resolveSecrets` :1239, `preflight` :279, `start` :406), `src/main/deploy/local-runner.ts` (`totalTimeoutSec`), `src/main/deploy/selection.ts`.
- Test: `tests/main/release-service.test.ts`, `tests/main/release-preview.test.ts`, `tests/main/deploy-selection.test.ts`.

**Interfaces.**
- `plan()` builds `PlanDeployment.steps` from `effectiveSteps(dep)`, the `secretKeys` minted by `resolveSecrets`, and `whenBase` (the run's `previousCommit` from preflight when it passes SHA, else null).
- `resolveSecrets` adds the secrets of steps in scope. It refuses a step secret that the environment's existing env and become references do not include (S12), with "This step uses a secret the environment does not already use".
- `seedSteps(infos, kind, backup)` is rebuilt from `stepList(plan)` and stores `label` and `key` on each row.
- Skip-unchanged:
  - `PreflightResult` services get `skippable: boolean`, true when `skipUnchanged && known && count === 0`;
  - `ReleaseOptions` gains `forceServiceIds: string[]`;
  - `resolveSelection` drops skippable services that are not forced and returns `skipped: string[]`.
- `start` refuses with `NOTHING_SELECTED_MESSAGE = 'Every selected service has no changes; select one to deploy it anyway'` when every service was skipped. That check happens before the redeploy branch.
- `totalTimeoutSec` sums the timeouts of the steps.

- [ ] **Write failing tests.**
  - Through release-rig with a fixture deployment that has a pre-hook and a post-hook: `release.detail().runs[0].steps` lists `c_0` with label `pre-hook` in the old slot, and the preview hash is stable across two calls.
  - A step secret not used by env or become is refused, and the refusal message holds no value.
  - With skipUnchanged, a known zero-commit service is dropped and reported skipped, and forcing it brings it back.
  - When all are skipped, start throws NOTHING_SELECTED, not the redeploy confirm.
  - An unknown commit count is never skipped.
  - The `release.start` audit details hold no step names or values.
- [ ] **Run** `vitest run tests/main/release-service.test.ts tests/main/release-preview.test.ts tests/main/deploy-selection.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(release): run custom steps with their secrets; skip unchanged services`.

### Task 6: Release flow stages

**Files:**
- Modify: `src/main/deploy/runner.ts` (`DeployPlan.flow`), `src/main/deploy/generate.ts` (`playFor`, `generatePlaybook`), `src/main/deploy/ssh-files.ts` (`generateInventory`), `src/main/deploy/release-service.ts` (`plan`, `releasePlan`), `src/main/deploy/selection.ts`.
- Test: `tests/main/deploy-generate.test.ts`, `tests/main/release-service.test.ts`, `tests/main/deploy-selection.test.ts`.

**Interfaces.**
- `interface PlanFlow { stages: PlanStage[]; onFailure: ReleaseFlow['onFailure'] }`.
- `type PlanStage = { kind: 'services'; parts: { runId: string; services: string[] | null }[] } | { kind: 'step'; runId: string; step: PlanStep }`.
- `DeployPlan.flow: PlanFlow | null`.
- `flowStages(flow: ReleaseFlow | null, selected: Info-like[], metas): PlanStage[]`, a pure function exported from selection.ts. It:
  - keeps flow order;
  - drops unselected services and their step stages;
  - splits a checkout's up and health across stages by service;
  - with no flow, returns null, so the generator path is today's.
- With a flow, the generator emits one play per stage, over the stage's hosts.
  - Blocks carry `when: inventory_hostname == '<alias>'` in a fixed, quoted alias form, and the alias passes `ALIAS`.
  - `strategy: free` is used across hosts, and services on the same host stay in listed order.
  - `stop-all` sets `any_errors_fatal: true`. `continue-other-hosts` omits it, and the next play's first task fails hosts if any host has `od_failed`.
  - Per-host `od` and become values move to inventory host_vars, generated from the same values and emitted only when a flow or parallel prepare is active.
  - Step stages generate the step task on the bound checkout's host, in phase 2.
  - The lock is taken in the first play on every host, as today.

- [ ] **Write failing tests.**
  - No flow: all six goldens are unchanged.
  - The flow `backend → migrate(step on backend) → frontend ∥ fastapi` gives 3 plays in that order. The second holds only the step task on backend's host, and the third spans both hosts with per-host `when`.
  - The JSON parses, and `bash -n` passes on every shell.
  - stop-all has `any_errors_fatal`.
  - The inventory host_vars hold no secret value, only the `{{ ... }}` references that are in the play vars today.
  - flowStages drops unselected services and step stages bound to them.
  - Through the rig, the stage order shows in seeded steps, and the preview hash is stable.
- [ ] **Run** `vitest run tests/main/deploy-generate.test.ts tests/main/release-service.test.ts tests/main/deploy-selection.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(deploy): release flow stages as consecutive plays`.

### Task 7: Parallel prepare

**Files:**
- Modify: `src/main/deploy/runner.ts`, `src/main/deploy/generate.ts`, `src/main/deploy/local-runner.ts`, `src/main/deploy/events.ts`, `src/main/deploy/release-service.ts` (`runRelease`, `autoRollback`, `rollbackTargets`, `cancel`, `safeUnlock`, `runPreflight`).
- Test: `tests/main/deploy-generate.test.ts`, `tests/main/deploy-events.test.ts`, `tests/main/release-service.test.ts`.

**Interfaces.**
- `DeployPlan.prepare: { cap: number } | null`. It is null when the environment's `parallelPrepare` is false.
- `prepareSchedule(deps: PlanDeployment[], cap: number): string[][]`, a pure function exported from generate.ts. Per host it returns waves of runIds of at most `cap`. Checkouts that share `hostId + repoPath` chain inside a single slot, one after another (G7).
- Phase 1 is one play over all hosts. Per checkout it runs record, backup, fetch, checkout, env and the `PREPARE_ANCHORS` steps synchronously.
  - Build is launched as `build launch <name>` with `async: buildTimeoutSec, poll: 0`. The launch is a helper task, and the body writes its pgid to `<repo>/.git/opsdeck-build-<run>.pid`.
  - Then `build <name>` runs `async_status` with tags `od_step=build`, retries `ceil(timeout/5)` and delay 5.
  - The prepare rescue sets `od_prep_failed`, and a final `od gate` task fails every host when any host has it.
- Phase 2 holds the plays for up, health, post steps and tag, using flow order from Task 6.
- The LocalRunner writes `async.json`, listing `{runId, hostId, repoPath}` per launched build, to the run dir.
- The unlock plan gains `killBuilds: { runId; repoPath }[]`. Its unlock task first runs `kill -TERM -$(cat pid)` for each, then removes the pid files, then removes the lock.
- `PREPARE_FAILED_MESSAGE(svc: string)` = `` `Build failed for ${svc}: no service was restarted; servers are left at the new commit with the new .env; running containers are unchanged.` ``
- Auto-rollback targets are limited to `reachedUp` when `plan.prepare` is set.
- Manual rollback stays available as today. That is a ruling.
- Preflight blocks two selected checkouts that share a repo path with different branches when parallel prepare is on, with the check id `shared-repo`.

- [ ] **Write failing tests.**
  - Generator:
    - with `prepare: {cap: 2}` and 3 checkouts on one host, the waves are [2, 1] and the launch precedes async_status;
    - async_status carries the od_step and od_run tags;
    - a shared repo path chains;
    - the gate task exists;
    - no `up` task appears in phase 1;
    - `bash -n` passes and the JSON parses;
    - with `prepare: null`, the goldens are unchanged;
    - the unlock plan kills recorded build pids before removing the lock file (Review Focus 3).
  - Events: a launch result does not settle build, and async_status ok does.
  - Rig:
    - a prepare-only failure gives no up anywhere, no auto-rollback run, and a PREPARE_FAILED_MESSAGE that names the service (Review Focus 2);
    - cancel mid-build runs the unlock plan with killBuilds;
    - the shared-repo preflight check blocks.
- [ ] **Run** `vitest run tests/main/deploy-generate.test.ts tests/main/deploy-events.test.ts tests/main/release-service.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(deploy): parallel prepare with async builds and a prepare gate`.

### Task 8: Operation playbooks (built-ins and params)

**Files:**
- Create: `src/main/deploy/generate-ops.ts`.
- Modify: `src/main/deploy/runner.ts` (`PlanKind` gains `'operation'`, `DeployPlan.operation`), `src/main/deploy/generate.ts` (export the `sh`, `streamed`, `block`, `taskPrep`, `taskLock` and `taskUnlock` helpers, and dispatch on kind).
- Test: `tests/main/deploy-generate-ops.test.ts`.

**Interfaces.**
- `interface PlanOperation { runbookId: string; name: string; lock: boolean; items: ({ type: 'step'; step: PlanStep } | { type: 'builtin'; builtin: BuiltinKind; tail?: number; untilHours?: number })[]; targets: { runId: string; services: string[] }[] }`.
- `generateOperation(plan: DeployPlan): string`.
  - It gives one play per host, with lock tasks only when `lock`.
  - Per target checkout, a block runs every item in order.
  - Every item task is `streamed()` (G24), with kind `c_<n>` for steps and `op_<builtin>` for built-ins. Built-in kinds use `[a-z_]` and fit the STREAM regex.
  - Built-ins:
    - `restart`, `stop`, `start` and `status` use `composeCommand` with the target's compose services;
    - `logs` uses `--tail <tail>`, with tail ≤ LOG_TAIL_MAX;
    - `prune-images` runs `docker image prune -f` plus `--filter until=<h>h` (h is an integer);
    - `backup-db` reuses the backup task;
    - `pull-only` reuses fetch and checkout.
  - Params are `OD_PARAM_<NAME>=<b64>` stdin lines.
- `StepKind` gains `'op'`, and the label is the built-in's name.

- [ ] **Write failing tests.**
  - Each built-in's command text appears with services quoted, and the JSON parses.
  - `bash -n` passes on every body.
  - A `lock: false` runbook has no lock or unlock tasks.
  - A param value `$(id)` appears only as base64.
  - No `environment:` key appears anywhere.
  - Logs tail 6000 is refused at plan build time.
- [ ] **Run** `vitest run tests/main/deploy-generate-ops.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(deploy): generate runbook operation playbooks`.

### Task 9: Operations in the release service, with IPC

**Files:**
- Modify:
  - `src/main/deploy/release-service.ts`;
  - `src/main/deploy/release-store.ts`;
  - `src/main/deploy/events.ts` (op kinds);
  - `src/main/ipc/handlers/deploy.ts`;
  - `src/shared/ipc.ts`;
  - `src/preload/index.ts`;
  - `src/main/notify/*`, for the one-line operation summary when `notify`.
- Test: `tests/main/release-service.test.ts`, `tests/main/release-store.test.ts`, `tests/main/deploy-ipc.test.ts`.

**Interfaces.**
- `ReleaseService.preflightOperation(req: { environmentId: string; runbookId: string; serviceIds: string[]; params: Record<string, string> }, ctx?: CallCtx): Promise<{ releaseId: string }>`.
  - It runs a short preflight: reachability, the lock check and compose services. It then creates a `ready` row with `operation` set and audits `ops.preflight`.
- `previewPlaybook` and `start` branch on `rel.operation`.
  - The access action is `ops.run`, the target deployment ids are those of the targeted services' checkouts, and the audit action is `ops.run` with `{ name, serviceCount, outcome }`.
  - Read-only operations skip the per-environment rule in `assertCapacity`, but still count toward `MAX_ACTIVE_RELEASES`.
  - Protected environments require the typed name.
- Every kind branch also checks `operation === null`:
  - `rollback`;
  - `retryVersion`;
  - `runFinalize` (no tags or notes);
  - `latestPerEnvironment`;
  - QA and notifications (operations notify with a one-line summary only when `notify`);
  - `assertStartable` (allows an operation).
- `DeployAccess` gains the action `'ops.run'`, and the desktop allows it.
- IPC channels:
  - `runbook:list(environmentId)`, `runbook:save(input)`, `runbook:delete(id)`;
  - `release:preflightOperation(req)`;
  - all of them added to the allow-list.

- [ ] **Write failing tests** through the rig:
  - an operation runs preview → start → succeeded, with steps seeded;
  - `release.list({operations:'only'})` returns it;
  - an operation row is excluded from rollback, retryVersion and latestPerEnvironment, and gets no version tagging (Review Focus 5);
  - a read-only operation can start while a release runs on the same environment, and a locking one is refused BUSY;
  - the protected environment's typed name is enforced;
  - the audit holds counts and names, no hosts and no param values;
  - in IPC, a save rejects invalid input with VALIDATION.
- [ ] **Run** `vitest run tests/main/release-service.test.ts tests/main/release-store.test.ts tests/main/deploy-ipc.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(release): runbook operations share release history, lock and audit`.

### Task 10: Playbook validator and edited runs

**Files:**
- Create: `src/main/deploy/playbook-validate.ts`, `tests/main/playbook-validate.test.ts`.
- Modify:
  - `src/main/deploy/runner.ts` (`DeployPlan.playbookText?: string`);
  - `src/main/deploy/local-runner.ts`, which writes `playbookText ?? generatePlaybook(plan)`;
  - `src/main/deploy/release-service.ts` (`previewPlaybook`, `start`, `rollback`);
  - `src/main/deploy/release-store.ts`;
  - `src/main/deploy/mask.ts`;
  - `src/main/ipc/handlers/deploy.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`.
- Test: `tests/main/playbook-validate.test.ts`, `tests/main/release-preview.test.ts`, `tests/main/release-service.test.ts`.

**Interfaces.**
- `validateEditedPlaybook(text: string, generated: string): { ok: true; canonical: string } | { ok: false; errors: { line: number; message: string }[] }`. It runs:
  1. `JSON.parse`, with a scanning pass that rejects duplicate keys, a BOM, `NaN` and `Infinity` (S9).
  2. Per-level key allow-lists (S7), and the module allow-list: shell, command, set_fact, fail, debug (msg only), wait_for and uri.
     - uri takes only these params: url, method, status_code, timeout, headers, body, body_format, return_content, validate_certs.
     - Timeouts are capped to STEP_TIMEOUT_RANGE.
  3. Jinja checks.
     - Only `{{ <path>( | filter)* }}` may appear, with the filters quote, b64decode, default, from_json, bool and int. `{%` and `{#` are rejected.
     - `s`, `hostvars` and `ansible_become_password` appear only inside strings equal to generated ones.
     - `when` and `failed_when` must equal a generated string or match `<reg>.rc (==|!=) <int>`.
  4. Generator-owned equality.
     - The plays, hosts and each play's `vars` must equal the generated ones.
     - Every task with `delegate_to` or `connection`, every lock prep, lock, unlock and gate task, and every no_log secret-stdin task must be byte-identical to a generated task.
  5. No `ansible_*`, `s`, `d`, `od` or `od_failed` in set_fact, register or vars (S3).
  6. `canonical = JSON.stringify(parsed, null, 2)`.
- Line numbers come from the scanner's offsets.
- Plain-language messages are exported as `EDIT_RULE` for the UI.
- `ReleaseService.validateEdit(releaseId: string, text: string, ctx?): { ok: true; canonical: string; sha256: string } | { ok: false; errors }`.
  - It regenerates exactly as the preview does, with the preview's startedAt.
- `start(releaseId, { editedPlaybook, playbookSha256, typedName })`:
  - it validates again and checks `sha256(canonical) === playbookSha256`;
  - it stores `playbook = canonical`, `playbook_generated = generated` and `playbook_source = 'edited'`, and runs `plan.playbookText = canonical`;
  - it audits `playbook.edited` with `{ lineDelta: number }` only.
- A rollback of an edited release uses the generated rollback, and its `releaseNotes` gets the line `ROLLBACK_GENERATED_NOTE = 'This release ran an edited playbook; the rollback uses the generated one.'`
- The same edit path works for operations.
- IPC `release:validateEdit(releaseId, text)`. On the desktop anyone may edit. On a protected environment, `start` requires the typed name, as today.

- [ ] **Write failing tests** in `playbook-validate.test.ts`, each with its message and line:
  - The generated text of every golden is accepted unchanged, and its canonical text equals the input.
  - Each rejection: a duplicate key, `delegate_to: localhost` on a new task, a changed health `delegate_to` task, `hosts: all`, `include_tasks`, `roles`, `vars_files`, `vars_prompt`, `handlers`, `pre_tasks`, `action:`, `args:`, `module_defaults`, `assert`, `pause`, `with_items`, `loop`, `uri.src`, `lookup(`, `{% %}`, `{{ s }}` in debug, `set_fact: {ansible_connection: local}`, `register: od_failed`, a removed lock task, a changed `od.lock_b64`, removed `no_log` on the env task, and a `timeout: 99999`.
  - An added `shell: echo hi` task with `tags` is accepted.
  - Review Focus 1: any reference to `s` outside the generated strings is rejected, and so is removing no_log from a secret-stdin task.
  - Service tests:
    - an edited run stores canonical and generated text, with source `edited`;
    - the hash mismatch refuses with PLAYBOOK_CHANGED_MESSAGE;
    - the audit details are `{lineDelta}` only;
    - a rollback of an edited release gets ROLLBACK_GENERATED_NOTE;
    - masking applies to both stored texts.
- [ ] **Run** `vitest run tests/main/playbook-validate.test.ts tests/main/release-preview.test.ts tests/main/release-service.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(release): validated one-off playbook edits`.

### Task 11: Hub server: migration 11, manifest schema 2, permissions and routes

**Files:**
- Modify:
  - `hub/src/db.ts` (HUB_MIGRATIONS 11);
  - `hub/src/config.ts` (`allowPlaybookEdits?: boolean`, default false);
  - `hub/src/registry.ts` (readManifest, sortManifest, publish);
  - `hub/src/releases/adapters.ts` (settings and services carry flow, prepare and skipUnchanged; a runbook adapter);
  - `hub/src/releases/service.ts`;
  - `hub/src/routes/releases.ts`;
  - `hub/src/routes/meta.ts`;
  - `hub/src/access/policy.ts`;
  - `src/shared/hub.ts`.
- Test: `hub/tests/db.test.ts`, `hub/tests/registry.test.ts`, `hub/tests/policy.test.ts`, `hub/tests/releases.test.ts`, `hub/tests/release-scope.test.ts`, `hub/tests/meta.test.ts`, `hub/tests/config.test.ts`.

**Interfaces.**
- Hub migration 11 `playbook_ops`:
  - on `releases`: `operation TEXT NULL`, `playbook_source TEXT NULL` and `playbook_generated TEXT NULL`;
  - on `environments`: `playbook_ops TEXT NOT NULL DEFAULT '{}'`, a JSON `{flow, parallelPrepare, prepareCap, runbooks}`.
  - Steps live in the deployments meta JSON, and `skipUnchanged` in the services meta JSON.
  - Existing rows default to parallelPrepare true and cap 3 on read.
- `HubEnvManifest` gains:
  - `schema?: 1 | 2`;
  - `environment.parallelPrepare?`, `prepareCap?` and `flow?`;
  - `services[].skipUnchanged?`;
  - `deployments[].steps?`;
  - `runbooks?: Omit<Runbook, 'environmentId' | 'createdAt' | 'updatedAt'>[]`.
- `HubMeta` gains `capabilities: { manifestSchema: 2; playbookEdits: boolean }`.
- `HubAction` gains `'ops.run' | 'playbook.edit'`.
  - `ADMIN_ONLY` gains `'playbook.edit'`.
  - `ops.run` passes with a covering grant, the same as `release.start`. No `ops.edit` action is added (deploy.edit covers it).
- `HUB_AUDIT_ACTIONS` gains `ops.run`, `ops.preflight` and `playbook.edited`.
- `readManifest`:
  - validates the steps (`validateStep`), flow and runbooks (`validateRunbook`) with the shared validators;
  - adds step secret ids to the `requiredSecrets` check;
  - leaves `preHook` and `postHook` accepted;
  - with `schema` absent or 1, migrates hooks on read through `effectiveSteps`.
- Routes:
  - `POST /api/v1/releases/preflight-operation`;
  - `POST /api/v1/releases/:id/validate-edit`. It returns 403 unless `allowPlaybookEdits` is set and the actor is an admin;
  - `start` accepts `editedPlaybook` under the same guard;
  - `GET /api/v1/releases?operations=only|exclude`.
- Operation visibility: an operation is listed only to holders whose `viewScope` covers every target checkout's deployment id.

- [ ] **Write failing tests.**
  - A v9 DB migrates to 10, and a release keeps `operation` null.
  - A schema-1 manifest with preHook reads back with a `pre-hook` step.
  - Invalid steps, a step secret outside requiredSecrets and a 21-step checkout are each rejected with a path message.
  - `decide(maintainer,'playbook.edit')` is denied and `decide(maintainer,'ops.run')` with a covering grant is allowed.
  - Validate-edit is 403 with the setting off, 403 for a maintainer with it on, and 200 for an admin with it on.
  - A partially-scoped holder cannot list an operation targeting an uncovered checkout.
  - `/meta` reports the capabilities.
  - A config without the setting defaults to false.
  - The Hub audit for `ops.run` has no host fields.
- [ ] **Run** `cd hub && ../node_modules/.bin/vitest run tests/db.test.ts tests/registry.test.ts tests/policy.test.ts tests/releases.test.ts tests/release-scope.test.ts tests/meta.test.ts tests/config.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then `tsc -p hub/tsconfig.json`.
- [ ] **Commit.** `feat(hub): playbook ops manifest schema 2, ops.run and gated playbook edits`.

### Task 12: Desktop Hub publish and runner

**Files:**
- Modify: `src/main/hub/publish.ts` (`buildManifest` :75, `HubPublisher`), `src/main/hub/runner.ts` (`ReleaseApi`, `HubRunner`, `RoutingReleases`), `src/main/hub/catalog.ts`.
- Test: `tests/main/hub-publish.test.ts`, `tests/main/hub-runner.test.ts`.

**Interfaces.**
- `buildManifest(environmentId, deps, o: { hubSchema: 1 | 2 })`.
  - With schema 2, it emits `schema: 2`, steps, flow, the prepare settings, skipUnchanged and runbooks.
  - With schema 1, migrated hook steps go back out as `preHook`/`postHook`. Any other step, a flow, or a runbook makes publish throw `HUB_TOO_OLD_MESSAGE = 'This Hub is too old for custom steps, release flow or runbooks; update the Hub first'`.
- `HubPublisher` reads `/meta` capabilities first, and a missing value counts as schema 1.
- `ReleaseApi` gains `preflightOperation(req)` and `validateEdit(releaseId, text)`, and `start` forwards `editedPlaybook`.
- `RoutingReleases` routes them by environment, as it does `preflight` today.
- Runbook CRUD for a Hub environment is a republish, the same as for deployments.

- [ ] **Write failing tests.**
  - Schema 1 with only migrated hooks publishes preHook and postHook and no steps.
  - Schema 1 with a custom step throws HUB_TOO_OLD.
  - Schema 2 round-trips through the Hub's `readManifest`, imported from `hub/src/registry.ts` the way `hub-e2e.test.ts` does.
  - `requiredSecrets` includes the step secret ids.
  - HubRunner forwards preflightOperation and validateEdit to the right routes.
- [ ] **Run** `vitest run tests/main/hub-publish.test.ts tests/main/hub-runner.test.ts`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then the typechecks.
- [ ] **Commit.** `feat(hub): publish steps, flow and runbooks when the Hub supports them`.

### Task 13: Renderer: Deployment dialog Steps section and skip toggle

**Files:**
- Create: `src/renderer/src/pages/deployments/StepsSection.tsx`, `src/renderer/src/pages/deployments/StepEditor.tsx`, `tests/renderer/deploy-steps.test.tsx`.
- Modify: `src/renderer/src/pages/deployments/DeploymentDialog.tsx`, which replaces the hook fields with StepsSection while still reading them through `effectiveSteps`; `src/renderer/src/deploy/form.ts`; and the service edit form, for the "Skip if no new commits" toggle.

**Interfaces.**
- `StepsSection({ steps, onChange, secrets: { id; name }[], serviceNames: string[] }): JSX.Element`.
  - It shows a timeline of built-in steps with "+ Add step" at each anchor.
  - Up and down buttons reorder within an anchor. Drag and drop is optional.
  - Each step expands to StepEditor: a monospace script field, plus run, compose service, sudo, timeout, failure policy, condition (with paths) and secrets.
  - Secrets are an env-name input plus a select limited to `secrets`.
- Validation errors come from `validateStep`, run in the renderer for inline messages. Main re-validates.

- [ ] **Write failing tests.**
  - A deployment with a preHook shows a `pre-hook` step under "before build".
  - Adding a step at `after_up` and saving sends `steps`, with the hooks cleared.
  - An env name `PATH` shows the deny message, and Save is disabled.
  - `after_tag` locks the failure policy to continue.
  - The skip toggle saves `skipUnchanged`.
- [ ] **Run** `vitest run tests/renderer/deploy-steps.test.tsx`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then `tsc -p tsconfig.web.json`.
- [ ] **Commit.** `feat(ui): steps section in the deployment dialog`.

### Task 14: Renderer: Release flow section, environment toggles, wizard skips and pipeline stages

**Files:**
- Create: `src/renderer/src/pages/products/ReleaseFlowSection.tsx`, `tests/renderer/release-flow.test.tsx`.
- Modify:
  - `src/renderer/src/pages/products/EnvironmentView.tsx`, adding the section after ServicesSection at :146;
  - `src/renderer/src/pages/deployments/EnvDeploySettings.tsx`, adding the Parallel prepare toggle and a cap of 1..8;
  - `src/renderer/src/pages/deployments/release/DeployWizard.tsx` and `ServicePicker.tsx`, to show "skipped: no changes" with "Deploy anyway";
  - `src/renderer/src/deploy/pipeline.ts`, for `hosts[]` and `stage`, removing the Task 4 shim;
  - `src/renderer/src/pages/deployments/release/{Pipeline,AnsibleSteps,StepChip}.tsx`, to show custom labels, warn and skipped.
- Test: `tests/renderer/release-flow.test.tsx`, `tests/renderer/deploy-pipeline.test.ts`, `tests/renderer/release-pages.test.tsx`.

**Interfaces.**
- `ReleaseFlowSection({ environmentId, services, settings, onSave })`.
  - Stages show as rows of service chips, with step stages between them.
  - It shows a preview line, e.g. `backend → migrate → frontend ∥ fastapi`, produced by `flowPreview(flow, names): string`, exported for tests.
  - It has a failure policy select.
- `pipeline.ts`: lanes stay per host, and each lane lists its blocks from every play in stage order.

- [ ] **Write failing tests.**
  - `flowPreview` produces the example string.
  - Saving sends the `flow` patch.
  - The wizard shows a skippable service as skipped, and "Deploy anyway" adds it to `forceServiceIds`.
  - The pipeline of a two-host stage play gives two lanes with the correct blocks.
  - A custom step chip shows its label and the warn state.
- [ ] **Run** `vitest run tests/renderer/release-flow.test.tsx tests/renderer/deploy-pipeline.test.ts tests/renderer/release-pages.test.tsx`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then `tsc -p tsconfig.web.json`.
- [ ] **Commit.** `feat(ui): release flow, parallel prepare and skipped services`.

### Task 15: Renderer: Runbooks section, run dialog and history badge

**Files:**
- Create: `src/renderer/src/pages/products/RunbooksSection.tsx`, `src/renderer/src/pages/products/RunbookDialog.tsx`, `src/renderer/src/pages/products/RunRunbookDialog.tsx`, `tests/renderer/runbooks.test.tsx`.
- Modify: `EnvironmentView.tsx`, `src/renderer/src/pages/deployments/release/ReleaseHistory.tsx` (an "Operation" badge and a filter), `src/renderer/src/pages/deployments/release/ReleaseView.tsx` (hide rollback, version and notes for operations), and `src/renderer/src/deploy/releases.ts`.

**Interfaces.**
- `RunbooksSection({ environmentId })` lists runbooks with Run, Edit and "New from template". Templates come from `RUNBOOK_TEMPLATES` and are created only when picked.
- `RunRunbookDialog` gives:
  - a param form, validated with `validateParamValues`;
  - service checkboxes, defaulting to the target;
  - then the shared PlaybookReview;
  - then live progress in ReleaseView.
  - It calls `release:preflightOperation`, then preview, then start, with the typed name on protected environments.

- [ ] **Write failing tests.**
  - Creating from "Tail logs" saves a read-only runbook with lock off.
  - The Run dialog refuses `1;rm` in a number param.
  - Run calls preflightOperation, then preview, then start with the sha.
  - History shows the Operation badge, and the filter limits the list to operations.
  - ReleaseView for an operation shows no Rollback button.
- [ ] **Run** `vitest run tests/renderer/runbooks.test.tsx tests/renderer/release-history.test.tsx`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS, then `tsc -p tsconfig.web.json`.
- [ ] **Commit.** `feat(ui): runbooks per environment`.

### Task 16: Renderer: edit in Review playbook, Edited badge and diff

**Files:**
- Modify: `src/renderer/src/pages/deployments/release/PlaybookReview.tsx`, `DeployWizard.tsx`, `ReleaseView.tsx` (an "Edited playbook" header badge), and `src/renderer/src/pages/deployments/PlaybookLogsPage.tsx` (the edited text plus a diff toggle against the generated text).
- Create: `src/renderer/src/deploy/line-diff.ts` (a pure LCS line diff, with no dependency), `tests/renderer/playbook-edit.test.tsx`.

**Interfaces.**
- `PlaybookReview({ playbook, editable: boolean, onRunEdited?: (text: string, sha256: string) => void })`.
  - Edit turns the view into a monospace textarea.
  - Every change calls `release:validateEdit`, debounced by 400 ms, and shows the errors inline by line number.
  - "Run edited" is enabled only on `ok`.
- `editable` is always true on the desktop. On the Hub it follows `capabilities.playbookEdits && isAdmin`.
- `lineDiff(a: string, b: string): { op: ' ' | '+' | '-'; text: string }[]`.

- [ ] **Write failing tests.**
  - The validation error at line 12 renders next to line 12.
  - Run edited passes the canonical sha.
  - With a Hub environment and a non-admin, there is no Edit button.
  - ReleaseView shows "Edited playbook" for an edited source.
  - The diff toggle shows `+`/`-` lines.
  - `lineDiff` handles an empty input and a pure insert.
- [ ] **Run** `vitest run tests/renderer/playbook-edit.test.tsx`. It should FAIL.
- [ ] **Implement, then run again.** Expect PASS. Then run the full app suite, the full Hub suite and all three typechecks.
- [ ] **Commit.** `feat(ui): edit and run a validated playbook once`.

---

## Self-review

- **Spec coverage.** Each spec section maps to these tasks:

  | Spec | Tasks |
  |---|---|
  | C1 | 2, 3, 4, 5, 13 |
  | C2 | 6 (flow), 7 (parallel prepare), 5 (skip-unchanged) |
  | C3 | 8, 9, 15 |
  | C4 | 10, 16 |
  | C5 | 11, 12, with audit across 2, 9, 10 |
  | C6 | 13–16 |
  | A1–A3 | 10 (validator, hash, typed name), 3 and 10 (redaction) |
  | A4 | 1, with the goldens re-checked in 3, 6 and 7 |

  - The PO answers are honoured. Parallel prepare defaults to 1 in migration 13 and to true on Hub reads. A prepare failure leaves the code in place and does not auto-roll back (Task 7). Hub edits are behind `allowPlaybookEdits` (Task 11).
- **Step scan.** Every task has a failing test with named assertions, a run command, an implement step, a passing run and a commit. There is no "TBD".
- **Type consistency.** These names are spelled the same everywhere they appear:
  - `Step`/`StepBody`/`PlanStep`, `effectiveSteps`, `stepList`;
  - `PlanFlow`/`PlanStage`, `prepareSchedule`, `PlanOperation`;
  - `validateEditedPlaybook`, `OperationMeta`;
  - `playbookSource`/`playbookGenerated`.
  - `PlaybookPlay.hosts` changes in Task 4, with a shim that Task 14 removes.
- **Review Focus.** All 5 failure modes have a named test in tasks 3, 7, 4, 9 and 10.
- **Proportion.** 16 tasks. The heaviest are 7 (parallel prepare) and 10 (validator). Both are kept whole because their tests need the full mechanism.

### Task 17: Config export and import carry steps, flow, runbooks and toggles (pre-flight S16)

Runs in the core track after Task 9. Today export and import handle only `preHook`/`postHook`, so everything Tasks 2–9 add would be lost on export.

**Files:**
- Modify: `src/main/config/export.ts` (deployment rows near line 245; environment and service rows)
- Modify: `src/main/config/import.ts` (deployment import near line 495; environment and service import)
- Modify: the shared config-file types that export and import use (wherever `preHook` is declared for the file format)
- Test: `tests/main/config-export.test.ts` and `tests/main/config-import.test.ts` (extend the existing ones if they're named differently)

**Interfaces:**
- Consumes, from Task 2: the deployment `steps` field, the environment's `flow`, `parallelPrepare` and `prepareCap`, the service `skipUnchanged` field, the runbook store, and `effectiveSteps()`.
- Produces: export files with the fields `steps`, `flow`, `parallelPrepare`, `prepareCap`, `skipUnchanged` and `runbooks`. They are additive, and old files without them still import.

- [ ] **Step 1: Write the failing tests**
  - `it('round-trips steps, flow, parallelPrepare, prepareCap, skipUnchanged and runbooks')`: export, then import into an empty DB. The imported values deep-equal the originals.
  - `it('an old file with only preHook/postHook imports as migrated steps pre-hook/post-hook')`: the result equals `effectiveSteps()` of the old shape.
  - `it('a file without parallelPrepare imports with parallelPrepare true and prepareCap 3')`: this is the alpha import default, per the product-owner answer that parallel prepare is on for all environments.
  - `it('step secrets are exported as secret ids only, never values')`: the export text contains none of the test secret's value or its base64 form.
  - `it('import rejects an invalid step (bad anchor, timeout 5, 21 steps) with a validation error naming the deployment')`.
- [ ] **Step 2: Run them and confirm they fail.** Run `./node_modules/.bin/vitest run --maxWorkers=3 --testTimeout=30000 tests/main/config-export.test.ts tests/main/config-import.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** Export writes the new fields only when they're set. Import validates them through the same Task 2 validators the stores use (no second validator), and when the steps are absent it migrates `preHook`/`postHook` through `effectiveSteps()`.
- [ ] **Step 4: Run the tests again.** Expected: they pass. Then run the full app suite and the node and web typechecks.
- [ ] **Step 5: Commit** with the message "Carry steps, flow, runbooks and prepare settings through config export and import".
