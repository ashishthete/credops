# OpsDeck Phase 8a: Deployments Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Phase 8 is split into two plans. Each one can ship on its own.
- **8a (this file):** the model, playbook generation, the `DeployRunner`
  boundary with `LocalRunner`, the `DeployAccess` boundary, the run-event
  stream, the host deploy lock, preflight, backup, rollback, versioning,
  the release IPC, and the screens to configure apps and deployments.
- **8b (`2026-10-19-phase8-deployments-8b.md`):** the release experience.
  That covers the release wizard, the animated pipeline, the live run log,
  history, the rollback and cancel UX, map attachments and palette commands.
  8b uses only the IPC and events that 8a ships.

After 8a merges you can configure deployments, and every release capability
can be reached through IPC and is tested end to end, including a real
`ansible-playbook` run against localhost. After 8b merges a user can drive it
all from the UI.

**Goal:** The spec's §8.4 release flow (which today lives in
`unified_release.sh`) becomes a typed, tested and secret-safe engine:
- **Model:** apps, deployments and per-environment deploy settings, with
  CRUD, validation and audit.
- **Generation:** a pure generator turns a `DeployPlan` into Ansible
  playbooks, an inventory, an `ssh_config`, a `known_hosts` file and an
  `ansible.cfg`. The playbooks are `preflight`, `release`, `rollback`,
  `version` and `unlock`. None of the generated files holds a secret.
- **Running:** a `DeployRunner` interface with one implementation,
  `LocalRunner`. It spawns the external `ansible-playbook`, uses a JSON-lines
  callback plugin, and gives each run a private `ssh-agent`, a generated
  `known_hosts` and a live log tap. Phase 10 adds `HubRunner` behind the same
  interface.
- **Access:** a `DeployAccess` boundary. Locally it allows everything; the
  Hub enforces SSO roles in Phase 10.
- **Events:** an append-only `run_events` stream with UUIDv7 ids. It is the
  only thing the UI reads about a run.
- **Locking:** a host deploy lock in each repo. It is reentrant for the same
  release, goes stale after 2 h, and can be broken with a typed confirmation
  that is audited.
- **Safety and lifecycle:** preflight, a DB backup, auto-rollback in reverse
  order, a one-click manual rollback, and versioning with a unified tag.
- **Phase 9 seam:** a `FinalizeSteps` interface (release notes, notify, QA).
  It is a no-op here.

**Architecture:**
- **`src/shared/deploy.ts`** holds every shared type, limit and pure rule.
  These are the `DeployPlan`, `RunEvent`, step ids, the version bump, the
  revert filter and the env-template parser.
- **`src/main/deploy/`** holds small modules. Each one can be tested without
  Ansible:
  - `uuidv7.ts`;
  - `deploy-store.ts`: apps, deployments and environment settings;
  - `release-store.ts`: releases, deployment runs and run events;
  - `quote.ts` and `generate.ts`: pure playbook, inventory and config
    generation;
  - `callback-plugin.ts`: the Python plugin source as a string;
  - `events.ts`: JSON lines become `RunEvent`s, with redaction;
  - `tooling.ts`: detects Ansible;
  - `agent.ts`: the private ssh-agent;
  - `hostkeys.ts`: dials each host and builds `known_hosts`;
  - `log-tap.ts`: live output over the prepared SSH link;
  - `local-runner.ts`: the `DeployRunner` implementation;
  - `access.ts`: `DeployAccess`;
  - `release-service.ts`: orchestration, confirmations and audit;
  - `finalize.ts`: the Phase 9 seam.
- **Main owns every release.** The renderer only sends intents
  (`release:preflight`, `release:start`, …). It reads state from `deploy:event`
  batches and from `release:get` / `release:events`.

**Tech Stack:** Phases 1–5. **No new npm dependencies.**
- **External binaries, detected at run time and never bundled:**
  - `ansible-playbook` (ansible-core ≥ 2.14);
  - `ssh-agent`, `ssh-add` and `ssh` (system OpenSSH).
- **Generated playbooks are JSON**, which is valid YAML, so no YAML library
  is needed and no quoting can go wrong.
