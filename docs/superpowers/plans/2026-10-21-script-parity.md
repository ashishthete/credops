# Script Parity and Playbook-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal.** Close the gaps between OpsDeck and `unified_release.sh` for the user's real alpha Essentials deploy. Show the generated playbook before anything runs. Show the script cross-check inside the app.

**Architecture.**
- Small changes to the playbook generator, notifications and QA settings.
- One new pure module, `src/shared/script-parity.ts`, that checks an environment's deploy config against the script's behaviour.
- One wizard step, Review playbook, bound to the run by a hash.

**Tech stack.** Electron 44, React 19, TS, vitest, node:sqlite. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-script-parity.md`. It is the 52-row audit. Row numbers below refer to it, and the parent spec is `docs/superpowers/specs/2026-10-16-opsdeck-design.md` §8.4.

The user's ask (2026-10-21): "i dont want deployment script to run from ansible. but create playbook based on the deployment script first", then "cross check all things", then "add this in app as well all this". Target: the alpha environment of the Essentials app.

## Global Constraints

- **Generated text.** Playbook, shell and unit text is tested at parse/string level only and never executed. No real ansible, docker, ssh or network in tests.
- **Secrets.** No secret value in the playbook, the preview, logs, audit, errors or IPC. The playbook carries secret *references* only, as today.
- **Injection rules** in `generate.ts` (the header comment) still hold for every new value.
- **Dependencies.** No new dependencies, no pnpm add or install.
- **Migrations** are additive (new nullable columns or JSON fields with defaults). Existing rows keep their current behaviour unless the user applies the preset (Task 5).
- **UI copy** is plain language. The UI must not say "parity". Use "Compared with unified_release.sh".
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Sonnet implementers may use their own trailer.
- **Commands.** Tests: `./node_modules/.bin/vitest run --maxWorkers=3 --testTimeout=30000`. Typechecks: `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json`.

## Review Focus

1. **Existing deployments** with `composeFile: 'docker-compose.yml'` must generate byte-identical compose lines after Task 1. Only the new auto value omits `-f`.
2. **Backend and fastapi share one git repo** (different repoPath, same `.git`). The version tag step must not fail on the second deployment (row 40).
3. **The preview hash** must match exactly what runs. Any change between preview and Deploy refuses the run with a clear message. That covers settings edits, a different branch selection, or a host key change that alters the generated text.
4. **Applying the preset** never touches a protected or `prod` environment's `versioned` flag, and is a single undoable save. It must not silently flip settings on other environments.
5. **The QA wait** of 45 minutes must not block the release finishing. The wait stays in the background as today.

---

### Task 1: Compose file "auto" (no `-f`), row 11

**Files:** `src/shared/deploy.ts`, `src/main/deploy/compose.ts`, `src/main/deploy/generate.ts`, `src/main/deploy/events.ts` (the compose-file preflight), the deployment dialog compose field in `src/renderer/src/pages/deployments/DeploymentDialog.tsx`, tests in `tests/main/` next to the existing compose and generate tests.

**Interfaces.**
- `COMPOSE_AUTO = ''` (exported from shared/deploy.ts). A deployment whose `composeFile === ''` lets Compose discover files.
- `composeCommand` omits `-f` for `''`.
- The preflight passes if any of `compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` exists in the repo dir.
- The `COMPOSE_FILE` validator accepts `''`.
- The default for *new* deployments stays `docker-compose.yml`.

- [ ] **Test.** For `''`, the generated build and up lines contain no `-f`. For `docker-compose.yml`, the lines are unchanged byte for byte (snapshot the existing output before the change). The preflight script text for `''` checks the four names.
- [ ] **Implement.** The dialog shows a toggle, "Let Compose find files (uses docker-compose.override.yml and COMPOSE_FILE)", that sets `''`.
- [ ] **Verify and commit.** Run the full suite and both tscs.

### Task 2: Version tag once per git repository, row 40

**Files:** `src/main/deploy/generate.ts` (the unified version tag tasks near :412-416 and :613-614), tests.

**Behaviour.**
- The version tag task is idempotent per repository.
- Before `git tag -a V`, check whether `refs/tags/V` already exists locally and points at `HEAD`. If so, skip creating it and skip the push, marked as already tagged.
- If it exists at a different commit, fail as today.
- The preflight rule that blocks an existing V before the run is unchanged.

- [ ] **Test.** Generate for two deployments with different repoPath. The tag shell for each contains the exists-and-points-at-HEAD guard, and the guard reads V only through `| quote` or a validated token.
- [ ] **Implement, verify and commit.**

### Task 3: Notifications match what testers get today, rows 41-42

**Files:** `src/main/notify/email.ts`, the Teams card builder in `src/main/notify/`, tests.

**Behaviour.**
- **Email subject.**
  - With a version: unchanged.
  - Without a version and with ≥1 commit: `[product] <env> update: <dd-Mon-YYYY> available for testing`. Use the release's start date, in the local timezone of the main process.
  - With 0 commits (a redeploy): keep `… redeployed`.
- **Teams card.**
  - The title includes the environment name and the product.
  - Add a "Changes" section listing up to 10 commit subjects per deployment, plus "and N more".
  - Subjects are plain text, already redacted by the existing redaction, and truncated to 120 chars.

- [ ] **Test.** Cover the subject for all three cases, the card title, the 10-item cap with "and N more", and that a subject containing a known secret is redacted.
- [ ] **Implement, verify and commit.**

### Task 4: QA wait is configurable, default 45 min, row 46

**Files:** `src/main/notify/qa.ts`, `src/shared/settings.ts` (QaWorkflow gains optional `waitMinutes`, 5..180, default 45), the env QA settings UI in `EnvDeploySettings.tsx`, tests.

- [ ] **Test.**
  - With no `waitMinutes`, it polls until 45 min.
  - `waitMinutes: 10` stops at 10.
  - Out-of-range values are rejected by the validator.
  - The release finishing is not delayed (existing background behaviour).
- [ ] **Implement, verify and commit.**

### Task 5: "Compared with unified_release.sh" checks and the one-click preset

**Files:**
- Create: `src/shared/script-parity.ts`, a pure module.
- Modify: `EnvDeploySettings.tsx`, adding a panel. Add an IPC only if the existing env and deployment data in the renderer is not enough.
- Tests.

**Interfaces.**
- `checkAgainstScript(env: { name: string; versioned: boolean; protected: boolean; qa?: { repo; workflow; ref; waitMinutes? } | null }, deployments: Array<{ name: string; composeFile: string; useSudo: UseSudo; buildTimeoutSec: number; composeTimeoutSec: number; backup: unknown | null }>): ScriptCheck[]`
- `ScriptCheck = { id: string; level: 'ok' | 'differs' | 'risk'; title: string; script: string; opsdeck: string; fix?: ScriptFix }`
- `scriptPreset(env, deployments) → { env: Partial<…>; deployments: Record<id, Partial<…>> }`

**Checks.** The plain-language copy for `script` and `opsdeck` comes from the audit rows named.
- `timeouts`, row 31: risk if build < 1800 s or up < 600 s. The fix sets 3600 and 900.
- `sudo`, rows 16 and 22: differs if `useSudo !== 'yes'`. The fix sets `yes`.
- `versioned`, rows 4, 39 and 40: risk if `versioned` and the env name is not `prod`. The fix sets `false`, never for protected or prod envs.
- `compose`, row 11: differs if not auto. The fix is auto.
- `qa-env-name`, row 45: info `ok`, showing that the workflow input will be the env name exactly.
- `qa-wait`, row 46: differs if `waitMinutes < 45`.
- `strict-build`, row 32: always `differs`, info only, no fix. "The script ignored failed builds. OpsDeck stops and rolls back."
- `rollback`, row 37: always `ok`, info. "OpsDeck also moves deploy tags back."

**UI.**
- The panel is titled "Compared with unified_release.sh" and shows each check as a row with a coloured dot.
- An "Apply script-compatible settings" button saves all fixes in one go. Before saving it shows a confirm listing every change. Afterwards it shows an Undo toast that restores the previous values.
- The panel is per environment, inside the env's deploy settings.

- [ ] **Test** (pure module).
  - Each check fires on the right inputs.
  - The preset never sets `versioned` on a protected or `prod` env.
  - The preset is a no-op on an already-compatible env.
- [ ] **Test** (renderer, existing renderer test style). Applying calls save once with exactly the listed changes, and Undo restores them.
- [ ] **Implement, verify and commit.**

### Task 6: Review playbook before Deploy, bound by hash

**Files:**
- `src/main/deploy/release-service.ts`: a preview entry point.
- The IPC deploy handlers and preload.
- `src/renderer/src/pages/deployments/release/DeployWizard.tsx`: a new step before Deploy.
- `src/renderer/src/deploy/releases.ts`.
- Tests.

**Interfaces.**
- IPC `deploy:previewPlaybook(input: StartReleaseInput) → { playbook: string; sha256: string }`.
  - It builds the plan and playbook exactly as start does, through a shared function, so there is one code path.
  - It writes nothing, takes no lock, and starts no agent.
- `StartReleaseInput` gains `playbookSha256: string`.
  - Start regenerates the playbook and refuses with "The playbook changed since you reviewed it. Review it again." when the hash differs.
  - The stored release `playbook` is the reviewed text.
  - A missing hash is refused for runs started from the UI. Retry and rollback flows generate their own playbook and are exempt. Say so in a code comment.

**Wizard.**
- After the preflight and service picker, a "Review playbook" step shows the YAML in the same monospace view as ReleaseView.
- A step list on the left names each block: deployment name, then fetch, build, up, health, tag, and rollback.
- "Save as .yml…" uses the existing save-dialog IPC pattern, writing only the text.
- The Deploy button is enabled only on this step. Protected envs still require the typed name.

- [ ] **Test** (main).
  - The preview equals the playbook that start stores for the same input.
  - A mismatched hash is refused and nothing is written.
  - The preview has no secret values (use a fixture vault with a known secret and assert it is absent).
- [ ] **Test** (renderer). Deploy is disabled until the review step, and the start call carries the hash.
- [ ] **Implement, verify and commit.**

---

## Added 2026-10-21 from the user's later answers

### Task 7: Strip credentials from repository URLs already saved (user approved: "1 ok")

**Files:** a new additive migration in the main DB migrations, plus tests. Use the existing `hasRepoCredentials` from `src/shared/inventory.ts`.

**Behaviour.**
- Run once, as a migration, over `products.repo_url` and `deployments.repo_url`.
- For any URL with userinfo (`https://user:token@host/...` or `https://token@host/...`), remove the userinfo and keep the rest byte for byte.
- Write an audit event with the **count only**, never a URL or a value.
- Rows without credentials are untouched.
- The migration is idempotent.

