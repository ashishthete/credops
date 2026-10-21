# unified_release.sh vs OpsDeck: parity audit (alpha / Essentials)

Date: 2026-10-21. Read-only static audit. Nothing was run.

**Command audited:**

```
./deployment/unified_release.sh --env alpha --branch develop-essentials-api \
  --frontend-branch develop-essentials-frontend --version-type minor --no-backup
```

It runs on the host from `~/src/acme-essentials-alpha/esg_stage/webapp/esg/`.

**Sources:**

- **Script:** `webapp/esg/deployment/unified_release.sh` (1660 lines) and `unified_release_mail.sh` (591 lines), at commit 97624bd5ae, the same as `origin/develop-essentials-api`. Cited as `S:<line>` and `M:<line>`.
- **OpsDeck:** `master`. Paths are relative to `src/`.

**What the script resolves for this command:**

| Setting | Value | Where |
|---|---|---|
| backend branch | `develop-essentials-api` | S:1489 |
| frontend branch | `develop-essentials-frontend` | S:1490 |
| fastapi branch | `develop-essentials-api` | S:1491 |
| backup | off | S:1431, S:440-441 |
| email and Teams | on | |
| QA | on (alpha is not prod/uat/uat_eu) | S:1505-1511 |
| version bump | none: `--version-type minor` has no effect outside prod | S:1590-1605 |
| unified release tag | none | |

**Repo layout:** fast-api and webapp/esg are subdirectories of a single git repo.

- The sample config puts them at `.../acme-essentials/webapp/esg` and `.../acme-essentials/fast-api` (`unified_config.sample`).
- The local checkout has the same layout: `acme-esg/.git` exists, and `fast-api/.git` and `webapp/esg/.git` do not.
- So "backend" and "fastapi" share one work tree, one branch and one commit history.

Status key:

- **MATCH**: same behaviour.
- **DIFFERENT**: both do it, but differently; the cell says how.
- **MISSING**: the script does it and OpsDeck does not.
- **OPSDECK-ONLY**: OpsDeck does it and the script does not.
- **UNKNOWN**: can't be decided statically; the cell says why. Counted as its own status.

## 1. Parity table

### CLI flags and defaults

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 1 | `--env` is required; it must be dev, demo, develop, stage, prod, alpha, uat or uat_eu, otherwise exit 1 (S:1424, 1468-1486, 1494-1500). | The environment is an entity picked in the UI; there is no fixed list. The env name feeds the version-tag message (`generate.ts:413`), the QA input (`notify/qa.ts:103`) and the PROD_LIKE QA default (`shared/settings.ts:18`). | DIFFERENT (model, not flag) |
| 2 | `--branch` is required and is the default for every service (S:1425, 1489-1491). | No release-level branch. Each deployment has its own `defaultBranch`, used by the plan (`release-service.ts:293`, `:1052`). There is no per-release override. | DIFFERENT. The branch is configured per deployment, so it must be set on each one (see section 3). |
| 3 | `--backend-branch`, `--frontend-branch` and `--fastapi-branch` override `--branch` for one service (S:1427-1429, 1489-1491). | Same as row 2: each deployment's `defaultBranch` is the only source. | DIFFERENT. The values are equivalent once configured, but they cannot be changed per run. |
| 4 | `--version-type patch\|minor\|major`, default `minor` (S:1420, 1426). It is used only when env=prod (S:1590-1605). | The wizard asks for a bump. It is applied only if the env is `versioned` (`release-service.ts:270-271`). | MATCH, if alpha is set to `versioned=false`. If alpha is `versioned=true`, OpsDeck tags a version where the script does not (row 40). |
| 5 | `--no-backup` sets SKIP_BACKUP (S:1431, 440-441). | `ReleaseOptions.backup`, default true (`shared/deploy.ts:438`). The backup also needs `dbBackup` and `backupDir` on the deployment (`release-service.ts:1057`). | MATCH, if the option is unticked or the deployment has `dbBackup=false`. |
| 6 | `--no-email` and `--no-teams` are separate switches (S:1432-1433, 1608, 1625). | A single `notify` switch per run covers Teams and email; macOS alerts still fire (`notify/dispatcher.ts:62`, `:247-252`). Each channel can be turned off per environment. | DIFFERENT. There is no per-run switch for one channel only. |
| 7 | `--tests` / `--no-tests`. Tests are on by default except for prod, uat and uat_eu (S:1434-1435, 1505-1511). | `ReleaseOptions.qa`. Its default comes from the environment's `qaOnDeploy` and needs a workflow (`renderer/src/deploy/slots.tsx:56-61`). For a new environment's settings, `qaOnDeploy` defaults to `!PROD_LIKE` (`renderer/.../EnvironmentNotifications.tsx:166`). | MATCH, once alpha's QA workflow is saved. Until then QA is off; the base default is `qa:false` (`shared/deploy.ts:438`). |
| 8 | `--help` and `-h` exit 0. An unknown flag exits 1 (S:1436-1463). | Not applicable (GUI). | N/A, not counted |