- **On the dev machine:** ansible-core 2.18.6 at `/opt/homebrew/bin`, and
  OpenSSH 10.2.

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md`:
- §3 G6 (deployments), G16 (audit);
- §5 anti-goals: no plaintext secrets; no protected deploy without a typed
  confirmation;
- §6 (main owns runs);
- §7 App, Deployment, Release, DeploymentRun and the Environment deploy
  fields;
- §8.4 Deployments in full;
- §8.10 (the runner and access boundaries for the Hub);
- §9a (the private agent, ProxyJump, generated `known_hosts`, sudo, health
  checks from the host, rollback).

The behavioural reference is `acme-esg/webapp/esg/deployment/unified_release.sh`.
It was read for its behaviour only; no value from its configs is reproduced.

**Upstream (Phase 6, 7):**
- Phase 8 is rebased onto Phases 6 and 7 before execution.
- **By controller ruling, the migration number is 7.** Phase 7 uses 6, and
  Phase 6 adds none.
- 8a doesn't touch Phase 6 files, and 8b Task 6 consumes the Phase 6 map
  seam.
- Phase 6 also renumbers the sidebar: Map is `mod+6` and Deployments `mod+7`.
  Phase 7 adds Ops. 8a leaves `SECTIONS` alone, and the existing
  `deployments` section id and path (`/deployments`) are reused.

Roadmap and contracts: `docs/superpowers/plans/2026-10-16-roadmap.md`. Conventions: the Phase 3–5 plans in the same folder.

## Global Constraints

- **All Phase 1–5 constraints still hold:**
  - the window flags and CSP;
  - the renderer imports no Node, and the preload requires only `electron`;
  - modules under test import only *types* from `electron`;
  - every IPC channel has a validator in `VALIDATORS`. Validator errors name
    the path and the rule, never the value;
  - mutations call `vault.assertUnlocked()`;
  - audit is appended after COMMIT;
  - renderer mutations go through `attempt(...)`;
  - `~/.ssh/known_hosts` is **read only**, and trust goes through
    `KnownHostStore`.
- **Commands.** `pnpm test` is broken in worktrees, so use these:
  - **Tests:** `./node_modules/.bin/vitest run [files]`
  - **Typecheck:** `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json && ./node_modules/.bin/tsc --noEmit -p tsconfig.web.json`
  - **Lint:** `./node_modules/.bin/eslint .` **isn't installed at
    `bac633c`**, and the `lint` script is `pnpm typecheck`. Run it if it
    exists after the rebase. Otherwise the typecheck is the lint gate. This
    is flagged to the controller.
  - If a `pnpm` command rewrites `pnpm-workspace.yaml`, run
    `git checkout pnpm-workspace.yaml` before committing.
- **Migration 7 only (`deployments`), by controller ruling.**
  - Phase 7 is migration 6, Phase 9 is 8 and Phase 10 is 9. Phase 6 adds
    none.
  - Migration 7 lands after Phase 7's migration 6. It doesn't reference any
    Phase 7 table, so it is order-independent.
  - Earlier migrations are never edited, and the number is never changed
    when branches merge.
  - **The runner must tolerate the gap.** Today `migrate()` skips every
    `m.version <= MAX(version)`. If 8 merged before 7, a database that
    already applied 7 would silently skip 6 later.
    - Task 1 changes it to skip only versions **present in
      `schema_migrations`**, applying the missing ones in ascending order.
    - `currentVersion()` keeps returning MAX.
    - If Phase 7 makes the same change first, keep whichever lands first.
      The behaviour is identical.

  The DDL, verbatim:
  ```sql
  ALTER TABLE environments ADD COLUMN versioned INTEGER NOT NULL DEFAULT 0 CHECK (versioned IN (0,1));
  ALTER TABLE environments ADD COLUMN auto_rollback INTEGER NOT NULL DEFAULT 1 CHECK (auto_rollback IN (0,1));
  ALTER TABLE environments ADD COLUMN current_version TEXT;
  CREATE TABLE apps(id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    name TEXT NOT NULL, compose_project TEXT, description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX apps_name ON apps(environment_id, host_id, name COLLATE NOCASE);
  CREATE TABLE deployments(id TEXT PRIMARY KEY, name TEXT NOT NULL,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
    repo_path TEXT NOT NULL, default_branch TEXT NOT NULL,
    compose_file TEXT NOT NULL DEFAULT 'docker-compose.yml',
    deploy_tag TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    urls TEXT NOT NULL DEFAULT '[]',
    health_status INTEGER NOT NULL DEFAULT 200 CHECK (health_status BETWEEN 100 AND 599),
    health_timeout_sec INTEGER NOT NULL DEFAULT 60 CHECK (health_timeout_sec BETWEEN 5 AND 600),
    db_backup INTEGER NOT NULL DEFAULT 0 CHECK (db_backup IN (0,1)), backup_dir TEXT,
    pre_hook TEXT, post_hook TEXT,
    build_timeout_sec INTEGER NOT NULL DEFAULT 300 CHECK (build_timeout_sec BETWEEN 10 AND 3600),
    compose_timeout_sec INTEGER NOT NULL DEFAULT 120 CHECK (compose_timeout_sec BETWEEN 10 AND 3600),
    use_sudo TEXT NOT NULL DEFAULT 'auto' CHECK (use_sudo IN ('auto','yes','no')),
    become_secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,
    managed_env INTEGER NOT NULL DEFAULT 0 CHECK (managed_env IN (0,1)), env_template TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK (db_backup = 0 OR backup_dir IS NOT NULL),
    CHECK (managed_env = 0 OR env_template IS NOT NULL));
  CREATE UNIQUE INDEX deployments_name ON deployments(environment_id, name COLLATE NOCASE);
  CREATE INDEX deployments_host ON deployments(host_id);
  CREATE TABLE deployment_vaults(deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, PRIMARY KEY(deployment_id, vault_id));
  CREATE TABLE releases(id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('release','rollback')),
    status TEXT NOT NULL CHECK (status IN ('preflight','ready','blocked','running','rolling_back',
      'succeeded','failed','rolled_back','cancelled','discarded')),
    version TEXT, previous_version TEXT,
    version_bump TEXT NOT NULL DEFAULT 'none' CHECK (version_bump IN ('major','minor','patch','none')),
    redeploy INTEGER NOT NULL DEFAULT 0 CHECK (redeploy IN (0,1)),
    rollback_of TEXT REFERENCES releases(id) ON DELETE SET NULL,
    options TEXT NOT NULL DEFAULT '{}', release_notes TEXT, error TEXT, playbook TEXT,
    triggered_by TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
  CREATE INDEX releases_env ON releases(environment_id, created_at);
  CREATE TABLE deployment_runs(id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
    deployment_name TEXT NOT NULL, host_id TEXT, host_label TEXT NOT NULL, position INTEGER NOT NULL,
    branch TEXT NOT NULL, previous_commit TEXT, deployed_commit TEXT,
    commits TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped',
      'cancelled','rolled_back','rollback_failed')),
    rolled_back INTEGER NOT NULL DEFAULT 0 CHECK (rolled_back IN (0,1)),
    backup_file TEXT, started_at TEXT, finished_at TEXT);
  CREATE INDEX deployment_runs_release ON deployment_runs(release_id, position);
  CREATE TABLE run_events(id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE(release_id, seq));
  CREATE TRIGGER run_events_append_only BEFORE UPDATE ON run_events
    BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
  ```
  Notes on the schema:
  - `releases.playbook` holds the generated, secret-free release playbook
    JSON, so the UI can offer "View playbook".
  - The `environments` columns are the §7 deploy fields that Phase 8
    consumes. `qa_on_deploy`, `qa_workflow`, `email_to/cc`, `notify_events`
    and `teams_webhook_secret_id` **stay with Phase 9's
    `environment_integrations`**, which the Phase 9 plan already assumes.
  - `current_version` matches `^v\d+\.\d+\.\d+$` or is NULL. The store
    checks it, since an added column can't carry a pattern CHECK.
- **Ids:**
  - `releases.id`, `deployment_runs.id` and `run_events.id` are **UUIDv7**,
    from `src/main/deploy/uuidv7.ts`. That is RFC 9562: a 48-bit ms
    timestamp, version 7, variant `10`, then `crypto.randomFillSync`. Ids are
    monotonic within one ms through a 12-bit counter.
  - App and deployment ids stay `randomUUID()`, like every other entity.
- **Limits** (`src/shared/deploy.ts`):
  - `MAX_DEPLOYMENTS = 512`, `MAX_APPS = 512`;
  - `MAX_URLS = 8`, `MAX_HOOK = 4000` chars, `MAX_ENV_TEMPLATE = 32768`
    chars;
  - `MAX_COMMITS = 500` per deployment; extra commits are counted in
    `truncated`;
  - `MAX_LOG_LINE = 4096` chars; longer lines are cut and suffixed with
    ` …(cut)`;
  - `MAX_EVENTS_PER_RELEASE = 50000`. Past that, `log` events are dropped,
    one `log.truncated` event is written, and step and run events are still
    kept;
  - `EVENT_BATCH_MS = 100`. Events are persisted and pushed in batches;
  - `MAX_ACTIVE_RELEASES = 4`, and at most one active release per
    environment;
  - `LOCK_STALE_MS = 2 * 60 * 60 * 1000`;
  - `DISK_WARN_KB = 2 * 1024 * 1024`;
  - `CANCEL_GRACE_MS = 10000` (SIGINT, then SIGTERM), `KILL_GRACE_MS = 5000`
    (then SIGKILL);
  - `PREPARE_DIAL_TIMEOUT_MS = 20000` for each host.
- **Validation rules** (`src/shared/deploy.ts`). These shared regexes make
  generated YAML and shell injection impossible. No user string that isn't
  base64 contains `{`, `}`, a quote, `$`, a backtick, `;`, `|`, `&` or a
  newline:
  - `REPO_PATH = /^\/[A-Za-z0-9._@+\/-]{1,255}$/`. It must be absolute, must
    not contain `..`, and must not end in `/`;
  - `GIT_REF = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/`,
    for branch and tag;
  - `COMPOSE_FILE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/`, a path
    relative to the repo;
  - `BACKUP_DIR` uses the same rule as `REPO_PATH`;
  - each URL must parse with `new URL`, use `http:` or `https:`, have no
    credentials, contain no `{}`, and be at most 2048 chars;
  - `pre_hook` and `post_hook` are free text up to `MAX_HOOK`. They **only**
    reach a playbook base64-encoded and run as
    `echo <b64> | base64 -d | bash -e` (see Secrets);
  - the env template: see `parseEnvTemplate` in Task 1.
- **Secrets: the channel is decided as follows.**
  1. **The vault values a run needs** are the managed `.env` content
     (rendered from the template) and the become password. They are resolved
     in main **once, at `release:start`** (and at rollback). They are kept in
     memory for the release and dropped when it ends.
  2. They reach Ansible through **one child-process environment variable,
     `OPSDECK_SECRETS`**:
     - its value is a JSON object `{ "<key>": "<base64 value>" }`;
     - the playbook reads it on the controller with
       `lookup('env','OPSDECK_SECRETS') | from_json`;
     - lookup results are marked unsafe by Ansible, so they are never
       re-templated (verified with a `{{ 7*7 }}` value on ansible-core
       2.18.6);
     - **every task that references it is `no_log: true`**;
     - base64 values are decoded **on the target host** from stdin:
       `base64 -d > .env.opsdeck-new`.
  3. **Nothing secret touches the controller's disk, even encrypted:**
     - `ansible.builtin.copy content=` is **forbidden**, because its action
       plugin writes the content to a local temp file;
     - the `.env` is written with `ansible.builtin.shell` and `stdin`;
     - `pipelining = True` is set, so module arguments go over SSH stdin and
       never land in a remote temp file;
     - `ANSIBLE_KEEP_REMOTE_FILES=0` is set;
     - no `-e @file`, no vault file, no inventory var holds a secret.
  4. **The become password** is
     `ansible_become_password: "{{ (s.become_<n> | b64decode) if s.become_<n> is defined else omit }}"`.
     It is set as a host var in the play's `vars`, reading the same
     `OPSDECK_SECRETS`.
  5. **Private keys** never go to Ansible. They go to the run's **private
     ssh-agent**, on `ssh-add -` stdin (Task 5).
  6. **The DB password** never reaches OpsDeck. The backup sources `.env`
     **on the host**, `set -a; . ./.env; set +a`, as the reference script
     does.
  7. **Redaction.** Every `log` line, step error, run error, audit detail and
     toast text passes through `redact(text, knownSecrets ∪ runSecrets)`.
     `runSecrets` holds every individual secret value the run resolved, not
     only the joined `.env`.
  8. **Leftover files.** The generated files hold no secrets. They live in a
     `0700` run dir that is removed when the run ends, including on failure.

  The alternatives were rejected:
  - **`-e @/dev/fd/3`** fails, because Ansible checks that the path is a
    regular file.
  - **An ansible-vault file with an env-reading password script** exposes the
    same values and adds a temp file and crypto for nothing.

  **Residual exposure, accepted and noted:**
  - processes of the same OS user can read the child's environment (`ps
    eww`), just as they could read OpsDeck's memory;
  - `.env` and `.env.opsdeck-prev` on the target host are the intended
    target state, written with mode `0600`.
- **Templating safety.** User strings reach a playbook only as validated
  tokens (rules above), as base64 (hooks), or as data JSON-encoded inside
  `vars`. Every shell command takes them through `{{ var | quote }}`. The
  generator test asserts that no task string contains a raw user value
  outside `vars`.
- **Ansible environment.** The child process is spawned with a **built**
  environment, never `process.env`. It contains:
  - `PATH`: the detected tool dirs, plus `/usr/bin:/bin:/usr/sbin:/sbin`;
  - `HOME`, `LANG=en_US.UTF-8`;
  - `ANSIBLE_CONFIG=<rundir>/ansible.cfg`, `ANSIBLE_HOME=<rundir>/ah`,
    `ANSIBLE_LOCAL_TEMP=<rundir>/tmp`;
  - `ANSIBLE_KEEP_REMOTE_FILES=0`, `ANSIBLE_NOCOLOR=1`,
    `ANSIBLE_FORCE_COLOR=0`, `PYTHONUNBUFFERED=1`;
  - `OPSDECK_SECRETS`.

  `SSH_AUTH_SOCK` is **not** passed; each host's `IdentityAgent` comes from
  the generated `ssh_config`. The generated `ansible.cfg` is:
  ```ini
  [defaults]
  stdout_callback = opsdeck_jsonl
  callback_plugins = <rundir>/callback_plugins
  callbacks_enabled =
  host_key_checking = True
  retry_files_enabled = False
  interpreter_python = auto_silent
  forks = <min(hosts, 10)>
  timeout = 30
  [ssh_connection]
  pipelining = True
  ssh_args = -F <rundir>/ssh_config
  control_path_dir = <rundir>/cp
  ```
- **Generated `ssh_config`** (Task 3). There is one `Host od-<n>` block per
  hop alias, holding:
  - `HostName`, `Port`, `User`;
  - `ProxyJump od-<m>` for the previous hop;
  - `IdentityAgent <sock>`;
  - `IdentitiesOnly yes` plus `IdentityFile none`, for key identities only;
  - `PreferredAuthentications publickey`;
  - `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
    `BatchMode yes`;
  - `StrictHostKeyChecking yes`, `UserKnownHostsFile <rundir>/known_hosts`,
    `GlobalKnownHostsFile /dev/null`;
  - `ServerAliveInterval 15`;
  - `ControlMaster auto`, `ControlPath <rundir>/cp/%C`, `ControlPersist 60`.

  `<sock>` is the private agent for a `key` identity, and the user's
  `SSH_AUTH_SOCK` (resolved from the deps env) for an `agent` or `default`
  identity. The `default` case also omits `IdentitiesOnly`, so OpenSSH's
  default key files apply. **A `password` identity anywhere in a chain is
  rejected before anything runs**, with the error
  `Deploys need key or agent auth; "<hop label>" uses a password` (§9a).
- **Run dir.** It is `mkdtemp(join(tmpdir(), 'od-'))` with mode `0700`. The
  agent socket is `<rundir>/a`. **On macOS, Unix socket paths are capped at
  104 bytes** (seen during research with a scratchpad path). If
  `<rundir>/a` would be longer than 100 bytes, the run dir falls back to
  `mkdtemp('/tmp/od-')`. The run dir is removed with `rm -rf` when the run
  ends.
- **Host lock** (§8.4):
  - The lock file is `<repo_path>/.opsdeck-deploy.lock`. Its JSON is
    `{ releaseId, user, machine, environment, version, startedAt }`. `user`
    and `machine` are sanitised to `[A-Za-z0-9._@-]`, and the other fields
    are validated tokens.
  - **Acquire** happens at the start of the `release` and `rollback`
    playbooks, for every repo on the host. It uses
    `set -C; printf '%s' <json|quote> > .opsdeck-deploy.lock`:
    - if the file exists, the task prints `OD-LOCK <content>`;
    - it exits `0` when the holder's `releaseId` equals ours (reentrant);
    - it exits `42` otherwise.
  - **Release** happens only in the `unlock` playbook, which deletes the
    file only when it still holds our `releaseId`. The release service
    **always** runs `unlock` last: after success, failure, rollback, cancel
    and a crash recovery at startup. A lock therefore stays held across
    release → auto-rollback → version tagging, and nobody can slip in
    between.
  - **Busy** is the `lock.busy` event. Its text is
    `<user>@<machine> is deploying <version|release> since <time>` (the time
    is relative in the UI). It carries `stale: true` when `startedAt` is
    more than `LOCK_STALE_MS` ago.
  - **Break** is `release:break-lock`. It is allowed only when the holder is
    stale, and needs the host label typed exactly. It runs a `break-lock`
    flavour of `unlock` that deletes the file only if its content is
    byte-identical to what preflight saw, and is audited as
    `deploy.lock_break`.
  - **Startup recovery.** Releases in `running` or `rolling_back` when the
    app starts are marked `failed` with error
    `OpsDeck quit during the release`. The lock is left to go stale,
    because there is no vault access at startup. Phase 10's Hub owns locks
    centrally.
- **Steps** (`StepKind`, each one a pipeline chip in 8b):
  - **Host level:** `lock`, `unlock`.
  - **Deployment level, in order:**
    1. `record` (previous commit);
    2. `backup` (only when `db_backup`);
    3. `fetch`, then `checkout`;
    4. `env` (only when `managed_env`);
    5. `pre_hook` (only when set);
    6. `build`, then `up`;
    7. `health` (only when there are URLs);
    8. `post_hook` (only when set);
    9. `tag`.
  - **Rollback:** `rb_checkout`, `rb_env` (when `managed_env`), `rb_build`,
    `rb_up`, `rb_tag`.
  - **Release level:** `version` (versioned envs on success), then
    `finalize_notes`, `finalize_notify`, `finalize_qa`.
  - **Step ids:** `<deploymentRunId>:<kind>` for deployment steps,
    `host:<hostId>:<kind>` for lock and unlock, `release:<kind>` for release
    steps.
  - **Tagging.** Every generated task is tagged `od_step=<kind>` and
    `od_run=<deploymentRunId|host:<hostId>|release>`. The callback reads
    these tags.
- **Build and up are split** into two steps, `docker compose -f <file> build`
  then `up -d`. This differs from the reference, which runs one
  `up --build -d`. Each step has its own Ansible task `timeout:`
  (`build_timeout_sec`, `compose_timeout_sec`), giving two honest chips and
  a precise error. Both steps source `.env` first:
  `set -a; [ -f .env ] && . ./.env; set +a`.
