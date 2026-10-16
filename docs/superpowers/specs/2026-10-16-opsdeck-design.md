# OpsDeck — Design

*Working name; rename freely. Date: 2026-10-16.*

## 1. Intent

A macOS desktop app, Termius-like, that does three jobs for the people running our
infrastructure:

1. **SSH** into machines (interactive terminal).
2. **Tunnels**: reverse (`-R`), local (`-L`) and dynamic/SOCKS (`-D`) port forwards,
   mainly to reach database machines.
3. **Deployments**: ship docker-compose apps to hosts, via Ansible when available.

What makes it different from Termius is an **Environment** layer. An environment
(e.g. `prod`, `staging`, `analytics-db`) groups machines and the apps running on
them. Some environments are only DB machines, used just for SSH or tunnels.
Others also have apps. Deployments are tied to environments, hosts and vaults,
so "what runs where, and how do I reach or ship it" lives in one place.

## 2. What we learned from Termius (reverse engineered, v10.1.0)

Observed in `/Applications/Termius.app/Contents/Resources/app.asar`:

- An Electron app with a React UI (`ui-process`), a `background-process` for sync
  and crypto, and `main-process`. Native modules: `@termius/libtermius` (libssh2),
  `node-pty`, `mosh`, `keytar`, `libfido2` and serialport.
- **Entity model** (from the entity classes in `reconnectSaga-*.js`):
  - `BaseEntity`: `local_id, id, updated_at, is_shared, encrypted_with`.
  - `Host`: `address, label, group, tags, icon, os_name, ssh_config, credentials_mode`.
  - `SshConfig`: `port, identity, agent_forwarding, keep_alive_packages, proxy,
    host_chain (jump hosts), env_variables, startup_snippet, strict_host_key_check,
    timeout, use_mosh`.
  - `Identity`: `label, username, password, ssh_key, hardware_key`.
  - `SshKey`: `label, private_key, public_key, passphrase, certificates`.
  - `PortForwardingRule`: `host, pf_type (Local|Remote|Dynamic), bound_address,
    local_port, hostname, remote_port, label, status`.
  - `Snippet`: `label, script, package, targetHosts`. `KnownHost`: `hostnames, key, marker`.
  - Groups nest and carry an `ssh_config`, so hosts inherit settings from their group.
  - Vaults are encrypted containers that hold all of the above.

We copy the **shape** of this model (identity separated from host, a reusable
SSH config, hosts inheriting from a parent), not code or branding.

## 3. Goals

**Core (the three jobs)**
- G1. Vaults, keys, identities and hosts are created **separately**, then **linked**.
- G2. Environments hold hosts (machines) and apps. A host can belong to more than
  one environment (e.g. a shared DB box).
- G3. Default authentication is SSH public-key: use the user's ssh-agent and
  `~/.ssh/id_ed25519` / `id_rsa` without any setup.
- G4. Interactive SSH terminal in tabs, including through jump hosts.
- G5. Saved tunnels (L/R/D) with live status.
- G6. Deployments: name, URLs (for identification and health checks), local
  docker-compose file, remote path on the host, links to host, environment and
  vault(s). Several deployments on the **same host** can be run together in one
  run (one SSH session / one Ansible play per host).

**Extras (all in v1)**
- G7. **Environment defaults + jump hosts.** An environment sets the default
  identity, port and jump host; a host can override them. Resolution order:
  host → environment → global default (agent / `~/.ssh` key).
- G8. **Auto-reconnecting tunnels.** Exponential backoff, "start on app launch"
  flag, status dot (connecting / up / retrying / failed), drop notifications.
- G9. **Safer deploys** (port everything `unified_release.sh` does today, plus more).
  - Preflight checks: host reachable, `docker` and `docker compose` present,
    free disk above a threshold.
  - `.env` rendered from vault secrets.
  - Health check against the deployment URLs after `up`.
  - Run history with full logs.
  - One-click rollback to the previous release.
  - Environments marked `protected` (e.g. prod) require typing the environment
    name to confirm.
- G10. **Import `~/.ssh/config`** (Host, HostName, User, Port, IdentityFile,
  ProxyJump, LocalForward/RemoteForward → tunnels).
- G11. **Container view** per app/host: `docker ps`, `docker compose ps`, live
  `logs -f`, restart a service.