### Environment, repos, paths and compose files

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 9 | Settings come from `~/asrs-release/config/unified_config.<env>`, sourced as shell. A missing file exits 1 (S:70-115, 1513-1515). BACKEND/FRONTEND/FASTAPI_REPO_PATH are required. | Deployments, environments and hosts live in OpsDeck's DB. `repoPath` must be absolute and must not contain `~` (`shared/deploy.ts:22`, `deploy/deploy-store.ts:477`). | DIFFERENT. The values must be copied from the host's `unified_config.alpha`, which is UNKNOWN here because that file is on the host. |
| 10 | Deploy tags default to `backend_<env>`, `frontend_<env>` and `fastapi_<env>`, and the config can override them (S:101-103). | `deployTag` is set per deployment (`shared/deploy.ts:78`). | MATCH, once set to `backend_alpha`, `frontend_alpha` and `fastapi_alpha`. Whether the host config overrides them is UNKNOWN. |
| 11 | Compose: `docker compose up --build -d` in the repo dir with no `-f`, so Compose finds `docker-compose.yml` itself and also merges `docker-compose.override.yml` and `COMPOSE_FILE` from `.env` (S:457, 477, 497). Backend checks that `docker-compose.yml` exists (S:449-452). | `docker compose -f <composeFile> [-p project] build` and then `up -d` (`deploy/compose.ts:32`, `generate.ts:279-289`). The default `composeFile` is `docker-compose.yml` (`shared/deploy.ts:98`). The preflight checks that the file exists for every deployment (`deploy/events.ts:613`). | DIFFERENT. An explicit `-f` turns off override-file merging and `COMPOSE_FILE`. Whether the alpha host has an override file or COMPOSE_FILE is UNKNOWN; the repo has none (`webapp/esg` and `fast-api` contain only `docker-compose.yml`). |
| 12 | The backend `.env` is sourced before compose: `source .env && sudo docker compose …` (S:457, 477, 497). Because `sudo` resets the environment, the sourced values do not reach compose; compose reads `.env` on its own. | `.env` is never sourced; compose reads the project `.env` (`generate.ts:281`). | MATCH in effect, provided sudo's `env_reset` is the default. Whether the sudoers file on the alpha host keeps env vars is UNKNOWN. |
| 13 | No managed `.env`. | Optional managed `.env` written from the vault (`generate.ts:236-260`). | OPSDECK-ONLY. It must stay off for alpha so the host's `.env` is not overwritten. |

