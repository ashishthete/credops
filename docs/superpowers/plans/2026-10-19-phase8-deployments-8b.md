# OpsDeck Phase 8b: Release Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on 8a** (`2026-10-19-phase8-deployments.md`), and it is merged
after it. 8b is renderer only:
- **no migration**;
- **no new IPC channel**;
- no change to main other than adding palette command ids.

It uses exactly the 8a channels:
- `release:preflight`, `release:start`, `release:cancel`, `release:rollback`;
- `release:break-lock`, `release:discard`, `release:retry-version`;
- `release:list`, `release:get`, `release:events`, `release:active`;
- `deploy:tooling`;
- the events `deploy:event` and `release:state`.

**Goal:** Make releasing fun and calm instead of a nightmare:
- a release wizard with a live preflight checklist;
- an animated pipeline, with per-host lanes of step chips;
- a fast, virtualized live run log that you can follow, search and filter;
- release history with one-click rollback, cancel and break-lock;
- map attachments (via the Phase 6 seam), palette commands and a sidebar
  badge.

Every motion honours reduced motion.

**Architecture:**
- **`src/renderer/src/deploy/`** holds the state:
  - `releases.ts`: a release store, plus `startReleaseSync()` with a
    generation counter, like `tunnels/store.ts`;
  - `pipeline.ts`: a **pure** reducer that turns `RunEvent[]` into a
    `PipelineState`. It is the only interpreter of the event stream;
  - `log-buffer.ts`: a ring buffer with indexes by step and host;
  - `ansi.ts`: an SGR parser.
- **`src/renderer/src/pages/deployments/release/`** holds the views:
  - `ReleaseWizard`, `PreflightChecklist`, `CommitList`;
  - `Pipeline`, `StepChip`;
  - `LiveLog`;
  - `ReleaseHistory`, `ReleaseView`.
- **Rehydration.** When it opens, a run view loads `release:get` and then
  pages through `release:events(afterSeq)`. Live batches then append to it.
  Seq gaps trigger a refetch from the last seq, so a reload mid-run is
  lossless.

**Tech Stack:** Same as 8a. **No new dependencies.** The log virtualizer is
hand-rolled (fixed row height and absolute positioning). It uses
framer-motion 14 (`motion`, `AnimatePresence`, `LayoutGroup`, `layoutId`)
and lucide icons.

**Spec:** §8.4 (wizard, pipeline, live log, history, rollback), §5 (typed
confirmation), §10 (feel: springs, reduced motion) and the Phase 1 motion
rules in `ui/motion.ts`.

**Upstream:** Phase 6 map files (`src/renderer/src/map/*`) are consumed in
Task 6 only.

## Global Constraints

- **8a's Global Constraints hold.** The renderer never sees a secret value.
  Log lines arrive already redacted, and the UI re-renders them as text,
  never as HTML.
- **Commands:** as in 8a:
  - `./node_modules/.bin/vitest run`;
  - the two `tsc` runs;
  - eslint is absent, so skip it unless it exists after the rebase.
- **Motion:**
  - every transform and animated `opacity` loop goes through
    `useMotionSafe()`;
  - with reduced motion, state is shown by icon, colour and text only:
    no shimmer, pulse, confetti, shake, flip or `layoutId` morph;
  - springs come from `ui/motion.ts` (`spring`, `fast`);
  - no animation runs longer than 600 ms, except the running shimmer, which
    is a loop.
- **Performance:**
  - the pipeline reducer is O(events);
  - the log keeps at most `LOG_CAP = 50000` lines in the renderer. The
    oldest are dropped, with a `(n earlier lines hidden)` header row;
  - rendering uses at most about 2 × the viewport of DOM rows;
  - events are applied in one `requestAnimationFrame` per batch.
- **Accessibility:**
  - chips are buttons with `aria-label` `"<step> on <host>: <state>"`;
  - the log is `role="log"` with `aria-live="off"`. A separate visually
    hidden live region announces only step state changes and the run
    result;
  - every action has a keyboard path.
