# OpsDeck Phase 5: Tunnels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved port forwards that stay up, and that honestly show when they aren't:
- Tunnels of type `L` (local), `R` (remote) and `D` (dynamic, SOCKS5), saved
  against a host and an optional environment context. They use the Phase 3
  resolution for identity, port and jump chain.
- One SSH connection per host context, shared by every tunnel on it.
- Status comes from a real liveness probe. A tunnel is `up` only after its
  first probe has passed, and it leaves `up` when the link or a probe dies.
- Auto-reconnect with exponential backoff (1 s → 2 s → … capped at 60 s).
  After 5 consecutive failures the tunnel is marked `failed`.
- Start on app launch, once the vault is first unlocked.
- Clear bind errors. A port clash names the process that holds the port
  (`lsof`). A bind address that isn't loopback carries a warning.
- `LocalForward`, `RemoteForward` and `DynamicForward` from `~/.ssh/config`
  become tunnels on import.
- A Tunnels section with live cards (status, throughput, sparkline), start
  and stop toggles, a create/edit dialog and palette commands.
- A typed tunnel-event seam, so Phase 6 (animated edges) and Phase 9
  (notifications, Explain & fix) can subscribe.
- Audit events for tunnel start and stop, and for tunnel create, update and
  delete.

**Architecture:**
- **Main owns every tunnel** (§6). `src/main/tunnels/` holds small modules,
  each testable against real sockets on `127.0.0.1:0` and the in-process
  `ssh2` test server:
  - `tunnel-store.ts`: CRUD and validation;
  - `bind.ts`: listens with clear errors, looks up the port holder with
    `lsof`, and classifies loopback addresses;
  - `forward.ts`: the `L` and `R` engines over an `ssh2` `Client`, byte
    counters and the probe token;
  - `socks5.ts`: a minimal SOCKS5 server (no auth, `CONNECT` only) and the
    `D` engine;
  - `backoff.ts`: the pure retry schedule;
  - `manager.ts`: `TunnelManager` and its per-host `HostLink`. It handles
    the liveness loop, backoff, lock and unlock, auto-start, events and
    audit.
- **Prompts move to one shared broker.** The host-key, password and
  keyboard prompts move out of `SessionManager` into
  `src/main/ssh/prompts.ts` (`PromptBroker`). Sessions and tunnels raise
  prompts through the same `session:prompt` / `session:answer` channel, so
  the Phase 4 `PromptHost` shows tunnel prompts on any page without
  changes. A tunnel prompt's `sessionId` is the tunnel id.
- **The renderer is UI only.**
  - A tunnel store mirrors `TunnelMeta`, `TunnelRuntime` and a
    60-sample throughput ring per tunnel, all from events.
  - `TunnelsPage` replaces the Phase 1 placeholder at `/tunnels`.
  - `HostView` gets a Tunnels card.