### Preflight

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 14 | Required tools are git, docker, pg_dump, curl and jq. pg_dump is required even with `--no-backup` (S:166-175). | Required tools are git, docker and curl, plus pg_dump only when the run takes a backup (`generate.ts:429-432`). jq is not needed. | DIFFERENT. OpsDeck is more lenient. |
| 15 | The three repo dirs must exist (S:177-190). | Checks that the repo exists and is a git repo (`events.ts:589-590`). | MATCH. OpsDeck also checks that it is a git repo. |
| 16 | `docker info` without sudo; failure aborts with "Docker daemon is not running" (S:192-195). The deploy itself still uses `sudo docker` (S:105-110). | Tries docker plainly, then with sudo (`useSudo` auto, yes or no) and chooses a mode (`events.ts:565-583`, `release-service.ts:1062`). | DIFFERENT. See row 22 for which docker user runs. |
| 17 | Disk: `df $BACKUP_PATH`, warns below 2 GB (S:197-201). | Disk: `df -Pk .` in the repo dir, warns below 2 GB (`generate.ts:457`, `events.ts:638`, `shared/deploy.ts:14`). | DIFFERENT. Different filesystem; warning only in both. |
| 18 | Clean tree (`git diff-index --quiet HEAD --`). This runs per repo inside `reset_branch`, at the moment that repo is deployed (S:249-263). So a dirty frontend repo is found only after the backend is already deployed, and that triggers a rollback. | Clean check for every deployment in the preflight, before anything changes (`events.ts:602`). | DIFFERENT. OpsDeck finds it earlier, which is safer. |
| 19 | Branch exists on origin, checked after fetch (S:231-247). | Fetch plus a branch-exists check in the preflight (`events.ts:607-608`). If the fetch fails but a copy was fetched before, OpsDeck warns and uses it. | DIFFERENT. The script fails hard on a fetch failure. |
| 20 | No lock, protected-environment, capacity or version-tag checks. | Lock check, deploy tag readable on origin, version tag free, typed-name confirm for protected environments, at most one release per environment and four in total (`events.ts:643-717`, `release-service.ts:1207`, `:1405`). | OPSDECK-ONLY |

### Git: fetch, checkout, reset and tags

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 21 | Fetch: `git fetch --force --tags origin refs/heads/B:refs/remotes/origin/B`. It runs for all three repos before commit collection (S:1532-1535) and again in `reset_branch` (S:259). | The same refspec (`generate.ts:221-223`), run per deployment at preflight and again in the release play. | MATCH |
| 22 | Docker runs as `sudo docker` (default `DOCKER_SUDO=true`, S:105-110), so compose builds and pulls use root's `~/.docker/config.json`. | `useSudo` auto by default (`shared/deploy.ts:98`). If plain docker works, OpsDeck runs it as the SSH user, without sudo. Become goes through Ansible (`generate.ts:285`). | DIFFERENT. With `auto`, alpha would run docker as the user, because the script's `docker info` already proves plain docker works. Registry credentials and file ownership may differ; whether that matters is UNKNOWN. Set `useSudo: yes` to match. |
| 23 | Checkout: if the local branch is missing, `checkout -b B origin/B`; otherwise `checkout B` then `reset --hard origin/B` (S:282-298). | `git checkout -q -B B refs/remotes/origin/B` (`generate.ts:225-230`). | MATCH. Same end state; both refuse to run on a dirty tree. |
| 24 | Previous commit is the local `HEAD` before the reset (S:274-280). | Previous commit is the deploy tag's commit on origin, read with `ls-remote` (OD-PREV, `generate.ts:186-191`, `release-service.ts:994`). | DIFFERENT. They give the same result when the host HEAD equals the last deploy tag; they differ after a manual change on the host or a failed run. |
| 25 | Deploy tag: `git tag -fa backend_alpha -m "Backend alpha deployment - <date>"` and `git push -f origin <tag>` (S:459-460, 479-480, 499-500). The deploy functions are called inside `if !` (S:1567-1587), so `set -e` is off within them, and a failed tag or push is ignored. | `git tag -fa T -m "OpsDeck deploy" HEAD && git push -f origin refs/tags/T`, best effort (`failed_when false`, OD-TAG warning) (`generate.ts:326-336`). The committer is `OpsDeck`. | MATCH in behaviour. The tag message and committer differ. |
| 26 | A shared repo for backend and fastapi means fastapi's "reset" does nothing, and `fastapi_alpha` lands on the same commit as `backend_alpha`. | Two deployments with different `repoPath` subdirs of one repo. The checkout repeats with no effect; locks are per path (`generate.ts:575`). | MATCH |

