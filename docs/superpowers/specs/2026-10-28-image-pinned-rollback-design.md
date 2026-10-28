# CredOps — Image-pinned rollback

Date: 2026-10-28. Extends `2026-10-16-opsdeck-design.md` (the main spec),
`2026-10-19-services-design.md` (services, multi-service checkouts) and the
playbook-ops work (migration 13: steps, flow, parallel prepare, edited
playbooks). Calls marked "(controller's call)" were made when this spec was
written; calls marked "(builder's call)" are left to whoever plans the build.
Open questions for the user are in section 14.

Design only: nothing here is built yet.

## 1. Intent

Today a rollback is a second deploy that runs backwards. `taskRbCheckout`
detaches HEAD at the previous commit, `rb_env` puts the old `.env` back,
`rb_build` runs `docker compose build` again, and `rb_up` recreates the
containers. The rebuild is the weak link:

- `docker compose build` writes the new image over the old one under the same
  tag. Once a build has finished, the image that was running before is gone.
  `prepareFailed` already says so to the user: "builds that finished: their
  images already replaced the old ones under the same tags".
- So every rollback is a fresh build of old code. It is slow (minutes, under
  `buildTimeoutSec`). It can fail (registry down, a base image that moved, an
  `apt` mirror that is gone). And it is not the same artifact that ran before:
  a floating `FROM node:20` or an unpinned dependency gives you a different
  image.
- A rollback needs the git checkout to move, so it needs a clean tree. On a
  monorepo checkout shared by several deployments, it moves the tree under
  every sibling too (the "shared" note in `PrepareShared`).

The fix is to keep the images. Before a release touches anything, CredOps tags
the image each service is running. After a release succeeds, it tags each
service's new image with the commit. A rollback then retags the kept image back
to the name compose uses and runs `docker compose up -d --no-deps --no-build`.
That takes seconds, cannot fail on a build, and brings back the exact bytes
that ran before. When the kept image is not there (pruned by hand, a different
daemon, a release made before this feature), the rollback falls back to
today's checkout and rebuild. No release ends up worse off than today.

## 2. Goals

- **G1. Restore what ran.** Rolling back release R puts every service R touched
  back on the image it was running just before R. That is the snapshot image,
  not a rebuild of R's previous commit.
- **G2. No build in the common case.** A rollback whose snapshots all exist
  runs no `compose build` and does not need origin.
- **G3. Leave a monorepo alone where it can.** When the compose inputs are the
  same at both commits, the rollback does not move the git tree. When the tree
  is shared with deployments outside the rollback, it is never moved for an
  image rollback.
- **G4. Older commits too.** A manual rollback to any of the last N deployed
  commits of a service can use that commit's image while it still exists.
- **G5. Bounded disk.** Each host keeps at most N pinned images per service
  (default 3), pruned at the end of every successful release.
- **G6. Graceful fallback.** A missing image, a different docker daemon or an
  edited playbook that dropped the pin all lead to today's checkout+build path,
  per deployment, and the UI says which path it will take.
- **G7. Same on desktop and Hub.** The generator is shared, so both get it.
  Mixed versions keep working.
- **G8. Failed prepare and cancel recover images too.** A failed parallel
  prepare or a cancel after the build retags the snapshots, so the old images
  are back under their compose names even if nobody rolls back.

## 3. Non-goals

- A registry. Pins live in the host's local docker image store. Pushing to or
  pulling from a registry ("build once, deploy many") is a separate feature.
  The tag naming in section 5.1 avoids getting in its way.
- Rolling back volumes, databases or migrations. The `backup` step exists for
  that, and this changes nothing about it.
- Kubernetes, Swarm or `docker stack`. Compose only.
- Removing services a release added. The current rollback does not remove
  orphans, and this keeps that behaviour (section 14, Q4).
- Rolling back the `.env`. That already works (`rb_env` and
  `.env.opsdeck-prev`) and stays as it is. Section 7 explains how the two fit
  together.

## 4. How it fits today's engine

The relevant pieces, all in `src/main/deploy/`:

