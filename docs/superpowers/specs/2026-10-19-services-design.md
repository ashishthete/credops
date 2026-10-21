# OpsDeck — Services

Date: 2026-10-19. Extends `2026-10-16-opsdeck-design.md` (the main spec) and
evolves Phase 8 (`phase8-deployments`, plans `2026-10-19-phase8-deployments.md`
and `-8b.md`). Calls marked "(controller's call)" were made when this spec was
written; calls marked "(builder's call)" are left to whoever plans the build.

## 1. Intent

User, 2026-10-19: "each env can have frontend, backend, db and other services;
can be on same host or different. today we are missing services." Product alpha
has frontend, backend, db, JS foundry and AI services. "Services mostly run on
same host; db can be on different machine. We should take one type whether
service or db. db needs tunnel, not services." "Every env has different git
branch and path on host." Their day-to-day jobs on a service are **deploy** and
**check logs**.

On deploying, the user said: "ansible can deploy selected services — so you
should build that way", then "user have selection what needs to be deployed, it
runs playbook to deploy this", and "skip db deployment as always."

Today OpsDeck knows hosts and environments, and Phase 8 knows deployments
(a repo checkout on a host). Nothing names the things that actually run:
"backend", "JS foundry", "the prod Postgres". This spec adds that layer, makes
it the main surface of an environment, and makes **pick services, then run one
playbook for exactly those** the way deploys happen.

## 2. Goals

- S1. A **Service** belongs to one Environment and has a kind: `service` or `db`.
- S2. A `service` runs from a **checkout** (a git repo at a per-environment
  branch and path on a host) and is one compose service in it. It may have a URL.
  Actions: **Logs** (live), **Deploy**, **Open URL**.
- S3. A `db` has an engine, an address and a port. Action: **Open tunnel**, through
  the environment's app host or a chosen via-host, to a local port. A db is
  never deployed.
- S4. **The central flow is deploying selected services.** The user ticks one,
  several or all services in a picker grouped by checkout. Confirming generates
  and runs one Ansible playbook through Phase 8's runner. For each affected
  checkout the playbook resets to the branch and runs
  `docker compose up --build -d <selected compose services>`. Only the chosen
  services rebuild and restart. Progress is live, and a failure rolls back the
  selected services only.
- S5. **Copy services** from one environment to another, changing only branch,
  path and host.

## 3. Non-goals

- Deploying, migrating, backing up or restarting a database. Db services have
  no deploy action and no playbook ever touches one.