**Tech Stack:** Phases 1–4. **No new dependencies.** SOCKS5 is about 150
lines over `node:net`. The holder lookup shells out to the system `lsof`
through `execFile`, and a missing `lsof` degrades to the plain message.

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md`:
- §3 G5 (saved tunnels with live status), G8 (auto-reconnect, backoff,
  start on launch, status dot), G9 (ssh config import of forwards), G13
  (smooth transitions), G16 (audit tunnel start/stop);
- §5 anti-goals: no plaintext secrets; a tunnel never shows "up" while it is
  dead;
- §6 main owns tunnels;
- §7 Tunnel;
- §8.3 Tunnels;
- §9 item 5;
- §10 feel.

The hooks left for later phases:
- G15 / §8.6 notifications and Explain & fix: Phase 9 subscribes to the
  event seam;
- §8.5 the map's edges (green when up, amber while retrying, red when
  failed): Phase 6 reads `TunnelRuntime.state`.

Roadmap and contracts: `docs/superpowers/plans/2026-10-16-roadmap.md`. Conventions: the Phase 3 and Phase 4 plans in the same folder.

## Global Constraints

- **All Phase 1–4 constraints still hold:**
  - the window flags and CSP;
  - the renderer imports no Node, and the preload requires only `electron`;
  - modules under test import only *types* from `electron`;
  - every IPC channel has a validator in `VALIDATORS`. Validator errors name
    the path and the rule, never the value;
  - mutations call `vault.assertUnlocked()`;
  - audit is appended after COMMIT;
  - renderer mutations go through `attempt(...)`;
  - `~/.ssh/known_hosts` is **read only**, and trust decisions go to the app
    store through the Phase 4 `KnownHostStore`.
- **Migration 5 only.** Migrations 1–4 are never edited. Migration 5 is
  `{ version: 5, name: 'tunnels', up }`:
  ```sql
  CREATE TABLE tunnels(id TEXT PRIMARY KEY, label TEXT NOT NULL,
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('L','R','D')),
    bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
    bind_port INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
    target_host TEXT,
    target_port INTEGER CHECK (target_port IS NULL OR target_port BETWEEN 1 AND 65535),
    auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0,1)),
    auto_reconnect INTEGER NOT NULL DEFAULT 1 CHECK (auto_reconnect IN (0,1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK ((type = 'D') = (target_host IS NULL AND target_port IS NULL)));
  CREATE INDEX tunnels_host ON tunnels(host_id);
  ```
  `environment_id` goes beyond the §7 field list. It is the resolution
  context (§7 "Credential and route resolution"), exactly what `ssh:open`
  takes. `foreign_keys` is already `ON` per connection (`db/connection.ts`).
- **Limits.** These go in `src/shared/tunnels.ts`.
  - **Count:** `MAX_TUNNELS = 256` saved; `MAX_RUNNING_TUNNELS = 64`
    running at once. A start past that fails with code `limit` and the
    message `Too many running tunnels (64)`.
  - **Channels:** `MAX_TUNNEL_CHANNELS = 128` open connections per tunnel.
    Past that, a new local connection is destroyed at once and counted in
    `rejected`.
  - **Backoff:** `BACKOFF_BASE_MS = 1000`, `BACKOFF_CAP_MS = 60000`. After
    failure *n* (1-based), the wait is `min(1000 · 2^(n−1), 60000)`.
  - **Failures:** `DEFAULT_MAX_FAILURES = 5`. The 5th consecutive failure
    marks the tunnel `failed`, so the waits are 1, 2, 4 and 8 s. The
    counter resets once the tunnel has stayed `up` for `STABLE_MS = 30000`.
    The limit is a `TunnelManager` dep. There's no settings UI for it in
    Phase 5.
  - **Probes:** `PROBE_INTERVAL_MS = 15000`; `PROBE_TIMEOUT_MS = 3000`;
    `PROBE_GRACE_MS = 25`; the probe token is 16 random bytes.
  - **Keepalive:** tunnels use the host's `keepaliveSec` when it is set and
    greater than 0. Otherwise they use `TUNNEL_KEEPALIVE_SEC = 15`. A
    host's "off" (`0`) never turns tunnel keepalives off, because liveness
    depends on them. `keepaliveCountMax` stays 3.
  - **Stats:** emitted every `STATS_MS = 1000` while any tunnel runs. The
    renderer keeps `SPARK_POINTS = 60` samples.
  - **SOCKS:** `SOCKS_HANDSHAKE_MS = 10000`; a request is at most 262 bytes.
  - **lsof:** `LSOF_TIMEOUT_MS = 2000`.
- **States** (G8): `stopped | connecting | up | retrying | failed`.
  - **`up` requires** the link to be ready, the bind or remote listen to
    have succeeded, and **the first probe to have passed**. Nothing is
    reported `up` on an optimistic guess.
  - **Leaving `up`:** the link's `close` (keepalive timeout, remote end,
    network) or a failed probe moves every affected tunnel to `retrying`,
    or to `failed` when `autoReconnect` is off.
- **Liveness** (§8.3):
  - **Link:** every tunnel relies on the SSH keepalive.
  - **`L` / `D`:** on top of that, a local connect probe to the bound
    address every `PROBE_INTERVAL_MS`. The probe sends the token on
    connect.
  - **`R`:** a `forwardOut` to the remote bind port (`127.0.0.1` when the
    bind address is a wildcard or loopback). It carries the token, which
    must come back as an incoming forwarded connection within
    `PROBE_TIMEOUT_MS`.
    - If the server refuses `direct-tcpip` with reason 1 (administratively
      prohibited), R liveness falls back to keepalive only.
    - The runtime then shows `liveness: 'keepalive'`, and the card says
      "Liveness: keepalive only".
  - **A probe never reaches the target.** A listener holds a new
    connection's outbound leg until the connection's first chunk arrives or
    `PROBE_GRACE_MS` has passed. A first chunk equal to a live token is
    consumed as a probe and the connection is closed; the target never
    sees it.
    - SOCKS clients always speak first, so `D` adds no delay.
    - For `L` and `R`, protocols where the server speaks first get at most
      25 ms of extra connect latency.
- **Retry policy:**
  - **Retryable:** `refused`, `not-found`, `timeout`, `closed`, `dropped`,
    `probe-failed` and `unknown`. These go to `retrying` on the backoff.
  - **Not retryable**, so `failed` at once:
    - `auth`;
    - `host-key-changed`, `host-key-revoked` and `host-key-rejected`.
      Cancelling or timing out a prompt lands here, so a reconnect loop
      never re-prompts forever;
    - `port-in-use`, `bind-denied` and `remote-refused`;
    - `limit`.
  - **`autoReconnect: false`:** the first failure of any kind is `failed`.
  - **Recovery:** each retry redoes only what failed. A dead link redials
    and then re-binds or re-listens; a failed probe re-probes, and for `R`
    it first cancels and re-requests the remote listen.
  - **Listeners while retrying:** `L`/`D` listeners stay bound during
    `retrying`, so another process can't take the port. Connections that
    arrive meanwhile are destroyed and counted in `rejected`. Listeners are
    released on `stopped` and `failed`.
- **Lock policy (ruling, consistent with Phase 4):**
  - Running tunnels **keep running across a vault lock**.
  - Pending prompts are cancelled when the lock happens.
  - A dial or redial that needs the vault while it is locked **pauses**
    instead of failing:
    - state `retrying`, `error.code: 'locked'`, message `Waiting for unlock`;
    - it doesn't count toward the failure limit;
    - it has no timer, and resumes as soon as the vault unlocks.

    This differs on purpose from a Phase 4 session, which fails as locked.
    A tunnel is a background service that recovers by itself; a terminal
    tab is something you're looking at.
  - `tunnel:start` while locked rejects with `VAULT_LOCKED`. The UI is
    gated anyway.
- **Auto-start:**
  - It runs **once per app run**, on the vault's **first unlock** (password
    or quick unlock). It needs a new `VaultService.onUnlock(fn)` hook (Task 2).
  - Every `autoStart` tunnel starts with `trigger: 'auto'`, in label order,
    up to `MAX_RUNNING_TUNNELS`.
  - A later lock and unlock doesn't re-run it. It only resumes paused
    tunnels.
- **Protected environments (ruling):**
  - Starting or stopping a tunnel is **not destructive**, so it needs no
    typed confirmation, even in a protected environment. A tunnel opens a
    port on your own machine (or a remote listen) and changes nothing on
    the hosts.
  - **Deleting** a tunnel whose environment is protected asks you to type
    the environment's name, through the Phase 3 `ConfirmDialog`
    `typeToConfirm`. Deleting any other tunnel uses the plain confirm.
  - Cards and the dialog show the protected lock badge, so you know which
    tunnels are in a protected environment.
- **Exposure:**
  - A bind address is loopback when it is `localhost`, `::1` or in
    `127.0.0.0/8`. Anything else, including `0.0.0.0` and `::`, is
    **exposed**.
  - The dialog shows a warning callout for an exposed bind:
    - for `L`/`D`: `Anyone who can reach this machine on <addr>:<port> can use this tunnel`;
    - for `R`: `Exposed on the server's network (needs GatewayPorts on the server)`.
  - The card shows an `Exposed` badge. The store accepts the address, and
    audit records `exposed: true`.
- **Bind errors** (§8.3), which come from `bind.ts`:
  - **`EADDRINUSE` held by another process:** `port-in-use`, with the
    message `Port 5433 on 127.0.0.1 is in use by postgres (pid 812)`. When
    `lsof` is missing, times out or finds nothing, the message is
    `Port 5433 on 127.0.0.1 is already in use`.
  - **Held by another running tunnel:** checked before binding, with the
    message `Port 5433 on 127.0.0.1 is used by tunnel "db replica"`.
  - **`EACCES`:** `bind-denied`, with the message
    `Port 80 needs admin rights; pick a port above 1023`.
  - **`EADDRNOTAVAIL`:** `bind-denied`, with the message
    `127.0.0.9 isn't an address on this machine`.
  - **The server refuses `tcpip-forward`:** `remote-refused`, with the
    message `db refused to listen on port 8080 (it may be in use, or remote forwarding is disabled)`.
- **Secrets:**
  - Passwords and keys stay in main memory for one dial, exactly as in
    Phase 4.
  - Tunnel errors, events, toasts and audit never hold passwords, key
    material, usernames or traffic.
  - Error text passes through `redact()`.
  - Byte counts are the only thing measured about traffic.
  - The `lsof` command line uses `-Fpc` (pid and command name only), so
    other processes' arguments never show up.
- **Audit:** new actions appended to `AUDIT_ACTIONS`:
  - `tunnel.create`, `tunnel.update` (`details.fields`), `tunnel.delete`;
  - `tunnel.start`: once per start request. It is `success` when the tunnel
    first reaches `up`, and `failure` with `details.code` when it fails
    before ever being up. A stop while still connecting audits no start
    event;
  - `tunnel.stop`: once per started tunnel that reached `up`. It carries
    `details.reason: 'user' | 'failed' | 'quit' | 'deleted' | 'edited'`,
    plus `durationSec` and `failures`.

  The target is `targetType: 'tunnel'` with the tunnel's id and label.
  `details` may hold:
  - `type`, `bindPort`, `exposed`, `trigger` (`user` | `auto`);
  - `code`, `reason`, `durationSec`, `failures`, `fields`.

  They never hold addresses or target hosts. Reconnects aren't audited one
  by one; the event seam carries them.
- **Event seam** (for Phases 6 and 9). `TunnelEvent` lives in
  `src/shared/tunnels.ts`. Main exposes `TunnelManager.onEvent(fn): () => void`,
  and the same events go to the renderer as `tunnel:event`. The renderer's
  `onTunnelEvent(fn)` is the subscription point for the map and for
  notifications. Phase 9 reads `failed` with `wasUp: true` as "tunnel
  dropped and not recovered" (G15).
- **Tests never touch the real `~/.ssh`, `SSH_AUTH_SOCK` or any network
  beyond localhost.**
  - Tunnels in tests bind `127.0.0.1` with port `0` and read the bound port
    from the runtime.
  - Targets are throwaway `net` echo servers on `127.0.0.1:0`.
  - SSH runs on the Phase 4 `tests/main/ssh-server.ts`.
  - `lsof` is a dep, faked everywhere except one test that runs the real
    binary against our own listener. That test is skipped when `lsof` is
    absent.
  - Backoff and probe timers go through an injected `timers` dep, so tests
    step them by hand (`manualTimers()` in `tests/main/tunnel-helpers.ts`),
    never with real sleeps.
- **Feel** (Phase 1 rule):
  - springs from `ui/motion.ts`;
  - `useMotionSafe()` false means no transforms and no looping animation
    (no flowing route dashes, no pulsing dots, no shake). State is then
    shown by colour and text only.
  - Stats updates never re-render more than the affected card.
- **Shortcuts:** Tunnels keeps its section slot. The palette gains
  `New tunnel`, plus `Start tunnel <label>` and `Stop tunnel <label>` for
  each tunnel, depending on its state.

## Review Focus

1. **A tunnel shown up while it is dead.** When the server goes away, every
   tunnel on the link leaves `up` the moment the link closes. A tunnel
   never reports `up` before its first probe passes, and a failed local
   probe on an otherwise healthy link moves the tunnel to `retrying`.
   *Pinned:* the Task 6 tests `a dropped link moves every tunnel on it to
   retrying`, `never reports up before the first probe passes` and `a
   failed probe leaves up even while the link is healthy`.
2. **The backoff gives up correctly.** The waits are exactly 1, 2, 4 and
   8 s. The 5th failure is `failed`, with one `failed` event (`wasUp:
   true`) and one `tunnel.stop` audit with reason `failed`. The listener is
   released. *Pinned:* the Task 6 test `backs off 1-2-4-8 s and fails on
   the 5th failure`.
3. **Lock during a reconnect.** The tunnel pauses as `locked`, isn't
   counted, has no timer, and resumes on unlock. Running tunnels on other
   links keep running, and a host-key prompt open at lock time is
   cancelled. *Pinned:* the Task 6 test `a redial while locked waits for
   unlock without counting a failure`.
4. **Port clash.** The error names the holding process, and the tunnel
   fails at once without retrying or leaking a link. *Pinned:* the Task 5
   test `names the process holding the port` and the Task 6 test `port in
   use fails at once and releases the link`.
5. **Probes stay invisible to the target**, so a database doesn't log a
   junk connection every 15 s. *Pinned:* the Task 3 test `a probe never
   opens a connection to the target`.

Also pinned:
- the prompt refactor keeps every Phase 4 session test green, and sessions
  and tunnels share one prompt queue (Task 2, `sessions and tunnels share
  one prompt queue`);
- malformed SOCKS input gets the right reply code and never hangs (Task 4,
  `rejects malformed greetings and unsupported commands`).

## File map

```
src/shared/tunnels.ts                    types, limits, TunnelEvent (T1)
src/main/db/migrations.ts                migration 5 (T1)
src/main/tunnels/tunnel-store.ts         TunnelStore CRUD + validation (T1)
src/main/ssh/prompts.ts                  PromptBroker, extracted from SessionManager (T2)
src/main/vault/vault-service.ts          onUnlock hook (T2)
src/main/tunnels/forward.ts              L/R engines, probe token, byte counters (T3)
src/main/tunnels/socks5.ts               SOCKS5 server + D engine (T4)
src/main/tunnels/bind.ts                 listen(), lsof holder, isLoopback (T5)
src/main/tunnels/backoff.ts              backoffMs(), retry classification (T6)
src/main/tunnels/manager.ts              TunnelManager, HostLink, liveness loop (T6)
src/main/ipc/handlers/tunnels.ts         tunnel:* handlers (T1, T6)
src/main/inventory/forward-spec.ts       ssh config forward spec → TunnelInput (T7)
tests/main/ssh-server.ts                 + allowRemoteForward (T3)
tests/main/tunnel-helpers.ts             echo server, manualTimers, link fixtures (T3)
src/renderer/src/tunnels/store.ts        tunnel store, sync, stats ring, onTunnelEvent (T8)
src/renderer/src/ui/Switch.tsx, Sparkline.tsx (T8)
src/renderer/src/pages/tunnels/*         TunnelsPage, TunnelCard, RouteLine (T9); TunnelDialog (T10)
src/renderer/src/tunnels/commands.ts     palette commands (T10)
src/renderer/src/pages/hosts/HostTunnels.tsx  Tunnels card on HostView (T10)
```

---

### Task 1: Migration 5, shared tunnel types, audit actions, TunnelStore and CRUD IPC

**Files:**
- Create:
  - `src/shared/tunnels.ts`;
  - `src/main/tunnels/tunnel-store.ts`;
  - `src/main/ipc/handlers/tunnels.ts`.
- Modify:
  - `src/main/db/migrations.ts`;
  - `src/shared/audit.ts`;
  - `src/shared/ipc.ts`;
  - `src/main/ipc/validators.ts`;
  - `src/main/index.ts` (construct the store, spread its handlers).
- Test:
  - `tests/main/inventory-schema.test.ts`;
  - `tests/main/tunnel-store.test.ts` (new);
  - `tests/main/ipc.test.ts` (channel completeness only, if needed).

**Interfaces:**
- Produces, in `src/shared/tunnels.ts`:
  - all the limits in Global Constraints;
  - `type TunnelType = 'L' | 'R' | 'D'`;
  - `type TunnelState = 'stopped' | 'connecting' | 'up' | 'retrying' | 'failed'`;
  - `interface TunnelMeta`, with these fields:
    - `id`, `label`, `hostId`, `environmentId: string | null`;
    - `type: TunnelType`;
    - `bindAddress: string`, `bindPort: number`;
    - `targetHost: string | null`, `targetPort: number | null`. Both are
      `null` exactly when `type === 'D'`;
    - `autoStart: boolean`, `autoReconnect: boolean`;
    - `createdAt`, `updatedAt`.
  - `interface TunnelInput`:
    `{ label; hostId; environmentId?: string; type; bindAddress?: string; bindPort: number; targetHost?: string; targetPort?: number; autoStart?: boolean; autoReconnect?: boolean }`.
    The defaults are `bindAddress '127.0.0.1'`, `autoStart false` and
    `autoReconnect true`.
  - `type TunnelPatch = Partial<Omit<TunnelInput, 'environmentId' | 'targetHost' | 'targetPort'>> & { environmentId?: string | null; targetHost?: string | null; targetPort?: number | null }`;
  - `type TunnelErrorCode = SshErrorCode | 'dropped' | 'probe-failed' | 'port-in-use' | 'bind-denied' | 'remote-refused'`;
  - `interface TunnelError { code: TunnelErrorCode; message: string; hopLabel?: string }`;
  - `interface TunnelRuntime`, with these fields:
    - `id`, `state: TunnelState`, `error: TunnelError | null`;
    - `failures: number`;
    - `retryAt: string | null` (ISO; `null` while paused or not retrying);
    - `boundAddress: string | null`, `boundPort: number | null` (the real
      port when `bindPort` is 0);
    - `liveness: 'probe' | 'keepalive'`;
    - `startedAt`, `upAt`, `lastProbeAt` (all `string | null`).
  - `interface TunnelStats { id; bytesIn: number; bytesOut: number; rateIn: number; rateOut: number; connections: number; rejected: number }`.
    `bytesIn` is remote → local; the rates are bytes per second over the
    last `STATS_MS`.
  - `type TunnelStopReason = 'user' | 'failed' | 'quit' | 'deleted' | 'edited'`;
  - `type TunnelEvent`, one of:
    - `{ type: 'connecting'; tunnelId; label; at; trigger: 'user' | 'auto' }`;
    - `{ type: 'up'; tunnelId; label; at; recovered: boolean }`;
    - `{ type: 'retrying'; tunnelId; label; at; failures: number; retryInMs: number | null; error: TunnelError }`;
    - `{ type: 'failed'; tunnelId; label; at; error: TunnelError; wasUp: boolean }`;
    - `{ type: 'stopped'; tunnelId; label; at; reason: TunnelStopReason }`.
  - `isLoopback(address: string): boolean`. It is pure and shared, so the
    dialog and the store agree.
  - `BIND_ADDRESS`, a check accepting an IPv4 dotted quad, an IPv6 literal
    or `localhost`, at most 64 chars.
- `AUDIT_ACTIONS` gains `tunnel.create`, `tunnel.update`, `tunnel.delete`,
  `tunnel.start` and `tunnel.stop`.
- IPC channels:
  - `'tunnel:list': [] → TunnelMeta[]`, sorted by label (`NOCASE`);
  - `'tunnel:create': [input: TunnelInput] → TunnelMeta`;
  - `'tunnel:update': [id: string, patch: TunnelPatch] → TunnelMeta`;
  - `'tunnel:delete': [id: string] → void`.
- `class TunnelStore`:
  - `constructor({ db, audit, vault, now?, ids? })`, following
    `HostStore`'s shape;
  - `list()`, `get(id)`, `create`, `update`, `delete`;
  - `listForHost(hostId)`;
  - `insertInTx(input)` for the importer (Task 7);
  - `findSame(input): TunnelMeta | null`, matching on host, type, bind
    address, bind port and target, for de-duplicating on import.
  - `delete` and the `update` hooks call `onRemoved?(id)` and
    `onChanged?(before, after)`. Those are set by the manager in Task 6.
- Store errors (lower case, as in `rows.ts`; they never hold the value):
  - `checkText(raw, 'tunnel label', MAX_LABEL)`;
  - `host not found`;
  - `host isn't in that environment` (via `environment_hosts`);
  - `bind address must be an IP address or localhost`;
  - `bind port must be 0-65535`;
  - `target host is required for L and R tunnels`;
  - the existing `checkPort` `port must be 1-65535` for the target, plus
    `checkAddress` for the target host;
  - `a dynamic tunnel has no target`;
  - `too many tunnels (256)`.

- [ ] **Step 1: Write the failing tests**

`tests/main/inventory-schema.test.ts`, test `migration 5 adds tunnels with checks and cascades`:
- `PRAGMA table_info(tunnels)` lists the 13 columns from Global
  Constraints.
- Inserting `type 'D'` with `target_port 22` throws a CHECK error, and so
  does `type 'L'` with a NULL `target_host`.
- Deleting the host deletes its tunnel.
- Deleting the environment sets `environment_id` to NULL.

`tests/main/tunnel-store.test.ts`:
- `creates an L tunnel with defaults`:
  - the input is
    `{ label: 'db', hostId, type: 'L', bindPort: 5433, targetHost: 'localhost', targetPort: 5432 }`;
  - the result has `bindAddress '127.0.0.1'`, `autoStart false` and
    `autoReconnect true`;
  - `tunnel.create` is audited with `details`
    `{ type: 'L', bindPort: 5433, exposed: false }`;
  - no audit field contains `localhost`.
- `creates a D tunnel without target`: the target fields are `null`.
  Passing `targetPort: 1` throws `a dynamic tunnel has no target`.
- `rejects bad input`, one case per store error above. The messages never
  contain the offending value; the bind address case uses `10.0.0.999x`.
- `environment must contain the host`.
- `exposed bind is accepted and audited`: `bindAddress '0.0.0.0'` gives
  `details.exposed: true`.
- `update audits changed fields only`:
  - patching `{ label: 'db2', bindPort: 5433 }` when only the label changed
    audits `fields: ['label']`;
  - a no-op patch audits nothing.
- `switching to D clears the target`: patching
  `{ type: 'D', targetHost: null, targetPort: null }` works. Patching
  `{ type: 'D' }` alone throws `a dynamic tunnel has no target`.
- `limit`: the 257th create throws `too many tunnels (256)`.
- `mutations need the vault unlocked`: when locked, `create` rejects with
  `VAULT_LOCKED`.
- `IPC validator rejects bad shapes naming the path`. Each of these fails at
  the validator, naming the path:
  - `bindPort: 70000`;
  - `type: 'X'`;
  - `label: 5`;
  - `hostId: 'nope'`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/main/inventory-schema.test.ts tests/main/tunnel-store.test.ts`
Expected: FAIL. There is no `tunnels` table, and `TunnelStore` doesn't
exist.

- [ ] **Step 3: Implement**
  - Migration 5 holds the DDL from Global Constraints, verbatim.
  - The store uses `inTransaction` and appends audit after COMMIT.
  - The validators are `asTunnelInput` and `asTunnelPatch`:
    - `type` is `v.oneOf(['L','R','D'])`;
    - ports are ints in range;
    - strings are length-capped (the store re-checks the rules).
  - The handlers live in `createTunnelHandlers({ store })`; Task 6 adds the
    runtime channels to the same file.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): migration 5, shared tunnel types, store and CRUD IPC`

---

### Task 2: Shared PromptBroker and the vault unlock hook

**Files:**
- Create: `src/main/ssh/prompts.ts`.
- Modify:
  - `src/main/ssh/sessions.ts` (use the broker; behaviour unchanged);
  - `src/main/ipc/handlers/sessions.ts` (`session:answer` and
    `session:prompts` go to the broker);
  - `src/main/vault/vault-service.ts` (`onUnlock`);
  - `src/main/index.ts` (one broker; lock cancels all of its prompts).
- Test:
  - `tests/main/prompts.test.ts` (new);
  - `tests/main/sessions.test.ts` and `tests/main/sessions-ipc.test.ts`
    (construction only; **no assertion changes**);
  - `tests/main/vault-service.test.ts`.

**Interfaces:**
- `type PromptBody`: `SessionPrompt` minus `promptId` and `sessionId`,
  moved here from `sessions.ts`.
- `class PromptBroker`:
  - `constructor({ emit, isLocked, ids, timeoutMs = PROMPT_TIMEOUT_MS })`;
  - `ask(ownerId: string, group: Set<string>, body: PromptBody): Promise<PromptAnswer | null | 'locked'>`:
    - it resolves `'locked'` at once, emitting nothing, when `isLocked()`
      is true;
    - otherwise it emits `session:prompt` with `sessionId: ownerId` and
      adds the prompt id to `group`.
  - `answer(promptId, answer): void`. An unknown id is a no-op. A kind or
    count mismatch throws `prompt answer doesn't match` (moved verbatim).
  - `pending(): SessionPrompt[]`, oldest first;
  - `cancel(group: Set<string>): void`;
  - `cancelAll(): void`.

  Every settle path emits `session:promptDone` and clears the timer.
- `SessionManager` deps gain `prompts: PromptBroker`. Its private `ask`
  calls the broker and maps `'locked'` to `attempt.fail(new Error(VAULT_LOCKED))`,
  as today. `answer` and `pendingPrompts` are removed from the manager.
  `vaultLocked()` keeps failing the dials that are still connecting, and
  `index.ts` calls `prompts.cancelAll()` on lock.
- `VaultService.onUnlock(fn: () => void): () => void`:
  - it fires after any transition from locked to unlocked: password
    unlock, quick unlock, and vault creation on first run;
  - it fires after the serial section resolves, once per transition;
  - a throwing listener is caught and logged through `redact()`.

- [ ] **Step 1: Write the failing tests**

`tests/main/prompts.test.ts`:
- `asks, answers and emits done`:
  - `ask('t1', g, { kind: 'password', hopLabel: 'db', username: 'u' })`
    emits a `session:prompt` with `sessionId: 't1'`;
  - `answer(id, { kind: 'password', password: 'pw' })` resolves the promise
    with that answer and emits `session:promptDone`;
  - `g` is then empty.
- `times out as cancelled`: with fake timers past `timeoutMs`, the promise
  resolves `null`.
- `locked asks resolve 'locked' and emit nothing`.
- `cancel(group) settles only that group; cancelAll settles everything`.
- `mismatched kind throws; unknown id is a no-op`.
- `sessions and tunnels share one prompt queue`:
  - a `SessionManager` and a raw `ask('tunnel-1', …)` on the same broker
    give `pending()` holding both, in order;
  - `session:answer` through the handler resolves the tunnel's prompt.

`tests/main/vault-service.test.ts`, test `onUnlock fires once per unlock, not on a failed attempt`:
- a wrong password fires nothing;
- the right one fires once;
- lock then quick unlock fires again;
- the unsubscribe function works.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/main/prompts.test.ts tests/main/vault-service.test.ts`
Expected: FAIL. `prompts.ts` and `onUnlock` don't exist.

- [ ] **Step 3: Implement**

Move `ask`, `settle`, `PendingPrompt` and the timeout out of
`sessions.ts`, verbatim. `Attempt.prompts` becomes the `group` set.

Update the construction in `tests/main/sessions.test.ts` and
`sessions-ipc.test.ts`:
- create a broker;
- call `broker.answer` where tests used `manager.answer`.

Every existing test name and assertion stays the same.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, including every Phase 4 session test.

- [ ] **Step 5: Commit**: `refactor(ssh): extract a shared prompt broker; add vault onUnlock`

---

### Task 3: Forward engines for L and R, the probe token and byte counters

**Files:**
- Create:
  - `src/main/tunnels/forward.ts`;
  - `tests/main/tunnel-helpers.ts`.
- Modify: `tests/main/ssh-server.ts` (add `allowRemoteForward`).
- Test: `tests/main/tunnel-forward.test.ts` (new).

**Interfaces:**
- `tests/main/ssh-server.ts`:
  - `startServer({ ..., allowRemoteForward?: boolean })`;
  - when the option is set, `tcpip-forward` binds a real listener on
    `127.0.0.1:<port>` (port 0 means pick a free one, reported back). Each
    accepted socket is opened back to the client as a `forwarded-tcpip`
    channel;
  - `cancel-tcpip-forward` closes that listener;
  - when the option isn't set, both requests are rejected;
  - the server also returns `remoteListeners(): number[]`, the bound
    ports, and `dropAll(): void`, which destroys every client connection
    (to simulate a dead network).
- `tests/main/tunnel-helpers.ts`:
  - `echoServer(): Promise<{ port; accepted(): number; close() }>`.
    `accepted()` counts TCP accepts, so a test can prove that no probe
    reached it;
  - `manualTimers(): { timers: Timers; pending(): { ms: number }[]; fire(): void; fireAll(): void }`;
  - `linkTo(server)`: a ready `ssh2` `Client` for a test server.
- `forward.ts`:
  - `interface Timers { setTimeout(fn, ms): unknown; clearTimeout(h): void; setInterval(fn, ms): unknown; clearInterval(h): void }`;
  - `class Counter { bytesIn; bytesOut; connections; rejected; sample(): TunnelStats-without-id }`.
    `sample()` computes the rates since the last sample;
  - `class ProbeTokens { issue(): Buffer; consume(chunk: Buffer): boolean }`;
  - `interface ForwardHandle { readonly accepting: boolean; setAccepting(on: boolean): void; probe(): Promise<void>; close(): Promise<void>; readonly address: { address: string; port: number } }`.
    `probe()` rejects with an `Error` that has `code: 'probe-failed'`, or
    with `liveness: 'keepalive'` for an `R` probe the server prohibits.
  - `startLocal(client, { server: net.Server, targetHost, targetPort, counter, tokens, timers }): ForwardHandle`
    takes an already listening server from `bind.ts` (Task 5; until then,
    tests pass a `net.createServer().listen(0, '127.0.0.1')`):
    - on each connection it waits for the first chunk or `PROBE_GRACE_MS`;
    - it consumes probe tokens;
    - it then calls `client.forwardOut(...)` and pipes both ways, counting
      bytes;
    - a channel open failure destroys the local socket.
  - `startRemote(client, { bindAddress, bindPort, targetHost, targetPort, counter, tokens, timers }): Promise<ForwardHandle>`:
    - it calls `client.forwardIn`, and a refusal rejects with
      `remote-refused`;
    - it handles `client.on('tcp connection')` only for its own
      bind port: accept, grace or probe, then `net.connect` to the target;
    - `close()` calls `unforwardIn`.

- [ ] **Step 1: Write the failing tests** (`tests/main/tunnel-forward.test.ts`)
- `L forwards bytes both ways and counts them`:
  - echo target, `startLocal` on port 0;
  - a client writes `ping` and reads `ping`;
  - `counter.sample()` has `bytesOut 4`, `bytesIn 4` and `connections 1`,
    falling to 0 after the client closes.
- `a probe never opens a connection to the target`:
  - `probe()` resolves;
  - the echo server's `accepted()` stays at 0, and so does `bytesOut`.
- `L probe fails when the listener is gone`: close the server, and
  `probe()` rejects with code `probe-failed` within `PROBE_TIMEOUT_MS`.
- `L server-first protocol waits at most the grace period`:
  - the target writes `HELLO` on accept, and the client never writes;
  - with `manualTimers`, the grace timer is armed with exactly 25 ms and
    no channel is opened before it fires;
  - after `fire()`, the client receives `HELLO`.
- `L rejects connections while not accepting`: after
  `setAccepting(false)`, a client socket is closed at once and
  `rejected === 1`.
- `L enforces MAX_TUNNEL_CHANNELS`: with 128 connections open, the 129th is
  destroyed and `rejected` goes up by 1.
- `R listens remotely and forwards to the local target`:
  - with `allowRemoteForward` and `bindPort 0`, the server's
    `remoteListeners()` has one port;
  - a connect to it from the test reaches the echo target;
  - the bytes are counted.
- `R probe round-trips the token without reaching the target`: `probe()`
  resolves, and `accepted()` stays at 0.
- `R refused by the server rejects with remote-refused`: without
  `allowRemoteForward`, `startRemote` rejects with code `remote-refused`.
- `R close cancels the remote listen`: after `close()`,
  `remoteListeners()` is empty.
- `probe tokens are single-use`: a consumed token doesn't match a second
  time.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/main/tunnel-forward.test.ts`
Expected: FAIL. `forward.ts` doesn't exist, and the server doesn't handle
`tcpip-forward`.

- [ ] **Step 3: Implement**
  - Pipe with `stream.pipeline`, so an error on either side destroys both.
  - Counters wrap `data` listeners, never buffers.
  - The `L` and `R` paths share one `holdForProbe(socket, tokens, timers, onReal)`.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): L and R forward engines with probe tokens and byte counters`

---

### Task 4: A minimal SOCKS5 server and the D engine

**Files:**
- Create: `src/main/tunnels/socks5.ts`.
- Test: `tests/main/socks5.test.ts` (new).

**Interfaces:**
- `parseGreeting(buf): { methods: number[] } | 'short' | 'bad'`;
- `parseRequest(buf): { cmd: number; host: string; port: number; length: number } | 'short' | 'bad-atyp' | 'bad'`.
  It handles ATYP `0x01` (IPv4), `0x03` (domain, 1–255 bytes) and `0x04`
  (IPv6, compressed text form);
- `reply(code: number): Buffer`, which always carries bound address
  `0.0.0.0:0`;
- `const REP = { ok: 0x00, fail: 0x01, notAllowed: 0x02, netUnreachable: 0x03, hostUnreachable: 0x04, refused: 0x05, ttl: 0x06, cmdUnsupported: 0x07, atypUnsupported: 0x08 }`;
- `startDynamic(client, { server, counter, tokens, timers }): ForwardHandle`:
  - **Greeting:** without method `0x00` in the greeting, it replies
    `05 FF` and closes.
  - **Commands:** only `CONNECT` (`0x01`). Other commands get `cmdUnsupported`.
  - **Opening:** it calls `client.forwardOut('127.0.0.1', 0, host, port)`;
    domain names are resolved by the server, like `ssh -D`.
  - **Mapping a channel failure:**
    - an open failure reason 2 with `refused` in the text gives `refused`;
    - `not known` or `resolve` in the text gives `hostUnreachable`;
    - anything else gives `fail`.
  - **Timeout:** a client that hasn't finished the handshake within
    `SOCKS_HANDSHAKE_MS` is destroyed.
  - **Probes:** the probe token is checked against the **first chunk**
    before greeting parsing.
  - **`probe()`** connects, sends the token and expects the server to close
    cleanly within `PROBE_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing tests** (`tests/main/socks5.test.ts`)