- G12. **Multi-host run**: run a command or saved snippet on every host in an
  environment (or a selection) in parallel, with output grouped per host.
- G13. **Visualization with good animation.**
  - A topology map: environment → hosts → apps, with tunnels drawn as animated
    flowing edges and status colours.
  - Deploy runs shown as an animated step pipeline per host.
  - Smooth transitions throughout the app.
- G14. **AI help on failures.**
  - On a failed deploy, connection or tunnel, an "Explain & fix" action sends the
    redacted error context to Claude.
  - It shows the likely cause and suggested fix commands. The user can copy a
    suggested command or run it in a terminal; it is never run automatically.
- G15. **Notifications to Microsoft Teams** via incoming-webhook URL(s). Events:
  release started / succeeded / failed / rolled back, tunnel dropped and not
  recovered. Choose the events per environment. macOS native notifications for
  the same events.
- G16. **User audit trail.** An append-only log of every meaningful action: who
  (OS user and app profile name), what, target, when, outcome. It covers SSH
  session open/close, tunnel start/stop, deploy/rollback, vault unlock, secret
  reveal/edit, and host/env changes. Shown in a viewer with filters and CSV export.

## 4. Non-goals (v1)

- Cloud sync, accounts, team sharing of vaults, or a server component.
- Windows/Linux builds (keep the code portable; ship macOS only).
- SFTP browser, mosh, telnet, serial, FIDO2 hardware keys, cloud-provider import.
- Kubernetes or non-compose deploy targets.
- A registry / CI image pipeline (images keep being built on the host, as today).

## 5. Anti-goals (failure even if it "works")

- Secrets in plaintext on disk, in logs, in the audit trail, in Teams messages,
  or in AI prompts.
- A deploy to a protected environment without explicit confirmation.
- AI suggestions executed without the user clicking.
- Losing anything the current release script does (backup, tags, rollback,
  versioning, release notes, Teams, email, QA trigger).
- A tunnel shown as "up" while it is actually dead (status must reflect a real
  check, not just "we started it").
- Animation that slows down the work: it must never block input or delay output.

## 6. Decisions (platform and how)

*Claude's calls, accepted by the user at the platform level ("Desktop app").*

- **Stack:** Electron + React + TypeScript, Vite build, electron-builder for packaging.
- **Process split:** the **main process** owns all SSH connections, tunnels, jobs,
  storage and secrets. The **renderer** is UI only. A typed IPC API is exposed
  through a preload `contextBridge`; `contextIsolation` is on and `nodeIntegration`
  is off.
- **SSH:** `ssh2` (pure JS): sessions, exec, forwardOut / forwardIn
  (reverse), SOCKS, jump hosts through chained `forwardOut` sockets, and ssh-agent
  via `SSH_AUTH_SOCK`.
- **Known hosts:** verify against `~/.ssh/known_hosts` plus the app's own store.
  Ask on first sight (TOFU) and block loudly on a changed key.
- **Terminal:** xterm.js (+ fit, search and web-links addons). A local shell tab
  via `node-pty`.
- **Storage:** SQLite via `better-sqlite3` in the app data dir, with migrations.
- **Vault crypto:**
  - Each vault's secret fields are encrypted with AES-256-GCM.
  - The vault key is wrapped by a key derived from a master password (scrypt).
  - The unlocked key can be cached in macOS Keychain (Electron `safeStorage`) for
    "unlock with Touch ID / login".
  - Non-secret metadata (labels, addresses) is plain so search works while locked.
- **Ansible is the deployment engine** (user decision). Each release produces a
  generated inventory and playbook in a private temp dir, then runs
  `ansible-playbook`. Step events come from a small bundled callback plugin that
  writes one JSON line per task start/finish. There is no native fallback runner:
  if `ansible-playbook` is missing, the Deployments screen says so and explains
  how to install it (`brew install ansible`). `ssh2` is still used for terminals,
  tunnels, container view and multi-host run.
- **Visualization:** React Flow for the topology map, Framer Motion for transitions
  and pipeline animation.
- **AI:** Anthropic Claude API, default model `claude-opus-5-5` (configurable). The
  user's API key is stored in a vault. Redaction runs before sending: vault values,
  private keys, tokens and passwords are replaced with `‹redacted›`.