- A pre-deploy `pg_dump` backup tied to the new flow. It is out of scope here
  and listed as a later addition (§10). Phase 8's existing per-checkout backup
  setting is left as it is (off by default) and is not shown in the service
  picker (controller's call).
- A database client, query runner or connection-string builder. The db service
  ends at "a local port is open".
- DB restore on rollback (the script does none; Phase 8 does none).
- Service discovery: reading compose files on the host to create services
  automatically. A builder may add a "suggest from compose file" helper later,
  but suggestions are never applied without the user saving them.
- Non-compose services (systemd, k8s), as in the main spec.

## 4. Anti-goals (failure even if it "works")

- A second deploy engine beside Phase 8. Services deploy through Phase 8's
  `ReleaseService`, generator, `DeployRunner` and run-event stream.
- Restarting a service the user did not select, including through compose
  dependencies.
- Hiding that a git reset changes code for every service in a checkout.
- Any playbook task that targets a db service.
- A db service whose tunnel is a separate, hidden copy of the tunnel machinery.
  It must be a Phase 5 tunnel with real status (main spec §5: never "up" while
  dead).
- Copy that carries one environment's secret references into another
  (for example, prod vault secrets into staging).

## 5. Constraints (carried from the main spec and earlier phases)

- No secrets in plaintext on disk, in logs, in the audit trail or over IPC.
  Secrets come from vaults by reference.
- Audit events never store target host ids or labels, only `hostCount` (the
  existing rule).
- `known_hosts` is read-only to these features; host-key handling stays as in
  Phases 4 and 8.
- AI suggestions are never auto-executed.
- Animations are fast (user: "make it faster"). Reuse the existing motion
  tokens, and add nothing slower than what the UI already uses.
- The protected-environment typed-name confirmation applies to every deploy
  and rollback into a protected environment (existing rule; Phase 8
  `ReleaseConfirm.typedName`).
- Creating, editing or deleting a service or checkout in a protected
  environment through the UI asks for no typed name, because nothing runs
  until a deploy or rollback, which does ask. Config import does ask, because
  it is a bulk retarget.
- No new npm dependencies.

## 6. Reconciling with Phase 8

Phase 8 already has the right shapes; they are named for the engine, not for
the user.

| Phase 8 concept | What it really is | Becomes |
|---|---|---|
| `Deployment` (env, host, `repo_path`, `default_branch`, `compose_file`, `deploy_tag`, `position`, hooks, env template) | One repo checked out in one environment on one host, at that environment's branch and path | **Checkout**. The table and type keep the name `deployments`. |
| `App` (env, host, name, `compose_project`) | "What runs where", one row per app, linked from a deployment by `deployments.app_id` | **Service**. The `apps` table grows into `services`. |
| `Release` | One playbook run for one environment | One deploy of a **service selection**. |
| `DeploymentRun` | One checkout inside a release | One affected checkout, now with the list of services it deployed. |

**Decision (controller's call).** A checkout is a Phase 8 Deployment, and a
Service is the evolved Phase 8 App. A release gains a service selection.
Reasoning:

- The Deployment row already carries exactly the per-env checkout fields the
  user asked for (branch, path, host) plus the script's behaviour (order, tag,
  rollback). Making it the checkout keeps preflight, locks, rollback, run
  events and the runner boundary. The generator changes in one place: compose
  commands take a service list.
- Phase 10 grants, `deployment_runs.deployment_id` and the Hub registry all key
  on deployment ids. Keeping the table keeps those keys stable.
- The App table is the only thing in Phase 8 that names what runs, but its link
  points the wrong way: `deployments.app_id` gives one app per checkout, while
  the user's checkouts hold several services (webapp/esg holds `esg` and
  `js_foundry`; fast-api holds `fastapi-app`, `langgraph-api` and `redis`). The
  link is reversed so that a service points at its checkout.