- `parses IPv4, domain and IPv6 requests`: three byte fixtures give
  `127.0.0.1:80`, `example.internal:443` and `::1:22`.
- `returns short on partial input`: every proper prefix of a valid request
  is `'short'`.
- `connects through the link to an echo target`:
  - a raw socket sends `05 01 00`;
  - it reads `05 00`;
  - it sends CONNECT to `127.0.0.1:<echo>` and reads `05 00 00 01 00 00 00 00 00 00`;
  - then `ping` echoes back.
- `rejects malformed greetings and unsupported commands`, with no hang:
  - version `04` is closed without a reply;
  - methods `[0x02]` only gives `05 FF`;
  - `BIND` (`0x02`) gives `REP.cmdUnsupported`;
  - ATYP `0x05` gives `REP.atypUnsupported`;
  - a 300-byte request is closed.

  Each socket closes within 100 ms.
- `refused target maps to REP.refused`: CONNECT to a closed localhost port
  gets reply byte 1 = `0x05`.
- `handshake timeout closes a silent client`: with `manualTimers`,
  `fire()` closes the socket.
- `probe never opens a channel`: `probe()` resolves, and the test server
  saw no `tcpip` channel request.
- `counts SOCKS traffic`: after the `ping` exchange, `bytesIn` and
  `bytesOut` are both 4. The handshake bytes aren't counted.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/main/socks5.test.ts`