- **Teams:** a POST to an Incoming Webhook URL with an Adaptive Card payload;
  webhook URLs are stored as vault secrets.

## 7. Data model

All entities: `id (uuid), created_at, updated_at`.

| Entity | Key fields | Notes |
|---|---|---|
| **Vault** | name, color, wrapped_key, kdf_params | Holds encrypted secrets. |
| **Secret** | vault_id, name, kind (`password`/`token`/`env`/`webhook`/`api_key`), value_enc | Generic key/value secrets, e.g. for `.env`. |
| **SshKey** | vault_id, label, private_key_enc, public_key, passphrase_enc, source (`file`/`imported`/`generated`), file_path? | `file` keys reference `~/.ssh/...` without copying. |
| **Identity** | vault_id, label, username, auth (`agent`/`key`/`password`), ssh_key_id?, password_enc? | |
| **Host** | label, address, port?, identity_id?, jump_host_id?, tags[], os_icon, keepalive, env_vars, startup_snippet_id?, notes | `null` fields inherit (see resolution). |
| **Environment** | name, color, protected (bool), versioned (bool), auto_rollback (bool, default true), qa_on_deploy (bool), current_version, qa_workflow (repo, workflow, ref), email_to/cc, default_identity_id?, default_port?, default_jump_host_id?, notify_events[], teams_webhook_secret_id? | |
| **EnvironmentHost** | environment_id, host_id, role (`app`/`db`/`bastion`/`other`) | Many-to-many. |
| **App** | environment_id, host_id, name, compose_project, description | "What runs where"; shown on the map. |
| **Tunnel** | label, host_id, type (`L`/`R`/`D`), bind_address, bind_port, target_host, target_port, auto_start, auto_reconnect | Host resolution gives the identity and jump host. |
| **Deployment** | name, urls[], environment_id, host_id, app_id?, repo_path, default_branch, compose_file, deploy_tag, order, db_backup (on/off, backup_dir), pre_hook?, post_hook?, timeouts, use_sudo (auto/yes/no), managed_env (off/on + env_template → secret refs), vault_ids[], health_check (expected status, timeout, from host/mac) | |
| **Release** | environment_id, version (e.g. v1.4.0)?, version_bump, status, started_at, finished_at, triggered_by, release_notes, options (backup/notify/qa) | One batch run. |
| **DeploymentRun** | release_id, deployment_id, branch, previous_commit, deployed_commit, commits[], status, steps[] (name, status, log ref), rolled_back | |
| **Snippet** | label, script, tags[] | Used by multi-host run and startup. |
| **KnownHost** | host_pattern, key_type, key, first_seen | |
| **AuditEvent** | ts, actor_os_user, actor_profile, action, target_type, target_id, target_label, outcome, details (redacted JSON), prev_hash, hash | Append-only; hash chain for tamper evidence. |
| **Settings** | ai_model, ai_api_key_secret_id, defaults, theme… | |

**Credential and route resolution for a host in context:**
1. Host's own field.
2. If opened from an environment: that environment's default.
3. Global default: ssh-agent first, then `~/.ssh/id_ed25519`, then `~/.ssh/id_rsa`;
   the username defaults to the local user.

When a host is opened outside any environment, step 2 is skipped. If the host
belongs to several environments with conflicting defaults, the host must set the
field itself to avoid ambiguity; the UI shows a warning.

## 8. Behaviour of each part

### 8.1 Vaults and linking
- Vaults are created on their own; one **Default** vault exists from the start.
- Keys, identities and secrets live in a vault.
- Hosts and deployments **link** to identities and vault secrets by reference.
- The app opens locked: lists and the map are visible, but nothing that needs a
  secret works until unlock.
- Reveal-secret actions are audited.

### 8.2 SSH sessions
- Tabs, split panes (nice-to-have), reconnect button, copy on select.
- The tab header shows the environment colour.
- Opening a host from inside an environment applies that environment's defaults.

### 8.3 Tunnels
- Start and stop from the list, the host page or the map.
- Liveness: the SSH keepalive, plus for `L`/`D` a periodic local connect probe.
- Reconnect backoff: 1s → 2s → … capped at 60s.
- After N failures (default 5) the tunnel is marked failed and a notification is
  sent.
- A port clash on bind shows a clear error naming the process holding the port
  (`lsof`).

### 8.4 Deployments