- **Docker privilege** (§9a):
  - **Preflight** works it out per deployment:
    1. `docker info` → `plain`;
    2. else `sudo -n docker info` → `sudo`;
    3. else, if `become_secret_id` is set, a become test → `sudo-password`;
    4. else it is a blocker:
       `docker needs sudo on <host> and no sudo password is set`.

    `use_sudo: 'no'` stops at step 1; `'yes'` skips step 1.
  - **Release playbook.** The resolved mode is baked into the plan.
    `sudo` and `sudo-password` tasks use `become: true`, with the password
    from `OPSDECK_SECRETS` for `sudo-password`.
- **Health checks** (§9a):
  - **`from: 'host'`** (the default) runs a bash loop of
    `curl -sS -o /dev/null -w '%{http_code}' --max-time 10 <url|quote>` until
    the code equals `health_status` or `health_timeout_sec` passes. The
    interval is 2 s.
  - **`from: 'mac'`** runs `ansible.builtin.uri` with
    `delegate_to: localhost`, `connection: local`,
    `status_code: <health_status>`, `retries`/`delay: 2`, and
    `until: r.status == <health_status>`.
- **Timeouts:**
  - every generated shell task has `timeout:`:
    - `fetch`, `checkout`, `record`, `tag` and `lock`: 120 s;
    - `backup`: 1800 s;
    - hooks: 600 s;
    - build and up: as configured;
  - preflight tasks: 60 s each.
- **Auto-rollback** (§8.4):
  - When `auto_rollback` is on and the release playbook fails, the service
    runs the `rollback` playbook for **every deployment run that reached
    `checkout`**, on any host, in **reverse plan order**.
  - Each rollback:
    - checks out `previous_commit` (`git checkout -f <sha>`);
    - restores `.env.opsdeck-prev` when `managed_env` wrote one;
    - rebuilds with `build` and then `up -d`;
    - moves `deploy_tag` back to `previous_commit` (`git tag -fa` +
      `push -f`) when the release had already moved it.
  - **Hosts run in parallel within one playbook** (one play per host), and
    deployments on one host run sequentially.
  - **When one host fails, the other hosts finish their own play.**
    Ansible can't stop sibling plays mid-way without `any_errors_fatal`,
    which would kill in-flight builds. The rollback then reverts all of
    them. This is flagged as a decision.
  - When `auto_rollback` is off, the release ends `failed`, and 8b offers a
    one-click rollback.
- **Versioning:**
  - It applies only to `versioned` environments.
  - **Wizard:** `next = bump(current_version ?? 'v0.0.0', bump)`.
  - **Preflight** blocks when the tag already exists in any repo:
    `Tag v1.5.0 already exists in <repo>`.
  - **On success**, the `version` playbook runs `git tag -a vX -m "<env>
    release vX"` and `git push origin vX` in every repo of the release.
    Then, and only then, `environments.current_version = vX` is committed,
    together with `release.version`. Tagging failures are a `failed`
    `version` step. The deploy stays up, and the version isn't committed.
  - A redeploy (zero commits) doesn't bump; `version_bump` is forced to
    `none`.
- **Zero commits** (§8.4). When every deployment has 0 commits, preflight
  reports `commitsTotal: 0`. `release:start` then requires
  `confirm.redeploy === true`, and the release is stored with `redeploy = 1`.
  Phase 9 skips notifications for it.
- **Protected environments:**
  - `release:start`, `release:rollback` and `release:break-lock` require the
    typed confirmation **in main**:
    - `confirm.typedName === environment.name` for start and rollback;
    - `confirm.typedLabel === host.label` for break-lock.
  - Anything else fails with code `CONFIRM_REQUIRED` and the message
    `Type the environment name to confirm`.
  - The renderer collects it with the Phase 3 `ConfirmDialog`
    `typeToConfirm`.
- **Access** (`DeployAccess`):
  - Every release, rollback, cancel and lock-break call, and every deployment
    edit, calls
    `access.check(actor, action, { environmentId, deploymentIds? })`
    first.
  - A denial throws code `DENIED` and is audited with outcome `denied`.
  - `LocalAllowAll` returns `{ allowed: true }`.
- **Audit**, new actions appended to `AUDIT_ACTIONS`:
  - `app.create`, `app.update`, `app.delete`;
  - `deploy.create`, `deploy.update` (`details.fields`), `deploy.delete`;
  - `release.preflight`, with `details` `{ deployments, commits, blockers }`;
  - `release.start`, with `details`
    `{ kind, version, bump, redeploy, deployments, hosts, secretIds }`.
    `secretIds` holds ids only;
  - `release.finish`: `success` or `failure`, with `details`
    `{ status, version, durationSec, failedStep? }`;
  - `release.cancel`;
  - `release.rollback`: the manual one. Auto-rollback shows as a
    `release.finish` status of `rolled_back`;
  - `deploy.lock_break`, with `details` `{ host, holder }`. The holder is
    `user@machine`;
  - `deploy.settings`, with `details.fields`.

  `targetType` is `release` with the release id and `<env> <version|kind>`,
  or `deployment`/`app` with the id and name. No URL, repo path, hook text or
  secret value goes in audit details.
- **Tests:**
  - **No test touches the real `~/.ssh`, `SSH_AUTH_SOCK` or a host other than
    localhost.**
  - `LocalRunner` tests use an injected `spawn` (a `FakeAnsible` replaying
    JSON-line fixtures), an injected `agent`, `hostKeys` and `tap`, and a temp
    `HOME`.
  - **Exactly two kinds of test use real binaries**, and both skip when the
    binary is missing:
    - `agent.real.test.ts` uses `ssh-agent`/`ssh-add` with a key generated
      in a temp dir and a cleared env;
    - `ansible-local.test.ts` uses `ansible-playbook` with
      `ansible_connection=local` against temp git repos, a bare origin, and
      `docker`/`curl` shims on `PATH`. It never uses `ssh`.
  - Timers go through injected clocks; there are no real sleeps over
    100 ms.
- **Feel (8a).** The only 8a screens are configuration screens: the
  Deployments page list and the deployment dialog. They use the Phase 1
  rules (springs from `ui/motion.ts`, and `useMotionSafe()` gates every
  transform). The pipeline animation and the live log belong to 8b.

## Review Focus

1. **No secret anywhere it shouldn't be.**
   - With a template secret `S3cr3t-Value-xyz` and a become password
     `B3come-pw-123`, a full fake run checks:
     - neither value appears in a generated file (the playbook, inventory,
       `ssh_config` or cfg);
     - nor in `releases.playbook`, any `run_events.payload`, audit rows,
       thrown errors or the spawn argv;
     - and they are only in the spawn env `OPSDECK_SECRETS`, base64-encoded.
   - A fixture line in which Ansible echoes the secret comes out redacted.
   - The run dir is gone after the run.
   - *Pinned:* the Task 6 test `no secret reaches disk, argv, events or
     audit`, and the Task 3 test `generated files never contain secret
     values`.
2. **Injection.** A hook containing `{{ 7*7 }}`, `$(id)` and quotes runs
   verbatim (the real localhost test prints it literally). Repo, branch,
   tag and compose values that break the regexes are rejected by the
   validator and by the store. *Pinned:* the Task 3 tests `hooks reach bash
   byte-exact via base64` and `rejects unsafe tokens`, and the Task 8
   localhost test.
3. **The lock never leaks or double-grants.**
   - The `unlock` playbook runs after success, failure, rollback, cancel and
     a runner crash.
   - A second release on the same repo gets `lock.busy` with the holder
     text.
   - The same release re-acquires its own lock.
   - Break-lock refuses a fresh lock and a changed lock file.
   - *Pinned:* the Task 7 tests `unlock always runs`, `busy names the
     holder` and `break-lock needs stale + typed label`, and the Task 8
     localhost test `second release is blocked by the first's lock`.
4. **Rollback correctness.**
   - Only deployments that reached `checkout` are rolled back, in reverse
     order, to their `previous_commit`, and the deploy tag is moved back.
   - `current_version` is untouched on failure.
   - *Pinned:* the Task 7 test `auto-rollback reverts in reverse order` and
     the Task 8 localhost test `failed health rolls back to the previous
     commit`.
5. **Protected confirmation is enforced in main**, not only in the UI.
   *Pinned:* the Task 7 test `protected start without the typed name is
   CONFIRM_REQUIRED and audited denied`.
6. **Ansible missing** gives one clear, actionable error before anything
   runs, and leaves no release row in `running`. *Pinned:* the Task 4 test
   `missing ansible-playbook explains how to install`.

## File map

```
src/shared/deploy.ts                      types, limits, regexes, bump, revert filter, env template, RunEvent (T1)
src/shared/audit.ts, ipc.ts               actions, channels, events (T1, T2, T7)
src/main/db/migrations.ts                 migration 7 (T1)
src/main/deploy/uuidv7.ts                 UUIDv7 (T1)
src/main/deploy/deploy-store.ts           apps, deployments, env deploy settings (T2)
src/main/deploy/release-store.ts          releases, deployment_runs, run_events (T2)
src/main/ipc/handlers/deploy.ts           app:*, deploy:* (T2); release:* (T7)
src/main/ipc/validators.ts                validators (T2, T7)
src/main/deploy/quote.ts                  b64, sanitise, lock JSON (T3)
src/main/deploy/generate.ts               playbooks, inventory, ssh_config, known_hosts, cfg (T3)
src/main/deploy/callback-plugin.ts        opsdeck_jsonl.py source (T4)
src/main/deploy/events.ts                 JSON line → RunEvent, preflight/commit parsing, redaction (T4)
src/main/deploy/tooling.ts                ansible / ssh-agent detection (T4)
src/main/deploy/agent.ts                  private ssh-agent (T5)
src/main/deploy/hostkeys.ts               prepare dial, generated known_hosts (T5)
src/main/deploy/log-tap.ts                live output tail over the prepared link (T5)
src/main/deploy/runner.ts                 DeployRunner interface, DeployPlan types (T6)
src/main/deploy/local-runner.ts           LocalRunner (T6)
src/main/deploy/access.ts                 DeployAccess, LocalAllowAll (T7)
src/main/deploy/finalize.ts               FinalizeSteps seam, no-op default (T7)
src/main/deploy/release-service.ts        orchestration, confirm, audit, recovery (T7)
src/main/index.ts                         wiring, before-quit guard (T2, T7)
tests/main/deploy-helpers.ts              fixtures, FakeAnsible, fake agent/tap (T2, T6)
tests/main/fixtures/ansible/*.jsonl       recorded callback output (T4, T6)
src/renderer/src/deploy/store.ts          apps/deployments/settings store (T9)
src/renderer/src/pages/deployments/*      DeploymentsPage, DeploymentDialog, EnvTemplateEditor, EnvDeploySettings (T9)
```

---

### Task 1: Migration 7, shared deploy types, pure rules and UUIDv7

**Files:**
- Create:
  - `src/shared/deploy.ts`;
  - `src/main/deploy/uuidv7.ts`.
- Modify:
  - `src/main/db/migrations.ts` (migration 7, and gap-tolerant `migrate`);
  - `src/shared/audit.ts` (all of the Phase 8 actions above, at once).
- Test:
  - `tests/main/inventory-schema.test.ts` (migration 7);
  - `tests/main/deploy-rules.test.ts` (new);
  - `tests/main/uuidv7.test.ts` (new).

**Interfaces.** These are produced in `src/shared/deploy.ts`; later tasks use
these exact names.
- The limits and regexes from Global Constraints.
- The basic types:
  - `type UseSudo = 'auto' | 'yes' | 'no'`;
  - `type DockerMode = 'plain' | 'sudo' | 'sudo-password'`;
  - `type HealthFrom = 'host' | 'mac'`;
  - `interface HealthUrl { url: string; from: HealthFrom }`.