Expected: FAIL. `socks5.ts` doesn't exist.

- [ ] **Step 3: Implement**
  - A per-socket state machine: `greeting → request → piping`.
  - Accumulate input up to 262 bytes. Once piping starts, hand off to the
    same pipe-and-count helper as Task 3.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): minimal SOCKS5 server for dynamic forwards`

---

### Task 5: Binding with clear errors: port holder via lsof, permissions, exposure

**Files:**
- Create: `src/main/tunnels/bind.ts`.
- Test: `tests/main/tunnel-bind.test.ts` (new).

**Interfaces:**
- `class BindError extends Error { code: 'port-in-use' | 'bind-denied' }`;
- `parseLsof(out: string): { pid: number; command: string } | null`. It
  reads `-Fpc` output (`p812\ncpostgres\n`) and takes the first process;
- `whoHolds(port, { execFile, timeoutMs = LSOF_TIMEOUT_MS }): Promise<{ pid; command } | null>`:
  - it runs `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`;
  - any error, a non-zero exit or a timeout gives `null`;
  - the command name is cut to 64 chars and stripped of control
    characters.
- `listen(address, port, { whoHolds, inUseBy?: (address, port) => string | null }): Promise<net.Server>`:
  - `inUseBy` is the manager's check for another running tunnel, made
    before binding;
  - it maps `EADDRINUSE`, `EACCES` and `EADDRNOTAVAIL` to `BindError` with
    the exact messages from Global Constraints;
  - `localhost` binds `127.0.0.1`.
- `isLoopback` is re-exported from `src/shared/tunnels.ts`.

- [ ] **Step 1: Write the failing tests** (`tests/main/tunnel-bind.test.ts`)
- `parses lsof field output`:
  - `p812\ncpostgres\n` gives `{ pid: 812, command: 'postgres' }`;
  - two processes give the first;
  - an empty string and garbage give `null`.
- `names the process holding the port`:
  - hold a port with a plain `net` server;
  - `listen('127.0.0.1', held, { whoHolds: async () => ({ pid: 812, command: 'postgres' }) })`
    rejects with a `BindError` with code `port-in-use` and the message
    `Port <held> on 127.0.0.1 is in use by postgres (pid 812)`.
- `falls back when the holder is unknown`: when `whoHolds` returns `null`,
  the message is `Port <held> on 127.0.0.1 is already in use`.
- `another tunnel holding the port is named without binding`: `inUseBy`
  returns `db replica`, so the message is
  `Port 5433 on 127.0.0.1 is used by tunnel "db replica"`, and nothing was
  bound.
- `real lsof finds our own listener` (skipped unless `/usr/sbin/lsof`
  exists): `whoHolds(heldPort, { execFile })` returns our `process.pid`.
- `whoHolds gives null on timeout`: a fake `execFile` that never calls back
  gives `null` after 2000 ms (fake timers).
- `maps EADDRNOTAVAIL`: `listen('127.0.0.9', 0, …)` on macOS gives
  `bind-denied` with `127.0.0.9 isn't an address on this machine`. When
  the platform allows the bind (some Linux CI), skip.