**This is modelled on the existing `acme-esg/webapp/esg/deployment/unified_release.sh`.**
How it works today:
- The apps are already running on Azure VMs.
- Each app is a **git checkout on the host** (e.g.
  `/home/azureuser/src/acme-essentials/webapp/esg`) with its own `.env`.
- Its images are **built on the host** with `docker compose up --build -d`.
- Compose files use relative bind mounts (`./logs`, `./climate_data_optimized`),
  so deploys must run **in place** inside the checkout. No release folders.

**Deployment (one app)** = name, URLs, environment, host, and:
- `repo_path` on the host, default `branch`, compose file (default `docker-compose.yml`);
- `deploy_tag` (e.g. `backend_prod`);
- an optional `db_backup` (reads `DB_USER/DB_HOST/DB_PORT/DB_NAME/DB_PASS` from the
  host `.env`, runs `pg_dump -Fc` into a backup directory on the host);
- optional pre/post hook commands;
- build and compose timeouts (defaults: 300 s / 120 s);
- `use_sudo` (auto-detected in preflight);
- `managed_env` (off by default, see below).

**Release (a batch run)** = 1..n deployments, grouped by host. The usual case is
backend + frontend + FastAPI on one host in a fixed order. Release settings:
- branch per deployment (a default plus overrides);
- version bump `patch|minor|major` (tracked per environment, applied on environments
  marked `versioned`, e.g. prod);
- toggles for backup, notifications and QA.

Steps per host, in order:
1. **Preflight.**
   - Tools: `git`, `docker`, `curl`, plus `pg_dump` and `jq` when needed.
   - `docker info` works, with or without sudo.
   - The repo path exists and the worktree is clean (no uncommitted changes).
   - The branch exists on `origin`.
   - Free disk is at least 2 GB; below that it's a warning, not a failure.
2. **Collect changes.** List the commits between the last `deploy_tag` and
   `origin/<branch>` for each repo, with reverts filtered out.
   - If there are 0 commits, ask "redeploy anyway?". A redeploy sends no
     notifications.
3. For each deployment, in order:
   1. Record `previous_commit`.
   2. DB backup (if enabled).
   3. `git fetch --tags origin <branch>` and `checkout` + `reset --hard origin/<branch>`.
   4. Pre-hook.
   5. `docker compose up --build -d`, with a timeout.
   6. Health check on the URLs.
   7. Post-hook.
   8. `git tag -fa <deploy_tag>` and `git push -f origin <deploy_tag>`.
4. **On failure.**
   - If the environment's `auto_rollback` is on (default **on**, as the script does
     today), roll back every deployment already applied in this release, in reverse
     order: `git checkout <previous_commit>`, then `docker compose up --build -d`.
   - Otherwise, offer a one-click rollback.
5. **Finalize.**
   - Bump the version and create the unified release tag (versioned environments only).
   - Generate AI release notes from the commits (features → enhancements →
     fixes → hotfixes, written for sales and marketing).
   - Send the Teams adaptive card and the optional SendGrid email.
   - Trigger the QA GitHub workflow (`workflow_dispatch`); this is skipped by default
     on prod/uat/uat_eu. Optionally wait for the result and notify.

Other rules:
- **Git auth** for fetching and pushing on the host uses the host's own deploy key
  or credentials. OpsDeck does not push code. SSH agent forwarding is an option
  per host.
- **`managed_env`** (opt-in): OpsDeck writes `.env` from vault secrets before the
  build and keeps a backup of the previous one. With it off, the host `.env` is
  never touched; it is only read, for the DB backup.
- **Protected environments** need the typed-name confirmation.
- Hosts run in parallel. Deployments on one host run in sequence in a single
  session.
- Every command and its output streams to the UI and the run history.
- **Execution:** the whole release is one generated Ansible playbook: one play
  per host, with the steps above as tasks (`ansible.builtin.git`/`shell`/`uri`/
  `command`). Rollback is a separate generated playbook. The local steps
  (release notes, Teams, email, QA dispatch) run in OpsDeck itself, after the
  playbook finishes.

### 8.5 Visualization
- **Map view** per environment: hosts as nodes (role icon, reachability dot),
  apps attached to their host, tunnels as animated dashed edges flowing in the
  direction of traffic (green when up, amber while retrying, red when failed).