- **Copy (status text):**
  - `Deploying to staging · 2 hosts · 3 deployments`;
  - `Released v1.5.0 to prod in 4m 12s`;
  - `Rolled back: health check failed on app1`;
  - `ana@mbp is deploying v1.5.0 since 10:42`.

  No exclamation marks in error text.

## Review Focus

1. **Event replay equals live.** Feeding a release's events in one batch, or
   one at a time, or with a reload in the middle produces the same
   `PipelineState`. *Pinned:* the Task 1 test `replay equals live, including
   after a seq gap refetch`.
2. **Protected confirmation** appears for start, rollback and break-lock,
   and the typed value is sent to main. Main's enforcement is pinned in 8a.
   *Pinned:* the Task 2 test `protected start requires typing the
   environment name`.
3. **Reduced motion.** With `useReducedMotion → true`, no element in the
   pipeline has a transform or animation style, and the states remain
   distinguishable by text. *Pinned:* the Task 3 test `reduced motion shows
   state by icon and text only`.
4. **The log stays fast and correct.** Following pauses on scroll-up, the
   pill counts new lines, and filters and search operate over 50k lines.
   *Pinned:* the Task 4 tests.

## File map

```
src/renderer/src/deploy/releases.ts            release store, sync, rehydrate (T1)
src/renderer/src/deploy/pipeline.ts            pure RunEvent → PipelineState reducer (T1)
src/renderer/src/deploy/log-buffer.ts          ring buffer + indexes (T4)
src/renderer/src/deploy/ansi.ts                SGR → spans (T4)
src/renderer/src/pages/deployments/release/ReleaseWizard.tsx      (T2)
src/renderer/src/pages/deployments/release/PreflightChecklist.tsx (T2)
src/renderer/src/pages/deployments/release/CommitList.tsx         (T2)
src/renderer/src/pages/deployments/release/Pipeline.tsx           (T3)
src/renderer/src/pages/deployments/release/StepChip.tsx           (T3)
src/renderer/src/pages/deployments/release/Celebrate.tsx          (T3)
src/renderer/src/pages/deployments/release/LiveLog.tsx            (T4)
src/renderer/src/pages/deployments/release/ReleaseView.tsx        (T3, T5)
src/renderer/src/pages/deployments/release/ReleaseHistory.tsx     (T5)
src/renderer/src/pages/deployments/DeploymentsPage.tsx            Release button, history tab (T2, T5)
src/renderer/src/map/*                                            attachments (T6, Phase 6 files)
src/renderer/src/deploy/commands.ts                               palette commands (T6)
src/renderer/src/shell/Sidebar.tsx                                running badge (T6)
tests/renderer/fixtures/release-events.ts                         event fixtures (T1)
```

---

### Task 1: The release store, sync and the pure pipeline reducer

**Files:**
- Create:
  - `src/renderer/src/deploy/releases.ts`;
  - `src/renderer/src/deploy/pipeline.ts`;
  - `tests/renderer/fixtures/release-events.ts`.
- Test:
  - `tests/renderer/deploy-pipeline.test.ts` (new);
  - `tests/renderer/deploy-releases.test.ts` (new).

**Interfaces:**
- `pipeline.ts`:
  ```ts
  interface ChipState { stepId: string; kind: StepKind; label: string; state: StepState | 'rolled_back'; startedAt: number | null; durationMs: number | null; error: string | null }
  interface Lane { hostId: string; hostLabel: string; lock: ChipState | null; deployments: { runId: string; name: string; status: DeploymentRunStatus; chips: ChipState[]; previousCommit: string | null; deployedCommit: string | null }[]; unlock: ChipState | null }
  interface PipelineState { releaseId: string; status: ReleaseStatus; lanes: Lane[]; release: ChipState[] /* version, finalize_* */; rollback: { active: boolean; runIds: string[]; ok: boolean | null }; version: { from: string | null; to: string | null }; lockBusy: { hostId: string; text: string; stale: boolean }[]; lastSeq: number; gap: boolean; result: { status: string; error?: string } | null }
  function initialPipeline(detail: ReleaseDetail): PipelineState   // lanes pre-filled with 'pending' chips from detail.runs and their planned steps
  function reducePipeline(s: PipelineState, events: RunEvent[]): PipelineState
  function etaMs(s: PipelineState, history: Record<StepKind, number[]>, now: number): number | null   // median past duration per remaining step
  ```
  - **Rollback.** `rollback.started` marks the chips of the listed runs that
    succeeded as `rolled_back`, which drives the reverse un-fill animation.
  - **Gaps.** A seq jump sets `gap: true`, and the store refetches.
  - **Logs.** `log` events are ignored here; Task 4 owns them.