- `maps EACCES` (unit test with a stub server whose `listen` emits an
  `EACCES` error): `Port 80 needs admin rights; pick a port above 1023`.
- `isLoopback`:
  - `localhost`, `127.0.0.1`, `127.4.5.6` and `::1` are true;
  - `0.0.0.0`, `::`, `192.168.1.2` and `10.0.0.1` are false.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/main/tunnel-bind.test.ts`
Expected: FAIL. `bind.ts` doesn't exist.

- [ ] **Step 3: Implement.** The production `execFile` is `node:child_process`'s
`execFile`, called with no shell and with the port as a separate integer
argument.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): bind with clear errors naming the port holder`

---

### Task 6: TunnelManager: shared links, liveness, backoff, lock and unlock, auto-start, events, IPC

**Files:**
- Create:
  - `src/main/tunnels/backoff.ts`;
  - `src/main/tunnels/manager.ts`.
- Modify:
  - `src/main/ipc/handlers/tunnels.ts`;
  - `src/shared/ipc.ts` (channels and events);
  - `src/main/ipc/validators.ts`;
  - `src/main/index.ts`:
    - construct the manager;
    - `vault.onLock → tunnels.vaultLocked()`;
    - `vault.onUnlock → tunnels.vaultUnlocked()`;
    - `before-quit` calls `tunnels.stopAll('quit')` before the session
      close;
    - store hooks.
  - `src/main/ipc/handlers/inventory.ts`: `host:delete` stops that host's
    tunnels first, with reason `deleted`.
- Test:
  - `tests/main/tunnels.test.ts` (new);
  - `tests/main/tunnels-ipc.test.ts` (new);
  - `tests/main/preload.test.ts` (new events allowed).

**Interfaces:**
- `backoff.ts`:
  - `backoffMs(failure: number): number`, equal to
    `min(BACKOFF_BASE_MS * 2 ** (failure - 1), BACKOFF_CAP_MS)`;
  - `isRetryable(code: TunnelErrorCode): boolean`, following the retry
    policy.
- IPC channels:
  - `'tunnel:start': [id] → TunnelRuntime`. It returns at once in
    `connecting`. Starting a tunnel that is running is a no-op returning
    the current runtime;
  - `'tunnel:stop': [id] → void`;
  - `'tunnel:status': [] → TunnelRuntime[]`, one entry per saved tunnel,
    with `stopped` for idle ones.
- Events:
  - `'tunnel:state': TunnelRuntime`;
  - `'tunnel:stats': TunnelStats[]`, only the running tunnels, every
    `STATS_MS`;
  - `'tunnel:event': TunnelEvent`.
- `class TunnelManager`:
  - `constructor(deps)`. The deps are:
    - `store: TunnelStore`;
    - `resolve`, `hostInfo` (as in Phase 4);
    - `connect` (`connectChain`), `plan`, `knownHosts`;
    - `prompts: PromptBroker`;
    - `isLocked()`;
    - `listen` (Task 5, bound with real `whoHolds`);
    - `audit`, `emit`;
    - `timers?`, `now?`, `ids?`;
    - `maxFailures = DEFAULT_MAX_FAILURES`.
  - `start(id, trigger: 'user' | 'auto' = 'user')`, `stop(id, reason = 'user')`;
  - `status()`, `runtime(id)`;
  - `onEvent(fn): () => void`;
  - `vaultLocked()`, `vaultUnlocked()`;
  - `stopAll('quit')`;
  - `removed(id)` (store delete hook, reason `deleted`);
  - `changed(before, after)` (store update hook):
    - when a running tunnel's host, environment, type, bind or target
      changed, it stops with reason `edited` and starts again;
    - label, `autoStart` or `autoReconnect` alone don't restart it.
- `HostLink` (inside `manager.ts`):
  - one per `hostId|environmentId`, refcounted by running tunnels;
  - it dials with Phase 4's `connectChain` and the same host-key and
    password handling as `SessionManager.verifyHostKey`, through the
    broker. The prompt owner is the tunnel id that triggered the dial;
  - states `dialing | ready | down`;
  - on `client.on('close')` every subscriber gets `dropped`;
  - when the last subscriber leaves, the client is ended;
  - the keepalive follows the Global Constraints rule.
- **Per-tunnel loop:**
  - `connecting`: link ready, then bind or listen, then first probe, then
    `up`;
  - a probe timer every `PROBE_INTERVAL_MS`, plus a `STABLE_MS` timer that
    resets `failures`;
  - on failure:
    - **`locked`:** pause;
    - **retryable with `autoReconnect`:** `failures += 1`. If `failures`
      reaches `maxFailures`, the tunnel is `failed`; otherwise it is
      `retrying` with `retryAt = now + backoffMs(failures)`;
    - **anything else:** `failed`.
  - `failed` and `stopped` release the listener and the link subscription,
    and cancel the broker group.