- [ ] **Test.**
  - Seed both tables via SQL with credentialed, clean and null URLs.
  - After the migration: the credentials are gone, everything else is unchanged, and the audit detail has the count and no URL text.
  - A second run changes nothing.
- [ ] **Implement, verify and commit.**

### Task 8: Hub unpublish keeps release history (user: "we can keep history", "commit id basically and time")

**Files:** `hub/src/**` (the unpublish route and its store; today it cascades and deletes releases, per final-review M5), the hub tests, and the app side only if it shows history for an unpublished environment.

**Behaviour.**
- Unpublishing an environment keeps its releases on the Hub, read-only.
- Each kept release keeps at least: release id, deployment names, commit ids (previous and deployed), started and finished time, status and actor.
- Logs may be dropped.
- Unpublished history is visible to admins and to the env's former members in the Hub history list, marked "unpublished".
- Republishing the same environment shows its old history again.
- Do the schema change additively: soft-unlink (for example `unpublished_at`) rather than delete.

- [ ] **Test (hub).**
  - Unpublish, then the releases still exist with commit ids and times, and no new release can be started.
  - Republish, then the history is visible again.
  - A non-member cannot read it.
- [ ] **Implement, verify (hub suite + `tsc -p hub/tsconfig.json`) and commit.**

### Task 9: Ansible steps and logs, clearer in the release view (user: "better show logs and steps of ansible in app")

**Files:**
- `src/renderer/src/pages/deployments/release/{Pipeline,LiveLog,StepChip,ReleaseView}.tsx`, plus a new `AnsibleSteps.tsx` if needed.
- `src/main/deploy/callback-plugin.ts` and `events.ts` only if the per-task data the UI needs is not already emitted.
- Tests.

**Behaviour.** The release view shows a step list per host and per deployment, in playbook order, one row per Ansible task, using the same names as the Task 6 preview step list. Each row shows:
- the status icon (pending, running, ok, changed, skipped, failed);
- the duration;
- the attempt or retry count if any.

**Logs.**
- Clicking a row opens that task's own output: stdout and stderr, already redacted, with rc and the command's failure message.
- "All logs" keeps today's full live log.
- When a step fails, its row auto-expands, and the existing AI help attaches to that step.
- Live updates while running.
- Finished releases show the same view from stored events.

- [ ] **Test.**
  - Events produce rows in playbook order with the right statuses.
  - A failed task auto-expands and shows its redacted output (a fixture secret is absent).
  - A stored release renders the same rows.
- [ ] **Implement, verify and commit.**