- `releases.ts`:
  - `releaseStore`, which is
    `{ byId: Record<id, ReleaseSummary>; active: string[]; pipelines: Record<id, PipelineState>; history: Record<envId, ReleaseSummary[]> }`;
  - `startReleaseSync()`, which subscribes to `deploy:event` and
    `release:state`, and loads `release:active` at start;
  - `openRelease(id)`, which loads `release:get`, then
    `release:events(0, 5000)` in pages, and builds the pipeline;
  - `closeRelease(id)`;
  - `onLogEvents(id, fn)`, a fan-out to Task 4.

  Events for releases that aren't open only update `byId` and `active`.

- [ ] **Step 1: Write the failing tests**

`deploy-pipeline.test.ts`:
- `fixture ok run ends with every chip ok and result succeeded`;
- `health failure marks the chip failed with error and later chips stay pending`;
- `auto-rollback marks earlier chips rolled_back and rollback ok`;
- `lock.busy is surfaced with holder text`;
- `replay equals live, including after a seq gap refetch`. This compares
  three things: one batch, single events, and a split with a gap followed by
  a refetch;
- `etaMs uses the median of history`.

`deploy-releases.test.ts`, with `mockBridge` and `emitBridgeEvent`:
- `open rehydrates from get + paged events`;
- `live batch appends`;
- `seq gap triggers refetch from lastSeq`;
- `release:state updates active list`;
- `stale generation ignores late results`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/renderer/deploy-pipeline.test.ts tests/renderer/deploy-releases.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** The reducer is pure and doesn't mutate its
  input. Use `structuredClone` only on the lanes that changed.

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy-ui): release store, event sync and pipeline reducer`

---

### Task 2: The release wizard with a live preflight checklist and commits

**Files:**
- Create:
  - `release/ReleaseWizard.tsx`;
  - `release/PreflightChecklist.tsx`;
  - `release/CommitList.tsx`.
- Modify: `DeploymentsPage.tsx`, which gets a **Release** button (`mod+enter`
  on the page) and a per-card `Release this`.
- Test: `tests/renderer/release-wizard.test.tsx` (new).

**Interfaces:**
- `ReleaseWizard({ environmentId, preselect?: string[], onClose })`. It is a
  `Dialog` with three steps on one shared surface.
- **1. Choose:**
  - deployment checkboxes grouped by host, all selected by default;
  - for versioned envs, a bump segmented control `patch | minor | major`
    (default `minor`) with a live preview `v1.4.0 → v1.5.0`, which flips
    when motion is safe;
  - option toggles: backup DB, and notify and QA, which are disabled with
    the tooltip `Available with notifications (Phase 9)` until Phase 9
    registers them;
  - a `releaseNotes` slot: `<ReleaseNotesSlot release={…} />`. It renders
    nothing by default. Phase 9 replaces it through a registry
    (`registerReleaseNotesEditor(component)`), and the value is passed to
    `release:preflight`.
- **2. Preflight.** It calls `release:preflight`, then streams
  `preflight.check` events into `PreflightChecklist`.
  - **Rows** appear one by one with a stagger (motion-safe). Each has a
    spinner, then an icon: ok (check), warn (amber triangle) or block (red
    octagon).
  - **Blockers** have inline fixes:
    - a dirty repo shows `Uncommitted changes on app1:/srv/esg`, with copy
      for the command `git -C <path> status` (text only; OpsDeck doesn't run
      it);
    - a busy lock shows the holder text, and **Break lock** when it is
      stale;
    - missing Ansible shows the install text;
    - an existing tag shows `Bump further`, which changes the bump and
      re-runs preflight.
  - **`CommitList`** is grouped by deployment and lists sha (7), subject,
    author and relative date. It shows a `n revert pairs hidden` toggle and
    `+n more` when truncated. A first deploy shows
    `First deploy: showing the latest 500 commits`.
  - **Zero commits** shows `Nothing new to deploy` with a secondary
    **Redeploy anyway** button.
- **3. Confirm:**
  - a summary: env colour bar, hosts, deployments, version and options;
  - a **protected** env uses `ConfirmDialog` `typeToConfirm={env.name}`;
  - **Start** calls `release:start(id, { typedName, redeploy })`.
  - Then the dialog **morphs into the pipeline**: the env header has a
    shared `layoutId` and the wizard surface becomes `ReleaseView`.
    `useMotionSafe()` turns this into a plain swap.
- Closing the wizard before Start calls `release:discard`.

- [ ] **Step 1: Write the failing tests**
  - `select deployments and bump; preview shows next version`;
  - `preflight rows stream in and block disables Start`;
  - `stale lock offers break-lock which needs the host label`;
  - `existing tag offers bump further and re-runs preflight`;
  - `revert pairs hidden toggle`;
  - `zero commits shows Redeploy anyway and sends redeploy: true`;
  - `protected start requires typing the environment name`. The exact value
    reaches `release:start`;
  - `closing before start discards`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/renderer/release-wizard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy-ui): release wizard with live preflight and commits`