- `interface AppMeta { id; environmentId; hostId; name; composeProject: string | null; description; createdAt; updatedAt }`,
  plus `AppInput` / `AppPatch`.
- `interface DeploymentMeta`, with these fields:
  - `id`, `name`, `environmentId`, `hostId`, `appId: string | null`;
  - `repoPath`, `defaultBranch`, `composeFile`, `deployTag`, `position`;
  - `urls: HealthUrl[]`, `healthStatus`, `healthTimeoutSec`;
  - `dbBackup: boolean`, `backupDir: string | null`;
  - `preHook: string | null`, `postHook: string | null`;
  - `buildTimeoutSec`, `composeTimeoutSec`;
  - `useSudo: UseSudo`, `becomeSecretId: string | null`;
  - `managedEnv: boolean`, `envTemplate: string | null`;
  - `vaultIds: string[]`;
  - `createdAt`, `updatedAt`.
- `DeploymentInput`. These fields are required: `name`, `environmentId`,
  `hostId`, `repoPath`, `defaultBranch` and `deployTag`. The rest are
  optional, with these defaults:
  - `composeFile 'docker-compose.yml'`;
  - `urls []`;
  - `healthStatus 200`, `healthTimeoutSec 60`;
  - `buildTimeoutSec 300`, `composeTimeoutSec 120`;
  - `useSudo 'auto'`.

  `deployTag` defaults in the dialog (not the store) to
  `deploy_<env name slug>`. This mirrors the reference's `backend_<env>`.
- `DeploymentPatch = Partial<…>`, with explicit `null`s to clear fields.
- `interface EnvDeploySettings { environmentId; versioned: boolean; autoRollback: boolean; currentVersion: string | null }`,
  plus `EnvDeploySettingsPatch`.
- `type VersionBump = 'major' | 'minor' | 'patch' | 'none'`, and
  `bumpVersion(current: string | null, bump: VersionBump): string | null`.
  `null` with `none` gives `null`; `null` with `minor` gives `v0.1.0`;
  `v1.4.2` with `major` gives `v2.0.0`. `VERSION = /^v\d+\.\d+\.\d+$/`.
- `interface CommitInfo { sha: string; subject: string; author: string; date: string; deploymentId: string }`,
  and `filterReverts(commits): { kept: CommitInfo[]; hiddenPairs: number }`:
  - a subject `[x] Revert "Y"` paired with a subject `[x] Y` removes both;
  - so does `Revert "Y"` paired with `Y`;
  - one revert removes at most one original, the nearest older one;
  - an unpaired revert is kept.
- `parseEnvTemplate(text): { lines: EnvLine[]; secretIds: string[]; errors: string[] }`:
  - `EnvLine` is `{ key; value: { kind: 'text'; text } | { kind: 'secret'; secretId } }`,
    or a comment or blank line;
  - the syntax is `KEY=value` or `KEY=${secret:<uuid>}`. The key matches
    `^[A-Za-z_][A-Za-z0-9_]{0,127}$`;
  - the `errors` messages never contain values:
    - `line 3: <KEY> looks sensitive; use a vault secret`, when the key
      matches `/TOKEN|PASSWORD|PASSWD|SECRET|KEY|CREDENTIAL|PRIVATE/i` and
      the value is non-empty text;
    - `line 3: not KEY=value`;
    - `line 3: duplicate <KEY>`.
- `renderEnvTemplate(lines, values: Map<string, string>): string`. It is
  used in main only, and it quotes each value for a POSIX `.env` (single
  quotes, `'` → `'\''`).
- `type StepKind`: the union of every kind in Global Constraints, plus
  `STEP_LABEL: Record<StepKind, string>`. The labels include `Lock`,
  `Record`, `Backup DB`, `Fetch`, `Checkout`, `Write .env`, `Pre-hook`,
  `Build`, `Up`, `Health`, `Post-hook`, `Tag`, `Unlock`, `Rollback
  checkout`, `Version tag`, `Release notes`, `Notify` and `QA`.
- `type StepState = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped' | 'cancelled'`.
- `type ReleaseStatus`, `type DeploymentRunStatus` and `type ReleaseKind`,
  matching the CHECK lists in the DDL.
- `interface Actor { osUser: string; machine: string; hubUserId?: string }`.
- `interface LockHolder { releaseId; user; machine; environment; version: string | null; startedAt }`,
  and `lockHolderText(h, now): string`.
- `interface PreflightCheck { id: string; deploymentId: string | null; hostId: string; label: string; level: 'ok' | 'warn' | 'block'; message: string }`.
  The ids are `tools`, `docker`, `repo`, `clean`, `branch`, `compose`,
  `disk`, `lock`, `tag`, `version-tag`, `reachable`, `auth` and `ansible`.
- `interface PreflightReport` holds:
  - `releaseId`;
  - `checks: PreflightCheck[]`;
  - `commits: Record<deploymentId, { commits: CommitInfo[]; hiddenPairs: number; truncated: number; firstDeploy: boolean; head: string | null }>`;
  - `dockerModes: Record<deploymentId, DockerMode>`;
  - `locks: Record<hostId, { holder: LockHolder; stale: boolean; raw: string } | null>`;
  - `commitsTotal: number`, `blocked: boolean`.
- `type RunEvent = RunEventBase & RunEventBody`:
  - `RunEventBase` is
    `{ id: string /* UUIDv7 */; runId: string /* = releaseId */; seq: number; at: string }`;
  - `RunEventBody` is a union on `type`. The names follow the Phase 9 plan's
    assumed stream, so Phase 9 maps nothing:
    - `{ type: 'run.started'; kind: ReleaseKind; version: string | null }`;
    - `{ type: 'preflight.check'; check: PreflightCheck }`;
    - `{ type: 'preflight.done'; report: PreflightReport }`;
    - `{ type: 'step.started'; stepId; kind: StepKind; name: string; hostId: string | null; deploymentRunId: string | null }`;
    - `{ type: 'step.done'; stepId; state: 'ok' | 'warn' | 'skipped'; durationMs: number; message?: string }`;
    - `{ type: 'step.failed'; stepId; error: string; durationMs: number }`;
    - `{ type: 'log'; stepId: string | null; hostId: string | null; stream: 'out' | 'err' | 'ansible'; line: string }`;
    - `{ type: 'log.truncated'; dropped: number }`;
    - `{ type: 'lock.busy'; hostId; holder: LockHolder; stale: boolean; text: string }`;
    - `{ type: 'rollback.started'; deploymentRunIds: string[] }`;
    - `{ type: 'rollback.done'; ok: boolean }`;
    - `{ type: 'deployment.updated'; deploymentRunId; status: DeploymentRunStatus; previousCommit?: string; deployedCommit?: string; backupFile?: string }`;
    - `{ type: 'version.bumped'; from: string | null; to: string }`;
    - `{ type: 'run.finished'; status: 'succeeded' | 'failed' | 'rolled_back' | 'cancelled'; error?: string }`.
- `interface ReleaseSummary` holds:
  - `id`, `environmentId`, `environmentName`, `kind`, `status`;
  - `version`, `previousVersion`, `redeploy`, `rollbackOf`;
  - `triggeredBy`, `createdAt`, `startedAt`, `finishedAt`;
  - `deploymentCount`, `hostCount`, `error`.
- `interface DeploymentRunMeta` holds:
  - `id`, `releaseId`, `deploymentId`, `deploymentName`, `hostId`,
    `hostLabel`, `position`, `branch`;
  - `previousCommit`, `deployedCommit`;
  - `commits: CommitInfo[]`;
  - `status`, `rolledBack`, `backupFile`, `startedAt`, `finishedAt`;
  - `steps: { stepId; kind; state: StepState; startedAt; finishedAt; error? }[]`.
- `interface ReleaseDetail extends ReleaseSummary` adds
  `{ options: ReleaseOptions; releaseNotes: string | null; runs: DeploymentRunMeta[]; preflight: PreflightReport | null; lastSeq: number }`.
- `interface ReleaseOptions { backup: boolean; notify: boolean; qa: boolean }`.
  The defaults are `backup: true`, `notify: true` and `qa: false`.
  `notify` and `qa` are stored for Phase 9 and unused in 8a.

Also in this task:
- `src/main/deploy/uuidv7.ts` exports
  `uuidv7(now = Date.now, rand = randomFillSync): string` and
  `uuidv7Time(id): number`.

- [ ] **Step 1: Write the failing tests**

`inventory-schema.test.ts`, test `migration 7 adds deployment tables, checks, cascades and the append-only trigger`:
- the column lists match the DDL;
- `db_backup = 1` with a NULL `backup_dir` violates a CHECK;
- deleting an environment cascades to its apps, deployments and releases;
- deleting a host cascades to its deployments;
- deleting an app sets the deployment's `app_id` to NULL;
- an `UPDATE run_events` aborts with `run_events is append-only`;
- the existing environments rows get `versioned 0`, `auto_rollback 1` and
  `current_version NULL`.

`inventory-schema.test.ts`, test `migrate applies a missing lower version after a higher one (gap tolerance)`:
- use a synthetic list `[1, 2, 4]` on a fresh DB, then `[1, 2, 3, 4]`;
- the second run applies 3 only;
- `from` and `to` report 4;
- a third run applies nothing.

`deploy-rules.test.ts`:
- `bumpVersion`: the table of cases above;
- `filterReverts`: these cases:
  - the bracketed pair is removed;
  - the plain pair is removed;
  - a revert without an original is kept;
  - two reverts of the same original remove only one original;
  - `hiddenPairs` counts the pairs;
- `parseEnvTemplate`:
  - it parses text and secret lines;
  - `DB_PASSWORD=hunter2` gives the error
    `line 1: DB_PASSWORD looks sensitive; use a vault secret`, and the
    message doesn't contain `hunter2`;
  - `${secret:not-a-uuid}` is an error;
  - duplicates are reported;
- `renderEnvTemplate`: it quotes `it's` as `'it'\''s'`;
- the regexes:
  - `REPO_PATH` accepts `/srv/app` and `/home/deploy/esg`;
  - it rejects `srv/app`, `/srv/../etc`, `/srv/app;rm`, `/srv/{a}`,
    `/srv/a b` and `/srv/$HOME`;
  - `GIT_REF` accepts `main`, `release/2026.10` and `backend_prod`;
  - it rejects `a..b`, `-x`, `a b`, `a;b` and `x.lock`;
- `lockHolderText` gives
  `ana@mbp is deploying v1.5.0 since 2026-10-19T10:00:00.000Z`.