### Change list

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 27 | Per repo: `git log --pretty='%s (%an)' <local tag>..origin/B`. If the tag is missing locally, the full branch history. Merge commits are included and there is no cap (S:506-531). The local tag equals origin's after `fetch --force --tags`. | `git log --no-merges --max-count=501` from the deploy tag commit on origin to `origin/B`. When the tag is missing, a first-deploy path. The list is capped at 500 and reverts are filtered (`generate.ts:482-517`, `events.ts:643-675`, `shared/deploy.ts:8`, `:160-184`). | DIFFERENT. No merges, a cap, and revert filtering, so the counts differ from the script's. The script filters reverts only for display (S:381-428). |
| 28 | Total count for the "nothing new" check includes fastapi (S:1553). Backend and fastapi share history, so their commits are counted twice. Fastapi is left out of the notification counts and the AI input. | `commitsTotal` sums every deployment (`events.ts:673`). The release notes get all commits; the notes prompt says "Merge duplicates" (`ai/release-notes.ts:19`). | DIFFERENT. Notes may list the backend and fastapi commits twice; the notes prompt is the only guard. |
| 29 | Zero commits: an interactive `read -p "Continue…? (y/N)"`. No exits 0; yes continues with email and Teams turned off, QA still runs (S:1553-1564). | Zero commits needs `confirm.redeploy` (`release-service.ts:367-368`, message at `shared/deploy.ts:35`). A redeploy sends no notifications (`dispatcher.ts:102`, `:131`) and writes no notes (`release-notes.ts:130`). QA still runs (`notify/qa.ts:274-279` does not check for a redeploy). | MATCH |

### DB backup

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 30 | Backend only, after `reset_branch`. `pg_dump -Fc` with DB_* read from `.env`, to `~/asrs-release/db-backups/<date>_<label>_<db>_<time>.sql.dump`. A failure aborts (S:307-357, 440-447). Skipped on this run. | Before fetch/checkout, `pg_dump -Fc` to `<backupDir>/<label>-<run>.dump` through a `.part` file, timeout 1800 s. `.env` is parsed, not sourced (`generate.ts:193-219`). | DIFFERENT (order, file name, location). Not exercised with `--no-backup`. |

### Build, compose, sudo and timeouts

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 31 | A single `sudo docker compose up --build -d` with **no timeout** (S:457, 477, 497). `DOCKER_BUILD_TIMEOUT` is defined but never used (S:98). | Separate `build` (timeout `buildTimeoutSec`, default 300 s) and `up -d` (timeout `composeTimeoutSec`, default 120 s) (`generate.ts:279-289`, `shared/deploy.ts:98`). Each can be set from 1 to 86400 s (`generate.ts:40-43`). | DIFFERENT. A backend image build that takes longer than 5 minutes, or an `up` that takes longer than 2 minutes, fails in OpsDeck and triggers a rollback. |
| 32 | **A failed compose is not detected.** `deploy_*` is called inside `if !` (S:1567, 1574, 1581), so bash ignores `set -e` in the function body. A failed `docker compose up --build` (S:457) is followed by tag, push and `*_DEPLOYED=true`, and the function returns 0. The script's own comment at S:1381 describes this suspension. | A compose task failure fails the deployment block: the rescue sets `od_failed`, later deployments are skipped, and auto-rollback runs (`generate.ts:530-637`, `release-service.ts:409-470`). | DIFFERENT. OpsDeck is stricter. A build that is broken today but "succeeds" under the script would fail and roll back in OpsDeck. |

### Health checks

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 33 | None. | Optional URL polling every 2 s, up to `healthTimeoutSec` (default 60) (`generate.ts:294-324`). With no URLs, there are no health tasks. | OPSDECK-ONLY |

