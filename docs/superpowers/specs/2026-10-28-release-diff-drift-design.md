# CredOps — Pre-release diff and drift check

Date: 2026-10-28. Extends `2026-10-16-opsdeck-design.md` (preflight, releases)
and `2026-10-28-image-pinned-rollback-design.md` (image pins, which give the
image half of the drift check). Calls marked "(controller's call)" were made
when this spec was written; "(builder's call)" are left to whoever plans the
build. Open questions are in section 12.

Design only: nothing here is built yet.

## 1. Intent

Preflight already answers "can this release run?" (tools, docker ladder, repo,
clean tree, fetch, compose services, disk, locks). It already lists the commits
to deploy (`OD-PF commits log_b64=…`, `PreflightReport.commits`,
`serviceCommits`). It does not answer two questions people ask before pressing
Deploy on a protected environment:

1. **What else changes besides code?** Which `.env` keys are added or removed,
   and which compose services are added, removed or changed in definition.
2. **Is the host what CredOps thinks it is?** Has someone hand-edited the
   `.env`, run `git pull` or `docker compose up` on the host, or left the tree on
   another commit since the last CredOps release? If so, the release will
   overwrite that, and a rollback will restore a state nobody recorded.

This spec adds both to preflight. Keys are shown by name only; values are never
shown. Drift is shown per host and deployment.

## 2. Goals

- **G1.** The preflight report gains an "What changes" section: commits (as
  today), `.env` keys added and removed, and compose services added, removed or
  changed.
- **G2.** A **drift** list per deployment compares what the host has now with
  what CredOps last recorded: tree HEAD, running image per service, compose
  config hash per service, `.env` fingerprint and `.env` release marker.
- **G3.** No secret value leaves the host or the vault, and none is stored. Only
  key names, and salted fingerprints that are never persisted, are used.
- **G4.** Read-only. The new preflight tasks write nothing on the host except a
  temporary directory under `$HOME/.opsdeck/tmp/<rel>`, which is removed in the
  same task.
- **G5.** Drift warns on normal environments. On protected environments it
  blocks until someone acknowledges it, and the acknowledgement is audited and
  bound to the review hash.
- **G6.** It works the same on the Hub (same generator, same events parser).

## 3. Non-goals

- Showing `.env` values or value diffs. "Changed value" detection is Q1 and is
  out of scope for v1.
- Fixing drift. CredOps reports it; the release itself (or a rollback) is the
  fix.
- Continuous drift monitoring or a background poller. This runs only as part
  of preflight (Q4 asks about an on-demand "Check drift" runbook).
- A full YAML diff of compose files. Compose files can hold inline secrets, so
  only service names, image references and config hashes are compared.

## 4. How it fits today's engine

| Piece | Today | Added |
|---|---|---|
| `generate.ts` `preflightTasks` | checks tools, docker, docker-become, repo, clean, fetch/branch, compose, disk, tag, deps, version-tag, commits | three new `pf(d, …)` checks: `env-keys`, `compose-diff`, `drift` |
| `markers.ts` `parsePfLine` | `OD-PF <check> …` | the same line shape; new check ids, key/value fields only |
| `events.ts` `parsePreflight` | builds `PreflightReport` | fills `envKeys`, `composeDiff`, `drift` |
| `src/shared/deploy.ts` `PreflightReport` | checks, commits, dockerModes, composeServices, serviceCommits, locks, checkouts, blocked | adds `envKeys`, `composeDiff`, `drift` (section 6) |
| `release-service.ts` `start()` | guard → confirmProtected → assertCurrent → skips → review hash → releasePlan | `assertDriftAcknowledged` after `confirmProtected`; the acknowledgement goes into `reviewHash` |
| `recordDeployedRuns` → `services.recordDeployed` | stores deployed commit per service | also stores the `.env` fingerprint salt and hash, and the per-service config hash at release end |

The existing `clean` check (dirty tree) stays as it is. Drift reports
different things, because a clean tree can still be on the wrong commit.

## 5. What each check does on the host

All commands are generated through the existing helpers. They use
`composeCommand`/`dockerCommand` with the deployment's sudo mode, and user
values are passed base64-encoded or validated (`dVars`), as every preflight
task is today.

### 5.1 `env-keys`

- **Host side.** If the managed `.env` exists, print the names of lines matching
  `^[A-Za-z_][A-Za-z0-9_]*=` (anything after `=` is cut by `sed` before it
  leaves the process), plus a count of lines that do not match:
  `OD-PF env-keys keys_b64=<base64 of newline-joined names> other=<n>`. With no
  file: `OD-PF env-keys none`.
- **Desktop side.** The new key set is the key list of the deployment's
  `envTemplate` (`parseEnvTemplate` already gives keys and secret ids without
  decrypting anything). The report gets `{added: [...], removed: [...],
  unmanaged: n}`. Deployments without `managedEnv` show "not managed by
  CredOps".