- **Audit and events** follow Global Constraints. `connecting`, `up`,
  `retrying`, `failed` and `stopped` each emit exactly one `tunnel:event`,
  together with the `tunnel:state` for that change.

- [ ] **Step 1: Write the failing tests.** `tests/main/tunnels.test.ts`
  uses a real `TunnelStore` on a tmp DB, the Phase 4 test server, echo
  targets, a real `KnownHostStore`, a real `PromptBroker` and
  `manualTimers`. It records events, states and audit.
  - `L tunnel goes connecting → up and carries traffic`:
    - the states are exactly `connecting`, then `up`;
    - `boundPort` is non-zero;
    - `ping` round-trips through it;
    - one `tunnel.start success` is audited with
      `details { type: 'L', bindPort: 0, exposed: false, trigger: 'user' }`;
    - no audit field contains `127.0.0.1`.
  - `never reports up before the first probe passes`:
    - stub `forward.probe` to stay pending;
    - the state stays `connecting`;
    - resolving the probe moves it to `up`.
  - `two tunnels on one host share one SSH connection`: the server's
    `connections()` is 1. Stopping one keeps the other `up`; stopping both
    gives 0.
  - `a dropped link moves every tunnel on it to retrying`:
    - two `up` tunnels;
    - `server.dropAll()`;
    - both reach `retrying` with `error.code: 'dropped'`, with no timer
      fired. Leaving `up` is driven by the link's `close`, not by a probe
      tick;
    - `pending()[0].ms === 1000`;
    - `fire()` redials, and both return to `up` with
      `{ type: 'up', recovered: true }`.
  - `a failed probe leaves up even while the link is healthy`:
    - stub the next `probe()` to reject `probe-failed`;
    - fire the probe interval;
    - the state is `retrying` with `failures 1`;
    - the next fire re-probes without redialling: `connections()` stays 1.
  - `backs off 1-2-4-8 s and fails on the 5th failure`:
    - after `up`, stop the server for good;
    - the scheduled delays read `[1000, 2000, 4000, 8000]`;
    - after the 5th failure the state is `failed` with `failures 5`;
    - there is one `failed` event with `wasUp: true`;
    - there is one `tunnel.stop` with `reason: 'failed'` and
      `failures: 5`;
    - a plain `net.connect` to the bound port is refused, because the
      listener was released.
  - `failure count resets after STABLE_MS up`: drop once, recover, fire
    `STABLE_MS`; the runtime has `failures 0`.
  - `autoReconnect off fails on the first drop`.
  - `port in use fails at once and releases the link`:
    - hold the port, with `listen` built from a fake `whoHolds` returning
      `{ pid: 812, command: 'postgres' }`;
    - the state is `failed` with `error.code 'port-in-use'` and the message
      `Port <p> on 127.0.0.1 is in use by postgres (pid 812)`;
    - no timer is pending;
    - `connections()` is 0;
    - `tunnel.start failure` is audited with `code 'port-in-use'`.
  - `two tunnels on the same port name each other`:
    - both use a fixed port taken from a `listen(0)` that was then closed;
    - the second fails with `is used by tunnel "first"`.
  - `a redial while locked waits for unlock without counting a failure`:
    - tunnel A is on server 1;
    - tunnel B is on server 2 and needs a host-key prompt;
    - lock while B's prompt is open: `session:promptDone` is emitted;
    - B is `retrying` with `error.code 'locked'`, message
      `Waiting for unlock`, `retryAt null` and `failures 0`, and no timer
      is pending for it;
    - A stays `up` and keeps carrying traffic;
    - drop server 1: A goes to `retrying` (`dropped`), and its first retry
      pauses as `locked` without adding to `failures`;
    - `vaultUnlocked()` resumes both.
  - `auto-start runs once on the first unlock`:
    - three tunnels, two with `autoStart`;
    - before the first `vaultUnlocked()` nothing starts;
    - after it, exactly the two start, with `trigger: 'auto'` in the audit;
    - lock and unlock again: no new `tunnel.start` events.
  - `host-key change blocks without prompting and is not retried`: a
    pre-seeded different key gives `failed` with `host-key-changed`, and
    no `session:prompt` is emitted.
  - `cancelling the password prompt fails as auth without re-prompting`.
  - `stop while connecting audits nothing and cancels the prompt`.
  - `editing a running tunnel's port restarts it; renaming does not`.
  - `deleting a running tunnel stops it with reason deleted`.
  - `stopAll quits every running tunnel`: `tunnel.stop` is audited with
    reason `quit` for each tunnel that was up.
  - `R tunnel goes up and its probe falls back to keepalive when prohibited`:
    - a server with `allowRemoteForward` but `direct-tcpip` disabled;
    - the state is `up` with `liveness: 'keepalive'`.
  - `D tunnel goes up and serves SOCKS`.
  - `stats are batched and only for running tunnels`: fire `STATS_MS`
    once; one `tunnel:stats` event with one entry per running tunnel.
  - `running limit`: with a stub `connect` that never resolves (as in the
    Phase 4 session-limit test), the 65th start fails with `limit` and the
    message `Too many running tunnels (64)`.
  - `errors never leak secrets`: with a password identity, no emitted event,
    state or audit row contains the password string.

  `tests/main/tunnels-ipc.test.ts`:
  - the handlers delegate to a fake manager;
  - the validators reject `tunnel:start` with a non-uuid;
  - `tunnel:start` while locked rejects with `VAULT_LOCKED`.

  `tests/main/preload.test.ts`: `on('tunnel:state', …)` is allowed.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/main/tunnels.test.ts tests/main/tunnels-ipc.test.ts`
Expected: FAIL. `TunnelManager` doesn't exist.

- [ ] **Step 3: Implement**
  - **Wiring:**
    - one `PromptBroker` is shared with `SessionManager`;
    - `emit` is `pushEvent(mainWindow, …)`;
    - the store hooks are set after construction;
    - the stats interval runs only while the running count is above 0.
  - **Copy:** keep the host-key verification identical to
    `SessionManager.verifyHostKey`. If the copy grows past about 15 lines,
    extract `verifyWithStore(knownHosts, broker, …)` into `prompts.ts`
    and use it from both.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): tunnel manager with liveness, backoff, lock policy, auto-start and events`

---

### Task 7: ssh config forwards → tunnels on import

**Files:**
- Create: `src/main/inventory/forward-spec.ts`.
- Modify:
  - `src/shared/inventory.ts`:
    - `SshForward.type` gains `'D'`;
    - `SshImportRequest.forwards?: boolean`;
    - `SshImportResult.tunnelsCreated: number`.
  - `src/main/inventory/ssh-config.ts` (parse `dynamicforward`);
  - `src/main/inventory/ssh-import.ts`;
  - `src/main/ipc/validators.ts`;
  - `src/renderer/src/pages/hosts/ImportDialog.tsx`;
  - `tests/fixtures/ssh/basic.conf` (add `DynamicForward 1080` and
    `RemoteForward 9000 localhost:3000` to an existing host).
- Test:
  - `tests/main/forward-spec.test.ts` (new);
  - `tests/main/ssh-config.test.ts`;
  - `tests/main/ssh-import.test.ts`;
  - `tests/renderer/hosts-page.test.tsx` (the import dialog).

**Interfaces:**
- `parseForwardSpec(f: SshForward, alias: string): { input: Omit<TunnelInput, 'hostId'> } | { error: string }`.
  The OpenSSH forms are:
  - `L`/`R`: `[bind_address:]port host:hostport`;
  - `D`: `[bind_address:]port`;
  - bracketed IPv6 (`[::1]:5433`) and `*` (meaning `0.0.0.0`) are
    accepted.

  These are unsupported and return errors:
  - a Unix socket path (contains `/`): `unix socket forwards aren't supported`;
  - single-argument `RemoteForward` (reverse SOCKS):
    `reverse dynamic forwards aren't supported`;
  - an unparsable spec: `can't read this forward`.

  Labels:
  - `L`/`R`: `${alias} ${type} ${port} → ${host}:${hostport}`;
  - `D`: `${alias} SOCKS ${port}`;
  - cut to `MAX_LABEL`.

  Imported tunnels get `autoStart false` and `autoReconnect true`.
- Importer:
  - **Request:** `forwards` defaults to `true`.
  - **For each created host:** create one tunnel per parsable forward, in
    the same `inTransaction`, with `TunnelStore.insertInTx`.
  - **For a candidate skipped as `exists`, with forwards:** create its
    tunnels against the existing host, skipping any `findSame` match.
  - **`MAX_TUNNELS`:** the importer respects it. The overflow becomes the
    warning `Tunnel limit reached; <n> forwards skipped`.
  - **Warnings:**
    - an unparsable forward gives `<alias>: <error>`;
    - the old preview warning
      `${n} port forward(s) will be offered when Tunnels arrive` becomes
      `${n} port forward${n === 1 ? '' : 's'} will become tunnel${n === 1 ? '' : 's'}`.
  - **Audit:** the `host.import` details gain `tunnels: <count>`. Each
    tunnel isn't audited separately on import, matching how import audits
    hosts.
- `ImportDialog`:
  - a checkbox `Also create tunnels for N port forwards`, checked by
    default and shown only when the selected candidates have forwards;
  - the result toast adds `, 3 tunnels`.

  Task 8 makes the dialog refresh the tunnel store after an import.

- [ ] **Step 1: Write the failing tests**

`tests/main/forward-spec.test.ts`:
- `parses L with and without bind`:
  - `5433 localhost:5432` gives `bindAddress '127.0.0.1'`, `bindPort 5433`,
    `targetHost 'localhost'` and `targetPort 5432`;
  - `0.0.0.0:5433 db:5432` gives `bindAddress '0.0.0.0'`.