### Order of backend, frontend and fastapi

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 34 | Fetches all three repos, collects all commits, then deploys backend, frontend and fastapi in order. A failure exits 1 and the later services are skipped (S:1532-1587). | Deployments run in checkout `position` order within one play per host. A failure sets `od_failed` and skips the later ones (`deploy/selection.ts:29-32`, `generate.ts:530-637`). | MATCH, if positions are backend=1, frontend=2, fastapi=3 and all three are on the same host. |

### Rollback

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 35 | Trigger: the EXIT trap on a non-zero exit when `ENABLE_AUTO_ROLLBACK=true`, the default (S:117-135, 97). | Trigger: `autoRollback` is set per environment; on failure the release rolls back automatically (`release-service.ts:432-434`, `:472-501`). | MATCH, if alpha's `autoRollback=true`. |
| 36 | Scope: only repos with `*_DEPLOYED=true`, which is set after the tag (S:209-227). The repo that failed is not rolled back. | Scope: every deployment that reached checkout, the failed one included, in reverse order (`release-service.ts:988-998`). | DIFFERENT. OpsDeck also restores the failed service. |
| 37 | Mechanics: `git checkout <prev>` (detached), then `timeout 120 sudo docker compose up --build -d`. Failures are warnings only. **Deploy tags are not reverted.** | Mechanics: detached checkout of prev, optional rb_env, build, up, then `rb_tag` moves the deploy tag back to prev (`generate.ts:339-352`). | DIFFERENT. The script leaves `backend_alpha` pointing at the commit that failed, which skews the next run's change list. |
| 38 | Manual rollback: none. | Manual rollback (`release-service.ts:568-678`). | OPSDECK-ONLY |

### Version bump and unified release tag

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 39 | Version source: `~/asrs-release/config/version.config` (MAJOR/MINOR/PATCH); if missing, 1.0.0. Bumps: patch, major, or anything else = minor. The file is rewritten (S:533-573). **Prod only** (S:1590-1605). | Version source: `currentVersion` per environment in the DB. `bumpVersion` starts from `v0.0.0` (`shared/deploy.ts:140`). Bump applies only if `versioned` (`release-service.ts:270-277`). | MATCH for alpha with `versioned=false`. DIFFERENT for prod: a different store and starting point. |
| 40 | Unified tag (prod only): `git tag -fa vX.Y.Z -m "Release: vX.Y.Z"` and push. **Force-tagged**, on the backend and frontend repos only (S:575-585). A failure is a warning (S:1600-1602). | `git tag -a V -m "<env> release V" && git push origin V`, not forced, once per distinct `repoPath`, fastapi included (`generate.ts:412-416`, `:613-614`). The preflight blocks if V exists (`events.ts:687`). | DIFFERENT. Not on the alpha path when `versioned=false`. On prod, backend and fastapi are separate `repoPath`s in one git repo, so OpsDeck would try to create V twice in that repo, and the second attempt fails. |

### Release notes and mail

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 41 | Teams: a single success card, Adaptive Card 1.4, with title "ASRS Alpha Release" and style good (S:1100). It has an AI summary from Gemini or OpenAI with a tester-focused alpha prompt and fallback (S:656-720, 824-900), API/UI counts, commit details when there are 30 or fewer (S:1086), and the time in IST (S:1052-1054). curl `--max-time 30`; 200 or 202 is success (S:1134, 1144). | Teams: Adaptive Card 1.5 with title "Release" and facts (env, product, deployment, hosts, status, version, duration, by, at), plus a notes excerpt of at most 600 chars (`notify/teams.ts:77-129`, `dispatcher.ts:169-186`). Notes come from Claude with a "sales and marketing" prompt, falling back to the commit list (`ai/release-notes.ts:12-24`, `:125-158`). | DIFFERENT. Different title, AI provider, audience and layout. There is no commit list or API/UI count, and no IST timestamp (ISO instead). |
| 42 | Email: `unified_release_mail.sh` sends through SendGrid v3; 202 is success (M:561, 574). The alpha subject is "ASRS Alpha Update: <dd-Mon-YYYY> Available for Testing" (M:504). The email is skipped when there are no API/UI commits (M:470-476). From name and recipients come per env from `mail.config`, which must exist or the script exits 1 (M:13-15). | Email: SendGrid v3, 2xx is success (`notify/email.ts:6`, `:88-96`). The subject is `[product] alpha redeployed` whenever there is no version (`email.ts:32-35`), so every alpha release is labelled "redeployed". From name `OpsDeck`. Recipients come from the env's `emailTo`/`emailCc` (`dispatcher.ts:251`). | DIFFERENT. Subject, sender name and body differ. There is no "fastapi-only, skip email" rule. |
| 43 | Notifications are sent only on success (S:1608-1635). | Defaults also send `release.failed`, `release.rolled_back` and `qa.finished` (`shared/settings.ts:15`). | OPSDECK-ONLY |
| 44 | A notification failure is only a warning (S:1617, 1633). | A failure is logged in finalize; the release outcome is unchanged (`notify/finalize.ts:46-54`, `release-service.ts:904-929`). | MATCH |

