# CredOps — Rolling and canary deploys with health gates

Date: 2026-10-28. Extends the playbook-ops work (release flow, `PlanFlow`,
parallel prepare; desktop migration 13) and
`2026-10-28-image-pinned-rollback-design.md`, which makes rolling back a
canary fast. Calls marked "(controller's call)" were made when this spec was
written; "(builder's call)" are left to whoever plans the build. Open
questions are in section 12.

Design only: nothing here is built yet.

## 1. Intent

A release today puts the new code on every host it targets in one go. With a
flow (`ReleaseFlow`), the order is by **service** (stage 0 brings up `api`
everywhere, stage 1 brings up `web` everywhere). It is never by **host**. A bad
build fails health on all hosts at once, and only then does auto-rollback
start.

A canary deploy brings the new code up on one host (or a fraction of hosts)
first, watches its health for a while, and continues to the rest only if it
stays healthy. If it does not, CredOps rolls back the hosts that already
switched and leaves the others on the old code. A rolling deploy is the same
thing with more waves (1 host, then 50%, then the rest).

## 2. Goals

- **G1. Waves by host.** An environment can define waves, for example
  `[1, "50%", "100%"]`. Each wave runs the whole flow (every stage) on its
  hosts before the next wave starts.
- **G2. Health gates between waves.** After a wave: the existing per-deployment
  health URLs (`urls`, `healthStatus`, `healthTimeoutSec`), then a **soak**
  (health re-checked every few seconds for N seconds), plus optional
  environment-level gate URLs (for example the load balancer). Every check
  must pass to continue.
- **G3. Act on a failed gate.** The default rolls back the hosts that went up
  in this and earlier waves and restores the hosts that were prepared but
  never went up. A **hold** option stops without rolling back, for
  investigation.
- **G4. Build once, up per wave.** All hosts still fetch, check out and build
  in the prepare play (in parallel with `plan.prepare`). Only `up` and health
  are split into waves, so later waves do not wait for builds.
- **G5. No new runner.** It is still one Ansible run, one release row, one lock
  per host, made of generated plays like today's `flowPlays`.
- **G6. Same on desktop and Hub.**

## 3. Non-goals

- Traffic shifting (weighted load balancers, header routing). CredOps does not
  own the load balancer. Gate URLs can point at one, but CredOps does not
  steer traffic.
- Metric-based gates (error rate, latency from Prometheus or Datadog). Gates
  are HTTP status checks. A team that wants metrics can expose a health URL
  that encodes them (Q5).
- Waves *within* a host (container-by-container rolling for `scale: n`
  services).
- A manual "pause between waves and wait for a click" in v1. It needs the run
  split into several Ansible invocations (phase 3; Q2).

## 4. How it fits today's engine

`flowPlays(plan, flow)` in `generate.ts` already builds a release as a list of
**phases**, one play each:

```
release prepare (all hosts: lock + everything before up; or the parallel prepare)
release stage 0 (hosts of stage 0's runs: up + health of its parts, or its step)
…
release stage k
release tag (all hosts: tag, after_tag)
```

Every play after the first opens with `flowGate(p, lastPlay)`. It fails the
remaining hosts unless each host's `od_stage` shows it finished its previous
play without `od_failed`. `onFailure` picks `linear + any_errors_fatal`
(stop-all) or `free` (continue-other-hosts).

Waves generalise the **middle** of that list. For waves W₀…Wₙ (sets of hosts):

```
release prepare                     (all hosts, unchanged)
wave 0 · stage 0 … stage k          (only runs whose host ∈ W₀)
wave 0 · gate                       (soak + gate URLs; sets od_wave_ok)
wave 1 · stage 0 … stage k          (runs on W₁; flowGate also requires wave 0's gate)
wave 1 · gate
…
release tag                         (all hosts: only if every wave passed)
release restore (on gate failure)   (hosts never brought up: return the tree and images)
```

- The `phases` array in `flowPlays` becomes `prepare + Σ_w (stages filtered to
  W_w + gate_w) + tag`. `blockAt(runId, stage)` is reused unchanged, and only
  the `ids` per phase are filtered by host. `lastPlay` and `flowGate` already
  handle hosts that sit out some plays (controller's call: no new gate
  mechanism, only a new phase kind).