- **Not done in v1:** "same key, new value". Doing it needs the vault unlocked
  at preflight, which preflight avoids today (Q1).

### 5.2 `compose-diff`

Compose has a built-in per-service fingerprint: `docker compose config --hash
'*'` prints `<service> <hash>`, the same hash compose stores on containers as
the `com.docker.compose.config-hash` label and uses to decide whether to
recreate them. (Compose v2.13+; older versions print `unknown`.)

- In a temporary directory, extract the compose inputs at two commits with
  `git archive <commit> -- <paths> | tar -x`: the **deployed commit** (the
  deploy tag's commit, `tagCommit`) and the **target** (`origin/<branch>`, or
  `expectOriginHead`). Paths are the compose file plus the
  `include`/`extends`/`env_file` paths resolved by `config --format json` at
  HEAD, the same list the image-pinned rollback spec records.
- In each tree run `config --hash '*' --env-file /dev/null`, with empty
  placeholder files for any missing `env_file`. This ignores `.env` on purpose:
  the env is diffed by key in 5.1, and the diff should show structural changes
  only.
- Print `OD-PF compose-diff old_b64=<svc hash…> new_b64=<svc hash…>`. The
  desktop reports `added`, `removed`, `changed` (hash differs) and also lists
  which services the release will actually recreate (changed ∩ selected).