`uuidv7.test.ts`:
- the version nibble is `7`, and the variant bits are `10`;
- `uuidv7Time` round-trips;
- 1000 ids in the same ms are strictly increasing as strings.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/main/inventory-schema.test.ts tests/main/deploy-rules.test.ts tests/main/uuidv7.test.ts`
Expected: FAIL. There is no migration 7, and the modules are missing.

- [ ] **Step 3: Implement**
  - Migration 7 is the DDL from Global Constraints, verbatim, as
    `{ version: 7, name: 'deployments', up }`.
  - `migrate()` reads `SELECT version FROM schema_migrations` into a set and
    applies, in ascending order, each listed migration not in it.
  - The rules are pure and import nothing from `main`.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit -p tsconfig.node.json && ./node_modules/.bin/tsc --noEmit -p tsconfig.web.json`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(deploy): migration 7, shared deploy types and pure rules, UUIDv7`

---

### Task 2: DeployStore, ReleaseStore and the configuration IPC

**Files:**
- Create:
  - `src/main/deploy/deploy-store.ts`;
  - `src/main/deploy/release-store.ts`;
  - `src/main/ipc/handlers/deploy.ts`;
  - `tests/main/deploy-helpers.ts`.
- Modify:
  - `src/shared/ipc.ts`;
  - `src/main/ipc/validators.ts`;
  - `src/main/index.ts`.
- Test:
  - `tests/main/deploy-store.test.ts` (new);
  - `tests/main/release-store.test.ts` (new);
  - `tests/main/ipc.test.ts` (completeness).

**Interfaces:**
- `class DeployStore`:
  - its constructor is `{ db, audit, vault, secrets: { exists(id): boolean; vaultOf(id): string | null }, now?, ids? }`;
  - apps: `listApps(environmentId?)`, `createApp`, `updateApp`,
    `deleteApp`;
  - deployments: `list(environmentId?)`, ordered by `position`, then name;
    `get(id)`, `create`, `update`, `delete`;
  - `reorder(environmentId, ids: string[])`, which renumbers `position`
    0..n-1 in one transaction. The ids must be exactly that environment's
    deployments;
  - `settings(environmentId): EnvDeploySettings` and
    `updateSettings(environmentId, patch)`;
  - `composeSnippet(id): null`. It is always `null`, because the compose
    file lives on the host. It exists so Phase 9's AI context compiles.
- Store errors (lower case; they never hold the value):
  - `checkText` for the name;
  - `host not found`;
  - `host isn't in that environment`;
  - `app isn't on that host`;
  - `repo path must be an absolute path without spaces or shell characters`;
  - `branch isn't a valid git branch name`;
  - `deploy tag isn't a valid git tag name`;
  - `compose file must be a relative path inside the repo`;
  - `backup dir is required when DB backup is on`;
  - `url 2 must be http(s) without credentials`;
  - `too many urls (8)`;
  - `hook is too long (4000)`;
  - `become secret not found`;
  - `secret <n> in the env template isn't in this deployment's vaults`;
  - the env template errors from `parseEnvTemplate`;
  - `version must look like v1.2.3`;
  - `a deployment named "<name>" already exists in this environment`;
  - `too many deployments (512)`.
- `class ReleaseStore`. It is main-only; there's no IPC in this task.
  - `createRelease(row)`, `setStatus(id, status, patch?)`, `get(id)`,
    `detail(id)`, `list({ environmentId?, limit, before? })`, `active()`;
  - `createRuns(releaseId, runs[])`, `updateRun(id, patch)`;
  - `appendEvents(releaseId, bodies: RunEventBody[]): RunEvent[]`. It
    assigns UUIDv7 ids and `seq`, writes in one transaction, enforces
    `MAX_EVENTS_PER_RELEASE`, and returns the stored events;
  - `events(releaseId, afterSeq, limit ≤ 5000)`;
  - `failInterrupted(): string[]`, used by the startup recovery.
- IPC channels:
  - `app:list` `[environmentId?: string] → AppMeta[]`;
  - `app:create` `[AppInput] → AppMeta`;
  - `app:update` `[id, AppPatch] → AppMeta`;
  - `app:delete` `[id] → void`;
  - `deploy:list` `[environmentId?: string] → DeploymentMeta[]`;
  - `deploy:create` `[DeploymentInput] → DeploymentMeta`;
  - `deploy:update` `[id, DeploymentPatch] → DeploymentMeta`;
  - `deploy:delete` `[id] → void`;
  - `deploy:reorder` `[environmentId, ids: string[]] → void`;
  - `deploy:settings` `[environmentId] → EnvDeploySettings`;
  - `deploy:update-settings` `[environmentId, EnvDeploySettingsPatch] → EnvDeploySettings`.
- Event: `'deploy:changed': { environmentId: string }`. It is pushed after
  every config mutation, so open pages refetch.

- [ ] **Step 1: Write the failing tests**

`tests/main/deploy-helpers.ts` provides `makeDeployFixture()`. It wraps
`makeInventory()` with:
- an env `staging` and a protected env `prod`;
- a host `app1` in both;
- a vault secret `envsecret`;
- a `DeployStore` and a `ReleaseStore`.

`deploy-store.test.ts`:
- `creates a deployment with defaults and audits without paths`. The
  `deploy.create` details are `{ environment, host }` (labels), and the
  audit JSON doesn't contain `/srv`.
- `rejects unsafe tokens`: one case per regex error above. No message
  contains the input.
- `env template with a plain sensitive value is rejected`.
- `env template secret must be in the deployment's vaults`.
- `managed env needs a template; db backup needs a dir`.
- `reorder renumbers and rejects foreign ids`.
- `settings: versioned and current version validate and audit deploy.settings`.
- `mutations need the vault unlocked`.
- `IPC validators reject bad shapes naming the path`. The cases are:
  - `urls: [{url: 5}]`;
  - `useSudo: 'maybe'`;
  - `buildTimeoutSec: 99999`;
  - `healthStatus: 42`.

`release-store.test.ts`:
- `appendEvents assigns increasing seq and UUIDv7 ids`.
- `events pages by afterSeq`.
- `drops log events past the cap with one log.truncated`. This uses a small
  cap injected for the test.
- `failInterrupted marks running and rolling_back as failed`.
- `detail joins runs with parsed steps and commits`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/main/deploy-store.test.ts tests/main/release-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - Follow `TunnelStore`'s shape: `inTransaction`, audit after COMMIT,
    `rows.ts` helpers.
  - `urls` is stored as JSON. `deployment_vaults` is replaced as a whole on
    each update.
  - The validators are built with `v.*` and cap every string by length; the
    store re-checks the rules.
  - `createDeployHandlers({ deploys })` is spread into `handlers` in
    `index.ts`. Task 7 adds `release:*` to the same file.

- [ ] **Step 4: Run the full suite and typecheck** (the commands as in Task 1).

- [ ] **Step 5: Commit**: `feat(deploy): deploy and release stores, config IPC`

---

### Task 3: The pure generator: playbooks, inventory, ssh_config, known_hosts and cfg

**Files:**
- Create:
  - `src/main/deploy/quote.ts`;
  - `src/main/deploy/generate.ts`.
- Test: `tests/main/deploy-generate.test.ts` (new).

**Interfaces:**
- In `src/main/deploy/runner.ts` (created here, types only; Task 6 adds the
  interface):
  - `interface PlanHop { alias: string /* od-<n> */; hostId: string | null; label; address; port; user; auth: 'key' | 'agent' | 'default' }`.
    `hostId` is `null` for a hop that isn't an inventory host.
  - `interface PlanHost { hostId; label; alias: string; hops: PlanHop[] /* last is the target */ }`.
  - `interface PlanDeployment`, with these fields:
    - `runId: string`, the `deployment_runs.id`;
    - `deploymentId`, `name`, `hostId`;
    - `repoPath`, `branch`, `composeFile`, `deployTag`;
    - `urls: HealthUrl[]`, `healthStatus`, `healthTimeoutSec`;
    - `backup: { dir: string; label: string } | null`;
    - `preHookB64: string | null`, `postHookB64: string | null`;
    - `buildTimeoutSec`, `composeTimeoutSec`;
    - `docker: DockerMode`;
    - `envSecretKey: string | null`, the key into `OPSDECK_SECRETS`;
    - `becomeSecretKey: string | null`;
    - `previousCommit: string | null`, which is set for rollback plans.
  - `interface DeployPlan`, with these fields:
    - `releaseId`, `kind: 'preflight' | 'release' | 'rollback' | 'version' | 'unlock' | 'break-lock'`;
    - `environment: { id; name }`;
    - `version: string | null`;
    - `actor: Actor`;
    - `hosts: PlanHost[]`;
    - `deployments: PlanDeployment[]`, in plan order;
    - `secretRefs: Record<string, { secretId: string } | { envTemplate: { deploymentId: string } }>`;
    - `lock: { expectRaw?: Record<hostId, string> }`, for `break-lock`;
    - `startedAt`.

    **It carries no secret values.** It is serialisable, so the Phase 10 Hub
    can receive it as is.
- `quote.ts`:
  - `b64(text)`;
  - `sanitizeIdent(s)`, which maps anything outside `[A-Za-z0-9._@-]` to `_`
    and caps at 64;
  - `lockJson(plan): string`.
- `generate.ts`:
  - `generatePlaybook(plan: DeployPlan): string`. It returns pretty JSON (an
    array of plays):
    - **one play per `PlanHost`**, with `hosts: <alias>` and
      `gather_facts: false`;
    - **the play `vars`** hold `od` (the plan data for this host's
      deployments: validated tokens and b64 hooks) and
      `s: "{{ lookup('env','OPSDECK_SECRETS') | default('{}', true) | from_json }}"`.
      The play also has `ansible_become_password` when any deployment uses
      `sudo-password`, and `strategy: linear`;
    - **`release`:**
      1. the `lock` tasks;
      2. per deployment, a `block`, then a `rescue` that sets
         `od_failed: true` and re-raises with `fail`. The block holds these
         tasks:
         - `record` (prints `OD-PREV <sha>`);
         - `backup`;
         - `fetch`, `checkout` (prints `OD-HEAD <sha>`);
         - `env`, `pre_hook`;
         - `build`, `up`;
         - `health`;
         - `post_hook`;
         - `tag`.

         Each task has `when: not (od_failed | default(false))`, so a host
         stops at its first failure.

      Before step 1, each play runs `mkdir -p ~/.opsdeck/runs/<releaseId>`
      and `touch stream.log` with `umask 077` (the log tap reads it).
    - **`rollback`:** `lock` (reentrant), then per deployment in the
      given order (the caller passes reverse order): `rb_checkout`,
      `rb_env`, `rb_build`, `rb_up`, `rb_tag`. Any failure marks
      `rollback_failed` and continues with the next deployment.
    - **`preflight`:** read-only tasks per deployment, each `failed_when:
      false`, each printing `OD-PF <json-ish key=value lines>` (parsed in
      Task 4). The checks are:
      - tools (`git`, `docker`, `curl`, plus `pg_dump` if backup);
      - the docker mode ladder;
      - the repo exists and has `.git`;
      - clean (`git update-index -q --refresh; git diff-index --quiet HEAD --`);
      - fetch the branch (`git fetch --force --tags origin refs/heads/B:refs/remotes/origin/B`),
        then `show-ref --verify`;
      - the compose file exists;
      - free disk (`df -Pk`);
      - the lock file contents;
      - the deploy tag exists;
      - the version tag exists;
      - commits, with
        `git log --no-merges --max-count=501 --pretty=tformat:%H%x1f%s%x1f%an%x1f%aI%x1e <tag>..origin/<branch>`
        (or `origin/<branch>` alone on a first deploy).

      Preflight never takes the lock.
    - **`version`:** per repo of the release, `git tag -a vX -m … && git push origin vX`.
    - **`unlock` / `break-lock`:** delete the lock file only when it holds
      our `releaseId`, or for `break-lock` only when it equals the expected
      raw content, and remove `~/.opsdeck/runs/<releaseId>`.
    - **Every shell task** has:
      - `executable: /bin/bash`;
      - `chdir: "{{ d.repo }}"`;
      - `timeout:`;
      - tags `od_step=<kind>` and `od_run=<id>`;
      - `become` per docker mode for `build`, `up`, `rb_*` and hooks;
      - commands that read user values only as `{{ … | quote }}`.
    - **Streamed steps** (`backup`, `build`, `up`, hooks and `rb_build` /
      `rb_up`) append to
      `~/.opsdeck/runs/<releaseId>/stream.log`, each line prefixed with
      `<runId>:<kind>\t`. They do this through
      `cmd 2>&1 | sed -u "s/^/<prefix>\t/" >> stream.log; exit ${PIPESTATUS[0]}`,
      and on failure print `tail -n 40` of their own lines, so the failure
      message carries context even without the tap.
  - `generateInventory(plan): string` (INI). It contains only aliases and
    `ansible_python_interpreter=auto_silent`.
  - `generateSshConfig(plan, socks: { privateAgent: string | null; userAgent: string | null }, rundir): string`.
  - `generateKnownHosts(entries: { token: string; keyType: string; keyBase64: string }[]): string`.
  - `generateAnsibleCfg(plan, rundir): string`.

- [ ] **Step 1: Write the failing tests**