---

### Task 3: The pipeline view

**Files:**
- Create:
  - `release/Pipeline.tsx`;
  - `release/StepChip.tsx`;
  - `release/Celebrate.tsx`;
  - `release/ReleaseView.tsx` (the shell).
- Test: `tests/renderer/pipeline-view.test.tsx` (new).

**Interfaces:**
- `ReleaseView({ releaseId })`:
  - **Header:** env, version badge, status, elapsed time and ETA, plus
    **Cancel** (when running) and **Rollback** (Task 5).
  - **Body:** `Pipeline`, with `LiveLog` below it (Task 4) in a resizable
    split.
  - **Failure:** the failed step's error and its last log lines show in a
    `FailurePanel` keyed by `stepId`. This is Phase 9's mount point for
    "Explain & fix" (`registerFailureAction(component)`), and it is empty by
    default.
- `Pipeline({ state, selected, onSelect })`:
  - one **lane per host**: a label with a lock chip, deployment groups of
    chips joined by **connector bars**, and an unlock chip at the end;
  - a **release row** below for the version and finalize chips;
  - lanes animate in with a stagger.
- `StepChip`, by state:
  - **pending:** muted outline;
  - **running:** a shimmer gradient sweep, a spinner icon and a ticking
    `0:12` timer;
  - **ok:** a check icon that pops with a spring scale of 0.6 → 1;
  - **warn:** amber with a triangle;
  - **failed:** red, which **shakes once** (`useShake`) and holds a soft
    glow;
  - **skipped:** a dashed outline;
  - **cancelled:** grey with a slash;
  - **rolled_back:** the fill reverses right to left in 300 ms, with an
    undo icon.

  The connector bar fills (`scaleX` 0 → 1) when the chip to its left
  finishes. Clicking a chip selects it and filters the log to that step.
  Pressing it again clears the filter.
- `Celebrate` plays on `run.finished succeeded`. It shows a short confetti
  burst (24 framer-motion particles, 600 ms) over the header, and the
  version badge flips `v1.4.0 → v1.5.0`. **Motion-safe only.**
- **Reduced motion.** Every state above is shown by icon, colour and text
  only. Timers still tick, because they are text.
- **Live region** announcements:
  - `Build on app1 started`;
  - `Health on app1 failed`;
  - `Release succeeded`.