### QA trigger

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 45 | Dispatch: alpha or uat only, never prod (S:1164-1177). POSTs `workflows/playwright.yml/dispatches` on `example-org/qa-automation`, `ref=main`, `inputs.environment=alpha`; 204 is success (S:54-56, 1190-1220). The token is `QA_DISPATCH_TOKEN` from the config file ([REDACTED]; value not read). | Dispatch: the env's `qa.repo`, `qa.workflow` and `qa.ref`. `inputs.environment` is the OpsDeck **environment name**, and `inputs.version` is added only when a version exists (`notify/qa.ts:97-112`). The token is the app-wide GitHub token from the vault (`qa.ts:239-254`). No env allow-list. | MATCH, if repo, workflow and ref are set as in section 3 and the env is named exactly `alpha`. |
| 46 | Wait: find the run every 10 s for up to 120 s, then poll every 20 s for up to 2700 s (45 min), synchronously, before the script exits. Then a Teams QA-result card (S:54-61, 1224-1406). | Wait: find the run every 15 s for up to 2 min, then poll every 30 s for up to 30 min, in the background (`qa.ts:12-15`, `:149-210`). A `qa.finished` notification follows. | DIFFERENT. A QA run longer than 30 minutes ends as "unknown" in OpsDeck; the script waits 45 minutes. |
| 47 | A QA failure never fails the deploy (S:1641-1643, 1381). | Same rule (`release-service.ts:904-929`). | MATCH |

### Locks

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 48 | None. Two concurrent runs can interleave. | A `.opsdeck-deploy.lock` per repo, created with `set -C`, exit 42 when busy, stale after 2 h, can be broken (`generate.ts:361-409`, `shared/deploy.ts:13`). | OPSDECK-ONLY. Script runs on the host don't take the lock, so a script run and an OpsDeck run are not protected from each other. |

### Logging

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 49 | Console in colour, plus a plain copy in `~/asrs-release/logs/unified_release_alpha_<YYYYmmdd_HHMMSS>.log` on the host (S:8, 113, 137-159). Lines logged before `load_config`, such as the header at S:1409-1414, are not written to the file. Docker output goes only to the console. | A step stream and `~/.opsdeck/runs/<release>/stream.log` on the operator's Mac (`shared/deploy.ts`, RUNS_SUBDIR), plus audit log entries. Docker output is streamed. | DIFFERENT. Different location, and nothing is written on the host. |

### Exit codes and results

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 50 | Exit 0 on success, `--help`, or "no" at the zero-commit prompt. Exit 1 on bad arguments, config, prerequisites or a deploy failure. A fetch or `set -e` failure in main exits non-zero, which runs the trap (S:1458-1586). | Release status: succeeded, failed or rolled_back, with step states. Ansible rc is internal; 42 means the lock is busy. | DIFFERENT (UI status vs exit code) |

### Specific to alpha / esg_stage