`deploy-generate.test.ts` builds plans with `planFixture()` from
`deploy-helpers.ts`. It covers two hosts, three deployments, one with backup,
hooks, a managed env, `sudo-password`, and a `mac` health URL. The tests:
- `release playbook has one play per host and steps in order`. Parse the
  JSON and map tasks to their `od_step` tags. Expect, per deployment:
  `lock…, record, backup, fetch, checkout, env, pre_hook, build, up, health,
  post_hook, tag`.
- `steps that don't apply are omitted`. With no backup, hooks, env or URLs,
  only `record, fetch, checkout, build, up, tag` remain.
- `every task referencing s. is no_log`. Walk all tasks; any string that
  contains `s.` or `OPSDECK_SECRETS` implies `no_log: true`, on the task
  itself or through its block.
- `no copy-with-content anywhere`. No task uses `copy` or
  `ansible.builtin.copy` with a `content` key.
- `generated files never contain secret values`. Build a plan, then render
  the playbook, inventory, ssh_config and cfg for every `kind`. Assert that
  none of them contains `S3cr3t-Value-xyz` or `B3come-pw-123`, the values
  the fixture's secret resolver would return. (The generator never sees
  them; this pins that the plan has only refs.)
- `hooks reach bash byte-exact via base64`. A hook containing
  `echo '{{ 7*7 }}' "$(id)" ; echo done` appears in the playbook only as its
  base64 form.
- `user values only appear inside vars or via quote`. For each task command
  string, every occurrence of the repo path, branch or tag is inside a
  `{{ d.<field> | quote }}` expression.
- `rollback runs given order and continues past a failure`. This checks the
  rescue structure.
- `preflight never acquires the lock`.
- `ssh_config chains ProxyJump and selects the agent per hop`. With the
  route bastion (agent) → app1 (key):
  - `Host od-0` has `IdentityAgent <user sock>`;
  - `Host od-1` has `ProxyJump od-0`, `IdentityAgent <private sock>`,
    `IdentitiesOnly yes` and `IdentityFile none`;
  - both have `StrictHostKeyChecking yes` and
    `UserKnownHostsFile <rundir>/known_hosts`.
- `known_hosts uses [addr]:port tokens for non-22`.
- `cfg pins callback, pipelining and ssh_args`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/main/deploy-generate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Build plays as plain objects and render them
  with `JSON.stringify(plays, null, 2)`. Keep one small builder function per
  step kind (`taskRecord(d)`, `taskBuild(d)`, …), so 8b's step labels and
  the generator agree on `StepKind`.

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy): pure playbook, inventory, ssh_config and known_hosts generation`

---

### Task 4: The callback plugin, event parsing and Ansible detection

**Files:**
- Create:
  - `src/main/deploy/callback-plugin.ts`;
  - `src/main/deploy/events.ts`;
  - `src/main/deploy/tooling.ts`;
  - `tests/main/fixtures/ansible/release-ok.jsonl`;
  - `tests/main/fixtures/ansible/release-health-fail.jsonl`;
  - `tests/main/fixtures/ansible/preflight.jsonl`;
  - `tests/main/fixtures/ansible/lock-busy.jsonl`.
- Test:
  - `tests/main/deploy-events.test.ts` (new);
  - `tests/main/deploy-tooling.test.ts` (new).

**Interfaces:**
- `CALLBACK_PLUGIN_SOURCE: string`. This is the `opsdeck_jsonl.py` source,
  which is written into `<rundir>/callback_plugins/` at run time. It is
  based on the prototype verified against ansible-core 2.18.6 during
  planning, extended to emit:
  - `task_start` with `name` and `tags`;
  - `ok`, `failed`, `skipped` and `unreachable` with `host`, `tags`, `rc`,
    `stdout` / `stderr` / `msg` (each capped at 64 KiB in Python), and
    `no_log`. Output is **omitted whenever `no_log` is set** on the task or
    the result;
  - `rescued`;
  - `stats`;
  - `warning` (from `v2_on_any`, or the `_display` wrapper is skipped;
    deprecation warnings are dropped).

  Every line is a JSON object, flushed after each write. Non-JSON stdout
  lines (if any) are treated as `ansible` log lines.
- `events.ts`:
  - `class EventTranslator`. Its constructor is
    `{ plan: DeployPlan; secrets: () => string[]; now }`, and it has
    `feed(line: string): RunEventBody[]` and `finish(exitCode, signal): RunEventBody[]`.
    - It maps `od_step` / `od_run` tags to `stepId` and emits
      `step.started` / `step.done` / `step.failed`.
    - It splits `stdout`/`stderr` into `log` lines, which are cut at
      `MAX_LOG_LINE` and **redacted**.
    - It recognises the markers `OD-PREV`, `OD-HEAD`, `OD-LOCK`,
      `OD-BACKUP <file>` and `OD-PF`, and turns them into
      `deployment.updated`, `lock.busy` (exit 42) and preflight checks.
    - `skipped` tasks give `step.done state: 'skipped'`.
    - A failed `tag` step gives `step.done state: 'warn'`.
    - An `unreachable` result is `step.failed`, with
      `error: "<host label> is unreachable: <redacted msg>"`.
  - `parsePreflight(stdoutByDeployment): Omit<PreflightReport, 'releaseId'>`.
    It applies `filterReverts` and the commit caps, and works out the levels
    and messages:
    - `docker needs sudo on app1 and no sudo password is set`;
    - `/srv/esg has uncommitted changes (3 files)`;
    - `branch release/x not found on origin`;
    - `only 1.2 GB free on app1 (warning below 2 GB)`;
    - `Tag v1.5.0 already exists in esg`;
    - `missing tools on app1: pg_dump`.
  - `parseStreamLine(line): { runId; kind; text } | null`, for the log tap.
- `tooling.ts`:
  - `detectTools({ env, home, execFile, exists }): Promise<Tooling>`;
  - `interface Tooling { ansiblePlaybook: { path: string; version: string } | null; sshAgent: string | null; sshAdd: string | null; ssh: string | null; problems: string[] }`.
  - It searches, in order: `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`,
    `~/.local/bin` and `/usr/bin`. Electron GUI apps start with a minimal
    `PATH`, so the extra directories matter.
  - It parses the version from `ansible-playbook --version`
    (`core 2.18.6`), and requires ≥ 2.14.
  - `ToolingError` has code `ansible-missing` and this message:
    `Ansible isn't installed. Install it with "brew install ansible" (or "pipx install ansible-core"), then try again.`
  - A version that is too old gets
    `Ansible 2.12 is too old; OpsDeck needs ansible-core 2.14 or newer.`
  - The result is cached for 60 s.
- IPC: `deploy:tooling` `[] → Tooling`, which is added to `deploy.ts`
  handlers.

- [ ] **Step 1: Write the failing tests**

`deploy-events.test.ts` replays the fixtures through `EventTranslator`:
- `ok run yields started/done per step with durations and deployment.updated commits`;
- `health failure yields step.failed with the last log lines and a redacted error`;
- `no_log results never produce log lines`;
- `a line echoing a run secret is redacted`;
- `lock-busy yields lock.busy with holder text and stale flag`. One fixture
  holder is 3 h old;
- `preflight parsing builds checks, commits (reverts filtered), docker modes and blocked`;
- `zero commits gives commitsTotal 0 and firstDeploy false`;
- `parseStreamLine splits prefix and text`.

`deploy-tooling.test.ts` uses a fake `execFile` and `exists`:
- `finds ansible in /opt/homebrew/bin when PATH is minimal`;
- `missing ansible-playbook explains how to install`;
- `too old version is rejected`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/main/deploy-events.test.ts tests/main/deploy-tooling.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** The fixtures are hand-written JSON lines in the
  plugin's format. The Task 8 localhost test proves that the real plugin
  produces the same shapes.

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy): JSON-lines callback plugin, event translation and ansible detection`

---

### Task 5: The private ssh-agent, host-key preparation and the live log tap

**Files:**
- Create:
  - `src/main/deploy/agent.ts`;
  - `src/main/deploy/hostkeys.ts`;
  - `src/main/deploy/log-tap.ts`.
- Test:
  - `tests/main/deploy-agent.test.ts` (new);
  - `tests/main/agent.real.test.ts` (new; skipped unless `/usr/bin/ssh-agent`
    exists);
  - `tests/main/deploy-hostkeys.test.ts` (new; uses the Phase 4
    `tests/main/ssh-server.ts`).

**Interfaces:**
- `agent.ts`:
  - `startPrivateAgent({ dir, tools, spawn, ttlSec }): Promise<PrivateAgent>`;
  - `interface PrivateAgent { sock: string; add(material: { privateKey: string; passphrase?: string }): Promise<void>; stop(): Promise<void> }`.
- How it works:
  - It runs `ssh-agent -D -a <dir>/a` as a child process, with a **built**
    env containing only `PATH`. It waits for the socket to appear (max
    3 s).
  - `add` runs `ssh-add -t <ttlSec> -`, with the key on **stdin** and this
    env:
    - `SSH_AUTH_SOCK=<sock>`;
    - `SSH_ASKPASS=<dir>/askpass`, `SSH_ASKPASS_REQUIRE=force`,
      `DISPLAY=none`;
    - `OPSDECK_ASKPASS=<passphrase>`, only when the key is encrypted.

    `<dir>/askpass` is a `0700` script that prints `$OPSDECK_ASKPASS` and
    holds no secret. This was verified during planning with OpenSSH 10.2,
    an ed25519 key encrypted with a passphrase, and a socket under `/tmp`.
  - `ttlSec` is the release's total timeout plus 10 min.
  - `stop` sends SIGTERM to the agent and removes the socket.
  - The key material comes from `KeyStore.material(id)` and the passphrase
    from the identity, at prepare time. Neither is ever written to disk.
- `hostkeys.ts`:
  - `prepareHosts(plan, deps): Promise<PreparedHosts>`. Its deps are
    `{ resolve, connectChain, verify, knownHosts, identities, signal, timeoutMs }`;
  - `interface PreparedHosts { knownHosts: KnownHostEntry[]; links: Map<hostId, Client>; keys: { privateKey; passphrase? }[]; userAgentNeeded: boolean; close(): void }`.
- How preparation works:
  - Each host chain is dialled with Phase 4's `connectChain` and
    `verifyWithStore`. TOFU and changed-key prompts go through the shared
    `PromptBroker`, so the Phase 4 `PromptHost` shows them on any page. The
    prompt's `sessionId` is the release id.
  - It rejects password identities with the §9a message.
  - It collects the verified key of every hop from `KnownHostStore`, as
    `hostToken(address, port)` entries.
  - It **keeps each final link open** for the log tap.
  - Any failure becomes a `PreflightCheck` (`reachable` or `auth`) at level
    `block`.
- `log-tap.ts`:
  - `startTap(link: Client, releaseId, onLine: (line) => void): { stop(): void }`.
  - It runs
    `exec("mkdir -p ~/.opsdeck/runs/<id> && touch ~/.opsdeck/runs/<id>/stream.log && exec tail -n +1 -F ~/.opsdeck/runs/<id>/stream.log")`.
    The id is UUIDv7, so it is safe.
  - It splits lines and calls `onLine`.
  - `stop` closes the channel.
  - When the tap fails, there is a single `log` line:
    `Live output unavailable on <host>; output will appear when each step ends`.
    The run continues.

- [ ] **Step 1: Write the failing tests**

`deploy-agent.test.ts` uses a fake `spawn`:
- `ssh-add receives the key on stdin, never argv, and env holds only the allowed vars`;
- `askpass script contains no secret`. Read the file and assert that it
  doesn't contain the passphrase;
- `stop kills the agent and removes the socket dir entry`.

`agent.real.test.ts` (skipped without binaries). It runs in a cleared env,
`HOME` is a temp dir, and `SSH_AUTH_SOCK` is deleted from the child env.
- Generate an encrypted ed25519 key with `ssh-keygen` in the temp dir.
- `add` it with its passphrase.
- `ssh-add -l` against the private socket lists one key.
- `stop` removes it.
- The key file is deleted before `add`, and the material passes through a
  string.

`deploy-hostkeys.test.ts` uses the in-process `ssh2` test server and a
`KnownHostStore` on a temp DB:
- `first dial raises a TOFU prompt and the trusted key lands in knownHosts entries`;
- `password identity is rejected with the §9a message before dialling`;
- `unreachable host becomes a reachable block check`;
- `tap streams appended lines`. The test server's exec handler simulates
  `tail -F` by writing two lines.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/main/deploy-agent.test.ts tests/main/agent.real.test.ts tests/main/deploy-hostkeys.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Check that `<dir>/a` is shorter than 100 bytes
  (Global Constraints). Sanitise every child env with an allow-list
  function, `childEnv(base, allow[])`.

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy): private ssh-agent, host-key preparation and live log tap`