- [ ] **Step 1: Write the failing tests**
  - `renders a lane per host with chips in step order`;
  - `chip states map to icons and aria-labels`;
  - `clicking a chip selects it and calls onSelect`;
  - `running chip shows a ticking timer on a fake clock`;
  - `failure shows FailurePanel with error and registered actions`;
  - `success shows Celebrate; reduced motion does not`;
  - `reduced motion shows state by icon and text only`: no `transform` or
    `animation` inline styles inside the pipeline;
  - `rollback marks chips rolled back`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/renderer/pipeline-view.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy-ui): animated pipeline with step chips and celebration`

---

### Task 4: The live run log

**Files:**
- Create:
  - `src/renderer/src/deploy/log-buffer.ts`;
  - `src/renderer/src/deploy/ansi.ts`;
  - `release/LiveLog.tsx`.
- Test:
  - `tests/renderer/log-buffer.test.ts` (new);
  - `tests/renderer/live-log.test.tsx` (new).

**Interfaces:**
- `class LogBuffer`:
  - `push(events: LogEvent[])`;
  - `size`;
  - `slice(from, to, filter)`;
  - `count(filter)`;
  - `search(query, filter): number[]`.

  It is a ring of `LOG_CAP`, indexed by `stepId` and `hostId`.
- `parseAnsi(line): { text: string; fg?: string; bold?: boolean }[]`. It
  handles SGR 0, 1, 22, 30–37, 39 and 90–97, and strips any other escape.
- `LiveLog({ releaseId, filter, onFilterChange })`:
  - **Rendering:** a fixed row height of 18 px and a mono font. The window
    holds only the visible rows plus 20 overscan.
  - **Follow mode** is on by default. Scrolling up pauses it and shows a
    floating **`Jump to live (+n)`** pill that springs in. Clicking the pill
    or pressing `End` resumes.
  - **Filters:** host, deployment and step chips, plus the chip selection
    from the pipeline.
  - **Search:** `mod+f` focuses it; matches are highlighted, and `n`/`N`
    (or `enter`/`shift+enter`) step through them.
  - **Rows:**
    - sticky step headers show the step label, the host and its state icon;
    - stderr and ansible lines are tinted;
    - a timestamps toggle;
    - `Copy visible` puts the visible lines on the clipboard, and
      `Download log` saves a `.log` through a Blob. The lines are already
      redacted.
  - **Empty state** before the first line: `Waiting for output…`, with a
    subtle pulse when motion is safe.

- [ ] **Step 1: Write the failing tests**

`log-buffer.test.ts`:
- `ring drops oldest past cap and reports hidden count`;
- `filters by step and host`;
- `search returns indexes`;
- `50k lines push + filter under 50 ms`. This is a perf guard with a
  generous bound.

`ansi.test`, inside `log-buffer.test.ts`:
- `colours and bold parsed, unknown escapes stripped`.

`live-log.test.tsx`:
- `renders only a window of rows`;
- `follows the tail; scroll up pauses and shows Jump to live (+n)`;
- `chip selection filters lines`;
- `search highlights and n/N moves`;
- `text is rendered as text, not HTML`. A line containing `<img onerror>`
  stays literal.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/renderer/log-buffer.test.ts tests/renderer/live-log.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy-ui): virtualized live run log with follow, filters and search`

---

### Task 5: History, run detail, rollback, cancel and break-lock UX

**Files:**
- Create: `release/ReleaseHistory.tsx`.
- Modify:
  - `release/ReleaseView.tsx`;
  - `DeploymentsPage.tsx`, which gets the tabs `Deployments | History` and
    a route `/deployments/release/:id`.
- Test: `tests/renderer/release-history.test.tsx` (new).

**Interfaces:**
- `ReleaseHistory({ environmentId })`:
  - a timeline list from `release:list`, paged with `before`;
  - each row shows the version badge, the kind (release, rollback or
    redeploy), the status icon, `triggered by`, the duration and the
    deployment count;
  - status filter chips;
  - clicking a row opens `ReleaseView` (the run is replayed from events);
  - the newest row shows **Rollback** when allowed.
- **Rollback** opens a confirm that lists what will be reverted:
  `esg-backend on app1: abc1234 → 9f8e7d6`. A protected environment needs
  the typed name. Confirming calls `release:rollback`, which navigates to
  the new release's view.