- No compose text and no `config` output beyond names and hashes leaves the
  host (controller's call; see section 8).

### 5.3 `drift`

One line per deployment with these fields; each is `ok`, `drift`, or `unknown`.

| Field | Host reads | Compared with (desktop/Hub DB) |
|---|---|---|
| `head` | `git rev-parse HEAD` of the checkout | the last `deployed_commit` of the deployment (or the rollback's restored commit) |
| `tag` | already in preflight (`tagCommit` on origin) | the same `deployed_commit`. A mismatch means someone else moved the deploy tag, or `OD-TAG failed` |
| `config` (per service) | the container label `com.docker.compose.config-hash` | `config --hash` of the current tree **with** the current `.env`, which is exactly "would compose recreate this if I ran up now?" |
| `image` (per service) | the running container's image ID | the last `OD-PIN` image ID from `image_pins` (needs image-pinned rollback P3; `unknown` until then) |
| `env` | `sha256(salt ‖ .env)` with a per-deployment salt sent in the plan | the hash recorded at the last release, computed on the desktop from the rendered content with the same salt |
| `env_rel` | the contents of `.env.opsdeck-rel` | the last release that wrote the `.env` |
| `orphans` | `docker compose ps -a --format '{{.Service}}'` minus `config --services` | none recorded: listed for information |

Printed as `OD-PF drift <field>=<state>[:<detail>] …`. A detail is a short sha,
a service name or a count, never content. `tree_left_at` (from the image-pinned
rollback spec) explains a `head` mismatch after an instant rollback, and the
report labels it "tree ahead of running (instant rollback)" rather than drift.

## 6. Data model

**Migration numbers.** This spec needs desktop migration n+1 and Hub migration
m+1 after whatever has shipped. If image pins ship first, they are desktop 17
and Hub 13. The numbers are assigned at build time.

Desktop:

```sql
ALTER TABLE deployments ADD COLUMN env_salt TEXT;          -- 16 random bytes hex, created on first need, not secret
ALTER TABLE deployment_runs ADD COLUMN env_hash TEXT;      -- sha256(salt ‖ rendered .env), set when the env step wrote it
ALTER TABLE deployment_runs ADD COLUMN config_hashes TEXT; -- JSON {service: hash}, read after up
```

Hub: the same two `deployment_runs` columns. The salt lives in the deployment
`meta` JSON. Desktop and Hub keep their own salt, so a hash recorded by one
cannot be checked by the other, and a release from the other actor reports
`env: unknown (last written by the Hub)`. This is acceptable for v1 (Q3).

Shared types (`src/shared/deploy.ts`):

```ts
interface PreflightReport {
  // …existing…
  envKeys?: Record<string /*deploymentId*/, { added: string[]; removed: string[]; unmanaged: number } | 'unmanaged' | null>
  composeDiff?: Record<string, { added: string[]; removed: string[]; changed: string[]; recreate: string[] } | null>
  drift?: Record<string, DriftItem[]>
}
type DriftItem = { field: 'head'|'tag'|'config'|'image'|'env'|'env_rel'|'orphans'; state: 'ok'|'drift'|'unknown'; service?: string; detail?: string }
```

All three fields are optional, so an old Hub's preflight report still parses on
a new desktop.

**Recording at release.** The `env` step already has the rendered content in
memory on the desktop (it base64-encodes it). Computing the salted hash there
adds no new secret handling. `config_hashes` come from a read-only task after
`up` (`docker inspect` label per service), printed as `OD-CFG <svc> <hash>`.
This is a new marker, so add it to `MARK`.

## 7. UI

- **Preflight panel:** a "What changes" card per deployment, with tabs:
  Commits (today's list), Config (`+ NEW_KEY`, `− OLD_KEY`, "3 lines not
  CredOps-managed"), Services (added, removed, changed, and "will recreate").
- **Drift banner** at the top of preflight when any item is `drift`, for
  example: "2 hosts differ from what CredOps recorded", expandable per host:
  "app-1 / api: running image differs from last release (sha 1a2b… vs 9f8e…)",
  "app-2 / web: .env edited outside CredOps".
- **Protected environment:** Deploy stays disabled until "I've reviewed the
  drift" is ticked. The tick is part of the confirm payload.
- **Release detail** keeps a copy of the drift and diff summary as it was at
  start, so a post-mortem can see what was overwritten.

## 8. Failure modes and safety

| Risk | Handling |
|---|---|
| A secret value leaks through key names | Only names matching the identifier regex are printed, and other lines are only counted. Names are not secret by policy. If a team treats them as secret, Q2 |
| `.env` brute-forced from its hash | The hash is salted, per deployment, and covers the whole file. A whole-file hash of a multi-key file is not practical to brute-force. Per-key hashes are deliberately not used |
| Compose file has inline secrets | Only `config --hash` output and service names leave the host, and the temp tree is removed in the same task (`trap … EXIT`) |
| Old compose (no `--hash`) | `compose-diff` and `config` drift become `unknown`, and the UI says "compose too old for config hashes" |
| `git archive` fails (commit not fetched) | `unknown`. Preflight already fetches, so this is rare |
| Slow on big monorepos | `git archive` with a path list extracts only the compose inputs. It runs once per checkout, not per service |
| Drift check itself fails | It is warn only and never blocks, even on protected environments: an `unknown` result does not need an acknowledgement |
| Stale acknowledgement | The acknowledgement is bound to the preflight release id and the review hash. A new preflight resets it |
| Edited playbooks | Preflight playbooks are not editable, so nothing changes in `playbook-validate.ts` |

## 9. Rollout and compatibility

- The new report fields are optional. An old desktop ignores them from a new
  Hub, and a new desktop shows "not available" for an old Hub.
  `HubMeta.capabilities.drift: true` tells the desktop whether to expect them.
- Deployments released before this feature have no `env_hash` or
  `config_hashes`. Their drift shows `unknown` until the next release, and the
  UI says "first check after upgrade".
- Protected-environment blocking is behind `EnvDeploySettings.driftGate:
  'warn' | 'acknowledge'`. The default is `acknowledge` for protected
  environments and `warn` otherwise. It travels as an optional manifest field
  and is not hashed when absent.

## 10. Test plan

- Generator tests: the new pf tasks for managed and unmanaged `.env`, a
  selection vs the whole checkout, and the sudo modes. The goldens
  `preflight.json` and `preflight-services.json` are regenerated.
- `parsePfLine`/`parsePreflight`: every field and state; malformed base64 →
  `unknown`; a names list with a non-identifier is rejected.
- Key diff unit tests from `parseEnvTemplate` output.
- `start()`: a protected environment with drift and no acknowledgement →
  `confirm_required`; with acknowledgement → proceeds, and the audit entry
  holds the drift summary; the review hash changes with the acknowledgement.
- Recording: `env_hash` equals `sha256(salt ‖ rendered)`, and the hash is never
  computed or logged without the salt.
- Redaction test: a fixture `.env` with values and a compose file with an inline
  password; assert that no value appears in `run_events`, the log tap or the
  report JSON.
- Local integration (local docker only): edit the `.env` and run `docker
  compose up` by hand between two releases → drift shows `env` and `config`.

## 11. Phases

| Phase | Scope | Effort |
|---|---|---|
| P1 | `env-keys` + UI Config tab | 1.5 days |
| P2 | `drift` head/tag/env/env_rel + recording + acknowledgement gate | 3 days |
| P3 | `compose-diff` + `config` drift (config hashes, `OD-CFG`) | 2–3 days |
| P4 | `image` drift (after image pins P3), Hub capability, orphans | 1–2 days |

## 12. Open questions for the user

- **Q1.** Do you want "value changed" for keys that exist on both sides? It
  needs the vault unlocked at preflight (preflight decrypts nothing today) and
  a per-key hash that is never stored. Recommendation: not in v1.
- **Q2.** Are `.env` key *names* acceptable to show to everyone who can run
  preflight, including Hub maintainers without secret access?
- **Q3.** When the Hub and desktops both deploy the same environment, is
  `env: unknown (written by the other side)` acceptable, or should the salt be
  per environment and published with the manifest so both can check?
- **Q4.** Should drift also be available on demand (a read-only "Check drift"
  runbook, with no release), or only inside preflight?
- **Q5.** On protected environments, should drift *block* (acknowledge) or only
  warn?