- **Deploy pipeline view:** per host, a row of step chips that animate as each
  step starts, finishes or fails.
- Respect "reduce motion".

### 8.6 AI help
- Shown on failed runs, steps, connections and tunnels.
- The context sent:
  - the step name and the command that ran;
  - the last ~200 log lines, redacted;
  - the host's OS if known;
  - a redacted snippet of the compose file.
- The response renders as a cause, fix steps, and commands with copy / "open in
  terminal" buttons.
- Audited (the fact that a request was made, not its content).

### 8.7 Notifications
- Teams webhook per environment (optional), plus macOS notifications.
- The message contains: environment, deployment name, host label, status,
  duration, URLs, and the user who triggered it. It never contains logs or
  secrets.

### 8.8 Audit trail
- Written by the main process only.
- Viewer: filter by actor, action, environment and date; export to CSV.
- A "verify chain" button checks the hash chain.

## 9. Build order (one by one)

Each phase ends usable and demoable.

1. **Foundation:** Electron/React/TS skeleton, IPC layer, SQLite plus migrations,
   app shell (sidebar: Environments, Hosts, Vaults, Tunnels, Deployments,
   Audit), audit trail writer.
2. **Vaults and keys:** master password, unlock, Keychain cache, secrets, SSH
   keys (pick from `~/.ssh`, import, generate ed25519), identities.
3. **Hosts and environments:** CRUD, many-to-many linking, roles, defaults and
   resolution, `~/.ssh/config` import.
4. **SSH terminal:** sessions, jump hosts, known-hosts / TOFU, local shell tab.
5. **Tunnels:** L/R/D, auto-reconnect, status, auto-start.
6. **Visualization:** topology map, animated tunnel edges.
7. **Ops tools:** container view, multi-host run, snippets.
8. **Deployments:** model, Ansible playbook generation and runner, preflight, `.env`
   rendering, health checks, history, rollback, protected-env confirm, pipeline
   animation.
9. **Notifications and AI help:** Teams webhooks, macOS notifications,
   "Explain & fix".

## 9a. Calls made after the builder review (Claude's calls, check these)

- **Deploy steps are generated as Ansible tasks** rather than calling
  `unified_release.sh` on the host, so every step gets its own status, log and AI help.
- **AI release notes use Claude** (user confirmed), with the same prompt intent as
  `release_mail.sh`, replacing the OpenAI/Gemini calls.
- **One master password** unlocks all vaults. Vaults are separate for organisation
  and linking, not for separate passwords.
- **Rollback = previous git commit + rebuild** (images are built on the host, so there are no digests to pin).
- **Ansible authentication.** For each run, start a private `ssh-agent`, load the
  identity's key into it from the vault (`ssh-add -t <run timeout>`), and kill the
  agent when the run ends. A generated `ssh_config` carries ProxyJump and a
  generated `known_hosts` built from the app's store.
  - No key file ever touches disk.
  - Deploy targets must use key or agent auth. Password-only identities still
    work for terminals and tunnels, but they are rejected for deployments in v1.
- **sudo.** Preflight tests `docker info` as the user. If that is denied, it tries
  `sudo -n docker info`. If that also fails, it asks for an optional "become
  password" secret on the identity. Ansible uses `become` the same way.
- **Health checks run from the target host by default** (curl or wget over SSH,
  checked in preflight). An option per URL switches it to "from this Mac".
- **Audit actor** = OS user + machine name. There is no "app profile" concept.
  The trail is a local history; the hash chain is a light tamper signal, not a
  compliance control. Central collection is out of scope for v1.
- **Distribution:** unsigned local builds during development. Signing and
  notarization are added when an Apple Developer ID is available. Touch ID
  unlock uses `systemPreferences.promptTouchID`. No auto-update in v1.

## 10. Left to the builder

- Exact UI layout and visual style. The bar is set: dark-first, at least
  Termius-level polish, highly interactive and **fun to use, not a nightmare** (user
  requirement). That means spring animations, a ⌘K command palette, keyboard
  shortcuts, toasts, skeleton loaders and friendly empty states.
- Library versions, project folder layout, test framework.
- The exact Ansible playbook shape (`community.docker` modules or shell
  `docker compose`).
- Exact retry counts, thresholds and timeouts, within the defaults stated above.
- Whether split panes make v1.