| # | Script behaviour | OpsDeck | Status |
|---|---|---|---|
| 51 | Alpha-specific behaviour: the Teams title and green style (S:1100), the alpha AI prompt and fallback (S:660, 714-715), the email subject (M:504), and QA on by default (S:1171-1172). Nothing in the script refers to `esg_stage`; it appears only in the host path. | Behaviour is not specific to an environment; it comes from configuration (notify events, QA, versioned). | DIFFERENT (see rows 41, 42, 45) |
| 52 | Runs locally on the host as the shell user (S:6). | Runs over SSH with Ansible from the Mac. It needs a host entry and an SSH identity with access to the repos, and **that user's git credentials for fetch and tag push**. | DIFFERENT. Whether the SSH user is the same account as the script user (which matters for `~/.ssh` deploy keys used by `git push`) is UNKNOWN. |

## 2. Counts

Counted over rows 1-52, excluding row 8 (N/A):

| Status | Count |
|---|---|
| MATCH (with the noted configuration) | 17 |
| DIFFERENT | 28 |
| MISSING in OpsDeck | 0 |
| OPSDECK-ONLY | 6 |
| N/A | 1 |

The rows: MATCH = 4, 5, 7, 10, 12, 15, 21, 23, 25, 26, 29, 34, 35, 39, 44, 45, 47. OPSDECK-ONLY = 13, 20, 33, 38, 43, 48. All other counted rows are DIFFERENT.

Row 39 is MATCH for alpha and DIFFERENT for prod; it is counted as MATCH.

Several rows depend on facts that can't be decided statically, so they carry a sub-UNKNOWN:

- the host's `unified_config.alpha` values (rows 9, 10);
- the compose override file or COMPOSE_FILE (row 11);
- sudoers `env_reset` (row 12);
- docker registry credentials (row 22);
- the SSH user's git credentials (row 52).

Nothing the script does is entirely missing from OpsDeck. The gaps are differences in behaviour.

## 3. What OpsDeck needs configured for the alpha Essentials deployment

**Host:** the alpha VM, reached over SSH, with the same Linux user that runs the script today. The user has to be able to:

- `git fetch` and `git push -f` tags on both repos;
- run `sudo docker`.

**Product / environment:**

- Name the environment exactly **`alpha`**. The name is sent as the QA `environment` input and appears in notifications.
- `versioned = false`. This matches the script, which bumps versions only for prod. With `true`, OpsDeck creates and pushes `vX.Y.Z` tags.
- `autoRollback = true`, matching `ENABLE_AUTO_ROLLBACK`'s default. If the host config sets it to false, match that; whether it does is UNKNOWN.
- Not protected; alpha is not prod.

**Deployments**, all on the alpha host, in this position order:

| Pos | Name | repoPath (absolute, no `~`) | Branch | composeFile | deployTag |
|---|---|---|---|---|---|
| 1 | backend | `/home/<user>/src/acme-essentials-alpha/esg_stage/webapp/esg` | `develop-essentials-api` | `docker-compose.yml` | `backend_alpha` |
| 2 | frontend | the host's `FRONTEND_REPO_PATH` (UNKNOWN; sample pattern `/home/<user>/src/acme-essentials-frontend`) | `develop-essentials-frontend` | `docker-compose.yml` | `frontend_alpha` |
| 3 | fastapi | the host's `FASTAPI_REPO_PATH` (UNKNOWN; layout suggests `/home/<user>/src/acme-essentials-alpha/esg_stage/fast-api`) | `develop-essentials-api` | `docker-compose.yml` | `fastapi_alpha` |

`<user>` and the frontend and fastapi paths must be copied from `~/asrs-release/config/unified_config.alpha` on the host. That file wasn't read in this audit. The deploy tags must also be checked there, in case it overrides them.

**Per deployment:**

