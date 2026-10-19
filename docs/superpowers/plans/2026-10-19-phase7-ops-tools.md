# OpsDeck Phase 7: Ops tools (containers, multi-host run, snippets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Goal:** Three operator tools on top of Phase 4's SSH. A **container view** lists a host's docker containers over an SSH exec (`docker ps`), shows logs (tail, then live follow), restarts, stops and starts them, and opens an exec shell into one as a terminal tab. A **multi-host run** sends one command or snippet to a picked set of hosts, a whole environment, or one role in an environment, with a concurrency limit, live per-host output, exit codes, a summary and a working cancel. **Snippets** are stored scripts with `{{variables}}` and tags, runnable from the palette, from the Run page, or typed into the active terminal.
- **Architecture:** Main owns every byte that goes to a host. A new `src/main/ops/` area holds the quoting module (the only place a command string is built), an `ExecLinks` pool that dials hosts with the Phase 4 `connectChain` and leases one connection per host context, a `RunManager` (targets, queue, concurrency, cancel, audit), a `ContainerService` (docker argv, JSON-line parsing, log follows) and a `SnippetStore` (migration 6). The renderer gets a new **Ops** section (`/ops`) with three tabs (Run, Containers, Snippets), stores fed by two new push events with batched output, and palette commands. Container exec reuses `SessionManager` with one new optional field on `ssh:open`.
- **Tech Stack:** what is already installed (Electron, React 19, TypeScript, ssh2, xterm, framer-motion, lucide-react, tailwind v4, vitest). **No new dependencies.**
- **Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md` G11 (container view), G12 (multi-host run), §4 Snippet entity, G9 (protected environments), G16 (audit), §5 anti-goals, §8.5 and §10 (feel).

## Commands for this worktree

`node_modules` is a symlink and `pnpm test` does not work here. Every verification step uses:

- Tests: `./node_modules/.bin/vitest run` (one file: `./node_modules/.bin/vitest run tests/main/<file>.test.ts`)
- Typecheck: `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json && ./node_modules/.bin/tsc --noEmit -p tsconfig.web.json`
- Lint: `./node_modules/.bin/eslint .` — **not installed** in this checkout (`.bin` has no eslint, and `package.json`'s `lint` script is just the typecheck). Run it only if `test -x ./node_modules/.bin/eslint`; otherwise the typecheck is the lint gate. Do not install it.
- If anything runs pnpm and it rewrites `pnpm-workspace.yaml`, restore it with `git checkout pnpm-workspace.yaml` before committing.

## Global Constraints

All Phase 1–5 constraints still hold: main owns SSH and secrets, renderer is UI only; typed IPC through `IpcContract` + `CHANNELS` + `VALIDATORS` and `EventContract` + `EVENTS` (both lists complete by construction); every store mutation calls `vault.assertUnlocked()`, writes in `inTransaction`, appends audit after COMMIT; error messages are lower-case-safe, name the field and never carry the value; migrations are append-only (never edit 1–5); stores take `{ db, audit, vault, now?, ids? }`; tests use the in-process ssh2 server on `127.0.0.1` only, never `~/.ssh`, `~/.ssh/known_hosts` or `SSH_AUTH_SOCK` (tests pass `env: {}` to auth and a tmp known_hosts path); no new dependencies; reduced motion honoured everywhere.

**Migration 6 (`snippets`), verbatim.** The number is fixed by controller ruling (Phase 6 none, Phase 7 = 6, Phase 8 = 7, Phase 9 = 8, Phase 10 = 9); never renumber it when merging other phase branches.

```sql
CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  script TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON array of TAG strings, sorted, unique
  variables TEXT NOT NULL DEFAULT '[]',   -- JSON array of { name, default } in first-use order
  destructive INTEGER NOT NULL DEFAULT 0, -- 1 = always needs the protected-env confirmation
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX snippets_label ON snippets (label COLLATE NOCASE);
```

Snippets are not vault-encrypted: they are scripts, not secrets. The editor says so ("Don't put secrets in a snippet; use a variable and type it at run time").

**Limits (all in `src/shared/ops.ts`):** `MAX_SNIPPETS 500`, `MAX_SCRIPT 16_384` chars, `MAX_DESCRIPTION 500`, `MAX_VARIABLES 16`, `VARIABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/`, `MAX_VARIABLE_VALUE 4096`, `MAX_COMMAND 16_384`, `MAX_RUN_TARGETS 100`, `DEFAULT_CONCURRENCY 4`, `MAX_CONCURRENCY 16`, `DEFAULT_RUN_TIMEOUT_SEC 600`, `MAX_RUN_TIMEOUT_SEC 3600`, `RUN_OUTPUT_CHARS 262_144` per host (ring, trimmed from the front, `truncated` flag), `MAX_RUNS_KEPT 20` (finished runs beyond that are dropped oldest-first), `MAX_ACTIVE_RUNS 4`, `OUTPUT_FLUSH_MS 50`, `OUTPUT_FLUSH_CHARS 32_768`, `LOG_TAIL_DEFAULT 200`, `LOG_TAIL_MAX 5000`, `MAX_LOG_FOLLOWS 8`, `LINK_IDLE_MS 30_000`, `MAX_LINKS 24`, `CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/`, `MAX_CONTAINERS 500`.

**Quoting rules (the security core; `src/main/ops/quote.ts`, pure, no imports from ssh):**

1. An SSH exec request carries one string that the remote login shell parses; there is no argv on the wire. So OpsDeck never splices untrusted text into a command. It builds a command in exactly two ways:
   - **argv** (docker, container exec): `shJoin(argv)` = `argv.map(shQuote).join(' ')`. Each element is one word on the remote side, whatever it contains.
   - **template** (snippets): the snippet's script is trusted text written by the user; only variable *values* are untrusted, and each value is substituted as one `shQuote`d word.
2. `shQuote(s)`: the empty string becomes `''`; returns `s` unchanged only when it matches `/^[A-Za-z0-9_@%+=:,./-]+$/`; otherwise `'` + `s.replaceAll("'", "'\\''")` + `'`. Values containing NUL or any C0/C1 control character other than tab and newline are rejected (`variable <name> has a control character`) — never stripped.
3. A placeholder is `{{name}}` with optional inner spaces (`{{ name }}`). `{{` not forming a valid placeholder is a template error, so there is no ambiguous text. `\{{` is not an escape (there is none in v1: write `{` `{` with a space between, or put it in a variable).
4. `parseTemplate(script)` scans with a small POSIX lexer that tracks: single quotes, double quotes, backslash escapes, `$'…'`, comments (`#` at word start to end of line), and here-documents. A placeholder is **allowed only in unquoted context** (including inside `$( … )` and backticks, at their own unquoted level). It is a template error when a placeholder sits inside `'…'`, `"…"`, `$'…'`, or after a backslash, with the message `{{name}} is inside quotes; remove them, OpsDeck quotes values itself`. A template that has placeholders **and** a here-document (`<<` or `<<-`, not `<<<`) is a template error (`a script with variables can't use a here-document`), because an unquoted-delimiter heredoc body expands `$( )` even inside single quotes. Placeholders inside comments are ignored (not substituted, not declared).
5. `renderTemplate(parsed, values)` replaces each placeholder with `shQuote(value)`; a missing value uses the declared default; a variable with neither is an error naming the variable. Concatenation like `--name={{n}}` stays safe because the quoted word joins its neighbours in unquoted context.
6. Free-text commands typed on the Run page are the user's own shell input, sent as-is (no rendering, no `{{}}` processing). They are length-checked (`MAX_COMMAND`) and NUL-checked only.
7. Snippets inserted into a terminal (`Insert into terminal`) go through the same `renderTemplate`; the rendered text is written to the session **without** a trailing newline, so the user presses Enter.
8. Container refs and log tails are validated (`CONTAINER_REF`, integers) **and** still passed through `shJoin`; validation is defence in depth, quoting is the guarantee.

**Targets and context.** A run target is `{ kind: 'hosts', hostIds: string[], environmentId?: string }` or `{ kind: 'environment', environmentId: string, role?: HostRole }`. Both resolve in main to an ordered, de-duplicated list of `{ hostId, environmentId | null, label }` with `resolveHost` (jump chain, identity, user per environment, exactly like sessions). A run has **at most one environment**; host-kind targets without `environmentId` run in the host's default context. Hosts that fail to resolve (deleted, no identity) become `failed` with `code: 'unknown'` and a message, not a thrown error, so one bad host never sinks a run.

**Protected-environment ruling (G9).** `confirmNeeded(env, targetCount, destructive)` in `src/main/ops/protect.ts`: when the run's environment is `protected` and (`targetCount > 1` **or** `destructive`), the request must carry `confirm` equal to the environment's name exactly (case-sensitive). `destructive` is true when the snippet has `destructive: 1`, or when the command (free text, or the rendered snippet) matches `DESTRUCTIVE_PATTERN` in `src/shared/ops.ts` (word-boundary matches of `rm`, `rmdir`, `mkfs`, `dd`, `shutdown`, `reboot`, `halt`, `poweroff`, `kill`, `pkill`, `killall`, `systemctl (stop|restart|disable|kill)`, `service \S+ (stop|restart)`, `docker (rm|rmi|stop|kill|restart|prune)`, `docker system prune`, `docker compose down`, `truncate`, `drop`, `>` redirect to `/dev/`). Container `stop` and `restart` in a protected environment are destructive; `start`, logs, list and exec are not. The check runs **in main**; the renderer only mirrors it to show the dialog (`ConfirmDialog` with `typeToConfirm` = environment name). A missing or wrong confirmation throws `Type the environment name to confirm`, and is audited with outcome `denied`. Hosts outside any environment are never protected.

**Run states.** Per host: `queued → connecting → running → ok | failed | cancelled | timeout`. `ok` = exit 0. `failed` = non-zero exit, a signal, or a dial/exec error (the `SessionError` code and message, via `describeError`). Run: `running → done | cancelled`. Exit code `null` when the host never ran or died by signal (signal name kept).

**Cancel.** `runs:cancel(runId)` marks every `queued` host `cancelled` without dialing, aborts every `connecting` dial (its prompts cancelled via the broker group), and for `running` hosts calls `stream.signal('INT')`, then closes the channel after 2 s if it hasn't exited; those hosts end `cancelled` with whatever exit code arrived, else `null`. Cancel is idempotent and resolves when the run is `cancelled`. `runs:cancel` on a finished run is a no-op.

**Lock policy (same spirit as Phase 4/5).** Starting a run, a container action, a log follow, a snippet mutation, or `ssh:open` with a container needs an unlocked vault (`Unlock the vault first`). On lock: hosts still `queued` or `connecting` end `cancelled` with `code: 'locked'`; hosts already `running` finish (like ready sessions); open log follows keep streaming; idle pooled links close; dials waiting on a prompt fail `locked`. A run never resumes on unlock. Wiring: `service.onLock(() => ops.vaultLocked())` between the tunnel and `prompts.cancelAll` listeners.

**Connections (`ExecLinks`).** One ssh2 client per `hostId|environmentId` context, dialled with the Phase 4 `connectChain`, `verifyWithStore` and the shared `PromptBroker` (prompt owner id = the run id, or `containers:<hostId>`). Leases are ref-counted; a link with no lease closes after `LINK_IDLE_MS`; at most `MAX_LINKS` links. A run's concurrency counts hosts, and each host opens one exec channel on its link. This is a separate, small dialer and does **not** refactor `TunnelManager`'s private `HostLink` (no Phase 5 churn, fewer merge conflicts); the duplication is about 60 lines and the review checks it mirrors the tunnel dial's lock handling.

**Secrets and output.** Run output and container logs never reach audit, the main log, or a toast. Toasts say counts and host labels only ("3 ok, 1 failed on db-2"). Error messages from a host's stderr shown in a container error (e.g. `permission denied … docker.sock`) are the first line, capped at 200 chars, passed through `redact()`. Variable **values** are never audited or logged; audit keeps variable **names**.

**Audit (new actions, appended to `AUDIT_ACTIONS`):** `snippet.create`, `snippet.update`, `snippet.delete`, `run.start`, `run.finish`, `container.start`, `container.stop`, `container.restart`, `container.exec`.
- `run.start` — `targetType: 'environment' | 'hosts'`, `targetLabel`: environment name or `"<n> hosts"`; `details`: `{ runId, hosts: [labels] (max 100), concurrency, timeoutSec, command }` where `command` is `{ kind: 'text', text: <first 1000 chars> }` or `{ kind: 'snippet', snippetId, label, variables: [names] }`, plus `confirmed: true` when a typed confirmation was given. Outcome `success`, or `denied` (confirmation missing/wrong, locked).
- `run.finish` — same target; `details: { runId, ok, failed, cancelled, timeout, results: [{ host: label, state, exitCode }] }`. Outcome `success` when every host is `ok`, `info` when cancelled, else `failure`.
- `container.*` — `targetType: 'container'`, `targetLabel: "<container name>@<host label>"`, `details: { hostId, environmentId, containerId (12 chars) }`, outcome `success`/`failure`/`denied`. `container.exec` is written when the exec tab opens; the session's own `ssh.open`/`ssh.close` stay as Phase 4 writes them, with `details.container` added.
- Never in audit: addresses, output, log lines, variable values, stderr text. The actor (OS user + machine) is added by `AuditLog` as always; the `AuditLog` redaction of known secrets still runs over `details.command.text`.
- List and logs are read-only and are **not** audited.

**Push events (new in `EventContract` and `EVENTS`):**
- `run:event` — `{ runId, kind: 'host', host: RunHostMeta } | { runId, kind: 'output', hostId, chunk } | { runId, kind: 'run', run: RunSummary }`; output chunks batched per host at `OUTPUT_FLUSH_MS` / `OUTPUT_FLUSH_CHARS` (stdout and stderr interleaved into one stream; stderr chunks carry `stream: 'err'` so the UI tints them).
- `containers:logs` — `{ followId, chunk } | { followId, ended: true, error: SessionError | null }`, same batching.

**IPC channels (new):** `snippets:list`, `snippets:create`, `snippets:update`, `snippets:delete`, `snippets:render` (returns rendered text for a terminal insert; vault-free since nothing is stored), `runs:start`, `runs:cancel`, `runs:list`, `runs:get` (summary plus each host's buffered output), `runs:dismiss`, `containers:list`, `containers:action` (`start | stop | restart`, optional `confirm`), `containers:logs` (tail, returns text), `containers:follow` (returns `followId`), `containers:unfollow`. `ssh:open`'s `OpenSshRequest` gains `container?: string` (validated by `CONTAINER_REF`).

**Container commands (exact argv, all through `shJoin`):**
- list: `['docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}']` — one JSON object per line; parse `ID, Names, Image, State, Status, Ports, CreatedAt, Labels`; compose project/service from labels `com.docker.compose.project` and `com.docker.compose.service`. Unparsable lines are skipped and counted (`skipped` on the result). More than `MAX_CONTAINERS` → truncated flag. No compose CLI call: grouping by labels covers `docker compose ps` without needing the compose plugin.
- action: `['docker', <start|stop|restart>, ref]`.
- logs: `['docker', 'logs', '--timestamps', '--tail', String(n), ref]`; follow adds `'--follow'`.
- exec tab: `['docker', 'exec', '-it', ref, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']` sent with `client.exec(cmd, { pty: { term: 'xterm-256color', cols, rows }, env }, cb)`.
- Errors: exit 127 or `command not found` → `Docker isn't installed on <label>`; `permission denied` with `docker.sock` → `Docker needs permission on <label> (add the user to the docker group)`; otherwise the redacted first stderr line.

**Feel.** Per-host status chips animate between states (layout spring, a pulsing dot while `connecting`/`running` using the existing `od-pulse` keyframe, a check/cross pop on finish); a summary bar fills as hosts finish; output panes stream in monospace with stderr tinted and auto-scroll that pauses when the user scrolls up (a "Jump to live" pill). The container list staggers in with `ListRow`, state badges cross-fade, actions show inline spinners, logs stream into a pane with the same auto-scroll. Animation never delays output: text is appended directly, only chrome animates. Under reduced motion: no pulse, no layout springs, opacity-only transitions.

**Shortcuts.** Ops is a sidebar section, so it gets the next `mod+<n>` (sections after it renumber; see Task 8). In the palette: "Run a command on hosts…", "Run snippet: <label>" (one per snippet), "Insert snippet into terminal: <label>" (only while a ready SSH tab is active), "New snippet", "Containers on <host>" (one per host). No new global key bindings.

## Review Focus

1. **Injection safety of the quoting module.** Every variable value, container ref and docker argument reaches the remote shell as exactly one word, and a placeholder can't sit in a context where quoting breaks. *Pinned:* `quote.test.ts` › "shQuote round-trips hostile values through a real sh", "rejects a placeholder inside single or double quotes", "rejects variables with a here-document", "rejects control characters in values"; `run-manager.test.ts` › "a hostile variable value reaches the server as one literal argument".
2. **Protected-environment confirmation is enforced in main.** Multi-host or destructive runs and container stop/restart in a protected environment are refused without the exact name, and the refusal is audited `denied`. *Pinned:* `run-manager.test.ts` › "a multi-host run in a protected environment needs the typed name", "a single destructive command in a protected environment needs the typed name"; `containers.test.ts` › "stop in a protected environment needs the typed name".
3. **Cancel and concurrency.** No more than `concurrency` hosts are ever connecting or running at once; cancel stops queued hosts without dialing and ends running ones. *Pinned:* `run-manager.test.ts` › "never exceeds the concurrency limit", "cancel skips queued hosts and interrupts running ones", "a host that hangs past the timeout ends as timeout".
4. **Audit carries what, where (label) and who, never output, values or addresses.** *Pinned:* `run-manager.test.ts` › "audits start and finish by host label without output or variable values"; `containers.test.ts` › "audits actions by container@host label".
5. **Vault lock.** Starting anything while locked throws; locking mid-run cancels queued and dialing hosts and lets running ones finish. *Pinned:* `run-manager.test.ts` › "locking cancels queued and dialing hosts but lets running ones finish"; `exec-links.test.ts` › "a dial waiting on a prompt fails as locked".

## File map

```
src/shared/ops.ts                         new: limits, types (SnippetMeta, RunRequest, RunSummary, RunHostMeta, ContainerMeta…), DESTRUCTIVE_PATTERN
src/shared/ipc.ts                         + snippets:*, runs:*, containers:* channels, run:event + containers:logs events, OpenSshRequest.container
src/shared/ssh.ts                         OpenSshRequest gains container?: string
src/shared/audit.ts                       + 9 actions
src/main/db/migrations.ts                 + migration 6 (snippets)
src/main/ops/quote.ts                     new: shQuote, shJoin, parseTemplate, renderTemplate
src/main/ops/protect.ts                   new: isDestructive, confirmNeeded, checkConfirm
src/main/ops/snippet-store.ts             new: SnippetStore (CRUD, tags, variables derived from script)
src/main/ops/exec-links.ts                new: ExecLinks pool (dial, lease, idle close, lock)
src/main/ops/exec.ts                      new: execOnce (one exec channel: stream, exit, signal, timeout, cancel)
src/main/ops/run-manager.ts               new: RunManager (targets, queue, events, cancel, audit, lock)
src/main/ops/containers.ts                new: ContainerService (list/parse, actions, logs, follows)
src/main/ipc/handlers/ops.ts              new: createOpsHandlers({ snippets, runs, containers })
src/main/ipc/validators.ts                + validators for every new channel; ssh:open container
src/main/ssh/sessions.ts                  openSsh with container: exec with pty instead of shell; label/audit detail
src/main/index.ts                         construct ExecLinks, RunManager, ContainerService, SnippetStore; lock + quit wiring; spread handlers
tests/main/ssh-server.ts                  + onExec option (exec requests, exit status, signals)
tests/main/ops-helpers.ts                 new: fake docker script handler, run-setup helper
tests/main/quote.test.ts                  new
tests/main/snippet-store.test.ts          new
tests/main/exec-links.test.ts             new
tests/main/run-manager.test.ts            new
tests/main/containers.test.ts             new
tests/main/ops-ipc.test.ts                new
tests/main/sessions.test.ts               + container exec tab cases
src/renderer/src/ops/snippets.ts          new: snippet store + actions
src/renderer/src/ops/runs.ts              new: run store, output buffers (separate high-frequency store), event seam
src/renderer/src/ops/containers.ts        new: container store, follow buffers, event seam
src/renderer/src/ops/commands.ts          new: useOpsCommands() palette commands
src/renderer/src/ops/template.ts          new: client-side placeholder listing for the form (display only)
src/renderer/src/ops/OutputPane.tsx       new: streaming monospace pane with stick-to-bottom + Jump to live
src/renderer/src/ops/HostChip.tsx         new: animated per-host status chip
src/renderer/src/pages/ops/OpsPage.tsx    new: tabs Run / Containers / Snippets (route /ops/:tab)
src/renderer/src/pages/ops/RunTab.tsx     new: target picker, command/snippet, variables, concurrency, chips, panes, summary, cancel
src/renderer/src/pages/ops/ContainersTab.tsx new: host picker, grouped list, actions, logs drawer, exec
src/renderer/src/pages/ops/SnippetsTab.tsx new: library, tag filter, editor dialog
src/renderer/src/pages/ops/SnippetDialog.tsx new: create/edit with live variable detection and template errors
src/renderer/src/pages/hosts/HostView.tsx + "Containers" and "Run" buttons linking to /ops
src/renderer/src/terminal/sessions.ts     openContainer(hostId, environmentId, ref, name)
src/renderer/src/shell/sections.ts        + ops section
src/renderer/src/shell/Sidebar.tsx        + ops icon, running-run badge
src/renderer/src/shell/AppShell.tsx       + /ops route, useOpsCommands, startOpsSync/reset
tests/renderer/helpers.tsx                + snippet / run / container fixtures
tests/renderer/ops-*.test.ts(x)           new (stores, commands, run tab, containers tab, snippets tab, output pane)
docs/superpowers/plans/2026-10-16-roadmap.md row 7 plan cell + Done
```

---

### Task 1: Shared ops contract, migration 6, audit actions

**Files:** create `src/shared/ops.ts`; modify `src/shared/ipc.ts`, `src/shared/ssh.ts`, `src/shared/audit.ts`, `src/main/db/migrations.ts`, `src/main/ipc/validators.ts`; tests `tests/main/db.test.ts`, `tests/main/validate.test.ts`, `tests/main/ipc.test.ts`.

**Interfaces (in `src/shared/ops.ts`):**

```ts
export interface SnippetVariable { name: string; default: string | null }
export interface SnippetMeta { id: string; label: string; script: string; description: string; tags: string[]; variables: SnippetVariable[]; destructive: boolean; createdAt: string; updatedAt: string }
export interface SnippetInput { label: string; script: string; description?: string; tags?: string[]; defaults?: Record<string, string | null>; destructive?: boolean }
export type RunTarget = { kind: 'hosts'; hostIds: string[]; environmentId?: string } | { kind: 'environment'; environmentId: string; role?: HostRole }
export type RunCommand = { kind: 'text'; text: string } | { kind: 'snippet'; snippetId: string; values: Record<string, string> }
export interface RunRequest { target: RunTarget; command: RunCommand; concurrency?: number; timeoutSec?: number; confirm?: string }
export type RunHostState = 'queued' | 'connecting' | 'running' | 'ok' | 'failed' | 'cancelled' | 'timeout'
export interface RunHostMeta { hostId: string; label: string; state: RunHostState; exitCode: number | null; signal: string | null; error: SessionError | null; startedAt: string | null; endedAt: string | null; truncated: boolean }
export interface RunSummary { id: string; state: 'running' | 'done' | 'cancelled'; title: string; environmentId: string | null; environmentName: string | null; concurrency: number; hosts: RunHostMeta[]; startedAt: string; endedAt: string | null }
export interface RunOutput { hostId: string; text: string; errRanges: [number, number][] }
export interface ContainerMeta { id: string; name: string; image: string; state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | 'removing' | 'unknown'; status: string; ports: string; createdAt: string; project: string | null; service: string | null }
export interface ContainerList { containers: ContainerMeta[]; truncated: boolean; skipped: number; fetchedAt: string }
export type ContainerAction = 'start' | 'stop' | 'restart'
```

plus every limit and `DESTRUCTIVE_PATTERN` from Global Constraints. Renderer-importable: constants and types only.

- [ ] **Step 1: Write the failing tests**
  - `db.test.ts` › "migration 6 creates snippets with a case-insensitive unique label" — fresh db reaches version 6; inserting `Deploy` then `deploy` violates the unique index; migration 5's tables are untouched.
  - `validate.test.ts` › "ops validators reject out-of-range concurrency, unknown target kinds and bad container refs" — `runs:start` with `concurrency: 0`, `17`, `target.kind: 'all'`; `containers:action` with ref `a b`, `-rm`, 129 chars; `ssh:open` with `container: '$(x)'`; each fails with a message naming the path and rule, never the value.
  - `validate.test.ts` › "ops validators accept a minimal valid request for every new channel".
  - `ipc.test.ts` existing `channelsAreComplete` / `eventsAreComplete` assertions pass with the new names (compile-time) and the runtime lists include them.
- [ ] **Step 2: Run them and watch them fail** — Run: `./node_modules/.bin/vitest run tests/main/db.test.ts tests/main/validate.test.ts tests/main/ipc.test.ts`. Expected: failures on version 6 and unknown channels.
- [ ] **Step 3: Implement** — append migration 6 verbatim; add the 9 audit actions; add the channels/events to `IpcContract`, `CHANNELS`, `EventContract`, `EVENTS`; add `container?: string` to `OpenSshRequest`; add `VALIDATORS` entries using `v.*` (`v.oneOf` for kinds/actions/roles, `v.int` with min/max for concurrency, timeout, tail; a `v.str` with `CONTAINER_REF` pattern; `values` as an object of strings with max `MAX_VARIABLES` keys, each value ≤ `MAX_VARIABLE_VALUE`). Main handlers come in Tasks 3, 5 and 6; until then `createOpsHandlers` returns a stub per new channel that throws `Not available yet`, so the handler map stays complete and type-correct. Task 6 removes the last stub.
- [ ] **Step 4: Run the full suite and typecheck** — `./node_modules/.bin/vitest run` then the typecheck pair. Expected: all green.
- [ ] **Step 5: Commit** — `feat(ops): shared ops contract, migration 6 snippets, audit actions`

### Task 2: Quoting and templates (`quote.ts`, `protect.ts`)

**Files:** create `src/main/ops/quote.ts`, `src/main/ops/protect.ts`; test `tests/main/quote.test.ts`.

**Interfaces:**

```ts
export function shQuote(s: string): string
export function shJoin(argv: readonly string[]): string
export interface ParsedTemplate { parts: ({ text: string } | { variable: string })[]; variables: string[] } // first-use order
export function parseTemplate(script: string): ParsedTemplate          // throws TemplateError with a user-facing message
export function renderTemplate(t: ParsedTemplate, values: Record<string, string>, defaults: Record<string, string | null>): string
export function checkValue(name: string, value: string): string        // control chars, length
// protect.ts
export function isDestructive(command: string, snippetFlag: boolean): boolean
export function confirmNeeded(env: { name: string; protected: boolean } | null, targetCount: number, destructive: boolean): string | null // the name to type, or null
export function checkConfirm(needed: string | null, given: string | undefined): void // throws 'Type the environment name to confirm'
```

- [ ] **Step 1: Write the failing tests** (`quote.test.ts`)
  - "shQuote leaves safe words alone and single-quotes everything else" — `abc`, `a/b.c`, `x=1`, `''` → `''`, `a b` → `'a b'`, `it's` → `'it'\''s'`.
  - "shQuote round-trips hostile values through a real sh" — for each of `` `id` ``, `$(id)`, `$HOME`, `a;b`, `a && b`, `' ; rm -rf / ; '`, `"\n"`, `*`, `~`, `-rf`, a 4096-char string, unicode: `execFileSync('/bin/sh', ['-c', 'printf %s ' + shQuote(v)])` returns exactly `v`. (Local `/bin/sh` only; no network.)
  - "shJoin keeps each argv element one word" — `sh -c 'for a in "$@"; do printf "[%s]" "$a"; done' _ <joined>` prints one bracket per element.
  - "parseTemplate finds variables in first-use order and ignores comments" — `echo {{a}} {{ b }} {{a}} # {{c}}` → `['a','b']`.
  - "rejects a placeholder inside single or double quotes" — `echo '{{a}}'`, `echo "x{{a}}"`, `echo $'{{a}}'`, `echo \{{a}}` each throw the quotes message naming `{{a}}`.
  - "allows placeholders inside command substitution" — `echo $(cat {{f}})`, `` echo `cat {{f}}` ``.
  - "rejects variables with a here-document" — `cat <<EOF\n{{a}}\nEOF` and `<<-X` throw; `cat <<< {{a}}` is fine; a heredoc with no variables is fine.
  - "rejects malformed placeholders and bad names" — `{{}}`, `{{A}}`, `{{1a}}`, `{{a-b}}`, `{{a}`, more than 16 variables.
  - "renderTemplate quotes values and uses defaults" — `ls {{dir}}` with `dir = "a b; rm x"` → `ls 'a b; rm x'`; default used when the value is missing; missing with no default throws naming the variable.
  - "rejects control characters in values" — `\u0000`, `\u001b[2J`, `\u0085` throw; tab and newline allowed.
  - "isDestructive matches the pattern list on word boundaries" — `rm -rf /tmp/x`, `sudo systemctl restart nginx`, `docker compose down`, `echo hi > /dev/sda` are destructive; `echo rmdir-like`, `ls -la`, `firmware`, `docker ps` are not; the snippet flag forces true.
  - "confirmNeeded: protected and multi-host or destructive" — truth table over protected × count 1/2 × destructive; unprotected or null env always null.
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/main/quote.test.ts`. Expected: module not found.
- [ ] **Step 3: Implement** — a single-pass lexer with a state stack (`top`, `single`, `double`, `dollarSingle`, `subshell`, `backtick`, `comment`); `$(` and backtick push a fresh unquoted level (so `"$(echo {{a}})"` is an error only because the outer level is `double`: keep it simple and say so in a code comment — placeholders inside a substitution inside double quotes are rejected). Heredoc detection: `<<` not followed by `<` in `top`/`subshell` state.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit** — `feat(ops): quoting rules and template parser with injection tests`

### Task 3: Snippet store and handlers

**Files:** create `src/main/ops/snippet-store.ts`, `src/main/ipc/handlers/ops.ts` (snippet part); test `tests/main/snippet-store.test.ts`; uses `tests/main/inventory-helpers.ts` (`makeInventory`).

**Interfaces:** `class SnippetStore { constructor(o: { db; audit; vault; now?; ids? }); list(): SnippetMeta[]; get(id): SnippetMeta; create(input: SnippetInput): SnippetMeta; update(id, input: SnippetInput): SnippetMeta; delete(id): void; render(id, values): string }`. `variables` are always derived from `parseTemplate(script)`; `defaults` keys not among them are dropped; defaults pass `checkValue`. Tags use the inventory `TAG` regex, `MAX_TAGS`, sorted unique lower-case. `render` needs no unlock (it reads a snippet and quotes values; nothing stored, nothing sent).

- [ ] **Step 1: Write the failing tests**
  - "creates a snippet with derived variables, sorted tags and defaults" — `systemctl status {{unit}}` with tags `['Ops','ops','svc']` → tags `['ops','svc']`, variables `[{ name: 'unit', default: null }]`.
  - "rejects a template error with its message and stores nothing".
  - "labels are unique ignoring case" — `Snippet label is already used`.
  - "update re-derives variables and keeps defaults for names that remain".
  - "mutations need an unlocked vault" — create/update/delete while locked throw `Unlock the vault first`; list and render still work.
  - "audits create, update and delete with the label and no script or defaults" — `auditRows(db)` last rows; `details` has `variables` (names) and `tags`, and `JSON.stringify(details)` contains neither the script nor a default value.
  - "enforces MAX_SNIPPETS, MAX_SCRIPT and MAX_DESCRIPTION" — messages name the field.
  - "render quotes values" — `render(id, { unit: 'a;b' })` → `systemctl status 'a;b'`.
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/main/snippet-store.test.ts`.
- [ ] **Step 3: Implement** — follow `TunnelStore`'s shape (row mapping, `inTransaction`, audit after COMMIT, error on unique violation mapped to the friendly message). Add `snippets:*` handlers to `createOpsHandlers`.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit** — `feat(ops): snippet store with derived variables and audit`

### Task 4: Exec over SSH: test server exec, `ExecLinks`, `execOnce`

**Files:** modify `tests/main/ssh-server.ts`; create `src/main/ops/exec-links.ts`, `src/main/ops/exec.ts`, `tests/main/ops-helpers.ts`; test `tests/main/exec-links.test.ts`.

**Test server addition:** `startServer({ …, onExec?: (command: string, channel: ServerChannel, info: { env: Record<string, string>; pty: { cols: number; rows: number } | null }) => void })`. `serveSessions` accepts `exec` requests when `onExec` is set (else rejects), records `server.execs: string[]`, and the helper `tests/main/ops-helpers.ts` exports `shellExec(opts)` — an `onExec` that runs the received command with the **local** `/bin/sh -c` in a tmp dir with a scrubbed env (`PATH` set to a tmp `bin/` holding a fake `docker` script plus `/usr/bin:/bin`), pipes stdout/stderr, sends `exit-status`, and kills the child on a channel `signal` or close. This exercises real remote-shell parsing of what OpsDeck sends while staying on localhost. The fake `docker` script logs its argv one per line to a file and answers `ps` / `logs` / `start|stop|restart` from fixture files.

**Interfaces:**

```ts
export interface ExecLinksDeps { resolve; hostInfo; connect: typeof connectChain; plan; knownHosts; prompts: PromptBroker; isLocked(): boolean; now?; timers? }
export class ExecLinks {
  lease(hostId: string, environmentId: string | null, owner: { id: string; group: Set<number> }, signal: AbortSignal): Promise<Lease> // Lease = { client: Client; label: string; envVars: Record<string,string>; release(): void }
  vaultLocked(): void   // fails dials, closes idle links
  closeAll(): void
}
export function execOnce(client: Client, command: string, o: { env?: Record<string, string>; pty?: PtyInfo; signal: AbortSignal; timeoutMs?: number; onData(chunk: string, stream: 'out' | 'err'): void }): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean }>
```

Dial errors are `SessionError`s from `describeError` with the failing hop label; a dial interrupted by lock or a prompt answered `locked` rejects with `code: 'locked'`.

- [ ] **Step 1: Write the failing tests** (`exec-links.test.ts`, setup mirrors `tunnels.test.ts`: tmp known_hosts with the server key trusted, password auth plan, real `connectChain`)
  - "runs a command and reports stdout, stderr and the exit code" — `printf out; printf err >&2; exit 3` → chunks tagged correctly, `exitCode 3`.
  - "reuses one connection for two leases on the same context and closes it after the idle delay" — `server.connections` is 1; with manual timers, after release + `LINK_IDLE_MS` the client closes.
  - "a different environment context is a different link".
  - "an unknown host key asks through the broker under the owner's group; rejecting fails the lease with host-key-unknown".
  - "a dial waiting on a prompt fails as locked" — lock during the prompt → rejects `locked`; no connection stays open.
  - "abort while dialing rejects and never leaks the client".
  - "execOnce timeout signals then closes and reports timedOut".
  - "execOnce abort sends INT then closes after 2 s" — the fake shell's child receives SIGINT (it writes a marker file on trap).
  - "env vars from the host reach the exec" — `printf %s "$FOO"`.
  - "MAX_LINKS refuses a new context with a clear message".
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/main/exec-links.test.ts`.
- [ ] **Step 3: Implement** — dial mirrors `TunnelManager`'s link dial (ConfigError for resolve/plan errors, `verifyWithStore` with `isLive`, `onLocked`, prompts through `ask` that maps `'locked'`), minus the tunnel-specific backoff. `execOnce` uses `client.exec(cmd, { env, pty }, cb)`, decodes with a `StringDecoder` per stream so UTF-8 never splits, listens for `exit` (code, signal) and `close`.
- [ ] **Step 4: Run the full suite and typecheck** — existing `ssh-server` users unchanged (no `onExec` → exec rejected as before).
- [ ] **Step 5: Commit** — `feat(ops): exec link pool and one-shot exec over ssh, test server exec`

### Task 5: `RunManager`

**Files:** create `src/main/ops/run-manager.ts`; extend `src/main/ipc/handlers/ops.ts` (runs part); test `tests/main/run-manager.test.ts`.

**Interfaces:**

```ts
export interface RunManagerDeps { links: Pick<ExecLinks, 'lease'>; snippets: Pick<SnippetStore, 'get'>; environments(): EnvironmentMeta[]; hosts(): HostMeta[]; isLocked(): boolean; audit: { append(i: AuditInput): unknown }; emit(event: 'run:event', payload: RunEvent): void; now?; ids?; timers? }
export class RunManager {
  start(req: RunRequest): RunSummary   // validates, resolves, checks confirmation, audits run.start, kicks the queue; returns immediately
  cancel(runId: string): Promise<RunSummary>
  list(): RunSummary[]                 // newest first
  get(runId: string): { run: RunSummary; output: RunOutput[] }
  dismiss(runId: string): void         // finished runs only
  vaultLocked(): void
  closeAll(): void                     // quit: cancel everything without audit noise beyond run.finish
}
```

Target resolution: `environment` → that environment's `hosts` (filtered by `role` when given), in label order; `hosts` → given order, de-duplicated; an empty result throws `No hosts match this target`; more than `MAX_RUN_TARGETS` throws. The run's `title` is the snippet label or the first line of text (≤ 60 chars).

- [ ] **Step 1: Write the failing tests** (`ops-helpers.ts` gets `makeRunSetup()` building inventory with 5 hosts all pointing at one test server on different labels, a protected env `prod` and an unprotected `staging`, roles app/db)
  - "runs on every host in an environment and reports per-host exit codes" — each host has env var `OD_HOST` set to its label and the command `test "$OD_HOST" != db-2`, so db-2 exits 1 and the rest exit 0; results match; `run:event` sequence per host is queued → connecting → running → ok|failed; final `run` event `done`.
  - "a role filter picks only that role's hosts".
  - "never exceeds the concurrency limit" — fake shell sleeps on a gate file; a counter in `onExec` tracks the max simultaneous execs = 2 with `concurrency: 2` across 5 hosts.
  - "streams output in batched chunks per host and caps buffered output at RUN_OUTPUT_CHARS" — `yes | head -c 400000` → `truncated: true`, buffer length = cap, emitted chunk count ≪ bytes.
  - "cancel skips queued hosts and interrupts running ones" — concurrency 1, 3 hosts, the first sleeps; cancel → host 1 `cancelled` (child got SIGINT), hosts 2–3 `cancelled` and `server.execs.length === 1`.
  - "a host that hangs past the timeout ends as timeout".
  - "a host that fails to resolve fails alone" — one host without an identity → `failed` with a message, others ok.
  - "a multi-host run in a protected environment needs the typed name" — without `confirm` throws, wrong case throws, `prod` passes; the refusal appends `run.start` `denied`.
  - "a single destructive command in a protected environment needs the typed name" — `rm -f x` on one prod host needs it; `uptime` does not; a snippet with `destructive: true` needs it.
  - "a hostile variable value reaches the server as one literal argument" — snippet `printf %s {{v}}` with value `` x; touch /tmp/pwned-<uuid> `id` `` → output equals the value literally; the marker file does not exist; `server.execs[0]` contains `'x; touch`.
  - "audits start and finish by host label without output or variable values" — `run.start` `details.hosts` are labels, no address string (`127.0.0.1`) anywhere in any row; `run.finish` results by label; no row contains the output text or the variable value.
  - "locking cancels queued and dialing hosts but lets running ones finish" — concurrency 1, 3 hosts, host 1 running on a gate; `vaultLocked()` → hosts 2–3 `cancelled` with `error.code 'locked'`; releasing the gate lets host 1 end `ok`.
  - "start while locked throws and audits denied".
  - "keeps only MAX_RUNS_KEPT finished runs and refuses a fifth active run".
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/main/run-manager.test.ts`.
- [ ] **Step 3: Implement** — a per-run queue; a worker loop starts the next queued host while `active < concurrency`; each host: lease (owner = run id, its own prompt group), `execOnce`, release in `finally`; output appended to a per-host ring and a per-host pending buffer flushed by one run-level timer (`OUTPUT_FLUSH_MS`, or immediately past `OUTPUT_FLUSH_CHARS`); host state changes emit immediately (after flushing that host's pending output, so text never arrives after its final state). `run.finish` once, when the last host settles.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit** — `feat(ops): multi-host run manager with concurrency, cancel, timeout and audit`

### Task 6: `ContainerService`, container exec tab, IPC wiring

**Files:** create `src/main/ops/containers.ts`; modify `src/main/ssh/sessions.ts`, `src/main/ipc/handlers/ops.ts`, `src/main/index.ts`; tests `tests/main/containers.test.ts`, `tests/main/sessions.test.ts`, `tests/main/ops-ipc.test.ts`.

**Interfaces:**

```ts
export class ContainerService {
  constructor(deps: { links: Pick<ExecLinks, 'lease'>; environments(): EnvironmentMeta[]; hostLabel(id: string): string; isLocked(): boolean; audit; emit(event: 'containers:logs', p: LogEvent): void; ids?; timers? })
  list(hostId: string, environmentId: string | null): Promise<ContainerList>
  action(hostId: string, environmentId: string | null, ref: string, action: ContainerAction, confirm?: string): Promise<void>
  logs(hostId: string, environmentId: string | null, ref: string, tail: number): Promise<string>     // capped at RUN_OUTPUT_CHARS, from the end
  follow(hostId: string, environmentId: string | null, ref: string, tail: number): Promise<string>   // followId
  unfollow(followId: string): void
  closeAll(): void
}
```

Every call (list, action, logs, follow) needs an unlocked vault; follows already open survive a lock. `SessionManager.openSsh({ …, container })`: after the chain is up, `client.exec(shJoin(EXEC_ARGV(ref)), { pty, env }, onShell)` instead of `client.shell`; label `"<ref>@<host label>"`; reconnect re-runs the same exec; `ssh.open` audit details gain `container: ref`; also appends `container.exec`.

- [ ] **Step 1: Write the failing tests**
  - `containers.test.ts` (fake `docker` via `shellExec`):
    - "lists containers from docker ps JSON lines with compose grouping" — fixture of 3 containers (two from compose project `shop`), one garbage line → `skipped: 1`, states mapped, project/service set; the fake docker's argv log shows exactly `ps --all --no-trunc --format {{json .}}`.
    - "reports a missing docker and a socket permission error in plain words" — fixture exit 127; fixture stderr `permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock`.
    - "start, stop and restart pass the ref as one argument" — argv log `stop`, `web-1`.
    - "stop in a protected environment needs the typed name" — and restart; start does not; refusal audited `denied`.
    - "audits actions by container@host label" — `targetLabel 'web-1@app-1'`, no address, outcome failure when docker exits non-zero.
    - "logs tail returns the last lines and follow streams until unfollow" — follow emits chunks, `unfollow` ends the exec (fake docker child killed), `ended` event sent once; `MAX_LOG_FOLLOWS` enforced.
    - "a follow survives a vault lock; a new list while locked throws".
  - `sessions.test.ts` › "opens a container exec tab with a pty and the quoted docker exec command" — `onExec` receives `docker exec -it web-1 sh -c 'command -v bash …'` and a pty of the requested size; tab label `web-1@<label>`; audit `container.exec` + `ssh.open` with `details.container`.
  - `sessions.test.ts` › "reconnecting a container tab runs the exec again".
  - `ops-ipc.test.ts` › "every ops channel is wired and validated" — through `registerHandlers` with the ipc test helpers: bad args rejected before the handler, a valid `snippets:list` returns `[]`, `runs:list` returns `[]`.
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/main/containers.test.ts tests/main/sessions.test.ts tests/main/ops-ipc.test.ts`.
- [ ] **Step 3: Implement** — container service on `ExecLinks` + `execOnce`; handlers complete (remove Task 1's `notImplemented` stubs); `index.ts` builds `ExecLinks` (same `resolve`, `hostInfo` with envVars, `connect`, `plan`, `knownHosts`, `prompts`, `isLocked`), `SnippetStore`, `RunManager`, `ContainerService`; lock listeners `service.onLock(() => runs.vaultLocked())`, `service.onLock(() => links.vaultLocked())` placed before `prompts.cancelAll`; before-quit: `runs.closeAll()`, `containers.closeAll()`, `links.closeAll()` after tunnels, before sessions.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit** — `feat(ops): container service, container exec tabs, ops ipc wiring`

### Task 7: Renderer stores, event seams, Ops section shell

**Files:** create `src/renderer/src/ops/snippets.ts`, `runs.ts`, `containers.ts`, `template.ts`, `pages/ops/OpsPage.tsx`; modify `shell/sections.ts`, `shell/Sidebar.tsx`, `shell/AppShell.tsx`, `tests/renderer/helpers.tsx`; tests `tests/renderer/ops-stores.test.ts`, `tests/renderer/shell.test.tsx`.

**Behaviour:**
- `snippetStore` `{ snippets, loaded }` with `loadSnippets`, `saveSnippet`, `deleteSnippet` (through `attempt`).
- `runStore` `{ runs: RunSummary[], selectedId }` updated by `run:event` `host`/`run` events; `runOutputStore` (separate, like Phase 5's stats store) holds per-run, per-host text and stderr ranges, appended from `output` events and capped at `RUN_OUTPUT_CHARS` per host; `loadRun(id)` fills from `runs:get` and drops events older than the load via a generation counter.
- `containerStore` keyed by `hostId|environmentId`: `{ list, loading, error, busy: Record<ref, ContainerAction> }`; `followStore` holding follow text per `followId`.
- `startOpsSync()` idempotent, subscribes both events, returns the unsubscribe; `resetOps()` on unmount and vault reset.
- `template.ts` lists `{{name}}` placeholders for the run form (display only; main re-validates and is the authority).
- Section `ops` (label "Ops", icon `Wrench`) placed after `tunnels`; `/ops` redirects to `/ops/run`; `/ops/:tab`. Sidebar shows a small count badge of running runs (same component style as the tunnel badge).
- [ ] **Step 1: Write the failing tests**
  - "run events build per-host state and output in order" — host/output/run events → store reflects them; output beyond the cap trims from the front.
  - "a load discards events older than it".
  - "startOpsSync is idempotent and resetOps clears every store".
  - `shell.test.tsx` › "the Ops section is in the sidebar with its shortcut and badge" — the nav has Ops; `mod+6` navigates to `/ops/run`; with one running run the badge reads 1.
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/renderer/ops-stores.test.ts tests/renderer/shell.test.tsx`.
- [ ] **Step 3: Implement.** Update any existing shell test that pins `deployments`/`audit` shortcut numbers.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit** — `feat(ops): renderer stores, event seams and Ops section`

### Task 8: Run tab: targets, live chips, streaming output, summary, cancel

**Files:** create `pages/ops/RunTab.tsx`, `ops/HostChip.tsx`, `ops/OutputPane.tsx`; tests `tests/renderer/ops-run-tab.test.tsx`, `tests/renderer/ops-output-pane.test.tsx`.

**Behaviour:**
- Left: target picker with three modes (segmented control): **Environment** (select, plus role chips All/app/db/bastion/other with live host counts), **Hosts** (searchable checklist with tag filter and an optional environment context select), and a live "N hosts" preview list. Command: segmented **Command** (monospace textarea, `mod+enter` runs) / **Snippet** (select; variables appear as fields with defaults; template errors shown inline). Concurrency stepper 1–16 and timeout select. A protected environment shows its shield badge and the Run button reads "Run on 5 hosts…".
- Run: if the mirrored rule says a confirmation is needed, `ConfirmDialog` with `typeToConfirm` = environment name, title "Run on 5 hosts in prod?", description lists the first 5 labels + "and 3 more"; the typed value is sent as `confirm`. Main's refusal still shows as a toast if the mirror ever disagrees.
- Right: the run view. A header with title, environment chip, elapsed timer, a summary bar (segments for ok/failed/cancelled/timeout fill with a spring as hosts finish), and Cancel (becomes "Run again" when done). A wrap of `HostChip`s: label, state icon, exit code; `connecting`/`running` pulse; `ok` pops a check, `failed` shakes once (`useShake`); clicking a chip focuses that host's pane. Below, `OutputPane` per host (accordion, failed hosts expanded first, or a "Grouped / Interleaved" toggle: grouped is the default per G12). Recent runs list (left rail, last 20) to reopen or dismiss.
- `OutputPane`: renders text in `<pre>` chunks appended without re-rendering prior text (append to an array of chunk spans keyed by index), stderr ranges tinted, sticks to the bottom until the user scrolls up, then shows "Jump to live"; copy button copies that host's output (renderer only, never toasted).
- Toast on finish only when the Ops page isn't visible: "Run finished: 4 ok, 1 failed (db-2)".
- [ ] **Step 1: Write the failing tests**
  - "picking an environment and role previews matching hosts".
  - "a snippet's variables become fields and a quoted placeholder shows the template error from main" (fake `api.invoke` returns the error).
  - "a multi-host run in a protected environment asks for the typed name and sends it as confirm".
  - "an unprotected single-host run starts without a dialog".
  - "host chips follow run events and the summary counts settle" — feed fake events; chips show states; summary reads `3 ok · 1 failed · 1 cancelled`.
  - "cancel calls runs:cancel and the button becomes Run again when done".
  - "reduced motion: no pulse class and no layout animation on chips" (`matchMedia` stub).
  - `ops-output-pane.test.tsx` › "appends chunks, tints stderr, sticks to the bottom and offers Jump to live after a scroll up".
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/renderer/ops-run-tab.test.tsx tests/renderer/ops-output-pane.test.tsx`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit** — `feat(ops): Run tab with live host chips, streaming output, summary and cancel`

### Task 9: Containers tab and host entry points

**Files:** create `pages/ops/ContainersTab.tsx`; modify `terminal/sessions.ts` (`openContainer`), `pages/hosts/HostView.tsx`; test `tests/renderer/ops-containers-tab.test.tsx`, `tests/renderer/host-view.test.tsx`.

**Behaviour:**
- Host picker (host + environment context; remembers the last choice in `localStorage` guarded by try/catch); Refresh button and auto-refresh every 10 s while visible (paused when the window is hidden or the vault is locked).
- List grouped by compose project (collapsible group header with a count, "Standalone" last), each row: state dot (green running, amber restarting/paused, grey exited), name, image, status, ports; filter box and "Running only" switch. `ListRow` stagger on first load; skeleton rows while loading; `EmptyState` for "No containers" and for docker errors (with the plain message).
- Row actions: Logs, Shell (exec tab), Restart, Stop / Start. Restart/Stop in a protected environment go through `ConfirmDialog` with `typeToConfirm`; elsewhere they run directly with an inline spinner and the state badge cross-fades on the refreshed list. Toasts: "Restarted web-1 on app-1".
- Logs drawer (side sheet): tail select 100/200/1000/5000, Follow switch (starts/stops a follow; unfollows on close and on unmount), `OutputPane` for text, timestamps dimmed.
- Shell: `openContainer(hostId, environmentId, ref)` calls `ssh:open` with `container`, then navigates to `/terminals` like `useConnect`.
- HostView gains a "Containers" button (→ `/ops/containers?host=<id>&env=<id>`) and a "Run…" button (→ `/ops/run?hosts=<id>`).
- [ ] **Step 1: Write the failing tests**
  - "groups containers by compose project and filters running only".
  - "restart in a protected environment asks for the typed name; in staging it runs directly".
  - "a docker error shows the plain message with a retry".
  - "logs drawer follows and unfollows on close".
  - "Shell opens an exec tab and goes to Terminals" — `ssh:open` called with `container: 'web-1'`.
  - `host-view.test.tsx` › "links to containers and run for this host".
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/renderer/ops-containers-tab.test.tsx tests/renderer/host-view.test.tsx`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit** — `feat(ops): Containers tab with logs, actions and exec tabs`

### Task 10: Snippets tab, palette commands, terminal insert, roadmap

**Files:** create `pages/ops/SnippetsTab.tsx`, `pages/ops/SnippetDialog.tsx`, `ops/commands.ts`; modify `shell/AppShell.tsx` (register `useOpsCommands`), `pages/terminals/TerminalDeck.tsx` (a "Snippets" toolbar button opening the insert picker), `docs/superpowers/plans/2026-10-16-roadmap.md`; tests `tests/renderer/ops-snippets-tab.test.tsx`, `tests/renderer/ops-commands.test.ts`.

**Behaviour:**
- Library: search, tag chips filter (multi-select), rows with label, tags, variable pills, a destructive badge; row menu Run, Insert into terminal, Edit, Duplicate, Delete (`ConfirmDialog`).
- `SnippetDialog`: label, description, tags, monospace script editor; detected variables appear live as pills with default fields (client `template.ts` for display; on save main's message is shown inline via `attempt(…, onError)`); "Always ask for confirmation in protected environments" switch = `destructive`; hint about secrets.
- Insert into terminal: if the snippet has variables, a small dialog asks for them; `snippets:render` returns text; `session:write` to the active ready SSH or local tab (no newline); toast "Inserted <label>" with no command text.
- Palette (`useOpsCommands`): "Run a command on hosts…" (→ `/ops/run`), "New snippet" (→ `/ops/snippets?action=new`), per snippet "Run snippet: <label>" (→ `/ops/run?snippet=<id>`, host preselected from the active terminal tab's host when there is one) and "Insert snippet into terminal: <label>" (only while a tab is active), per host "Containers on <label>". Keywords include tags.
- Roadmap row 7: Plan file cell → `2026-10-19-phase7-ops-tools.md`, Status `Done` (the cell is already updated when this plan is committed; this task flips Status only).
- [ ] **Step 1: Write the failing tests**
  - "filters snippets by search and tag".
  - "the editor shows detected variables live and main's template error inline".
  - "insert renders with values and writes to the active session without a newline".
  - "delete asks for confirmation".
  - `ops-commands.test.ts` › "registers run/insert commands per snippet and container commands per host; insert only with an active tab".
- [ ] **Step 2: Run them and watch them fail** — `./node_modules/.bin/vitest run tests/renderer/ops-snippets-tab.test.tsx tests/renderer/ops-commands.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite, typecheck, and lint if present** — `./node_modules/.bin/vitest run`; the typecheck pair; `test -x ./node_modules/.bin/eslint && ./node_modules/.bin/eslint .`. `git status` shows no change to `pnpm-workspace.yaml`.
- [ ] **Step 5: Commit** — `feat(ops): snippets library, palette commands, terminal insert; roadmap row 7 done`

---

## Self-review notes

- **Spec coverage.** G11: list (`docker ps`), compose grouping (labels instead of `docker compose ps`, decision recorded), logs tail + live follow, restart/stop/start, exec tab → Tasks 6, 9. G12: environment, role and selection targets, parallel with a limit, output grouped per host, exit codes, summary, cancel → Tasks 5, 8. Snippet entity (label, script, tags) plus variables, description, destructive flag → Tasks 1, 3, 10; runnable from palette, Run page and terminal → Task 10. G9 typed-name confirmation enforced in main → Tasks 2, 5, 6, mirrored in 8, 9. G16 audit → Tasks 3, 5, 6. §5 no secrets/output in audit, logs or toasts → Global Constraints + Review Focus 4. Lock → Global Constraints + Review Focus 5. Feel and reduced motion → Tasks 8–10.
- **Deferred:** the spec's `Host.startup_snippet_id` (run a snippet when a terminal opens) — needs a host-form field and a session hook; Phase 7 ships snippets the feature can use later. Also deferred: `sudo docker`, podman, per-run output export to a file, saved target groups, scheduled runs.
- **Type consistency.** `RunHostState`, `RunSummary`, `RunHostMeta`, `ContainerMeta`, `SnippetMeta` are defined once in `src/shared/ops.ts` and used by main, IPC and renderer; errors reuse `SessionError` from `src/shared/ssh.ts`.
- **Constraints check.** Every main test dials `127.0.0.1` test servers only, uses a tmp known_hosts, `env: {}` for auth, and a scrubbed `PATH` for the local `/bin/sh` the fake exec runs; nothing reads `~/.ssh` or `SSH_AUTH_SOCK`.