- **An environment without a flow** gets an implicit one-stage flow ("all
  services, all URLs") when waves are on, so waves always go through
  `flowPlays`. The builder must check that the implicit flow produces the same
  per-host task order as `playFor` for a one-wave release (a golden test).
  (builder's call on whether `playFor` then becomes the one-wave special case.)
- **Parallel prepare** (`preparedPlays` / `prepareTasks`, `prepareSchedule`)
  is unchanged. It is the prepare play, and it already runs linear with
  `any_errors_fatal`.
- **Waves force stop-all inside a wave** (controller's call). Under
  `continue-other-hosts`, a host that fails in wave 0 would let its siblings
  finish wave 0. The gate then sees a failure and stops anyway. The effect is
  the same; stop-all is just quicker and simpler to explain.

### 4.1 The gate play

`wave <w> gate` runs on the wave's hosts plus, for desktop-side URLs,
`delegate_to: localhost`, as `taskHealth` already does for `mac` health.
Tasks:

1. `flowGate` (unchanged).
2. **Soak.** For each run in the wave and each of its health URLs, a curl loop
   (the same shell as `taskHealth`'s host loop) every `intervalSec` (default
   10) for `soakSec`. A miss counts. More than `maxMisses` (default 0) fails
   the task. It prints `OD-WAVE <w> soak <runId> ok|fail misses=<n>`.
3. **Gate URLs** (environment level, optional, validated with the same rule as
   health URLs: http(s), no credentials). Checked from the host
   (`from: host`) or from the desktop/Hub (`from: local`), with a status code
   and a timeout. It prints `OD-WAVE <w> url <i> ok|fail status=<code>`.
4. `set_fact od_stage` (the existing pattern), so the next wave's `flowGate`
   requires the gate.

`OD-WAVE` is a new marker, so add it to `MARK` in `markers.ts`.

### 4.2 Choosing hosts for a wave

At plan time on the desktop or Hub, deterministically:

- Hosts that have at least one non-skipped deployment in this release, ordered
  by: the **canary host(s)** pinned in settings first, then by region code (if
  hosts have regions), then by host label.
- A wave spec of `1`/`2` means that many hosts. `"50%"` means ceil(50% × the
  hosts that remain), with at least one. The last wave always takes what is
  left, even if the spec says less.
- Each host is in exactly one wave. All of a host's deployments go together,
  because the lock, shared checkouts and `.env` are per host (controller's
  call).
- A release with fewer hosts than waves collapses the empty waves, and a
  one-host release is just one wave (no gate overhead beyond the soak, which
  still runs).

The plan carries `plan.rollout = { waves: hostId[][], gate: {...},
onGateFail }`. The review hash covers it, because `reviewHash` hashes the
generated playbook.

## 5. When a gate fails

The Ansible run exits non-zero, and `runRelease` takes its fail branch as
today. What changes:

| Host state | Today's analogue | With waves |
|---|---|---|
| In a wave that went up (`reachedUp`) | `rollbackTargets` from `reachedUp` with prepare | Same: auto-rollback (`autoRollback`) if `onGateFail = 'rollback'`, **even when the environment's `autoRollback` is off** (controller's call: choosing canary means choosing this). It is fast with image pins (mode A) |
| Prepared, never up (later waves) | `prepareFailed` + `taskPrepRestore` | A `release restore` play runs `taskPrepRestore` on those hosts in the same playbook (checkout the deploy tag's commit, and with image pins, retag the snapshots). Nothing to roll back, because their containers never changed |
| `onGateFail = 'hold'` | none | No rollback. Hosts of failed waves keep running the new code. The release ends `failed` with a "held" note, and the user can roll back from the release page as today |

**Version tag.** `release tag` runs only after every wave passed, and the
version tag (`EnvDeploySettings.versioned`) is added only on success, as
today. A held release is never version-tagged.

**Git deploy tag.** It is moved in `release tag`, after all waves. Hosts of
wave 0 run the new commit while the deploy tag still names the old one until
the end. This is today's behaviour for a long release, and the record step of
the rollback uses the run row's `previousCommit`, not the tag.

**Cancel during a wave.** It is the existing cancel path. `cancelledText`
names the hosts that went up and those that did not. "Can be rolled back"
(commit ec18e9f) covers both.

## 6. Data model

Desktop migration (next free number; 16 if this ships first):

```sql
ALTER TABLE environments ADD COLUMN rollout TEXT;          -- JSON EnvRollout | NULL (all at once)
ALTER TABLE releases ADD COLUMN rollout TEXT;              -- JSON snapshot of the waves as planned
ALTER TABLE deployment_runs ADD COLUMN wave INTEGER;       -- NULL for releases without waves
```

Hub migration (next free number): `releases.rollout`, `deployment_runs.wave`.
The environment setting rides in `environments.playbook_ops` JSON next to
`flow`.

Shared types (`src/shared/deploy.ts`):

```ts
interface EnvRollout {
  waves: (number | `${number}%`)[]          // e.g. [1, '50%', '100%']; validated 1..20 entries
  canaryHostIds: string[]                    // pinned first; may be empty
  gate: { soakSec: number; intervalSec: number; maxMisses: number;
          urls: { url: string; status: number; timeoutSec: number; from: 'host' | 'local' }[] }
  onGateFail: 'rollback' | 'hold'
}
EnvDeploySettings.rollout: EnvRollout | null
PlanFlow (runner.ts) gains rollout?: { waves: string[][]; gate: …; onGateFail }   // hostIds
RunOutcome gains waves?: { reached: number; failedAt: number | null; reason: string | null }
```

The manifest gets an optional `environment.rollout`, absent when null so the
hash does not change. `HubMeta.capabilities.rollout: true`. A desktop refuses
to publish a rollout to a Hub without the capability, using the
`HUB_TOO_OLD_MESSAGE` pattern.

## 7. UI

- **Environment deploy settings → Release flow:** a new "Rollout" block. "All
  at once" (default) / "Canary then the rest" (waves `[1, '100%']`) / "Rolling"
  (custom waves). Canary host picker, soak duration, gate URLs, and "if the
  gate fails: roll back / hold".
- **Preflight / review:** a wave preview listing hosts per wave. The review
  hash covers it.
- **Live release view:** wave lanes. Each lane shows its hosts, then "Soaking
  1:20 / 3:00" with a health tick per URL, then passed/failed. A failed gate
  shows which URL failed and with what status.
- **Release history:** "Canary failed at wave 0 (api: 502); rolled back 1
  host; 3 hosts restored".

## 8. Failure modes and safety

| Risk | Handling |
|---|---|
| Canary host unreachable | The prepare play fails (as today) before anything goes up |
| Soak too short to catch the problem | User setting. Default 120 s for canary waves, 0 for later waves (Q3) |
| A gate URL served by the load balancer hits old hosts too | It is documented as "aggregate" health. Per-host health stays the deployment URLs |
| A desktop-side gate (`from: local`) on the Hub | Runs from the Hub machine (as `mac` health does). The UI labels it "from CredOps (this machine / the Hub)" |
| Long releases hold the host locks longer | The locks are held across all waves, as they are across stages today. A soak counts toward the 2 h stale-lock rule; settings validate that `Σ soak + timeouts < 90 min` (builder's call on the exact bound) |
| Edited playbooks | The gate play's `flowGate` and soak tasks join the protected set (`playbook-validate.ts`). Wave plays cannot be added or removed (the existing rule). An edit may change a stage's user steps but not wave membership |
| Rollback while waves exist | A rollback of a canary release is all at once (no waves) (controller's call: a rollback should be fast and complete) |
| Services skipped (`skipUnchanged`) | Hosts with nothing left to deploy are left out of waves, so a wave may shrink. Planning happens after skips |

## 9. Rollout and compatibility

- Off by default (`rollout = null`), and then the generated playbook is
  byte-identical to today. The golden fixtures must not change for
  environments without a rollout.
- Old desktops reading an environment row with `rollout` ignore the column. A
  Hub without the capability never receives it.
- Release rows with `rollout` NULL render as today.

## 10. Test plan

- Generator: waves × flow stages produce the expected play list. The implicit
  flow matches `playFor` for one wave. `flowGate` membership is correct when
  hosts sit out plays. New goldens: `release-canary`, `release-rolling-prepare`.
- Wave planning: canary pin first, percentages with ceil, collapsing empty
  waves, region ordering, skip interaction.
- events.ts: `OD-WAVE` parsing → `RunOutcome.waves`.
- release-service: a gate failure → rollback of reached-up runs with
  `autoRollback` off when `onGateFail=rollback`; hold → no rollback; the
  restore play reported; version tag only on full success.
- playbook-validate: the protected gate tasks; editing wave membership is
  refused.
- Local integration (local docker only): two "hosts" as two compose projects
  on localhost through `local-runner`. Wave 0's health URL returns 500 →
  assert wave 1 was never brought up and that its tree and images were
  restored.

## 11. Phases

| Phase | Scope | Effort |
|---|---|---|
| P1 | Wave planning, wave phases in `flowPlays`, gate play (soak + deployment URLs), `OD-WAVE`, fail → rollback/restore, settings UI (basic), goldens | 5–6 days |
| P2 | Environment gate URLs (`from: host/local`), live wave lanes UI, history text, Hub capability and migration | 3 days |
| P3 | Manual approval between waves: the run is split into one Ansible invocation per wave, the release status is `paused`, and locks are kept across invocations | 5+ days (depends on Q2) |

Image-pinned rollback P1 should land first, or alongside, because a canary
whose rollback rebuilds loses most of its value.

## 12. Open questions for the user

- **Q1.** Is the wave unit "host" right for you, or do you need waves by
  **region** (all of `eu-west` first)? Regions already exist on hosts. The
  design orders by region, but a "wave = region" mode is extra work.
- **Q2.** Do you need a **manual pause** ("canary is up, a human checks, then
  clicks Continue"), or are automatic soak gates enough for v1?
- **Q3.** Default soak for the canary wave: 2 minutes? 5?
- **Q4.** Should choosing canary **force** auto-rollback on a failed gate even
  when the environment has auto-rollback off? The design says yes, unless
  "hold" is chosen.
- **Q5.** Do you want metric gates (error rate from Prometheus or Datadog) on
  the roadmap, or is "expose it as a health URL" enough?