| Piece | Today | With pins |
|---|---|---|
| `generate.ts` `RELEASE_SLOTS` | record, backup, before_fetch, fetch, checkout, …, build, …, up, …, health, …, tag, after_tag | the `record` builtin also takes the **snapshot**; a new builtin **`pin`** runs inside the `tag` slot, after `taskTag`, and also prunes |
| `ROLLBACK_SLOTS` | before_fetch, rb_checkout, after_checkout, rb_env, before_build, rb_build, after_build, rb_up, after_up, rb_health, after_health, rb_tag, after_tag | a new protected **`rb_probe`** task comes first; `rb_checkout` and `rb_build` gain a `when:` on the probe's fact; a new **`rb_retag`** task runs just before `rb_up`; `rb_up` adds `--no-build` in image mode |
| `composeCommand(t, sub, services, {sudo})` in `compose.ts` | the only way to build a compose command | joined by `dockerCommand(t, args, {sudo})`, which shares `AUTO_DOCKER`, so every docker call goes through the same sudo ladder |
| `markers.ts` `MARK` | PREV, HEAD, LOCK, …, RESTORE, PF, STEP, SKIP | adds `SNAP`, `PIN`, `RB` (section 6). The marker test that sweeps the generated commands will force this |
| `events.ts` `marker()` | PREV/HEAD/BACKUP/TAG/RESTORE → run columns and events | `SNAP`/`PIN` → `image_pins` rows; `RB` → a run event plus `deployment_runs.rollback_mode` |
| `taskPrepRestore` (`OD-RESTORE`) | checks the deploy tag's commit back out after a failed prepare | also retags the snapshot images (G8) |
| `prepareFailed` / `PREPARE_FAILED_MESSAGE` | says the finished builds replaced the old images | says "old images restored" when every `OD-RESTORE images=ok` came back |
| `release-service.ts` `rollback()` / `runRollback` / `autoRollback` | build a `kind:'rollback'` plan, with `previousCommit` per deployment | plan deployments carry `rollbackImage: {rel, sha}`, and the confirm text shows the expected mode per deployment |
| `host-vars.ts` `hostOd` | rel, env, lock_repos, env_rel, … | adds `pin_keep` (N) and `pin_rel` (which release's snapshot a rollback restores) |

Data flow for a release R on host H, checkout D, services S (the selected ones,
or every compose service when `services` is null):

1. **record** (existing). It prints `OD-PREV`. New in this step: for each
   service in S that has a container, read the image ID with
   `docker inspect -f '{{.Image}}' <cid>` (container id from
   `docker compose ps -a -q <svc>`), tag it `<pinrepo>:rel-<R12>`, and print
   `OD-SNAP <svc> <imageId|none>`. This happens before fetch, checkout or
   build, so it records what is really running even when the tree has drifted
   from the deploy tag.
2. fetch, checkout, env, build, up, health: unchanged.
3. **tag** (existing `taskTag`, which moves the git deploy tag). Then, new:
   **pin**. For each service in S, tag the image ID of its new container as
   `<pinrepo>:<sha12>`, where sha12 is the `OD-HEAD` commit. Append a line to
   the host pin log and print `OD-PIN <svc> <sha12> <imageId>`. Then prune
   (section 8).
4. **Rollback of R** (manual, auto, or after a failed or cancelled release).
   `rb_probe` checks for `<pinrepo>:rel-<R12>` for every service the run
   touched, and decides the mode (section 6). In image mode, `rb_retag` tags
   each snapshot back to the service's compose image name, then `rb_up` runs
   `up -d --no-deps --no-build [services]`. `rb_env` and `rb_health` run as
   they do today. `rb_tag` moves the git deploy tag to the restored commit, as
   today.

## 5. What gets tagged, and what it is called

### 5.1 Names (controller's call)

`<pinrepo>` = `opsdeck.pin/<project>/<service>`, where `<project>` is the
compose project name (`composeProject`, or the default compose derives from
the directory, resolved once by `docker compose config --format json` →
`.name`). Tags are `rel-<first 12 of the release uuid>` (snapshots) and
`<first 12 of the commit sha>` (pins).

- The first component has a dot, so docker reads it as a registry host. An
  accidental `docker push` cannot reach Docker Hub; it fails to resolve
  `opsdeck.pin`.
- Project and service names are already validated (`dVars`). The generator
  lowercases them and checks them against docker's reference grammar. A name
  that cannot be a reference (rare: compose service names allow characters
  docker repo names do not) turns pinning off for that service. It prints
  `OD-PIN <svc> - - skipped=name`, and that service falls back.
- The pin log is `$HOME/.opsdeck/pins/<project>.log`, next to the existing
  `$HOME/.opsdeck/runs/`. One line per pin or snapshot: time, kind
  (`snap|pin`), service, tag, image ID, release ID. It is host-local, so it
  does not matter which desktop or Hub made the pin (section 11).

### 5.2 `build:` services vs `image:` services

Both work the same way, because we pin the running container's **image ID**,
never a name:

- `build:` without `image:`. Compose names the image `<project>-<service>`.
  `rb_retag` retags to that name. The name comes from the same
  `docker compose config --format json` (`services.<svc>.image` when set,
  otherwise the compose default). Retagging, not an override file, is the
  controller's call: after a rollback, a person on the host who types
  `docker compose up` gets what CredOps restored, not the failed build.
- `build:` with `image: registry/app:tag`. Retag to `registry/app:tag`.
- `image:` only (for example `nginx:1.25`, `redis:7`). Nothing is built, but a
  release can still change it, for example by editing the tag in the compose
  file. The snapshot holds the old image ID, so `rb_retag` makes `nginx:1.25`
  (or the old commit's name, see below) point at it, and `up --no-build` does
  not pull because the reference exists locally. We also store `RepoDigests[0]`
  when there is one. It is only for display and the drift check (the drift
  spec); it is never needed to restore.

**Compose file changed between the commits.** If the old commit's compose file
names a different image (`nginx:1.24`) from the current one (`nginx:1.25`),
retagging the current name would be wrong. The probe compares the compose
inputs (section 6), and any difference forces **mode B** (checkout without
build). There, `up` runs against the old compose file, and `rb_retag` targets
the name *that* file resolves.

### 5.3 Multi-service checkouts and selections

- `services: [a, b]` (a selection). Snapshot, pin, retag and up touch only a
  and b. `up` keeps `--no-deps`, as `composeTask` does today.
- `services: null` (whole checkout). The service list comes from
  `docker compose config --services` at record time, the same call preflight
  already makes for `checkComposeServices`.
- A service that had no container before R (new in R, or stopped) gets
  `OD-SNAP <svc> none`. Its deployment cannot use image mode for that service,
  and the probe falls back for the **whole deployment** (controller's call: a
  half-image, half-rebuild deployment doubles the paths to test for a rare
  case).

### 5.4 Monorepo shared checkouts

Several deployments can share one git root (the lock already keys on the root,
and `sharedRepoChecks` warns about it). Images are per compose project and
service, not per checkout, so pinning is unaffected. The win is on rollback:

- Mode A (image, same compose inputs) does **not** touch the tree. Rolling
  back deployment D1 leaves the shared root where it is, so D2's next deploy
  and anyone reading the host see no surprise detach.
- In modes B and C, the checkout moves, exactly as today. The confirm dialog
  names the siblings it will move (`PrepareShared` already computes them).
- After mode A, the tree on disk is at the failed commit while the containers
  run the snapshot. `deployment_runs.deployed_commit` for the rollback run is
  the restored commit, as today, and the run gets `tree_left_at = <failed sha>`.
  The next release fetches and checks out anyway. The drift check (separate
  spec) reports this as "tree ahead of running", not as drift. Whether mode A
  should still detach a tree that is *not* shared is Q2.

## 6. Rollback modes and the probe

`rb_probe` is the first task of each host's rollback play. It runs as the
connection user and uses `dockerCommand` for docker. Per deployment it prints
one line:

```
OD-RB <runId> mode=<image|checkout-image|build> reason=<ok|missing:<svc>|compose-changed|no-snapshot|name|daemon>
```

Its output sets the Ansible fact `od_rb_mode[<runId>]`. Ansible facts cannot
be set from shell, so the probe task registers stdout and a following
`set_fact` parses the marker, the same pattern as the existing prepare gate.

| Mode | When | Tasks run |
|---|---|---|
| **A `image`** | every touched service has `rel-<R12>` (or, for a manual rollback to an older commit, `<sha12>`) **and** the compose inputs are identical at the running tree's HEAD and the target commit | rb_env, rb_retag, rb_up --no-build, rb_health, rb_tag. **No** rb_checkout, **no** rb_build, no fetch needed |
| **B `checkout-image`** | images all present, compose inputs differ | rb_checkout (local commit, no fetch unless missing), rb_env, rb_retag (to names resolved from the checked-out compose), rb_up --no-build, rb_health, rb_tag |
| **C `build`** | any image missing, a snapshot of `none`, a name that cannot be pinned, or the probe cannot reach the daemon that took the snapshot | today's path, unchanged |

**Compose inputs** means: the compose file(s) given by `composeFile`, every
file they `include:` or `extends:`, and every `env_file:` path they name,
compared with `git diff --quiet <target> HEAD -- <paths>`. The path list comes
from `docker compose config --format json` at record time and goes in the pin
log entry, so the probe does not need to parse YAML. A `git diff` that fails
(target commit not local) counts as "changed", which means mode B, which
fetches as today. **The `.env` is not a compose input**: it is handled by
rb_env in every mode.

User steps in `before_build` and `after_build` are skipped in modes A and B,
because no build runs. They are build hooks, and running them without a build
would be surprising (controller's call; Q3 asks whether anyone relies on them
running during a rollback). `after_checkout` runs in mode B only.

`rb_retag` per service: `docker tag <pinrepo>:<tag> <composeImageName>`. Then
it checks with `docker image inspect --format '{{.Id}}' <composeImageName>`
that the ID matches the snapshot ID, and prints
`OD-RB <runId> retag <svc> ok|failed`. If any retag fails, the deployment
fails before `up`, so no container is recreated on a half-retagged set, and
the run is reported as rollback-failed with the reason.

## 7. The `.env` interplay

Nothing about `.env` handling changes; the order matters:

- rb_env still restores `.env.opsdeck-prev` only when `.env.opsdeck-rel`
  equals `od.env_rel | default(od.rel)`. It runs before `rb_up` in every mode,
  so the restored image starts with the restored `.env`.
- Build-time values (`args:`, and a `.env` read by the Dockerfile) are baked
  into the snapshot. That is more faithful than today: a rebuild during a
  rollback reads whatever `.env` is on disk at that moment.
- Pinning by commit (`<sha12>`) does not capture the `.env`. A manual rollback
  to an older commit gets that commit's image with the `.env` rb_env restores,
  which is the previous release's `.env` (the same as today). The rollback
  dialog keeps its existing note that only one `.env` generation is kept.

## 8. Disk use and pruning

- **What a pin costs.** A tag costs nothing by itself. It keeps an image from
  becoming dangling, so its layers stay. Layers shared between versions (base
  image, dependencies) count once. Realistically, each extra kept version
  costs only the layers that changed, often tens to hundreds of MB, and
  occasionally a full image.
- **Retention (controller's call).** Keep per service the last `pin_keep`
  (default 3) distinct `<sha12>` pins and the last `pin_keep` `rel-*`
  snapshots, ordered by the host pin log, plus anything a running container
  uses. Prune at the end of the `pin` builtin, for this deployment's services
  only, with `docker rmi <pinrepo>:<tag>`. On a tagged reference this only
  removes the tag, and docker frees the layers once nothing else holds them.
  It never runs `-f`, so an image a container uses is never removed. Pruning
  is best effort and prints `OD-PIN <svc> pruned=<n> failed=<n>`. A prune
  failure never fails a release.
- **The host log orders the pins, not the DB.** The desktop DB and the Hub DB
  each see only their own releases. Pruning from the deployer's DB would
  delete pins another actor relies on.
- **Range.** `pin_keep` is an environment setting from 1 to 10. 0 turns
  pinning off: no snapshot, no pin, and every rollback takes mode C.
- **Preflight.** The existing disk check (`avail_kb`, `DISK_WARN_KB` = 2 GB)
  stays. A new warn-only check (`pins`) prints how many pins exist for the
  selected services and their combined unique size
  (`docker system df -v` is too slow; sum `docker image inspect --format
  '{{.Size}}'` and label it as an upper bound). (builder's call)
- **Other prunes.** The builtin `prune-images` runbook (`docker image prune -f
  [--filter until=Nh]`) removes only dangling images, so pins survive it. A
  person running `docker image prune -a` or `docker system prune -a` on the
  host removes unused pins. The next rollback then takes mode C and says
  `missing:<svc>`. The runbook catalog gets a `prune-pins` builtin (keep N)
  for people who want to clear disk deliberately. (builder's call: phase 4)

## 9. Docker sudo modes

`docker` vs `sudo docker` vs `sudo -S docker` (the `plain | sudo |
sudo-password` ladder that preflight walks, picked by `useSudo` auto/yes/no)
all reach **the same daemon** in a normal install. Image tags belong to the
daemon, so pins made in one mode can be used in another.

The exception is rootless docker or a second context: the connection user's
rootless daemon and root's daemon have separate image stores. To cover it:

- The snapshot prints the daemon ID (`docker info --format '{{.ID}}'`), and the
  pin log records it.
- `rb_probe` compares it with the daemon it reaches now. A mismatch means
  mode C with `reason=daemon`.
- All new docker calls go through `dockerCommand` with the same `{sudo}` as
  `composeTask` for that deployment, so a release never snapshots in one
  daemon and builds in another.

## 10. Edited playbooks

`playbook-validate.ts` keeps generated lock, secret and gate tasks
byte-identical, and a rollback is always generated (`ROLLBACK_GENERATED_NOTE`).
So:

- **Rollback playbooks** are never edited, so probe, retag and mode logic are
  always present.
- **The snapshot task** joins the protected set (controller's call). It is the
  only thing that makes a rollback of *this* release instant, and removing it
  saves nothing. An edit that changes it is refused with "the image snapshot
  is generated; it keeps the old images for rollback".
- **The pin task** is not protected. An edit may delete or change it (for
  example, someone who does not want pins on a particular run). The validator
  warns: "Without the image pin, rolling back to this commit later will
  rebuild." A missing pin only affects G4 (older commits). The snapshot still
  covers rolling back this release.
- The golden fixtures (`tests/main/fixtures/playbook-golden/*.json`) all change
  and are regenerated with `UPDATE_GOLDEN=1`. A new `rollback-image` golden
  covers the probe, retag and `when:` gates.

## 11. Data model

### 11.1 Desktop migration 16 (`src/main/db/migrations.ts`)

```sql
CREATE TABLE image_pins(
  id TEXT PRIMARY KEY,                 -- uuidv7
  host_id TEXT NOT NULL,
  compose_project TEXT NOT NULL,
  service TEXT NOT NULL,               -- compose service name
  kind TEXT NOT NULL CHECK (kind IN ('snap','pin')),
  tag TEXT NOT NULL,                   -- 'rel-<12>' or '<sha12>'
  commit_sha TEXT,                     -- full sha when known
  image_id TEXT,                       -- sha256:…; NULL for a 'none' snapshot
  repo_digest TEXT,
  daemon_id TEXT,
  release_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pruned_at TEXT                       -- set when a later OD-PIN pruned= names it (best effort)
);
CREATE INDEX image_pins_lookup ON image_pins(host_id, compose_project, service, created_at);
ALTER TABLE deployment_runs ADD COLUMN rollback_mode TEXT;   -- image | checkout-image | build | NULL
ALTER TABLE deployment_runs ADD COLUMN tree_left_at TEXT;
ALTER TABLE environments ADD COLUMN pin_keep INTEGER;          -- NULL = default 3; 0 = off
```

`image_pins` is a **cache for the UI** ("instant rollback available"), filled
from markers by `events.ts`. The host is the source of truth: `rb_probe`
decides every time. A stale row can mislabel the dialog, but it can never
cause a wrong rollback.

### 11.2 Hub migration 12 (`hub/src/db.ts`)

The same `image_pins` table and the same two `deployment_runs` columns.
`pin_keep` goes into the `playbook_ops` JSON column of `environments` (the
same place as `flow`/`parallelPrepare`), so it needs no environment column.

### 11.3 Shared types (`src/shared/deploy.ts`)

- `EnvDeploySettings.pinKeep: number | null`.
- `PlanDeployment.rollbackImage?: { tag: string }` (the `rel-…` or sha tag a
  rollback restores).
- `RunOutcome.rollbackModes?: Record<runId, RollbackMode>`.
- `StepKind` gains `'pin' | 'rb_probe' | 'rb_retag'`, and `STEP_LABEL` gains
  "Pin images", "Check kept images", "Restore images". Both must change
  together, as noted in the file.
- The manifest gets an optional `environment.pinKeep`. It is absent when
  default, so a manifest without it hashes exactly as before (the pattern
  `toHubIntegrations` uses for `waitMinutes`).

## 12. UI

- **Release detail, per run:** a badge "Rollback: instant (image kept)" or
  "Rollback: rebuild", taken from `image_pins`. After a rollback, the run shows
  its mode and reason, for example "Rebuilt: image for `api` was pruned".
- **Rollback confirm dialog** (`rollback()`, and the protected typed-name
  confirm): a per-deployment table with the expected mode, the services and
  "will move shared checkout: D2, D3" for modes B and C. It is labelled
  *expected*, because the probe decides on the host.
- **Manual rollback to an older release** (G4): the release history marks
  releases whose commits still have pins on every host as "instant".
- **Environment deploy settings:** "Keep images for rollback: [3]" (0 = off),
  next to auto-rollback and parallel prepare. Help text says what it costs in
  disk.
- **Preflight panel:** the `pins` check from section 8 (warn only).
- **Failed prepare and cancel text:** "Old images restored" replaces "builds
  that finished already replaced the old images" when every `OD-RESTORE`
  reported `images=ok`.

## 13. Failure modes and safety

| Failure | Behaviour |
|---|---|
| Snapshot fails (docker down at record) | `OD-SNAP <svc> none err=…`. The release continues (today's behaviour), and its rollback takes mode C. It is warn only, so a release is never blocked by a missing pin |
| Pin or prune fails after a successful up | Best effort, like `OD-TAG failed rc=`. The release succeeds with a warning event |
| Retag succeeds, `up` fails | The same as today's `rb_up` failure: the rollback run fails and `unrolled` names it. The compose name now points at the snapshot, which is the state we wanted anyway |
| Snapshot image was removed between probe and retag | `docker tag` fails, the deployment fails before `up`, and the message says to retry the rollback (the probe will choose mode C) |
| Concurrent release on the same host | Already excluded by the per-git-root lock `.opsdeck-deploy.lock`. Pins are per project and service, and the prune keeps anything a running container uses |
| Two checkouts with the same compose project name on one host | They would share `<pinrepo>`. Preflight already resolves the project name. A new preflight check, `pin-project-clash`, blocks pinning (warn, fall back) when two deployments on a host resolve the same project (builder's call) |
| A pin tag pushed by mistake | `opsdeck.pin/…` resolves to no registry, so the push fails |
| The image ID matches but the image was rebuilt under the same sha (same commit, different base) | The `<sha12>` tag points at the latest build of that commit, and the pin log keeps the older ID. `rel-*` snapshots are by release, so G1 is unaffected |
| Desktop crashes mid-rollback | The existing interrupted-run handling (commit 0d2c7e4) applies. Retag is idempotent, so a retry is safe |

Secrets: no new secret enters the playbook. Image IDs, tags and compose paths
are not secret. `docker compose config --format json` *resolves* variables,
which can include `.env` values. **Only `.name`, `.services.*.image` and the
file paths are extracted on the host, with `jq` or a Python one-liner, and
never printed whole** (controller's call). The generator's existing marker
redaction stays in place as a backstop.

## 14. Open questions for the user

- **Q1. Default retention.** Is `pin_keep = 3` per service right, or do you
  want it per environment class (for example 5 for prod, 1 for dev)?
- **Q2. Mode A and an unshared tree.** When the checkout is not shared, should
  an instant rollback still `git checkout --detach` the old commit, so the
  tree on disk matches what is running? This costs about a second, but needs a
  clean tree and brings back the dirty-tree failure. Recommendation: no; leave
  the tree and record `tree_left_at`.
- **Q3. Build hooks during an instant rollback.** Do any of your environments
  rely on `before_build`/`after_build` user steps running during a rollback?
  The design skips them when nothing is built.
- **Q4. Services added by the failed release.** A rollback leaves them running
  (today's behaviour). Should an image rollback stop containers for services
  that had no snapshot (`OD-SNAP none`) instead of falling back to a rebuild?
- **Q5. Turn on for existing environments by default?** It is safe because
  everything falls back, but it uses disk on hosts that may be tight.

## 15. Test plan

- **Generator unit tests (`tests/main`).** Snapshot and pin task text for
  `services: null` and a selection; `dockerCommand` under plain, sudo and
  auto; validation of the reference grammar; `pin_keep=0` emits nothing.
- **Golden fixtures.** Regenerate all of them, and add `rollback-image` and
  `release-pin-off`.
- **Marker test.** The existing sweep must find `SNAP`, `PIN` and `RB` in
  `MARK`. Add parse tests for every `reason=`.
- **events.ts.** `OD-SNAP`/`OD-PIN` → `image_pins` rows, and `OD-RB` →
  `rollback_mode`. A `none` snapshot creates no row with an image ID.
- **release-service.** `rollback()` fills `rollbackImage`; the confirm text
  shows the expected modes; `prepareFailed` text changes when restore reports
  `images=ok`; `autoRollback` uses the same path.
- **playbook-validate.** Editing the snapshot is refused; deleting pin gives a
  warning; rollback playbooks are still generated only.
- **Local integration (opt-in, a local docker only, never a remote host).** A
  scripted compose project on the developer's machine through the
  `local-runner`: release v1 → release v2 that fails health → auto-rollback →
  assert the container image ID equals v1's ID and that no `build` ran (watch
  `docker events`). Cases: mode B (compose file changed), mode C (pin deleted
  by hand), shared checkout untouched in mode A.
- **Hub.** Migration 12 test; the Hub release path writes `image_pins`; root
  `vitest run` must include the Hub suite (the decoupling spec, step 0).

## 16. Rollout and compatibility

- **Old releases** (made before this feature) have no `rel-*` snapshot, so the
  probe takes mode C. That is today's behaviour, labelled "rebuild".
- **Old desktop rolling back a release a new version made.** Old generator,
  so checkout+build. The extra tags are inert.
- **New desktop rolling back a release made by the Hub (or the other way
  round).** The probe looks at the host, not the DB, so it works across
  actors. Only the "instant" badge may be missing for releases this client
  did not run.
- **Mixed Hub and desktop on the same host.** Both prune by the host log,
  which neither owns, so neither deletes pins that are less than N back.
- **Hub capability.** `HubMeta.capabilities.imagePins: true`. A desktop does
  not publish a non-default `pinKeep` to a Hub without it, which avoids a
  silent drop. The publish error copies `HUB_TOO_OLD_MESSAGE`.
- **Feature flag.** None needed beyond `pin_keep=0`.

## 17. Current rollback weaknesses this removes

1. **A rebuild on every rollback** (slow, can fail, not reproducible) → mode A
   and mode B do not build.
2. **Finished builds overwrite old images during a failed parallel prepare**
   → `taskPrepRestore` retags the snapshots (G8), so the host is back on the
   old images with no rollback run.
3. **Rollback moves shared monorepo trees** → mode A never touches the tree.
4. **Rollback needs origin and the previous commit from `git ls-remote`.** The
   "unrolled: previous commit unknown" case happens when ls-remote failed at
   record. → The snapshot does not need to know the commit. It captures
   whatever was running, so a rollback can work even when `OD-PREV unknown`.
   `rb_tag` is skipped in that case, as today.
5. **Deploy tag lagging after `OD-TAG failed`** → the snapshot does not depend
   on the deploy tag. The `rel-*` tag is tied to the release, not to the
   remote tag.
6. **Rollback build timeouts** (`buildTimeoutSec`) → no build.
7. **Dirty tree blocks a rollback** → mode A does not check out.

What stays: database and volume state (use `backup`), only one `.env`
generation, and orphan services (Q4).

## 18. Phases

| Phase | Scope | Rough effort |
|---|---|---|
| **P1 Snapshot + instant rollback of the last release** | `dockerCommand`; snapshot in record; `rb_probe`/`rb_retag`; modes A/C (B treated as C); markers; migration 16 (`rollback_mode` only); goldens; local integration test | 4–5 days |
| **P2 Failed prepare and cancel restore images** | `taskPrepRestore` retag; `prepareFailed`/`cancelledText` text | 1–2 days |
| **P3 Commit pins, retention, mode B** | `pin` builtin; host pin log; prune; compose-input diff and mode B; `image_pins` table; `pin_keep` setting and UI | 4–5 days |
| **P4 UI and Hub** | rollback dialog modes, history "instant" badges, preflight `pins` check, Hub migration 12 and capability, manifest field, `prune-pins` runbook | 3–4 days |

P1 alone removes weaknesses 1, 3, 5, 6 and 7 for the most common case
(auto-rollback of the release that just failed).