- **Cancel** shows the confirm `Cancel the release? Running steps are
  stopped and the lock is released.` After confirming, the chips show
  `cancelling…` until `run.finished`.
- **Retry tagging** appears when only `release:version` failed, and calls
  `release:retry-version`.
- **Break lock** appears from preflight or from a `lock.busy` banner. It
  needs the host label typed and calls `release:break-lock`.
- **View playbook** opens the stored secret-free playbook JSON from
  `release:get` in a read-only mono dialog.

- [ ] **Step 1: Write the failing tests**
  - `history lists releases with kind and status and pages`;
  - `rollback shows the commits to revert and needs typed name on protected`;
  - `rollback only offered on the newest release`;
  - `cancel confirm then cancelling state`;
  - `retry tagging shown only for version-only failure`;
  - `view playbook shows stored JSON`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/renderer/release-history.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy-ui): release history, rollback, cancel and break-lock`

---

### Task 6: Map attachments, palette commands, the sidebar badge and the roadmap

**Files:**
- Modify:
  - Phase 6 `src/renderer/src/map/graph.ts` (input and attachments),
    `layout.ts` (`ATTACH_H`), `nodes.tsx` (the attachment strip state) and
    `useMapGraph.ts` (feeding deployments and active releases);
  - `src/renderer/src/shell/Sidebar.tsx`;
  - `docs/superpowers/plans/2026-10-16-roadmap.md` (row 8 status).
- Create: `src/renderer/src/deploy/commands.ts`.
- Test:
  - `tests/renderer/map-graph.test.ts` (extended);
  - `tests/renderer/deploy-commands.test.tsx` (new).

**Interfaces:**
- **Map (Phase 6 seam):**
  - `MapAttachment` gains `state?: 'idle' | 'running' | 'failed'` and
    `href?: string`;
  - `buildGraph` input gains
    `attachments?: Record<placementKey /* `${envId}:${hostId}` */, MapAttachment[]>`;
  - `layout.ts`: `ATTACH_H = 20` when any host has attachments;
  - one attachment per deployment on that host in that environment, with
    `kind: 'deployment'` and label = deployment name;
  - a running release pulses the attachment (motion-safe) and links to its
    `ReleaseView`.

  If Phase 6 shipped different names, adapt them at merge. The contract is
  "attachments per host placement".
- **Palette:**
  - `Release <env>…` opens the wizard;
  - `Open running release` appears when one is active;
  - `Rollback latest release in <env>…`;
  - `Deployment history: <env>`.

  They are registered through `registerCommands`.
- **Sidebar:** the Deployments item shows a running badge (a pulsing dot
  when motion is safe, plus a count) while `active.length > 0`.
- **Roadmap:** mark row 8 as done after both plans have merged.

- [ ] **Step 1: Write the failing tests**
  - `buildGraph places deployment attachments on host placements and grows ATTACH_H`;
  - `running release sets attachment state running`;
  - `palette commands register and open the wizard / release view`;
  - `sidebar badge shows active release count`.

- [ ] **Step 2: Run them and watch them fail**

Run: `./node_modules/.bin/vitest run tests/renderer/map-graph.test.ts tests/renderer/deploy-commands.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(deploy-ui): map attachments, palette commands and running badge`

---

## Self-review notes

- **Coverage** (the feel brief):
  - the pipeline animation: T3;
  - the live log: T4;
  - the interactive wizard: T2;
  - history, rollback and cancel: T5;
  - the map: T6;
  - reduced motion is pinned in T3 and checked in T4 and T6.
- **8a contracts consumed:**
  - `RunEvent`, `ReleaseDetail`, `ReleaseSummary`, `PreflightReport`,
    `StepKind`, `STEP_LABEL`, `StepState` and `VersionBump`;
  - the `release:*` channels, plus `deploy:event` and `release:state`.

  8b introduces no new main-side types.
- **Phase 9 mount points:** `registerReleaseNotesEditor` (T2) and
  `registerFailureAction` (T3). Both render nothing by default.