- `parses bracketed IPv6 and star`: `[::1]:8080 [fe80::1]:80` and
  `*:1080` (D) give `0.0.0.0`.
- `parses D`: `1080` gives `type 'D'` with a null target and the label
  `web SOCKS 1080`.
- `rejects unix sockets, reverse dynamic and garbage with the exact errors`.
- `labels are capped at MAX_LABEL`.

`tests/main/ssh-config.test.ts`, test `parses DynamicForward`: `DynamicForward 1080` gives `{ type: 'D', spec: '1080' }`.

`tests/main/ssh-import.test.ts`:
- `preview warns that forwards will become tunnels`: replace the old
  assertion at line 55 with `'1 port forward will become tunnel'`, then
  `'3 port forwards will become tunnels'` for the updated fixture host.
- `import creates tunnels for forwards`:
  - `tunnelsCreated` is 3;
  - `TunnelStore.list()` holds L 5433, R 9000 and D 1080 with the expected
    fields;
  - `host.import` details contain `tunnels: 3`.
- `forwards: false creates none`.
- `re-import adds forwards to an existing host without duplicates`: a
  second import gives `tunnelsCreated 0`.
- `bad forward becomes a warning, not a failure`.

`tests/renderer/hosts-page.test.tsx`, test `import dialog offers forwards and reports tunnels`:
- the checkbox text reads `Also create tunnels for 3 port forwards`;
- unchecking it sends `forwards: false`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/main/forward-spec.test.ts tests/main/ssh-config.test.ts tests/main/ssh-import.test.ts`
Expected: FAIL. `forward-spec.ts` doesn't exist, `DynamicForward` isn't
parsed, and the preview still uses the old warning.

- [ ] **Step 3: Implement.** In `ssh-config.ts`, add `dynamicforward` next
to the existing branch at line 69, within the same `MAX_FORWARDS` cap.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): import LocalForward, RemoteForward and DynamicForward as tunnels`

---

### Task 8: Renderer tunnel store, sync, event seam, sidebar badge, Switch and Sparkline

**Files:**
- Create:
  - `src/renderer/src/tunnels/store.ts`;
  - `src/renderer/src/ui/Switch.tsx`;
  - `src/renderer/src/ui/Sparkline.tsx`.
- Modify:
  - `src/renderer/src/shell/AppShell.tsx` (call `startTunnelSync()`);
  - `src/renderer/src/shell/Sidebar.tsx` (the tunnel badge);
  - `src/renderer/src/pages/hosts/ImportDialog.tsx` (call `loadTunnels()`
    after an import that created tunnels).
- Test:
  - `tests/renderer/tunnel-store.test.ts` (new);
  - `tests/renderer/ui.test.tsx`;
  - `tests/renderer/shell.test.tsx`;
  - `tests/renderer/helpers.tsx` (an `api` fake for `tunnel:*`).

**Interfaces:**
- `tunnelStore = createStore<{ tunnels: TunnelMeta[]; runtime: Record<string, TunnelRuntime>; loaded: boolean }>`;
- `statsStore`, a separate store, so stats ticks don't re-render the
  list. It is
  `Record<id, { last: TunnelStats; inSamples: number[]; outSamples: number[] }>`,
  with each ring capped at `SPARK_POINTS`;
- `useTunnel(id)` and `useTunnelStats(id)`, both selector hooks with
  `useSyncExternalStore` per id;
- `startTunnelSync(): () => void`:
  - it subscribes to `tunnel:state`, `tunnel:stats` and `tunnel:event`;
  - it loads `tunnel:list` and `tunnel:status`;
  - it is idempotent.
- `loadTunnels()`, `resetTunnels()`;
- actions, all through `attempt`:
  - `createTunnel(input)`, `updateTunnel(id, patch)`, `deleteTunnel(id)`;
  - `startTunnel(id)`, `stopTunnel(id)`.
- `onTunnelEvent(fn): () => void` is **the renderer seam** for Phases 6
  and 9. It is the only listener of `tunnel:event` in the renderer, and
  it fans out to subscribers.
- Toasts:
  - a `failed` event shows `toast.error('<label>: <error.message>')`;
  - `up` with `recovered: true` shows `toast('<label> is back up')`.

  Nothing else toasts, and messages come from main already redacted.
- `Switch({ checked, onChange, label, busy?, disabled? })`:
  - a `role="switch"` button with `aria-checked`;
  - the knob slides with `spring`;
  - `busy` shows a small spinner in the knob;
  - under reduced motion there is no slide, only the end position.
- `Sparkline({ values, max?, tone, label })`:
  - an SVG `polyline` with a soft area fill under it;
  - `aria-hidden` on the SVG, plus a visually hidden text `label`;
  - points are scaled to a 100×24 viewBox;
  - an all-zero series is a flat line at the bottom.
  - `sparkPoints(values, max)` is exported and pure.
- Sidebar:
  - the Tunnels item shows the count of `up` tunnels;
  - a dot is red if any tunnel is `failed`, otherwise amber if any is
    `retrying` or `connecting`;
  - its `aria-label` is `3 tunnels up, 1 failed`.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/tunnel-store.test.ts` (with `resetTunnels` in `afterEach`):
- `sync loads list and status`.
- `state events update runtime`.
- `stats events append to a ring capped at 60`: 61 events leave 60
  samples, the oldest dropped.
- `stats ticks don't notify tunnelStore subscribers`.
- `onTunnelEvent fans out and unsubscribes`.
- `failed event toasts the redacted message once`.
- `startTunnelSync twice subscribes once`.
- `import reloads tunnels`: an import result with `tunnelsCreated: 2`
  triggers one `tunnel:list` call.

`tests/renderer/ui.test.tsx`:
- `Switch toggles with click and Space and exposes aria-checked`;
- `Sparkline scales points`: `sparkPoints([0, 5, 10], 10)` is
  `'0,24 50,12 100,0'`;
- `Sparkline all-zero is flat`.

`tests/renderer/shell.test.tsx`, test `sidebar shows up tunnels and a failed dot`: two `up` tunnels and one `failed` give the text `2` and the aria label `2 tunnels up, 1 failed`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/tunnel-store.test.ts tests/renderer/ui.test.tsx tests/renderer/shell.test.tsx`
Expected: FAIL. The store, `Switch` and `Sparkline` don't exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): renderer tunnel store, event seam, sidebar badge, Switch and Sparkline`

---

### Task 9: Tunnels page: live cards, route animation, throughput, toggles, states

**Files:**
- Create:
  - `src/renderer/src/pages/tunnels/TunnelsPage.tsx`;
  - `TunnelCard.tsx`;
  - `RouteLine.tsx`.
- Modify:
  - `src/renderer/src/shell/AppShell.tsx`: remove the `tunnels` entry from
    `PLACEHOLDERS` and add the `/tunnels` route;
  - `src/renderer/src/ui/tokens.css`: the `od-flow` dash keyframes and the
    `od-pulse` keyframes, both disabled under
    `prefers-reduced-motion: reduce`.
- Test: `tests/renderer/tunnels-page.test.tsx` (new).

**Behaviour:**
- **Page layout:**
  - **Header:** the title `Tunnels`, a summary `3 up · 1 retrying · 1 failed`,
    and the buttons **New tunnel** and **Import from ssh config** (which
    opens the Phase 3 `ImportDialog`).
  - **Filter chips:** `All | Running | Failed`.
  - **Cards:** a responsive grid, grouped by host, with the host label as
    a group heading and the environment colour chip when there is one.
  - **Animation:** cards use `layout` and `AnimatePresence` (they spring in
    on create and collapse out on delete).
- **`TunnelCard`:**
  - **Top row:** a type chip (`L` / `R` / `SOCKS`, each with its own
    lucide icon), the label, the protected lock badge, the `Exposed` badge
    and a `RowMenu` (Edit, Duplicate, Copy address, Delete).
  - **The start/stop `Switch`:**
    - on when the state is not `stopped` or `failed`;
    - `busy` while `connecting`;
    - toggling calls `startTunnel` or `stopTunnel`.
  - **`RouteLine`:** an SVG of three nodes, `127.0.0.1:5433 → db → localhost:5432`.
    - For `R` the arrows point the other way:
      `db:9000 → this Mac → localhost:3000`.
    - For `D` it is `127.0.0.1:1080 → db → *`.
    - When `up`, the connector dashes flow (`od-flow`), and speed scales
      with the current rate in 3 steps.
    - When `connecting` or `retrying`, the jump hops light up as in
      Phase 4's ConnectOverlay, and the dashes are amber and still.
    - When `failed`, the connector is red, with a break glyph at the side
      that failed: the local side for bind errors, the remote side
      otherwise.
  - **Status line:**
    - **`connecting`:** a dot pulse and `Connecting…`.
    - **`up`:** a green dot, `Up 12 min`, and `Liveness: keepalive only`
      when it applies.
    - **`retrying`:** an amber dot and
      `Retrying in 4 s (attempt 2 of 5)`, counted down live from `retryAt`.
      A `locked` pause shows `Waiting for unlock` with a padlock.
    - **`failed`:** a red dot, the error message, and **Retry** (calls
      `startTunnel`). The card shakes once (`useShake`) when it first
      becomes failed. `port-in-use` errors show the message verbatim
      (it names the holder).
  - **Throughput:** `↓ 1.2 MB/s ↑ 30 KB/s · 3 connections`, next to a
    `Sparkline` of `inSamples + outSamples`. The stats come from
    `useTunnelStats(id)` only.
  - **Status glow:** on each state change, the card's border colour
    transitions (green, amber, red), and reaching `up` plays a single soft
    ring ripple.
  - **Reduced motion:** no flow, no pulse, no shake and no ripple, so
    state shows as colour and text alone.