- `useSudo: yes`, to match `sudo docker`; the script's `DOCKER_SUDO` default is true.
- `composeProject`: empty, so the default directory name matches the script.
- `buildTimeoutSec`: raise it from the default 300 to a value above the slowest real build, for example 1800–3600. The script has no limit.
- `composeTimeoutSec`: raise it from 120 to at least 600.
- `dbBackup`: off for this run. If turned on, backend only, with `backupDir: /home/<user>/asrs-release/db-backups` to keep the same location.
- Managed `.env`: off. The host's own `.env` stays as is.
- Health URLs: none. The script has none, so leave them empty, or add real ones as a deliberate improvement.
- Hooks: none.

**Notifications:**

- **Teams:** the alpha Teams webhook goes into the vault ([REDACTED]; it is in the host's `mail.config` as an `ALPHA_*` or global key).
- **Email:** `emailTo`/`emailCc` from `mail.config`'s alpha recipients. SendGrid API key and from-address go in the app settings ([REDACTED]).
- **Events:** keep `release.succeeded`. Turn off `release.failed`, `release.rolled_back` and `qa.finished` only if script parity is wanted; the script does send a QA result card.

**QA:**

- repo `example-org/qa-automation`
- workflow `playwright.yml`
- ref `main`
- `qaOnDeploy = on`, `qaWait = on`
- GitHub token in the app settings with workflow-dispatch rights on that repo ([REDACTED])

**Version source:** none for alpha. For prod later, set `currentVersion` from the host's `version.config` (the script writes `vMAJOR.MINOR.PATCH`); see row 40 for the shared-repo tag clash.

## 4. Gaps ranked by how likely they are to break or change the real alpha deploy

1. **Compose timeouts (row 31).** By default, OpsDeck kills `build` after 300 s and `up` after 120 s; the script has no limit. A cold backend or frontend image build on alpha that runs longer will fail, and then roll back. Raise `buildTimeoutSec` and `composeTimeoutSec` before the first run.
2. **Failed compose is now fatal (row 32).** Under the script, a failing `docker compose up --build` is ignored: tags move and the run "succeeds". OpsDeck fails and rolls back. If alpha builds have been failing quietly, the first OpsDeck run will surface it.
3. **Docker user / sudo (rows 16, 22).** With the default `useSudo: auto`, OpsDeck uses plain docker as the SSH user, because the script's `docker info` check shows that works. The script uses `sudo docker`. Root and the user can have different registry logins (`~/.docker/config.json`), so pulls of private base images may fail. Set `useSudo: yes`.
4. **Config values that only exist on the host (rows 9, 10, 52).** The frontend and fastapi paths, any deploy-tag or rollback overrides, and the SSH user's git push rights are UNKNOWN until `unified_config.alpha` and the account are checked. A wrong path or tag either blocks the preflight or computes the wrong change list.
5. **Compose `-f` drops override files (row 11).** If the alpha host has `docker-compose.override.yml` or `COMPOSE_FILE` in `.env`, OpsDeck's explicit `-f docker-compose.yml` will deploy a different stack. Whether that's the case is UNKNOWN; the repo has none.
6. **`versioned` must be false (rows 4, 39, 40).** Otherwise the "minor" bump that the script ignores becomes a real `vX.Y.Z` tag, pushed to every repo.
7. **Notification content changes (rows 41, 42, 43).** Testers get a different Teams card: a generic "Release" title, Claude notes written for sales, no commit list. The email subject reads "… alpha redeployed" for every release. Extra failure and rollback messages go out by default. Nothing breaks, but what people see changes.
8. **QA wait is shorter (row 46).** QA runs longer than 30 min end as "unknown" (the script waited 45). A misnamed environment (not exactly `alpha`) would also send the wrong workflow input.
9. **Different change-list counts (rows 27, 28).** OpsDeck drops merge commits and lists the shared backend and fastapi history under both deployments. The zero-commit redeploy check is still the same.
10. **Rollback scope and tag restore (rows 36, 37).** OpsDeck also rolls back the service that failed and moves the deploy tags back. That is better than the script, but different: after a failed OpsDeck run, `backend_alpha` and the other deploy tags point to the previous commits, not the failed one.