---

### Task 6: The DeployRunner boundary and LocalRunner

**Files:**
- Modify: `src/main/deploy/runner.ts`.
- Create: `src/main/deploy/local-runner.ts`.
- Test:
  - `tests/main/local-runner.test.ts` (new);
  - `tests/main/deploy-helpers.ts` (`FakeAnsible`, `fakeAgent`, `fakeTap`,
    `fakePrepare`).

**Interfaces:**
- `interface DeployRunner`:
  ```ts
  interface DeployRunner {
    /** Runs one playbook kind for a plan; resolves when the process has exited and cleanup is done. */
    start(plan: DeployPlan, secrets: RunSecrets): RunHandle
    cancel(runId: string): void
    onEvent(fn: (releaseId: string, body: RunEventBody) => void): () => void
  }
  interface RunHandle { runId: string /* UUIDv7, one per playbook execution */; done: Promise<RunOutcome> }
  interface RunOutcome { exitCode: number | null; signal: string | null; cancelled: boolean; preflight?: Omit<PreflightReport, 'releaseId'>; failedDeploymentRunIds: string[]; reachedCheckout: string[]; commits: Record<string, { previous?: string; deployed?: string }> }
  interface RunSecrets { values: Record<string, string> /* key → plaintext; base64'd only into OPSDECK_SECRETS */; known: string[] /* every individual value for redact() */ }
  ```
  - `runId` is the runner's id for one playbook execution. A release
    involves several of them. **The release id is the stream id**
    (`RunEvent.runId === releaseId`).
  - Phase 10's `HubRunner` takes the same `DeployPlan`, with secret refs
    resolved server-side.
  - `RunSecrets` exists only for `LocalRunner`. The Hub ignores it and
    resolves `plan.secretRefs` itself.
- `class LocalRunner implements DeployRunner`. Its constructor takes
  `{ tools: () => Promise<Tooling>; prepare: typeof prepareHosts; agent: typeof startPrivateAgent; tap: typeof startTap; spawn; fs; tmpdir; home; userAgentSock: string | null; connectionOverride?: 'local' }`.
  `connectionOverride` is test-only and used by Task 8.
- **`start` runs these steps:**
  1. `tools()`. A missing tool throws `ToolingError` synchronously from
     `done`, before anything is created.
  2. Create the run dir (`0700`) and write the files: `callback_plugins/`,
     the playbook, the inventory, `ssh_config`, `known_hosts` and
     `ansible.cfg`.
  3. Prepare the hosts (dial and verify keys, and keep the links). This is
     skipped when `connectionOverride === 'local'`.
  4. Start the private agent and add the keys, if any host uses a key.
  5. Start one tap per host link, with lines → `parseStreamLine` → `log`
     events.
  6. `spawn('ansible-playbook', ['-i', inv, playbook], { cwd: rundir, env: built })`.
     The argv holds paths only. stdout lines → `EventTranslator.feed`.
     stderr lines are redacted and become `log` with `stream: 'ansible'`.
  7. On exit, `translator.finish`. Then, in `finally`, stop the taps, close
     the links, stop the agent, and `rm -rf` the run dir.
- **`cancel` escalates:**
  1. SIGINT;
  2. SIGTERM after `CANCEL_GRACE_MS`;
  3. SIGKILL after `KILL_GRACE_MS`.

  The outcome has `cancelled: true`. Running steps are closed as
  `step.done state 'cancelled'`.
- **Events** are emitted through `onEvent`. Persisting and pushing them is
  the release service's job (Task 7).

- [ ] **Step 1: Write the failing tests** (in `local-runner.test.ts`, with
  every dep faked).
  - `writes the run files, spawns with paths-only argv and a built env`. The
    env keys are exactly the Global Constraints list. `SSH_AUTH_SOCK` is
    absent. `OPSDECK_SECRETS` is base64 JSON.
  - `streams translated events in order and resolves the outcome with commits`.
  - `no secret reaches disk, argv, events or audit`. This is Review Focus 1:
    - snapshot the run dir contents during the fake run (the `FakeAnsible`
      hook reads them), plus the argv, every event, and the thrown errors;
    - none contains either secret value;
    - a fixture line echoing the secret comes out as `‹redacted›`;
    - the run dir doesn't exist afterwards.
  - `cleanup runs on failure and on a throw in prepare`.
  - `cancel escalates SIGINT → SIGTERM → SIGKILL on a manual clock`.
  - `missing ansible-playbook fails before creating a run dir`.
  - `a key identity starts the private agent; agent-only plans don't`.
  - `tap lines become log events tagged with the step`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/main/local-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Keep `local-runner.ts` to orchestration only.
  Everything it calls is in Tasks 3–5.

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy): DeployRunner boundary and LocalRunner`

---

### Task 7: ReleaseService: preflight, start, rollback, versioning, lock, access, finalize seam and IPC

**Files:**
- Create:
  - `src/main/deploy/access.ts`;
  - `src/main/deploy/finalize.ts`;
  - `src/main/deploy/release-service.ts`.
- Modify:
  - `src/main/ipc/handlers/deploy.ts`;
  - `src/shared/ipc.ts`;
  - `src/main/ipc/validators.ts`;
  - `src/main/index.ts`, for the wiring, `service.onLock` (pending prompts
    cancelled), startup `failInterrupted`, and a before-quit guard.
- Test:
  - `tests/main/release-service.test.ts` (new);
  - `tests/main/deploy-ipc.test.ts` (new).

**Interfaces:**
- `access.ts`:
  - `type DeployAction = 'deploy.view' | 'deploy.edit' | 'release.start' | 'release.rollback' | 'release.cancel' | 'lock.break'`;
  - `interface DeployAccess { check(actor: Actor, action: DeployAction, target: { environmentId: string; deploymentIds?: string[] }): Promise<{ allowed: boolean; reason?: string }> }`;
  - `const localAllowAll: DeployAccess`.
- `finalize.ts`. Its names are those the Phase 9 plan assumed:
  ```ts
  interface FinalizeContext { run: ReleaseRunMeta; log(line: string): void; signal: AbortSignal }
  interface FinalizeSteps {
    releaseNotes(ctx: FinalizeContext): Promise<string | null>
    notify(ctx: FinalizeContext): Promise<void>
    qa(ctx: FinalizeContext): Promise<void>
  }
  const noopFinalize: FinalizeSteps   // returns null / resolves; its steps are reported as 'skipped'
  interface ReleaseRunMeta {
    id: string /* = releaseId */; releaseId: string; kind: ReleaseKind; status: ReleaseStatus
    environmentId: string; environmentName: string; productId: string | null; productName: string | null
    deployments: { id: string | null; name: string; hostId: string | null; hostLabel: string; status: DeploymentRunStatus; previousCommit: string | null; deployedCommit: string | null }[]
    hostIds: string[]; version: string | null; previousVersion: string | null
    commits: CommitInfo[]; options: ReleaseOptions; releaseNotes: string | null; redeploy: boolean
    startedAt: string | null; finishedAt: string | null; actor: Actor; urls: string[]
  }
  ```
  - The finalize steps run **only after a successful release**, in the
    order notes → notify → qa.
  - Each one is a `release:finalize_*` step. A throw marks only that step
    `failed`; the release stays `succeeded`.
  - The steps aren't run when they are the no-op.
- `class ReleaseService`. Its constructor takes
  `{ db, deploys, releases, runner: DeployRunner, access, finalize, audit, vault, resolve, identities, secrets, emit: (batch: RunEvent[]) => void, emitState: (s: ReleaseSummary) => void, actor: Actor, now, clock }`.
  - **`preflight(req)`** builds the release row and runs the preflight
    playbook, emitting `preflight.check` events and `preflight.done`. Its
    request is
    `{ environmentId; deploymentIds: string[]; bump: VersionBump; options: ReleaseOptions; releaseNotes?: string }`,
    and it returns `{ releaseId }`.
    - It sets `ready` or `blocked`, and stores the report.
    - It adds the Ansible check (`ansible` id), the prepare checks and the
      version-tag check.
    - It records `release.preflight` in audit.
  - **`start(releaseId, confirm: { typedName?: string; redeploy?: boolean })`**:
    - it enforces access, the protected typed name, `redeploy` when
      `commitsTotal === 0`, `MAX_ACTIVE_RELEASES`, and one active release
      per environment;
    - it resolves secrets once; the plan is built from the preflight docker
      modes;
    - it runs the release playbook;
    - **if the release failed and auto-rollback is on**, it runs `rollback`
      over the `reachedCheckout` deployments in reverse order;
    - **if it succeeded and the environment is versioned**, it runs
      `version`, then commits `current_version`;
    - it runs `finalize` (success only);
    - it **always** runs `unlock`;
    - it writes the final status and `release.finish` audit, and drops the
      resolved secrets.
  - **`cancel(releaseId)`** cancels the current runner run, then runs
    `unlock`, ends the release `cancelled`, and records `release.cancel`
    in audit.
  - **`rollback(releaseId, confirm)`** works on the newest `succeeded` or
    `failed` release of its environment. It creates a `rollback` release
    (`rollback_of`) whose plan targets that release's runs with
    `previousCommit`, runs the rollback playbook, then unlock, and records
    `release.rollback` in audit. A rollback of an older release throws
    `Only the latest release of <env> can be rolled back`.
  - **`breakLock(releaseId, hostId, confirm: { typedLabel: string })`**
    requires a stale holder in the stored preflight report, then runs
    `break-lock`, re-runs that host's lock check, and records
    `deploy.lock_break` in audit.
  - **`discard(releaseId)`** applies to `ready` or `blocked` releases only.
  - **`retryVersion(releaseId)`** re-runs the lock, `version` and unlock
    playbooks for a release that failed only at tagging.
  - Readers: `runMeta(id)`, `detail(id)`, `list(filter)`, `events(id,
    afterSeq, limit)`, `hasActive()`.
  - `onEvent(fn: (e: RunEvent) => void): () => void` is the main-side
    subscription for Phase 9.
  - Events are batched for `EVENT_BATCH_MS`, then persisted through
    `releases.appendEvents`, pushed with `emit`, and fanned out to
    `onEvent` subscribers.
- IPC channels:
  - `release:preflight` `[PreflightRequest] → { releaseId }`;
  - `release:start` `[releaseId, confirm] → void`. It resolves when the run
    **starts**, and progress comes through events;
  - `release:cancel` `[releaseId] → void`;
  - `release:rollback` `[releaseId, confirm] → { releaseId }`;
  - `release:break-lock` `[releaseId, hostId, confirm] → void`;
  - `release:discard` `[releaseId] → void`;
  - `release:retry-version` `[releaseId] → void`. It is allowed only on a
    `failed` release whose deployments all succeeded and whose only failed
    step is `release:version`;
  - `release:list` `[{ environmentId?: string; limit?: number; before?: string }] → ReleaseSummary[]`;
  - `release:get` `[releaseId] → ReleaseDetail`;
  - `release:events` `[releaseId, afterSeq: number, limit?: number] → RunEvent[]`;
  - `release:active` `[] → ReleaseSummary[]`.
- Events:
  - `'deploy:event': RunEvent[]` (a batch);
  - `'release:state': ReleaseSummary`.
- **Wiring in `index.ts`:**
  - `LocalRunner` gets real deps: `spawn` from `node:child_process`,
    `userAgentSock: process.env.SSH_AUTH_SOCK ?? null`, and the `prepare`
    deps from the Phase 4 objects.
  - **Before quit**, when `releases.hasActive()`, show
    `dialog.showMessageBox` with the message
    `A release is running on <env>. Quit and cancel it?`.
    - **Yes:** `cancel` all and wait up to 20 s for unlock, then quit.
    - **No:** stay open.

- [ ] **Step 1: Write the failing tests**

`release-service.test.ts` uses a scripted `FakeRunner`, which returns outcomes
per playbook kind and emits fixture events.
- `preflight stores a ready report and audits release.preflight`.
- `blocked preflight cannot start`.
- `protected start without the typed name is CONFIRM_REQUIRED and audited denied`.
  - The typed name `Prod` doesn't match `prod`, because the match is exact.
  - The correct name starts the release.
- `zero commits needs redeploy confirm, forces bump none and stores redeploy`.
- `success on a versioned env runs version then commits current_version`.
  - `v1.4.0` with bump `minor` gives `v1.5.0`.
  - A `version.bumped` event is emitted.
  - The `release.finish` audit is `success`.
- `version tag failure fails the release without rollback and keeps current_version`.
  - The deploys stay up and nothing rolls back, but the release ends
    `failed`, with the error
    `Deployed, but tagging v1.5.0 failed: <redacted>`.
  - `current_version` is unchanged.
  - `release:retry-version` re-runs only the `version` step (lock, version,
    unlock). On success the release becomes `succeeded` and
    `current_version` is committed.
- `auto-rollback reverts in reverse order`.
  - Three runs; the release fails at the second. `reachedCheckout` is
    `[r1, r2]`.
  - The rollback plan's deployments are `[r2, r1]`, with their
    `previousCommit`.
  - The status is `rolled_back`, and `current_version` is unchanged.
- `auto-rollback off ends failed and rollback() later works on the latest release only`.
- `unlock always runs`. This covers success, failure, rollback, cancel, and
  a runner `done` that rejects.
- `busy names the holder` (from a `lock.busy` outcome).
- `break-lock needs stale + typed label`.
  - A fresh holder throws `The lock is only 12 minutes old; wait or ask
    ana@mbp`.
  - The wrong label gives `CONFIRM_REQUIRED`.
  - A stale holder with the right label runs `break-lock` and audits.
- `one active release per environment; MAX_ACTIVE_RELEASES`.
- `finalize runs notes → notify → qa after success; a throw marks only that step`.
- `secrets resolved once at start and dropped at the end`. The resolver is
  called once, and after `run.finished` the service holds no reference
  (checked through a `WeakRef` on the values holder).
- `events are batched, persisted with seq and pushed`.
- `startup recovery marks interrupted releases failed`.
- `access denial is audited denied and nothing runs`.

`deploy-ipc.test.ts`:
- every `release:*` validator rejects bad shapes and names the path;
- `release:events` caps `limit` at 5000.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/main/release-service.test.ts tests/main/deploy-ipc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** `release-service.ts` is a state machine with one
  `async runRelease(id)` per release. Each transition calls
  `releases.setStatus` and `emitState`. Every error message passes through
  `redact()` before it is stored, emitted or audited.

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy): release service with preflight, rollback, versioning, lock and access boundaries`