- **Empty state:**
  - `EmptyState` with an animated cable illustration (still under reduced
    motion);
  - the copy `Port forwards that stay up`;
  - actions **New tunnel** and **Import from ssh config**.
- **Loading:** `Skeleton` cards until `loaded`.

- [ ] **Step 1: Write the failing tests** (`tests/renderer/tunnels-page.test.tsx`, with fake api and `resetTunnels`)
- `placeholder is gone and /tunnels renders the page`.
- `groups cards by host with environment chip`.
- `toggle starts and stops`:
  - clicking the switch calls `tunnel:start` with the id;
  - a `tunnel:state` event of `up` turns the switch on with the status
    `Up`;
  - clicking again calls `tunnel:stop`.
- `retrying shows a live countdown`:
  - `retryAt` is now + 4000 with `failures: 2`;
  - the text is `Retrying in 4 s (attempt 2 of 5)`;
  - advancing 1 s gives `3 s`.
- `locked pause shows waiting for unlock`.
- `failed shows the holder message and Retry calls start`:
  - the message is `Port 5433 on 127.0.0.1 is in use by postgres (pid 812)`;
  - Retry calls `tunnel:start`.
- `keepalive-only liveness is labelled`.
- `exposed and protected badges render`.
- `throughput renders from stats without re-rendering siblings`:
  - emit a `tunnel:stats` event for one card;
  - a render counter on the other card stays the same.
- `filter chips narrow the grid`.
- `empty state offers create and import`.
- `reduced motion disables flow and pulse`: with `matchMedia` reduced, no
  element has the `od-flow` or `od-pulse` class.
- `R route draws reversed`: the text order is `db:9000`, `this Mac`,
  `localhost:3000`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/tunnels-page.test.tsx`
Expected: FAIL. `TunnelsPage` doesn't exist, and `/tunnels` still renders
the placeholder.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): Tunnels page with live cards, route animation and throughput`

---

### Task 10: Create/edit dialog, palette commands, host page entry points, protected delete, roadmap

**Files:**
- Create:
  - `src/renderer/src/pages/tunnels/TunnelDialog.tsx`;
  - `src/renderer/src/tunnels/commands.ts`;
  - `src/renderer/src/pages/hosts/HostTunnels.tsx`.
- Modify:
  - `TunnelsPage.tsx` and `TunnelCard.tsx` (wire up the dialog, Duplicate
    and Delete);
  - `src/renderer/src/pages/hosts/HostView.tsx` (mount `HostTunnels`);
  - `src/renderer/src/shell/AppShell.tsx` (register the tunnel commands);
  - `docs/superpowers/plans/2026-10-16-roadmap.md` (row 5).
- Test:
  - `tests/renderer/tunnel-dialog.test.tsx` (new);
  - `tests/renderer/tunnel-commands.test.ts` (new);
  - `tests/renderer/host-view.test.tsx`.

**Behaviour:**
- **`TunnelDialog`** handles create, edit and duplicate.
  - **Fields:**
    - **Label**.
    - **Host:** a select from `useInventory().hosts`.
    - **Environment:** optional. It lists only the environments that hold
      the chosen host, and clears itself if the host changes.
    - **Type:** a three-way segmented control (`Local`, `Remote`,
      `SOCKS`). A small diagram animates between the three route shapes,
      using the same `RouteLine`.
    - **Bind address:** defaults to `127.0.0.1`, with quick chips
      `127.0.0.1` and `0.0.0.0`.
    - **Bind port**.
    - **Target host and target port:** they collapse away with a height
      animation for `SOCKS`.
    - **Start on launch** and **Reconnect automatically**, both as
      `Switch`es.
  - **Equivalent command:** a live, read-only line such as
    `ssh -L 127.0.0.1:5433:localhost:5432 db`, with a copy button. It uses
    the host label, never the address or user.
  - **Warnings** (inline, non-blocking):
    - an exposed bind, with the copy from Global Constraints;
    - a local bind port under 1024 (`L`/`D`): `Ports below 1024 need admin rights`;
    - another saved tunnel with the same bind address and port:
      `"db replica" uses the same port; they can't run at the same time`.
  - **Errors:** validation copy matches the store errors, shown inline.
    Saving is blocked until the required fields are valid.
  - **Editing:**
    - an edit sends only the changed fields;
    - switching to `SOCKS` sends `targetHost: null, targetPort: null`;
    - editing a running tunnel shows `Saving restarts this tunnel` above
      the footer when the route changes.
  - **Duplicate:** opens prefilled, with the label `<label> copy` and bind
    port + 1.
- **Delete:**
  - `ConfirmDialog`, with `typeToConfirm` set to the environment name when
    the tunnel's environment is `protected`, and the plain confirm
    otherwise;
  - deleting a running tunnel says `It will be stopped first`.
- **Palette** (`registerCommands`, re-registered when the tunnel list or
  states change):
  - `New tunnel`;
  - `Go to Tunnels`;
  - for each tunnel, `Start tunnel <label>` when it is `stopped` or
    `failed`, and `Stop tunnel <label>` otherwise. The keywords are the
    host label, the type and the bind port.
- **`HostTunnels`** on `HostView`:
  - a card listing that host's tunnels as compact rows, each with a status
    dot, the label, the route summary and a `Switch`;
  - **New tunnel for this host**, which opens the dialog with `hostId`
    prefilled, and `environmentId` too when HostView has an environment
    context;
  - when the host has no tunnels, a one-line empty state.
- **Roadmap row 5:** `done (branch \`phase5-tunnels\`)`, with the plan file
  `2026-10-17-phase5-tunnels.md`.

- [ ] **Step 1: Write the failing tests**

`tests/renderer/tunnel-dialog.test.tsx`:
- `creates an L tunnel`:
  - fill in the fields;
  - the command preview reads `ssh -L 127.0.0.1:5433:localhost:5432 db`;
  - saving calls `tunnel:create` with the exact input.
- `SOCKS hides target fields and sends none`.
- `environment options follow the host`.
- `exposed bind warns but still saves`.
- `duplicate bind port warns with the other tunnel's label`.
- `edit sends only changed fields and switching to SOCKS nulls the target`.
- `editing a running tunnel's route shows the restart note`.
- `store error shows inline`: the fake rejects with
  `bind address must be an IP address or localhost`, and the message shows
  under the field.

`tests/renderer/tunnel-dialog.test.tsx` (delete):
- `protected environment delete needs the typed name`: the confirm stays
  disabled until `prod` is typed.
- `unprotected delete is a plain confirm`.

`tests/renderer/tunnel-commands.test.ts`:
- `registers start for stopped and stop for up tunnels`.
- `re-registers when state changes`: an `up` event swaps
  `Start tunnel db` for `Stop tunnel db`.
- `New tunnel opens the dialog`.

`tests/renderer/host-view.test.tsx`:
- `HostView lists host tunnels with toggles`.
- `New tunnel for this host prefills host and environment`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/renderer/tunnel-dialog.test.tsx tests/renderer/tunnel-commands.test.ts tests/renderer/host-view.test.tsx`
Expected: FAIL. `TunnelDialog`, `tunnels/commands.ts` and `HostTunnels`
don't exist.

- [ ] **Step 3: Implement.** Update roadmap row 5.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(tunnels): tunnel dialog, palette commands, host tunnels card; roadmap row 5 done`

---

## Self-review notes

- **Spec coverage:**
  - G5 by T1, T6 and T9.
  - G8 by T6 (backoff, failure limit, auto-start, lock) and T8–T9 (the
    status dot and states).
  - G9 forwards by T7.
  - G13 by T8–T10, with reduced motion in each.
  - G16 by T1 and T6.
  - §5 "never shows up while dead" by T6 (`up` only after a probe; the
    link's close drives `retrying`) and Review Focus 1.
  - §7 Tunnel by T1. `environment_id` is a justified addition.
  - §8.3:
    - start and stop from the list (T9) and the host page (T10). The map
      is Phase 6, reading the same store;
    - liveness by T3, T4 and T6;
    - backoff by T6;
    - the port clash with `lsof` by T5.
- **Constraints from the brief:**
  - No plaintext secrets: Global Constraints, plus T6 `errors never leak
    secrets`.
  - known_hosts is read only: the Phase 4 store is reused.
  - Tests stay local: every test binds `127.0.0.1:0`.
  - The protected-environment ruling is in Global Constraints and is
    pinned in T10.
  - The lock policy is consistent with Phase 4 (tunnels survive and prompts
    are cancelled). It deliberately pauses instead of failing, with the
    reason stated.
  - Each host context reuses one `ssh2` connection (T6 `two tunnels on one
    host share one SSH connection`).
  - SOCKS5 adds no new dependency.
  - Non-loopback warnings in T1, T9 and T10.
  - The event seam in T6 (main) and T8 (renderer).
- **Types:**
  - `TunnelMeta`, `TunnelInput`, `TunnelPatch`, `TunnelRuntime`,
    `TunnelStats`, `TunnelEvent` and `TunnelErrorCode` are defined in T1
    and used unchanged in T3–T10.
  - `ForwardHandle`, `Counter`, `ProbeTokens` and `Timers` are defined in
    T3 and used by T4 and T6.
  - `BindError` and `listen` are defined in T5 and used by T6.
  - `PromptBroker` is defined in T2 and used by T6.
- **Deferred:**
  - Teams and macOS notifications, and Explain & fix on a failed tunnel
    (Phase 9, through `onTunnelEvent`/`onEvent`);
  - map edges (Phase 6);
  - a settings UI for the failure limit;
  - SOCKS auth and UDP ASSOCIATE;
  - Unix-socket forwards;
  - reverse dynamic forwards.