**Sequencing (controller's call).** Phase 8b is not built yet, and this spec
replaces the 8b plan. The next plan builds the release store, the wizard (the
service picker), the pipeline view, the live log and the map around service
selection from the start. It never builds a wizard that takes only
`deploymentIds`. Phase 8 (8a) is unmerged, so its schema is changed by amending
migration 7 in place (see Migration below).

**Exact changes to Phase 8:**

1. **Schema.** `deployments` gains `repo_url TEXT` (optional; the git remote,
   for display and as the key copy uses to pair checkouts) and
   `compose_project TEXT` (moved from `apps`, since a compose project belongs
   to a checkout). `deployments.app_id` is dropped. `apps` is replaced by
   `services` (§7).
2. **Request.** `PreflightRequest` takes `serviceIds: string[]` instead of
   `deploymentIds`. Main derives the affected checkouts, rejects any db service
   or a service from another environment, and rejects an empty selection. A
   checkout with no services defined is selectable as a whole. It is shown as a
   single row, "whole checkout", and deploys as Phase 8 does today, with no
   service list (controller's call).
3. **Plan.** `PlanDeployment` gains `services: string[] | null`: the selected
   compose service names (validated like `COMPOSE_PROJECT`, shell-quoted), or
   `null` for a whole-checkout deploy. `DeployPlan.deployments` holds only
   affected checkouts.
4. **Whole checkout vs partial (controller's call).** When every OpsDeck
   service in a checkout is ticked, the checkout is deployed whole, with
   `build` then `up -d` and no service list. That matches the user's release
   script, which rebuilds the whole compose project, and the picker labels the
   group "whole checkout". A partial selection sends the list:
   `build <svcs>` then `up -d --no-deps <svcs>`. That has the same effect as
   `up --build -d <svcs>` while keeping Phase 8's separate build and up steps
   and their timeouts. `--no-deps` stops compose from recreating an unselected
   dependency. If a selected service depends on one that is not running,
   preflight warns (builder's call how that is detected). `rb_build`/`rb_up`
   use the same form as the release did. Fetch, checkout, `.env`, hooks and tag
   stay per checkout.
5. **One compose invocation (controller's call).** Deploy, rollback and logs
   build the compose command with one shared helper: `docker compose -f <file>`,
   plus `-p <compose_project>` only when it is set. When it is unset, all three
   use compose's default project name. Preflight gets no new check.
6. **Ordering.** Affected checkouts on one host run in `position` order, and
   different hosts run in parallel, as in Phase 8. A whole-environment deploy
   ("All") therefore keeps the configured order. Within one checkout, the
   service list is passed in service `position` order; compose decides the
   start order within that one command.
7. **Health checks (controller's call).** They use the URLs of the selected
   services, checked from the Mac by default, with the checkout's expected
   status and timeout. A service can set `url_check_from` to `host` (§7). The
   checkout's own `urls` run only when the checkout has no service URLs.
8. **Tag.** `deploy_tag` still moves on every deploy of a checkout, as the
   script does, because it records the commit the checkout is at. OpsDeck's
   commit list in the picker does not rely on the tag alone. Each service keeps
   `last_deployed_commit`, and the picker shows commits since that commit,
   falling back to the tag (controller's call).
9. **Rollback (controller's call).** Automatic and manual rollback cover only
   the services the release deployed. Per affected checkout, in reverse order,
   rollback:
   - checks out the checkout's `previous_commit` (a whole-checkout rollback
     does the same);
   - restores `.env` as Phase 8 does;
   - runs `build`/`up` in the same form the release used.

   A manual rollback is allowed only if every service it would rebuild is
   still where the release left it. That means two things. No later release
   left the service deployed (one that failed or was rolled back does not
   count). And the service's `last_release_id` is this release (or, when this
   release's run for it did not record a commit, the release it was on
   before). A rollback sets `last_release_id` back to the release before the
   one it undid, so "the new release failed, roll back one more" works whether
   the newer release was rolled back automatically or by hand, and rolling
   back the same release twice is refused. Otherwise the rollback is refused
   and the refusal names each service and the release it is now on; a release
   already rolled back says so. On rollback, each service's
   `last_deployed_commit` is set to the commit the rollback checked out for
   its checkout (the run's previous commit), not each service's own stored
   previous commit: the whole checkout moves together, so siblings that had
   different last commits all end at the one that is now on the host.
10. **Release record.** `releases` gains `service_ids TEXT` (JSON, the
    selected service ids, as confirmed). Each `deployment_runs` row gains
    `services TEXT`: a JSON array with one entry per deployed service, holding
    its id, name, compose service, previous commit and deployed commit. A
    whole-checkout deploy stores an entry for every tracked service of that
    checkout. `ReleaseSummary` and `ReleaseDetail` gain `serviceIds`
    and `serviceCount`; `DeploymentRunMeta` gains `services` and `wholeCheckout`.
    Audit events for releases carry environment, `serviceCount`,
    `deploymentCount` and `hostCount`, and never host ids or labels. Service ids
    may appear in the release record and run events.
11. **UI.** `AppMeta`/`AppInput`, `AppDialog` and the app IPC are replaced by
    their service equivalents. The UI says "Checkout" where the engine says
    deployment. The release experience that 8b planned is built as §8.3
    describes. The Deployments page keeps its name, because it lists releases
    and history.

**Migration (controller's call).** Phase 8 is unmerged and has no user data, so
no data is migrated. Migration 7 is amended in place:
- it creates `services` directly, with no `apps` table;
- `deployments` has `repo_url` and `compose_project` and no `app_id`;
- `releases.service_ids` and `deployment_runs.services` are added.

## 7. Data model

**`services`**

| Field | Notes |
|---|---|
| `id`, `environment_id` (cascade), `name` | Name unique per environment, case-insensitive. |
| `kind` | `service` or `db`. |
| `position` | Display and deploy order within a checkout. |
| `description`, `created_at`, `updated_at` | |
| **kind `service`** | |
| `deployment_id` | The checkout, `ON DELETE SET NULL`. A service without one shows "No checkout": it cannot be picked for deploy, and only Open URL works. |
| `compose_service` | Required for kind `service`: the service name in the compose file (`esg`, `js_foundry`, `fastapi-app`, …). Unique per checkout. The form defaults it to the service name (controller's call). |
| `url` | Optional, http(s), `MAX_URL`. Used for Open and for health checks. |
| `url_check_from` | `mac` (default) or `host`: where the health check of `url` runs (controller's call). |
| `last_deployed_commit`, `last_release_id` | Set when a release that included it succeeds. A rollback sets it to the commit the rollback checked out for its checkout. |
| **kind `db`** | |
| `db_engine` | `postgres`, `mysql`, `mongodb`, `redis` or `other`, used for the icon and the default port. |
| `db_address`, `db_port` | Address as seen **from the via-host**: a hostname, IP or an inventory host's address. |
| `via_host_id` | Optional (`hosts`, set null). Null means the environment's app host (§8.4). |
| `local_port` | Local bind port; null means a free port is picked on open (builder's call how it is remembered). |
| `tunnel_id` | The Phase 5 tunnel that backs it (`tunnels`, set null). Created on first open. |

A CHECK keeps the kind-specific columns null for the other kind. A service's
host is not stored: it is its checkout's `host_id`. That keeps "the host it runs
on" and "the host we deploy to" from drifting apart.

**Host roles (controller's call): keep.** `environment_hosts.role`
(`app`/`db`/`bastion`/`other`) stays as it is. It describes the machine, not
what runs on it, and SSH, the map and jump-host defaults already use it.
Services relate to it in two ways only:

- The default via-host of a db service is the environment's `app` host. With
  several, the one with the most checkouts is used and the db form shows which
  one, so the user can pin another. With none, a via-host is required.
- When a checkout is saved on a host that is not yet a member of the
  environment, it is added with role `app` (builder's call whether to ask
  first).

No role is derived or migrated.

## 8. Behaviour

### 8.1 Environment view

The environment view gains a **Services** section as its first section, above
hosts. It is grouped by checkout, in `position` order, with db services in their
own group at the end. Each **checkout header** shows the repo, branch, path, host
label, and last deployed commit and tag. A **Deploy…** button sits at the top of
the section. Each **service row** shows an icon by kind or engine, the name, the
compose service, its last deployed commit, and these actions:

- **Logs** (`service`): opens a live log pane (§8.2).
- **Deploy** (`service`): opens the picker (§8.3) with only this service ticked.
- **Open** (`service` with a URL): `shell.openExternal`, through the same main
  path as `env:openDomain`.
- **Tunnel** (`db`): open or close, with the live Phase 5 state chip and the
  local `127.0.0.1:<port>` once it is up, plus a copy button for that address.
  Db rows show engine, address and port, and have no Deploy.

Add, edit, reorder and **Copy to…** live in the section's menu. Status chips and
row transitions use the existing fast motion; nothing waits on an animation.

### 8.2 Logs

Logs runs, over SSH on the checkout's host,
`cd <repo_path> && docker compose -f <compose_file> [-p <compose_project>] logs -f --tail <n> <compose_service>`.
It extends the Phase 7 `ContainersManager` follow with a compose variant
instead of adding a new streamer (controller's call). The variant keeps the
pooled exec links, the follow limit, the `containers:logs`-style events and the
`logsError` stderr handling. Every argument is validated by the Phase 8 rules
(`REPO_PATH`, `COMPOSE_FILE`, `COMPOSE_PROJECT`) and shell-quoted. **Privilege (controller's call, amended at pre-flight F11).** Phase 7 has no
per-host docker or sudo setting, so docker access follows the checkout's
`use_sudo`:
- `yes` uses `sudo -n`;
- `no` uses plain docker;
- `auto` uses plain docker when `docker info` works, else `sudo -n`.

Logs never fetch the become secret. If the command fails with a permission
error, the logs pane says so plainly, for example "Docker on <host> needs sudo
for logs; check the checkout's sudo setting", and links to that setting. Reading logs is not audited, as in
Phase 7, and needs no protected confirmation. Log lines stay in the renderer's
ring buffer and are never written to disk.

### 8.3 Deploy: pick services, run one playbook

This is the central flow.

1. **Picker.** A dialog lists every deployable service of the environment,
   with a checkbox per service, grouped under its checkout header (repo,
   branch, host). Each group has its own select-all box. **All** at the top
   ticks every deployable service. Db services are not listed, and All never
   includes them. Services with no checkout are listed greyed out, with the
   reason. Opening from a service row pre-ticks that service; opening from the
   section header starts with nothing ticked (builder's call whether to
   remember the last selection).
2. **Whole checkout.** When every OpsDeck service of a checkout is ticked, the
   group is labelled "whole checkout" and deploys with no service list, as
   the release script does (§6 item 4, controller's call).
3. **Shared-checkout notice.** When a checkout is only partly selected, its
   group shows, in plain words and always visible:
   "Updates code for webapp/esg to `<branch>`. Only esg is rebuilt and
   restarted. JS foundry keeps running its current image; it will pick up the
   new code the next time it is deployed or restarted." It names every
   unselected service of that checkout. It also lists the compose services that
   OpsDeck does not track, when the parsed compose file is available; when it
   is not, the notice adds "Other compose services in this checkout are not
   restarted" (controller's call). It also says when a managed `.env` will be
   rewritten, since that file is shared by the checkout too.
4. **Preflight and confirm.** The wizard then shows: preflight checklist, commits since each selected
   service's last deployed commit, version bump and options. This is the
   8b wizard's content, built around the selection from the start
   (controller's call, §6 Sequencing). A protected
   environment needs its name typed. Main enforces this; the renderer only
   mirrors it.
5. **Run.** Confirming generates one playbook covering exactly the affected
   checkouts and selected services (§6, items 3–6) and runs it through
   `LocalRunner` (or `HubRunner` later). The pipeline view shows one row per
   affected checkout, labelled with its selected services or "whole
   checkout". The live log shows the run-event stream.
   This covers the release script's "deploy multiple things together".
   Picking several services, or All, gives one run in the configured checkout
   order, so the script needs no separate batch concept.
6. **Failure.** With auto-rollback on (the default), every service already
   deployed in this release is rolled back in reverse order (§6 item 9).
   After a partial selection, unselected services are never restarted, by the
   release or by its rollback.

**Audit.** One `release.*` event per Phase 8, with environment,
`serviceCount`, `deploymentCount` and `hostCount`, and never host ids or
labels.

### 8.4 Db tunnel

**Open** makes sure the db's Phase 5 tunnel exists and starts it: type `L`, on
the via-host (or the default app host), bind `127.0.0.1:<local_port>`, and
target `db_address:db_port`. Host resolution (identity, jump host, environment
defaults), status, auto-reconnect and failure notifications are all Phase 5's
own. When the address, port or via-host change, a stopped tunnel is updated
and a running one is restarted after the user agrees. The exact flow is the
builder's call. `TunnelPatch` accepts route fields, but `TunnelStore.update`
restarts a running tunnel at once, through `TunnelManager.changed`. So OpsDeck
must not write a running tunnel's new route until the user agrees (pre-flight
F15). The tunnel
also appears on the Tunnels page with the service name as its label. Deleting
the service asks whether to delete its tunnel too.

### 8.5 Copy services to another environment

**Copy to…** asks for a target environment and shows one row per source
checkout, with **branch**, **path** and **host** to fill in. It also shows one
row per db service, with **address**, **port** and **via-host**. Nothing else is
asked.

- **Copied:** service names, kinds, compose services, engines, order, compose
  file and project, repo URL, hooks, timeouts and `use_sudo`.
- **Derived:** `deploy_tag` uses the script's `<repo>_<env>` form. Where the
  source environment's name appears in the tag, it is replaced with the
  target's; otherwise the field is left for the user to fill.
- **Not copied:** vault links, the become secret, managed-env secrets, tunnels,
  URLs, last deployed commits and the backup setting. For managed-env
  templates, the text is copied with every `${secret:…}` value cleared and
  `managed_env` off, and the dialog says so. Each tunnel is created on first
  open. URLs are left empty, because they differ per environment.
- If a service or checkout name already exists in the target, that row is
  skipped and listed afterwards; nothing is overwritten (builder's call whether
  to offer renaming instead).
- Copy is one transaction and one audit event (`services.copy`: source and
  target environment, service and checkout counts, `hostCount`). Copying into
  a protected environment needs no typed confirmation, since nothing runs, but
  the first deploy does.

## 9. Hub (Phase 10) grants

Grants stay where Phase 10 puts them: `all`, `environment`, or `deployment`,
where a deployment is now a checkout. Services carry no grant of their own:

- A selection is allowed when every affected checkout is granted, by its
  checkout grant or a wider one. `AccessTarget.deploymentIds` is the set of
  affected checkouts, which main derives from the selected service ids. If any
  checkout is not granted, the whole request is refused and the refusal names
  that checkout.
- Logs and db tunnels are SSH, which stays local and outside SSO (main spec
  §8.10).

The Hub registry (10b) publishes services with their environment, so Hub users
see service names in run history (builder's call). Ids stay the publishing
admin's local UUIDs, as Phase 10 rules.

## 10. Later additions

- An optional, off-by-default pre-deploy DB backup step attached to a selection
  (for example, when the backend is selected). It would reuse Phase 8's backup
  task and never restore anything.
- "Logs for all services in this checkout" in one pane.
- "Suggest services from the compose file" (§3).
- Fetching the become secret so that logs work on hosts where docker needs a
  sudo password.

## 11. Left to the builder

Left open:
- detecting unrunning dependencies for the `--no-deps` warning;
- the logs pane layout and tail size;
- how a picked local port is remembered;
- the tunnel route-change flow;
- conflict handling during copy;
- whether checkout membership is added silently;
- whether the picker remembers the last selection.

Everything else above is decided.

## 12. Calls made

All of these are controller's calls.

1. **Sequencing.** This spec replaces the 8b plan. The release store, picker
   wizard, pipeline view, live log and map are built around service selection
   from the start, with no `deploymentIds`-only wizard. Migration 7 is amended
   in place.
2. **Whole checkout.** If every OpsDeck service of a checkout is ticked, the
   checkout runs `build`/`up -d` with no list. A partial selection uses the
   list with `--no-deps`. The notice lists untracked compose services, or
   says they are not restarted.
3. **`-p`.** One shared compose helper is used for deploy, rollback and logs:
   `-f <file>`, plus `-p` only when `compose_project` is set. There is no new
   preflight check.
4. **Rollback.** Only the latest release per deployed service can be rolled
   back. Previous and deployed commits are stored per service in
   `deployment_runs.services`, and `last_deployed_commit` is restored from
   them. The checkout itself returns to its `previous_commit`.
5. **Health check.** A service URL is checked from the Mac by default, with the
   checkout's status and timeout. `url_check_from` (`mac` or `host`) can
   change that.
6. **Migration from `apps`.** There is no data migration: `services` is
   created directly and `apps` is dropped. `compose_service` is required for
   kind `service` and defaults to the service name in the form.
7. **Logs privilege.** Logs follow the checkout's `use_sudo` (`yes`:
   `sudo -n`; `no`: plain; `auto`: decided by `docker info`), because Phase 7
   has no per-host docker setting (amended at pre-flight F11). They never
   fetch the become secret. A permission error is shown plainly and points
   to the checkout's sudo setting. Fetching the become
   secret is a later addition.

## Addendum: config import/export (controller's call)

The user asked for "import and export of whole config including deployments,
in json or yaml, the best suitable one". Everything in this addendum is the
controller's call. The plan builds it in Tasks 12 and 13.

1. **Format.** The format is JSON.
   - No YAML dependency exists, and adding one is not allowed.
   - JSON round-trips exactly and is easy to validate strictly.
   - The file is `opsdeck-config.json`, pretty-printed with 2 spaces.
   - Top level:
     `{ format: "opsdeck-config", version: 1, exportedAt, products, environments, hosts, identities, tunnels, services, deployments (checkouts), with environment deploy settings }`.
     Groups and tags go in too, where present; today they are host tags
     only.
   - References between objects use the stable ids.
2. **Secrets are never exported.**
   - Vault items appear only as references `{ vaultName, itemName }`, and
     only where config points at them.
   - The file never contains passwords, keys, passphrases or tokens, or
     the contents of any field marked secret.
   - Releases, run logs, audit, known_hosts and session history are never
     exported either.
   - A test scans the export for fixture secret values.
3. **Export.**
   - It lives in Settings, as **Export config…**, using the save dialog.
   - Main alone writes the file, with mode 0600.
   - Audit: `config.export` with counts only.
4. **Import.**
   - It lives in Settings, as **Import config…**, using the open dialog.
   - **Validation.** Main parses and validates the file strictly. An
     unknown `format` or a newer `version` is refused, and the file is
     capped at 5 MB.
   - **Preview.** It shows what is added, what is updated (matched by id,
     then by name within its parent) and what is skipped. Nothing is
     applied until the user confirms.
   - **Apply.** Everything is applied in one DB transaction, all or
     nothing. Import never deletes anything that is not in the file.
   - **Secret references.** A reference that cannot be resolved leaves the
     field unset, and the result lists it as "needs a secret".
   - **Protected environments.** Updating one needs its name typed.
   - **Audit:** `config.import` with counts only.
5. **Tests.**
   - Round-trip fidelity: export, import into an empty DB, export again
     gives the same config.
   - Re-importing the same file is a no-op.