---

### Task 8: End-to-end against localhost with real Ansible

**Files:**
- Test: `tests/main/ansible-local.test.ts` (new). It is skipped unless
  `detectTools` finds `ansible-playbook` ≥ 2.14.

**Interfaces:**
- It consumes everything from Tasks 1–7.
- It uses `LocalRunner` with `connectionOverride: 'local'`:
  - the inventory gets `ansible_connection=local`;
  - prepare, the agent and the tap are skipped.
- It produces nothing new.

**Setup:**
- Everything lives in a temp dir. `HOME` is the temp dir. `PATH` is the shim
  dir first, then the detected ansible dir, then the system dirs.
- **A bare `origin.git`** with a clone at `<tmp>/srv/app`. It has three
  commits on `main`, plus `deploy_staging` tagged at commit 1.
- **A `docker` shim**, a bash script:
  - `docker info` exits 0;
  - `docker compose -f … build` and `up -d` append their argv to
    `<tmp>/docker.log`;
  - `build` fails when `<tmp>/fail-build` exists.
- **A `curl` shim**, which prints `200`, or `503` when `<tmp>/fail-health`
  exists.
- The env template uses a fixture secret value `S3cr3t-Value-xyz`. The hook
  is `echo '{{ 7*7 }}' "$HOME"`.

- [ ] **Step 1: Write the tests**
  - **`release on localhost deploys, tags and streams real callback events`:**
    - steps `record … tag` end `ok`;
    - the clone is at `origin/main` HEAD;
    - `deploy_staging` points at HEAD on origin;
    - `docker.log` shows `build` then `up -d`;
    - `.env` holds the secret with mode `0600`;
    - a `log` event has the hook output, which contains the literal
      `{{ 7*7 }}`;
    - **no `run_events` payload contains `S3cr3t-Value-xyz`**;
    - the run dir is removed.
  - **`failed health rolls back to the previous commit`:**
    - set `fail-health`, with auto-rollback on;
    - the clone ends at the old commit;
    - `.env` is restored from `.env.opsdeck-prev`;
    - the tag is unchanged;
    - the status is `rolled_back`.
  - **`second release is blocked by the first's lock`:**
    - write a lock file held by another release id;
    - preflight reports the lock with the holder text;
    - `start` gets `lock.busy` and the release ends `failed` without
      touching the repo;
    - the lock file is still the foreign one.
  - **`unlock removes only our lock`.**
  - **`version tag is created and pushed on a versioned env`.**

- [ ] **Step 2: Run them**

Run: `./node_modules/.bin/vitest run tests/main/ansible-local.test.ts`
Expected: PASS when Ansible is installed (it is on the dev machine), and
SKIP elsewhere. Fix the generator or translator until it passes. **Do not
weaken the assertions.**

- [ ] **Step 3: Run the full suite and typecheck.**

- [ ] **Step 4: Commit**: `test(deploy): end-to-end release, rollback and lock against localhost with real ansible`

---

### Task 9: The Deployments configuration UI

**Files:**
- Create:
  - `src/renderer/src/deploy/store.ts`;
  - `src/renderer/src/pages/deployments/DeploymentsPage.tsx`;
  - `DeploymentDialog.tsx`;
  - `EnvTemplateEditor.tsx`;
  - `EnvDeploySettings.tsx`;
  - `AppDialog.tsx`.
- Modify:
  - `src/renderer/src/shell/AppShell.tsx`: the `/deployments` route replaces
    `PlaceholderPage`;
  - `tests/renderer/helpers.tsx`: `deploymentMeta()` and `appMeta()`.
- Test:
  - `tests/renderer/deploy-config.test.tsx` (new);
  - `tests/renderer/shell.test.tsx`: the route.

**Interfaces:**
- `deploy/store.ts`:
  - `deployStore`, which is `{ deployments, apps, settings: Record<envId, EnvDeploySettings>, tooling: Tooling | null, loaded }`;
  - `loadDeploy()`, `useDeployments(envId)`;
  - `startDeploySync()`, which refetches on `deploy:changed`;
  - the mutations are wrapped in `attempt`.
- **`DeploymentsPage`:**
  - An environment picker, with pills grouped by product. The selection
    lives in the URL as `?env=`.
  - A tooling banner when Ansible is missing. It shows the exact install
    message, has a copy button, and links to the docs.
  - Deployment cards grouped by host, ordered by `position`. Each card shows:
    - the name, the repo path in mono, branch → tag, and the app;
    - badges for backup, managed env, sudo mode and URL count.
  - Drag-to-reorder with keyboard support: `alt+↑/↓` → `deploy:reorder`.
  - The environment's deploy settings panel: versioned, auto-rollback and
    the current version.
  - Empty state: `No deployments in <env> yet`, with a `New deployment`
    action.
  - 8b adds the **Release** button and the history to this page.
- **`DeploymentDialog`:**
  - Its sections are:
    - Source: repo path, branch, compose file and deploy tag;
    - Health: URLs, each with a `from host | from this Mac` segmented
      control, plus status and timeout;
    - Safety: DB backup and dir, and timeouts;
    - Privilege: sudo mode and the become secret;
    - Hooks;
    - Environment: managed `.env`.
  - Rules are checked inline with the shared regexes. Error text names the
    rule, never the value.
- **`EnvTemplateEditor`:**
  - A monospace editor. `${secret:<id>}` refs render as chips with the
    secret's **name** and vault colour. Values are never fetched.
  - An "Insert secret" picker lists secrets from the deployment's vaults.
  - Sensitive-looking plain values show the inline error from
    `parseEnvTemplate`.
- **Deleting** a deployment in a protected environment uses
  `ConfirmDialog` `typeToConfirm` with the environment name.

- [ ] **Step 1: Write the failing tests** (in `deploy-config.test.tsx`, with
  `mockBridge`).
  - `lists deployments grouped by host for the env in the URL`.
  - `create dialog validates repo path and branch inline and submits`.
  - `env template shows secret chips by name and blocks a plain DB_PASSWORD`.
  - `reorder with alt+arrow calls deploy:reorder`.
  - `missing ansible shows the install banner with the exact text`.
  - `protected delete needs the typed env name`.
  - `reduced motion: no transform on card reorder`. This mocks
    `useReducedMotion` → true and asserts that no `transform` style is set.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/renderer/deploy-config.test.tsx tests/renderer/shell.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.** Reuse `TextField`, `SelectField`,
  `TextAreaField`, `Switch`, `Badge`, `EmptyState`, `RowMenu`,
  `ConfirmDialog` and `attempt`. Add no new dependencies.

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy): deployments configuration UI`

---

## Self-review notes

- **Spec coverage** (§8.4):
  - the model: T1, T2;
  - generation: T3;
  - the runner boundary and LocalRunner: T6;
  - the access boundary: T7;
  - the run-event stream: T1, T2, T7;
  - the lock with stale break: T3, T7, T8;
  - preflight (tools, docker and sudo, repo clean, branch, disk, lock,
    commits, tags): T3, T4, T7;
  - backup: T3, T8;
  - fetch, checkout, hooks, build and up with timeouts, health from the host
    or the Mac, tag: T3, T8;
  - auto and manual rollback: T7, T8;
  - versioning: T1, T7, T8;
  - zero-commit redeploy: T4, T7;
  - hosts in parallel and deployments sequential per host: T3;
  - finalize hooks for Phase 9: T7;
  - the §9a agent, ProxyJump, known_hosts, the password rejection, sudo,
    and rollback as the previous commit plus a rebuild: T3, T5.
- **Deliberately out of 8a:**
  - the pipeline animation, the live log UI, the wizard, history and map
    attachments are in 8b;
  - release notes, Teams, email and QA are Phase 9, through
    `FinalizeSteps`.
- **Types** used across tasks:
  - `DeployPlan`, `PlanDeployment` and `PlanHost` (T3, used by T6 and T7);
  - `RunEventBody` and `RunEvent` (T1, used by T2, T4, T6 and T7);
  - `PreflightReport` (T1, used by T4 and T7);
  - `StepKind` (T1, used by T3 and T4);
  - `RunSecrets` and `RunOutcome` (T6, used by T7).

  The names were checked for consistency across tasks.
- **No secret value** appears anywhere in this plan. The fixture strings
  `S3cr3t-Value-xyz` and `B3come-pw-123` are test sentinels.
