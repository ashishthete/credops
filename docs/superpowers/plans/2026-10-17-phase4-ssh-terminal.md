# OpsDeck Phase 4: SSH Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interactive terminals in tabs:
- SSH sessions to any host, opened with or without an environment context.
  They use the Phase 3 resolution (host → environment → global) for port,
  identity and jump chain.
- Jump hosts through chained `forwardOut` sockets.
- Known-hosts checking against `~/.ssh/known_hosts` plus the app's own store.
  A host seen for the first time asks you (TOFU); a changed key blocks loudly.
- A local shell tab.
- A Terminals section where every connection is visible and animated as it
  dials hop by hop. Sessions survive page changes and a vault lock.
- Audit events for session open and close and for known-host trust, removal
  and mismatch.

**Architecture:**
- **Main owns every connection** (§6).
  - `src/main/ssh/` holds three pure-ish modules, each testable with an
    in-process `ssh2` `Server`:
    - `known-hosts.ts`: parses OpenSSH files and holds the app store;
    - `auth.ts`: turns an identity into an ordered list of auth methods;
    - `connect.ts`: dials the hop chain.
  - `SessionManager` (`sessions.ts`) runs SSH and local sessions behind one
    `Pty`-like interface. It keeps a scrollback ring buffer per session,
    batches output into events, and brokers prompts (host key, password,
    keyboard-interactive) to the renderer.
- **The renderer is UI only.**
  - A session store mirrors `SessionMeta` from events.
  - A terminal registry keeps one xterm.js instance per session. It lives
    outside the router, so instances survive navigation.
  - When the shell remounts after a lock, every view replays the session's
    main-side buffer through `session:attach`.
  - `TerminalDeck` is mounted once in `AppShell` and shown only on
    `/terminals`.

**Tech Stack:** Phases 1–3, plus these new dependencies:
- `ssh2` 1.17.x (runtime);
- `node-pty` 1.1.x (runtime, native, N-API);
- `@xterm/xterm` 6.x, `@xterm/addon-fit`, `@xterm/addon-search` and
  `@xterm/addon-web-links` (renderer, bundled);
- `@types/ssh2` (dev).

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md`:
- §3 G3 (default auth), G4 (tabs, jump hosts), G7 (defaults), G13 (smooth
  transitions) and G16 (audit: SSH session open/close);
- §5 anti-goals: no plaintext secrets; animation never blocks input or
  delays output;
- §6 SSH (`ssh2`, chained `forwardOut`, agent via `SSH_AUTH_SOCK`), known
  hosts (TOFU, block on change) and terminal (xterm.js plus the fit, search
  and web-links addons, local shell via `node-pty`);
- §7 Host `keepalive` and `env_vars`, KnownHost, and "Credential and route
  resolution";
- §8.2 SSH sessions;
- §9 item 4;
- §10 feel.

Roadmap and contracts: `docs/superpowers/plans/2026-10-16-roadmap.md`. Conventions: the Phase 2 and Phase 3 plans in the same folder.

## Global Constraints

- **All Phase 1–3 constraints still hold:**
  - the window flags and CSP;
  - the renderer imports no Node, and the preload requires only `electron`;
  - modules under test import only *types* from `electron`;
  - storage is `node:sqlite`;
  - every IPC channel has a validator in `VALIDATORS`. Validator errors name
    the path and the rule, never the value;
  - mutations call `vault.assertUnlocked()`;
  - audit is appended after COMMIT;
  - renderer mutations go through `attempt(...)`.
- **Migration 4 only**, via `ALTER TABLE` and `CREATE TABLE`. Migrations 1–3
  are never edited. Migration 4 adds:
  - `hosts.keepalive_sec` (NULL = default; CHECK `IS NULL OR BETWEEN 0 AND 3600`;
    `0` = off);
  - `hosts.env_vars` (`TEXT NOT NULL DEFAULT '{}'`, a JSON object);
  - `known_hosts(id TEXT PRIMARY KEY, host TEXT NOT NULL, key_type TEXT NOT NULL,
    key TEXT NOT NULL, fingerprint TEXT NOT NULL, first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL, UNIQUE(host, key_type))`.

  `startup_snippet_id` waits for Phase 7.
- **Limits.** These go in `src/shared/ssh.ts`; the env var limits go in
  `src/shared/inventory.ts`.
  - **Keepalive:** `DEFAULT_KEEPALIVE_SEC = 30`, sent every N seconds;
    `ssh2` `keepaliveCountMax: 3`.
  - **Timeouts:** `READY_TIMEOUT_MS = 20000` per hop;
    `PROMPT_TIMEOUT_MS = 120000` (an unanswered prompt counts as cancelled).
  - **Sessions:** at most `MAX_SESSIONS = 32` open at once.
  - **Scrollback:** a `SCROLLBACK_CHARS = 1_048_576` ring buffer per session,
    trimmed from the front.
  - **Output batching:** flushed every `FLUSH_MS = 16` ms, or as soon as
    `FLUSH_CHARS = 65536` are pending.
  - **Input:** `MAX_WRITE_CHARS = 65536` per `session:write`; the renderer
    sends pastes in 32 KiB chunks.
  - **Size:** `cols` 1–1000 and `rows` 1–500.
  - **Env vars:** `MAX_ENV_VARS = 32` per host. Names match
    `ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/`. A value is at most
    1024 chars, with no Cc, Cf, U+2028, U+2029 or U+0085.
  - **Files:** `MAX_KNOWN_HOSTS_BYTES = 4 MiB`. A bigger file is skipped
    with one warning and is treated as empty.
- **Known hosts** (§6):
  - `~/.ssh/known_hosts` is **read only**; the app never writes it.
  - Trust decisions go to the app's `known_hosts` table.
  - A key counts as known if either source has the same type and key for the
    host token.
  - The host token is `address` when the port is 22, and `[address]:port`
    otherwise, lowercased (OpenSSH rules). Hashed `|1|salt|hash` entries,
    comma lists, `*`/`?` wildcards and `!` negation all match.
  - `@revoked` blocks the key. `@cert-authority` lines are ignored (there is
    no certificate support).
  - If either source holds a **different key of the same type** for the
    token, the connection is refused with code `host-key-changed`, and you
    are not asked.
  - A host known only with other key types counts as unknown, and the prompt
    says so.
  - Fingerprints are OpenSSH style: `SHA256:` followed by the unpadded base64
    of the raw key's SHA-256.
- **Default auth** (§7 step 3, G3):
  - ssh-agent first, when `SSH_AUTH_SOCK` is set and the path exists;
  - then `~/.ssh/id_ed25519`, then `~/.ssh/id_rsa`, each only if it exists,
    is a regular file, is ≤ `MAX_PRIVATE_KEY_BYTES` and is not encrypted.
    An encrypted default key is skipped with the note `id_ed25519 needs a
    passphrase: add it to ssh-agent (ssh-add) or link it in a vault`.
  - If every configured method fails and the server still offers `password`
    or `keyboard-interactive`, you are asked **once** for a password. It is
    never stored or logged.
- **Secrets:**
  - Passwords, passphrases and private keys live only in main memory, for the
    life of one connect attempt.
  - They never appear in `SessionMeta`, events, errors, audit or logs.
  - Error text sent to the renderer passes through `redact()`.
  - Terminal output is never written to disk or to the audit trail.
- **Lock policy (ruling):**
  - Open sessions keep running across a vault lock.
  - Pending prompts are cancelled when the lock happens.
  - New connections need the vault unlocked, because identity resolution
    asserts it.
  - Quitting the app closes every session; each close is audited with reason
    `quit`.
- **Audit:** new actions appended to `AUDIT_ACTIONS`:
  - `ssh.open`: `success` when ready; `failure` with `details.code`;
  - `ssh.close`;
  - `shell.open`, `shell.close`;
  - `knownhost.trust`, `knownhost.remove`;
  - `knownhost.mismatch` (outcome `denied`).

  The target is the host and its label (`targetType: 'host'`), or
  `targetType: 'shell'` with the label `Local shell`. Known-host events use
  `targetType: 'knownhost'` with the host token as the label.

  `details` may hold:
  - `environmentId`, `hops` (a count) and `auth` (`agent|key|password|default|prompt`);
  - `durationSec` and `reason` (`user|remote|error|quit`);
  - `code`, `keyType` and `fingerprint` (fingerprints are public).

  They never hold addresses, usernames, typed input or output.
- **Tests never touch the real `~/.ssh`, `SSH_AUTH_SOCK` or network.**
  - Every module takes `home`, `knownHostsPath`, `env` and file readers from
    deps.
  - SSH tests run `ssh2` `Server`s on `127.0.0.1:0` with generated host
    keys, in `tests/main/ssh-server.ts`.
  - Tmp dirs are removed with `onTestFinished`.
- **Feel** (Phase 1 rule, unchanged):
  - springs from `ui/motion.ts`;
  - `useMotionSafe()` false means no transforms and no looping pulses.
  - Typing and output never wait on an animation: xterm writes are never
    deferred behind React state.
- **Shortcuts:**
  - Section shortcuts stay `mod+1…mod+7` (Terminals is section 7).
  - Tabs use `mod+t` (new local shell), `mod+w` (close tab),
    `mod+shift+]` / `mod+shift+[` (next / previous) and `mod+f` (search).
  - Inside the terminal, `mod+…` combos that the app owns (the ones above,
    plus `mod+k` and `mod+1…7`) go to the app.
  - Every other key, including all `ctrl+…`, goes to the terminal.

## Review Focus

1. **A flood of output** (`yes`, `cat` of a huge log). The UI stays
   responsive and memory is bounded, so events are coalesced and the ring
   buffer is capped. *Pinned:* the Task 5 test `coalesces a flood into
   batched events and caps scrollback`.
2. **An unreachable target or dead jump host.** The tab doesn't stay on
   "connecting": it fails within the timeout and names the hop that failed.
   *Pinned:* the Task 4 test `names the failing hop when the jump target is
   closed`.
3. **A tab closed while connecting or while a host-key prompt is open.** The
   dial is aborted and the prompt is dismissed. No client is leaked and no
   `ssh.open success` is audited. *Pinned:* the Task 5 test `close during a
   pending host-key prompt aborts cleanly`.
4. **The remote side exits.** The tab shows "Session ended", `ssh.close` is
   audited exactly once with reason `remote`, and Reconnect works in the
   same tab. *Pinned:* the Task 5 test `remote exit closes once and
   reconnect reuses the tab`.
5. **A changed key stored as a hashed `[host]:port` entry in
   `~/.ssh/known_hosts`.** The connection is blocked, not prompted.
   *Pinned:* the Task 2 test `hashed bracketed entry with a different key is
   changed` and the Task 4 test `refuses a changed key without prompting`.

Also pinned: a multi-byte UTF-8 character split across two output chunks
renders intact (Task 5, `decodes UTF-8 split across chunks`).

## File map

```
src/shared/ssh.ts                      types + limits (T1)
src/main/db/migrations.ts              migration 4 (T1)
src/main/inventory/host-store.ts       keepaliveSec, envVars (T1)
src/main/ssh/known-hosts.ts            parser, matcher, fingerprint, KnownHostStore (T2)
src/main/ssh/auth.ts                   authPlan(), default keys, ssh2 authHandler (T3)
src/main/ssh/connect.ts                connectChain(), describeError() (T4)
src/main/ssh/sessions.ts               SessionManager, ring buffer, prompt broker (T5)
src/main/ssh/local-shell.ts            node-pty adapter (T6)
src/main/ipc/handlers/sessions.ts      session:*, knownhost:* handlers (T5, T6)
tests/main/ssh-server.ts               in-process ssh2 test servers (T4)
src/renderer/src/terminal/sessions.ts  session + prompt stores, actions (T7)
src/renderer/src/terminal/registry.ts  xterm instances per session (T7)
src/renderer/src/terminal/TerminalView.tsx (T7)
src/renderer/src/pages/terminals/*     TerminalDeck, TabStrip, ConnectOverlay, QuickConnect (T8)
src/renderer/src/pages/terminals/HostKeyDialog.tsx, AuthPromptDialog.tsx, KnownHostsDialog.tsx (T9)
```

---

### Task 1: Dependencies, migration 4, shared SSH types, audit actions, host keepalive and env vars

**Files:**
- Modify:
  - `package.json`;
  - `pnpm-workspace.yaml` (add `node-pty` to `onlyBuiltDependencies`);
  - `electron-builder.yml` (`asarUnpack: ['**/node_modules/node-pty/**']`);
  - `src/main/db/migrations.ts`;
  - `src/shared/inventory.ts`;
  - `src/shared/audit.ts`;
  - `src/main/inventory/host-store.ts`, `src/main/inventory/rows.ts`;
  - `src/main/ipc/validators.ts`.
- Create: `src/shared/ssh.ts`.
- Test:
  - `tests/main/inventory-schema.test.ts`, `tests/main/hosts.test.ts`;
  - `tests/main/ipc.test.ts` (channel completeness only, if needed);
  - `tests/main/build-deps.test.ts`.

**Interfaces:**
- Produces, in `src/shared/ssh.ts`:
  - all the limits in Global Constraints;
  - `type SessionKind = 'ssh' | 'local'`;
  - `type SessionState = 'connecting' | 'ready' | 'closed' | 'failed'`;
  - `type HopState = 'pending' | 'connecting' | 'up' | 'failed'`;
  - `interface SessionHop { label: string; state: HopState }`:
    - for SSH, the hops are the jump chain then the target, first first;
    - for a local shell, the list is empty.
  - `type SshErrorCode = 'refused' | 'not-found' | 'timeout' | 'auth' |
    'host-key-changed' | 'host-key-revoked' | 'host-key-rejected' | 'locked' |
    'limit' | 'closed' | 'unknown'`;
  - `interface HostKeyInfo { host: string; keyType: string; fingerprint: string;
    known: { keyType: string; fingerprint: string; source: 'app' | 'openssh'; line?: number }[] }`;
  - `interface SessionError { code: SshErrorCode; message: string; hopLabel?: string; hostKey?: HostKeyInfo }`;
  - `interface SessionMeta`, with these fields:
    - `id: string`, `kind: SessionKind`;
    - `hostId: string | null`, `environmentId: string | null`;
    - `label: string`;
    - `color: string | null` (the environment colour; `null` when there is
      no context);
    - `state: SessionState`, `hops: SessionHop[]`, `error: SessionError | null`;
    - `openedAt: string`, `readyAt: string | null`, `closedAt: string | null`;
    - `attempt: number` (starts at 1; each reconnect adds 1).
  - `interface OpenSshRequest { hostId: string; environmentId?: string; cols: number; rows: number }`;
  - `interface OpenLocalRequest { cols: number; rows: number }`;
  - `type SessionPrompt`, one of:
    - `{ kind: 'host-key'; promptId; sessionId; hopLabel; info: HostKeyInfo }`;
    - `{ kind: 'password'; promptId; sessionId; hopLabel; username: string }`;
    - `{ kind: 'keyboard'; promptId; sessionId; hopLabel; name: string;
      instructions: string; prompts: { prompt: string; echo: boolean }[] }`;
  - `type PromptAnswer`, one of:
    - `{ kind: 'host-key'; trust: boolean }`;
    - `{ kind: 'password'; password: string | null }`;
    - `{ kind: 'keyboard'; responses: string[] | null }`;

    `null` means cancel.
  - `interface KnownHostMeta { id: string; host: string; keyType: string;
    fingerprint: string; firstSeen: string; lastSeen: string }`.
- Produces, in `src/shared/inventory.ts`:
  - `HostInput`/`HostPatch` gain `keepaliveSec?: number | null` and
    `envVars?: Record<string, string>`;
  - `HostMeta` gains `keepaliveSec: number | null` and
    `envVars: Record<string, string>`;
  - `MAX_ENV_VARS`, `ENV_NAME`, `MAX_ENV_VALUE = 1024`.
- `AUDIT_ACTIONS` gains the seven actions from Global Constraints.

- [ ] **Step 1: Add dependencies**

```bash
pnpm add ssh2@^1.17.0 node-pty@^1.1.0
pnpm add -D @types/ssh2@^1.15.6 @xterm/xterm@^6.0.0 @xterm/addon-fit@^0.11.0 @xterm/addon-search@^0.16.0 @xterm/addon-web-links@^0.12.0
```

Add `node-pty` to `onlyBuiltDependencies`. Leave `ssh2`'s optional
`cpu-features` unbuilt; `ssh2` works without it.

- [ ] **Step 2: Write the failing tests**

`tests/main/build-deps.test.ts`:
- `ssh2 and node-pty are runtime dependencies`:
  - read `package.json`;
  - expect `dependencies.ssh2` and `dependencies['node-pty']` to be defined;
  - expect `devDependencies['@xterm/xterm']` to be defined.
- `node-pty is unpacked from asar`: read `electron-builder.yml` and expect
  it to contain `node_modules/node-pty`.

`tests/main/inventory-schema.test.ts`, test `migration 4 adds keepalive, env vars and known_hosts`:
- `PRAGMA table_info(hosts)` includes `keepalive_sec` and `env_vars`.
- Inserting a host with `keepalive_sec = 4000` throws a CHECK error.
- `known_hosts` rejects a second row with the same `(host, key_type)`.

`tests/main/hosts.test.ts`:
- `stores keepalive and env vars`:
  - create `{ ..., keepaliveSec: 0, envVars: { LANG: 'en_US.UTF-8' } }`;
  - `list()` returns them;
  - a patch of `{ envVars: {} }` clears them;
  - the audit `details.fields` equals `['envVars']`, and no audit `details`
    contains `en_US`.
- `rejects bad env vars`, each with an error that names the rule, never the
  value:
  - the name `1BAD`;
  - 33 entries;
  - a value containing ` `;
  - a value of 1025 chars.
- `envVars no-op patch is not audited`: patching the same object with the
  keys in a different order appends no audit event.
- IPC rejection: `host:create` with `keepaliveSec: 3601` fails at the
  validator, naming `keepaliveSec`.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run tests/main/build-deps.test.ts tests/main/inventory-schema.test.ts tests/main/hosts.test.ts`
Expected: FAIL. The columns are missing, `envVars` is undefined, and the
validator does not reject `keepaliveSec: 3601`.

- [ ] **Step 4: Implement**
  - Migration 4 holds the exact DDL from Global Constraints.
  - `HostStore` validates `envVars` with a `checkEnvVars()` in
    `host-store.ts`. It stores sorted-key JSON, so the no-op compare is
    order-free.
  - Validators: `keepaliveSec` is `v.nullable(int 0..3600)`; `envVars` is a
    plain-object record of strings, at most 32 keys (the store re-checks the
    rules).
  - Write `src/shared/ssh.ts` with the types and limits.
  - Extend `AUDIT_ACTIONS`.

- [ ] **Step 5: Run the tests, then the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**: `feat(ssh): deps, migration 4, shared ssh types, host keepalive and env vars`

---

### Task 2: Known hosts: OpenSSH parser, matcher, fingerprints and the app store

**Files:**
- Create: `src/main/ssh/known-hosts.ts`.
- Test: `tests/main/known-hosts.test.ts`.
- Fixtures: generate them in the test, using `ssh2`
  `utils.generateKeyPairSync('ed25519')` and `('ecdsa', { bits: 256 })`. Hash
  entries with `createHmac('sha1', salt)`.

**Interfaces:**
- Produces:
  - `hostToken(address: string, port: number): string`;
  - `fingerprintOf(keyBase64: string): string`;
  - `interface KnownHostLine { line: number; marker: 'revoked' | 'cert-authority' | null; matches(token: string): boolean; keyType: string; key: string }`;
  - `parseKnownHosts(text: string): KnownHostLine[]`, which skips malformed
    lines;
  - `type HostKeyStatus = 'match' | 'unknown' | 'changed' | 'revoked'`;
  - `class KnownHostStore`:
    - `constructor(db: Db, vault: VaultService, audit: AuditLog, opts: { knownHostsPath: string; now?: () => Date })`;
    - `check(address: string, port: number, keyType: string, keyBase64: string): Promise<{ status: HostKeyStatus; info: HostKeyInfo }>`.
      It reads the OpenSSH file afresh on each call (async, size-capped) and
      updates `last_seen` on an app-store match.
    - `trust(address: string, port: number, keyType: string, keyBase64: string): KnownHostMeta`.
      It upserts on `(host, key_type)`, asserts unlocked, and audits
      `knownhost.trust` with `{ keyType, fingerprint }`.
    - `list(): KnownHostMeta[]`, which works while locked;
    - `remove(id: string): void`, which asserts unlocked and audits
      `knownhost.remove`;
    - `recordMismatch(info: HostKeyInfo, hostId: string | null): void`,
      which audits `knownhost.mismatch`, outcome `denied`.

- [ ] **Step 1: Write the failing tests** (in `tests/main/known-hosts.test.ts`)
  - `hostToken brackets non-22 ports and lowercases`:
    - `hostToken('DB.Example', 22)` is `'db.example'`;
    - `hostToken('db', 2222)` is `'[db]:2222'`;
    - `hostToken('::1', 2200)` is `'[::1]:2200'`.
  - `fingerprintOf matches OpenSSH`: for a generated ed25519 public key, the
    fingerprint equals `'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')`.
  - `matches plain, comma lists, wildcards and negation`:
    - the line `a.example,*.db.example,!bad.db.example ssh-ed25519 AAAA…`
      matches `a.example` and `x.db.example`;
    - it does not match `bad.db.example` or `b.example`.
  - `matches hashed entries`: the line `|1|<salt>|<hmac(salt,'[db]:2222')>`
    matches `'[db]:2222'` and does not match `'db'`.
  - `skips malformed lines and markers it does not know`: a junk line, an
    empty line, a `# comment` and `@unknown host type key` all give no
    entries. Line numbers of the good lines stay correct (1-based).
  - `unknown when neither source knows the host`: the status is `unknown`
    and `info.known` is `[]`.
  - `match from openssh file and from app store`: both report `match`, and
    the app-store match updates `last_seen`.
  - `hashed bracketed entry with a different key is changed`:
    - the file holds a hashed `[db]:2222` ed25519 entry with key A;
    - checking with key B gives `changed`;
    - `info.known` is `[{ keyType: 'ssh-ed25519', fingerprint: fp(A), source: 'openssh', line: 1 }]`.
  - `different key type only is unknown, with known listed`: the file has
    ecdsa, the server offers ed25519. The status is `unknown` and
    `info.known` has the ecdsa entry.
  - `revoked wins over match`: with `@revoked` for key A plus a plain line
    for A, the status is `revoked`.
  - `cert-authority lines are ignored`.
  - `missing file is empty; oversized file is skipped`:
    - a missing path gives `unknown`;
    - a 4 MiB + 1 byte file gives `unknown`, and nothing throws.
  - `trust upserts and audits without the address`:
    - calling `trust` twice for the same host and type leaves one row with
      the new key;
    - the audit `details` are exactly `{ keyType, fingerprint }`;
    - `targetLabel` is the token;
    - `trust` while locked throws `VAULT_LOCKED`.
  - `remove audits and works by id; list works while locked`.

- [ ] **Step 2: Run them and watch them fail**: `pnpm vitest run tests/main/known-hosts.test.ts`. Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `known-hosts.ts`.**
  - Patterns match with the same iterative glob as `ssh-config.ts`. Reuse it
    by exporting `globMatch` from there; don't copy it.
  - A line matches when any positive pattern matches and no negated pattern
    matches.
  - Compare hashed entries with `timingSafeEqual` on equal-length buffers.
  - The status is worked out in this order:
    1. `revoked`, if any revoked line matches the token with the same key;
    2. `match`, if any source has the same type and key;
    3. `changed`, if any source has the same type and a different key;
    4. `unknown` otherwise.

- [ ] **Step 4: Run the tests, then the full suite and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit**: `feat(ssh): known hosts parser, matcher and app store`

---

### Task 3: Auth plan: identity → ordered auth methods

**Files:**
- Create: `src/main/ssh/auth.ts`.
- Test: `tests/main/ssh-auth.test.ts`. It uses a tmp home, and keys from
  `generateKeyPairSync` written as OpenSSH text with `ssh2` `utils`.

**Interfaces:**
- Consumes:
  - `IdentityRef` (shared);
  - `IdentityStore.resolve(id): Promise<ResolvedIdentity>`;
  - `MAX_PRIVATE_KEY_BYTES` and `parsePrivateKey` from `vault/openssh.ts`.
- Produces:
  - `type AuthMethod`, one of:
    - `{ type: 'agent'; agent: string }`;
    - `{ type: 'publickey'; label: string; key: string; passphrase?: string }`;
    - `{ type: 'password'; password: string }`.
  - `interface AuthPlan { username: string; methods: AuthMethod[]; notes: string[]; kind: 'agent' | 'key' | 'password' | 'default' }`.
  - `authPlan(identity: IdentityRef, deps: { identities: Pick<IdentityStore, 'resolve'>; env: Record<string, string | undefined>; home: string }): Promise<AuthPlan>`.
  - `authHandler(plan: AuthPlan, askPassword: () => Promise<string | null>): ssh2.AuthHandlerMiddleware`.
    It returns the function form `(methodsLeft, partialSuccess, next) => void`.
    It tries `plan.methods` in order, skipping any type the server didn't
    list in `methodsLeft` (when it is not `null`). After those, if
    `methodsLeft` includes `password` or `keyboard-interactive`, it calls
    `askPassword()` **once**: a string becomes a password attempt, or a
    keyboard-interactive answer when only that is offered. `null` or nothing
    left means `next(false)`.
  - `answerKeyboard(prompts: { prompt: string; echo: boolean }[], password: string | undefined): string[] | null`.
    It answers a single non-echo prompt with the password; otherwise it
    returns `null`, meaning the renderer must be asked.

- [ ] **Step 1: Write the failing tests**
  - `identity with agent auth uses SSH_AUTH_SOCK`:
    - with `env.SSH_AUTH_SOCK` set to an existing tmp socket path (a plain
      file is fine for the existence check), the methods are
      `[{ type: 'agent', agent: path }]`;
    - with it unset, `methods` is `[]` and `notes` include
      `ssh-agent isn't running (SSH_AUTH_SOCK is not set)`.
  - `identity with key auth carries key and passphrase`: with `resolve` stubbed
    to return `{ auth: 'key', privateKey: 'K', passphrase: 'P' }`, the result
    is `[{ type: 'publickey', label: <identity label>, key: 'K', passphrase: 'P' }]`.
  - `identity with password auth`: the methods are
    `[{ type: 'password', password: 'pw' }]`.
  - `global default: agent, then id_ed25519, then id_rsa`:
    - in a tmp home with both keys and the agent socket, the method types
      are `['agent', 'publickey', 'publickey']`;
    - the labels are `~/.ssh/id_ed25519` and `~/.ssh/id_rsa`;
    - the username is `identity.username`.
  - `global default skips encrypted, symlinked-outside, oversize and missing keys with notes`:
    - an encrypted id_ed25519 gives the exact note from Global Constraints;
    - an id_rsa over the cap gives the note `id_rsa is too large to be a key`;
    - a missing key gives no note.
  - `authHandler order and single password ask`, using a fake
    `next`/`methodsLeft` sequence:
    - the first call yields agent;
    - after a failure with `methodsLeft = ['publickey', 'password']`, it
      yields the publickey;
    - then it calls `askPassword` once and yields `{ type: 'password', username, password: 'typed' }`;
    - then `next(false)`;
    - `askPassword` was called exactly once.
  - `authHandler skips methods the server doesn't offer`: with
    `methodsLeft = ['password']` at the start, the agent and publickey
    methods are skipped.
  - `answerKeyboard`:
    - a single `Password:` non-echo prompt with the password set gives
      `['pw']`;
    - two prompts give `null`;
    - an echo prompt gives `null`.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.**
  - Read the default keys with `lstat`, then `readFile`. Use
    `parsePrivateKey(text)` to detect `encrypted`.
  - Agent: pass the socket path; `ssh2` speaks the agent protocol.
  - No secret goes into `notes`.

- [ ] **Step 4: Run the tests, then the full suite and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit**: `feat(ssh): auth plan with default key chain and one-shot password fallback`

---

### Task 4: Connector: dial the hop chain, verify host keys, map errors

**Files:**
- Create:
  - `src/main/ssh/connect.ts`;
  - `tests/main/ssh-server.ts` (the test helper).
- Test: `tests/main/ssh-connect.test.ts`.

**Interfaces:**
- Consumes:
  - `ResolvedHost` / `ResolvedHop` (shared);
  - `authPlan` and `authHandler` (T3);
  - `KnownHostStore` (T2).
- Produces:
  - `interface HopTarget { label: string; address: string; port: number; identity: IdentityRef }`;
  - `hopsOf(resolved: ResolvedHost, targetLabel: string): HopTarget[]`,
    which lists the chain first and the target last.
  - `interface ConnectDeps`:
    - `plan(identity: IdentityRef): Promise<AuthPlan>`;
    - `verifyHostKey(hop: HopTarget, keyType: string, keyBase64: string): Promise<boolean>`.
      It returns true to proceed. A changed or revoked key throws
      `HostKeyError`; an unknown key asks the user (wired by T5).
    - `askPassword(hop: HopTarget, username: string): Promise<string | null>`;
    - `askKeyboard(hop: HopTarget, name: string, instructions: string, prompts: { prompt: string; echo: boolean }[]): Promise<string[] | null>`;
    - `onHop(index: number, state: HopState): void`;
    - `keepaliveSec: number`;
    - `readyTimeoutMs?: number`.
  - `class HostKeyError extends Error { code: 'host-key-changed' | 'host-key-revoked' | 'host-key-rejected'; info: HostKeyInfo }`.
  - `connectChain(hops: HopTarget[], deps: ConnectDeps, signal: AbortSignal): Promise<{ client: Client; close(): void }>`.
    - Each hop after the first dials over
      `prev.forwardOut('127.0.0.1', 0, hop.address, hop.port)`.
    - `hostVerifier` uses the async callback form, with `hostHash` unset. It
      takes the key type and base64 from the raw key blob.
    - `keepaliveInterval` is `keepaliveSec * 1000`; `0` turns it off.
    - On abort, or a failure at any hop, every client opened so far is ended,
      in reverse order.
  - `describeError(err: unknown, hop: HopTarget | null): SessionError`. Its
    messages are exact:
    - `ECONNREFUSED` gives `refused`: `<label> refused the connection on port <port>`;
    - `ENOTFOUND`/`EAI_AGAIN` gives `not-found`: `Couldn't find <address>`;
    - a timeout gives `timeout`: `<label> didn't answer within 20 s`;
    - an ssh2 auth failure (`All configured authentication methods failed`)
      gives `auth`: `<label> didn't accept any of the keys or passwords tried`;
    - `HostKeyError` gives its code, its `info` and these messages:
      - `host-key-changed`: `The host key for <label> has changed. This could be an attack, so OpenSSH-style protection blocked the connection.`;
      - `host-key-revoked`: `The host key for <label> is marked revoked in known_hosts`;
      - `host-key-rejected`: `You didn't trust the host key for <label>`;
    - anything else gives `unknown` with `redact(message)`.

    `hopLabel` is set whenever there is a hop.

`tests/main/ssh-server.ts` exports `startServer(opts)`:
- Options:
  - `{ hostKey?: string; users: { username: string; password?: string; publicKey?: ParsedKey }[]; keyboard?: { prompts: string[]; answers: string[] }; onShell?: (stream, info: { env: Record<string,string>; pty }) => void; allowForward?: boolean }`.
- Returns `{ port, hostKeyType, hostKeyBase64, close(), connections(): number }`.
  - `connections()` counts live client connections, so tests can check
    nothing leaks.
- The default shell echoes its input. It writes `READY\r\n` on start and
  handles `exit\r` by exiting with code 0.
- `env` requests are recorded.
- When `allowForward` is true, `direct-tcpip` is accepted and piped to
  `127.0.0.1:<destPort>`.

- [ ] **Step 1: Write the failing tests** (`tests/main/ssh-connect.test.ts`)
  - `connects with a key and opens a shell`: the shell output contains `READY`.
  - `connects through a jump host`:
    - the bastion has `allowForward`, and the target listens on another
      port;
    - `onHop` sees `(0,'connecting')`, `(0,'up')`, `(1,'connecting')` and
      `(1,'up')`, in that order.
  - `names the failing hop when the jump target is closed`:
    - the target port is closed and listening on nothing;
    - the call rejects, and `describeError` gives
      `{ code: 'refused', hopLabel: 'target' }`;
    - the bastion's `connections()` reaches 0 within 1 s.
  - `refused when nothing listens`: the code is `refused`.
  - `times out with readyTimeoutMs`: a raw TCP server that never speaks,
    with `readyTimeoutMs: 300`, gives code `timeout` within 2 s.
  - `refuses a changed key without prompting`:
    - `verifyHostKey` comes from a real `KnownHostStore` whose file holds a
      different key for `[127.0.0.1]:<port>`;
    - the code is `host-key-changed`, and the ask stub was never called;
    - `recordMismatch` was audited once (the wiring is in T5; here, assert
      the `HostKeyError.info`).
  - `unknown key asks and rejection stops the dial`: `verifyHostKey` resolves
    false, so the code is `host-key-rejected`.
  - `falls back to one password prompt`:
    - the server accepts only the password `pw`, and the plan has a wrong
      key;
    - `askPassword` returns `pw`, the connection succeeds, and
      `askPassword` was called exactly once.
  - `keyboard-interactive is answered by the renderer when it isn't a lone password prompt`:
    - the server asks two prompts;
    - `askKeyboard` returns the answers, and the connection succeeds.
  - `abort mid-dial ends every opened client`: abort after hop 0 is up; the
    call rejects with code `closed`, and every server's `connections()`
    reaches 0.
  - `keepalive 0 disables keepaliveInterval`: spy on `Client.prototype.connect`
    and assert `keepaliveInterval: 0`.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement `connect.ts` and the server helper.** For an
  error raised during hop i's handshake, `onHop(i, 'failed')` fires before
  the call rejects.

- [ ] **Step 4: Run the tests, then the full suite and typecheck.** Expected: PASS, with no open handles (vitest exits by itself).

- [ ] **Step 5: Commit**: `feat(ssh): hop-chain connector with host key checks and friendly errors`

---

### Task 5: SessionManager, prompt broker, IPC and events

**Files:**
- Create:
  - `src/main/ssh/sessions.ts`;
  - `src/main/ipc/handlers/sessions.ts`.
- Modify:
  - `src/shared/ipc.ts` (channels and events);
  - `src/main/ipc/validators.ts`;
  - `src/main/index.ts` (wiring, quit, lock);
  - `src/main/window.ts` (a generic `pushEvent`);
  - `src/preload/bridge.ts` only if needed. `EVENTS` drives it.
- Test:
  - `tests/main/sessions.test.ts`;
  - `tests/main/sessions-ipc.test.ts`;
  - `tests/main/preload.test.ts` (new events allowed).

**Interfaces:**
- IPC channels:
  - `'ssh:open'`: `[req: OpenSshRequest] → SessionMeta`. It returns at once
    with `state: 'connecting'`.
  - `'session:reconnect'`: `[id: string] → SessionMeta`. It is SSH only,
    allowed in the `closed`/`failed` states, uses the same id and adds 1 to
    `attempt`.
  - `'session:write'`: `[id: string, data: string] → void`;
  - `'session:resize'`: `[id: string, cols: number, rows: number] → void`;
  - `'session:close'`: `[id: string] → void`. It also forgets the session:
    it leaves the list and the buffer is freed.
  - `'session:list'`: `[] → SessionMeta[]`, in open order;
  - `'session:attach'`: `[id: string] → { meta: SessionMeta; buffer: string }`;
  - `'session:answer'`: `[promptId: string, answer: PromptAnswer] → void`.
    An unknown or expired id is a no-op. A kind mismatch throws
    `prompt answer doesn't match`.
  - `'knownhost:list'`: `[] → KnownHostMeta[]`;
  - `'knownhost:remove'`: `[id: string] → void`.
- Events (`EventContract` and `EVENTS`):
  - `'session:data': { id: string; data: string }`;
  - `'session:state': SessionMeta`;
  - `'session:prompt': SessionPrompt`;
  - `'session:promptDone': { promptId: string }`.
- `class SessionManager`:
  - `constructor(deps)`. The deps are:
    - `resolve(hostId, environmentId?)`;
    - `hostInfo(hostId): { label: string; keepaliveSec: number | null; envVars: Record<string,string> }`;
    - `envColor(environmentId): string | null`;
    - `connect` (T4 `connectChain`);
    - `plan` (T3);
    - `knownHosts: KnownHostStore`;
    - `openLocal?` (T6);
    - `audit`;
    - `emit<K extends EventName>(event: K, payload: EventContract[K]): void`;
    - `now?`, `ids?`.
  - Its methods mirror the channels: `openSsh`, `openLocal`, `reconnect`,
    `write`, `resize`, `close`, `list`, `attach`, `answer`.
  - `closeAll(reason: 'quit'): void`;
  - `cancelPrompts(): void`, called on lock;
  - `interface Pty { write(data: string): void; resize(cols: number, rows: number): void; onData(cb: (chunk: Buffer | string) => void): void; onExit(cb: (info: { code: number | null }) => void): void; kill(): void }`.
    The SSH shell stream and node-pty (T6) both adapt to it.
- Behaviour:
  - **Opening a session:**
    - `ssh2` `client.shell({ term: 'xterm-256color', cols, rows }, { env: envVars })`
      is called with the window size from the request. The server may refuse
      env vars; ignore that.
    - Output is decoded with a streaming `TextDecoder('utf-8')` per session.
  - **Output:** it is appended to the ring buffer, then batched and emitted
    as `session:data`, following `FLUSH_MS`/`FLUSH_CHARS`.
  - **State:** a `session:state` is emitted on every state or hop change.
  - **Host keys:** `verifyHostKey` handles an unknown key by emitting a
    `host-key` prompt.
    - If the user trusts it, call `knownHosts.trust(...)` and return true;
      otherwise return false.
    - A changed or revoked key calls `knownHosts.recordMismatch` and throws
      `HostKeyError`.
  - **Prompts:**
    - A prompt resolves as cancelled after `PROMPT_TIMEOUT_MS`, on
      `close(id)` and on `cancelPrompts()`.
    - Each of those cases emits `session:promptDone`.
  - **Audit:**
    - `ssh.open` is audited once per attempt: success when ready, failure
      with `code` when it fails. A close during connecting audits no open
      event.
    - `ssh.close` is audited once per ready session with `durationSec` and
      `reason`.
  - **Limits:** a 33rd open session throws `Too many open sessions (32)`
    with code `limit`.
  - **Writing to a dead session:** a write to a session that is not `ready`
    is dropped silently.

- [ ] **Step 1: Write the failing tests.** `tests/main/sessions.test.ts`
  uses T4's `startServer` and a real `KnownHostStore`, and records the
  emitted events.
  - `open → ready → data flows`:
    - the states are `connecting`, then `ready`;
    - `session:data` concatenation contains `READY`;
    - after `write(id, 'hi\r')`, the echo arrives;
    - `ssh.open success` is audited, its `details` have `hops: 1` and
      `auth: 'key'`, and none of its fields contain `127.0.0.1`.
  - `first sight asks, trust stores the key and connects`:
    - a `session:prompt` of kind `host-key` arrives, with the `fingerprint`
      equal to `fingerprintOf(server key)`;
    - answering `{ kind: 'host-key', trust: true }` leads to `ready`;
    - `knownHosts.list()` has one row;
    - a second session to the same host emits no prompt.
  - `close during a pending host-key prompt aborts cleanly`:
    - close while the prompt is open;
    - `session:promptDone` is emitted;
    - the server's `connections()` reaches 0;
    - no `ssh.open` event is audited and `list()` is empty.
  - `remote exit closes once and reconnect reuses the tab`:
    - write `exit\r`;
    - the state becomes `closed`, and `ssh.close` is audited once with
      reason `remote`;
    - `reconnect(id)` brings the same id back to `ready` with
      `attempt === 2`;
    - the buffer still holds the first output, followed by
      `\r\n\x1b[2m── reconnected ──\x1b[0m\r\n`.
  - `coalesces a flood into batched events and caps scrollback`:
    - the server writes 20,000 chunks of 100 chars as fast as it can;
    - fewer than 400 `session:data` events are emitted;
    - `attach(id).buffer.length` is at most `SCROLLBACK_CHARS`;
    - the buffer ends with the last chunk.
  - `decodes UTF-8 split across chunks`: the server writes `Buffer.from('é')`
    as two one-byte chunks. The emitted data contains `é` and no `�`.
  - `failed dial reports the error and audits failure`: a closed port gives
    `state: 'failed'`, `error.code: 'refused'`, and `ssh.open` with outcome
    `failure` and `details.code: 'refused'`.
  - `prompt timeout cancels`: with fake timers past `PROMPT_TIMEOUT_MS`, the
    session fails with `host-key-rejected` and `promptDone` is emitted.
  - `cancelPrompts on lock cancels pending prompts but keeps ready sessions`.
  - `closeAll audits quit for every ready session`.
  - `session limit`: once 32 open sessions exist (stub `connect` that never
    resolves), the next one throws `Too many open sessions (32)`.
  - `answer with a mismatched kind throws; unknown prompt id is a no-op`.

  `tests/main/sessions-ipc.test.ts`:
  - The handlers delegate to a fake manager.
  - The validators reject each of these, naming the path:
    - `cols: 0`;
    - `rows: 501`;
    - a `data` of 65,537 chars;
    - an answer `{ kind: 'host-key', trust: 'yes' }`;
    - a `hostId` that isn't a string.
  - `knownhost:remove` while locked rejects with `VAULT_LOCKED`.

  `tests/main/preload.test.ts`: `on('session:data', …)` is allowed.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.**
  - **Wiring (`index.ts`):**
    - `knownHostsPath` is `join(homedir(), '.ssh', 'known_hosts')`;
    - `emit` is `pushEvent(mainWindow, …)`;
    - `vault.onLock` calls `sessions.cancelPrompts()`;
    - `before-quit` calls `closeAll('quit')` before the existing quit audit.
  - **Events:** generalize `forwardVaultLocks` into
    `pushEvent(win, name, payload)` in `window.ts`, keeping the old export as
    a thin wrapper.

- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit**: `feat(ssh): session manager with scrollback, batching, prompts and IPC`

---

### Task 6: Local shell via node-pty, and packaging

**Files:**
- Create:
  - `src/main/ssh/local-shell.ts`;
  - `tests/main/local-shell.test.ts`.
- Modify:
  - `src/main/ssh/sessions.ts` (`openLocal`);
  - `src/main/ipc/handlers/sessions.ts`;
  - `src/shared/ipc.ts` (`'shell:open': [req: OpenLocalRequest] → SessionMeta`);
  - `src/main/ipc/validators.ts`;
  - `electron.vite.config.ts`, if `ssh2`/`node-pty` are not already
    external in the main build.

**Interfaces:**
- `spawnLocalShell(opts: { cols: number; rows: number; env: Record<string, string | undefined>; home: string; shell?: string }): Pty`.
  - The shell is `opts.shell ?? env.SHELL ?? '/bin/zsh'`, with args `['-l']`.
  - Its cwd is `home`.
  - Its env is a copy of `env` with these changes:
    - every key starting with `ELECTRON_`, plus `NODE_OPTIONS`, removed;
    - `TERM=xterm-256color` and `COLORTERM=truecolor` added.
  - `node-pty` is loaded lazily with `require` inside the function, so a
    failed native load shows up as an error on open, not as a crash at
    startup. That error message is `The local shell isn't available: <reason>`.
- `SessionManager.openLocal(req)`:
  - `kind: 'local'`, `label: 'Local shell'` (the second is `Local shell 2`,
    and so on, counting open local sessions);
  - `hops: []`, `color: null`;
  - audits `shell.open` and `shell.close` (with `durationSec`, `reason`).
  - Reconnect is not allowed for local sessions: it throws
    `A local shell can't be reconnected; open a new one`.

- [ ] **Step 1: Write the failing tests**
  - `spawns a shell, runs a command, exits`:
    - spawn `/bin/sh` (pass `shell: '/bin/sh'` and `env` with no `SHELL`);
    - write `echo opsdeck-$((40+2))\r`;
    - the output contains `opsdeck-42`;
    - `exit\r` fires `onExit`.
  - `strips ELECTRON_ and NODE_OPTIONS and sets TERM`:
    - spawn with `env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', PATH: process.env.PATH }`;
    - run `env`;
    - the output has neither key, and does contain `TERM=xterm-256color`.
  - `resize changes the pty size`: run `stty size` after `resize(100, 40)`;
    the output contains `40 100`.
  - `manager: local shell audits open and close; reconnect refused; numbering`.
  - `failed native load is a clear error`: inject a loader that throws. The
    open rejects with the message prefix `The local shell isn't available:`.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** Then verify the build:
  - run `pnpm build`;
  - `grep -c "require(\"node-pty\")\|require(\"ssh2\")" out/main/index.js` is ≥ 1 each, so they are not bundled;
  - `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "require('node-pty'); require('ssh2'); console.log('ok')"` prints `ok`.

  If node-pty's prebuilt binary doesn't load under Electron, add
  `@electron/rebuild` and a `postinstall`: `electron-rebuild -o node-pty`.
  Record what you did in the report.

- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit**: `feat(ssh): local shell tab via node-pty`

---

### Task 7: Renderer session store, terminal registry and TerminalView

**Files:**
- Create:
  - `src/renderer/src/terminal/sessions.ts`;
  - `src/renderer/src/terminal/registry.ts`;
  - `src/renderer/src/terminal/TerminalView.tsx`;
  - `src/renderer/src/terminal/theme.ts`.
- Modify:
  - `src/renderer/src/ui/shortcuts.ts` (pass-through for app combos from
    inside `.xterm`);
  - `src/renderer/src/styles.css` (import `@xterm/xterm/css/xterm.css`).
- Test:
  - `tests/renderer/terminal-sessions.test.ts`;
  - `tests/renderer/terminal-view.test.tsx`;
  - `tests/renderer/ui.test.tsx` (the shortcut case).

  These tests mock `@xterm/xterm` and its addons with a fake `Terminal` that
  records `write`, `open`, `onData` and `dispose`. jsdom can't run xterm.

**Interfaces:**
- `sessions.ts`:
  - `sessionStore: { sessions: SessionMeta[]; activeId: string | null; order: string[] }`
    (`createStore`);
  - `promptStore: SessionPrompt[]` (a FIFO);
  - `startSessionSync(): () => void`:
    - subscribes to the `session:state`, `session:prompt` and
      `session:promptDone` events;
    - loads `session:list`;
    - `session:data` goes straight to the registry, never into React state.
  - `openSsh(hostId: string, environmentId?: string): Promise<string>`
    (it uses the last-known size, 80×24 by default);
  - `openLocal(): Promise<string>`;
  - `closeSession(id)`, `reconnectSession(id)`;
  - `setActive(id)`, `nextTab(dir: 1 | -1)`;
  - `moveTab(id, toIndex)`;
  - `answerPrompt(promptId, answer)`.
- `registry.ts`:
  - `getTerminal(id: string): { term: Terminal; fit: FitAddon; search: SearchAddon }`.
    It is created lazily, with `scrollback: 10000`, `fontFamily: 'JetBrains Mono Variable'`,
    `fontSize: 13`, `cursorBlink: true`, `allowProposedApi: false` and the
    theme from `theme.ts`.
  - `attachSession(id): Promise<void>`. On first use per registry life it
    calls `session:attach` and writes the buffer. Data events that arrive
    before the attach finishes are queued and written afterwards, in order.
  - `writeData(id, data)`;
  - `disposeTerminal(id)`, `disposeAll()`.
- `<TerminalView sessionId visible />`:
  - It opens the term into its div on first visible mount.
  - A `ResizeObserver` drives `fit.fit()`; after that, `session:resize` is
    sent, debounced 50 ms, only when cols or rows changed.
  - `term.onData` sends `session:write`, splitting any input over 32 KiB.
  - Copy on select: `onSelectionChange` sends a non-empty selection to
    `navigator.clipboard.writeText`.
  - `WebLinksAddon` opens links with `window.open(url)`, which main's
    `setWindowOpenHandler` routes to the browser.
  - The search bar opens on `mod+f`. Enter finds the next match,
    shift+Enter the previous; Esc closes it and refocuses the terminal.
  - `attachCustomKeyEventHandler` returns `false` for the app-owned `mod+…`
    combos, so they reach the window shortcut handler.
- `shortcuts.ts`: a combo with `mod` that fires from an element inside
  `.xterm` is not treated as typing.

- [ ] **Step 1: Write the failing tests**
  - `state events upsert sessions and keep order; close removes and picks the neighbour as active`.
  - `data goes to the registry, not the store`: after a `session:data`
    event, the store's subscribers were not called, and the fake term's
    `write` got the data.
  - `attach replays the buffer before queued live data`: `session:attach`
    resolves after a `session:data` event, and the writes come out as
    `[buffer, live]`.
  - `prompts queue FIFO and promptDone removes`.
  - `paste over 32 KiB is chunked`: an `onData` of 70,000 chars becomes 3
    `session:write` calls of at most 32,768 chars each.
  - `resize is debounced and only sent on change`.
  - `copy on select writes to the clipboard`.
  - `mod+w from inside .xterm reaches the shortcut handler; ctrl+c does not`.
  - `mod+f opens search; Esc closes and refocuses`.

- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(terminal): session store, xterm registry and terminal view`

---

### Task 8: Terminals section: tab deck, connect animation, failure and empty states

**Files:**
- Create, in `src/renderer/src/pages/terminals/`:
  - `TerminalDeck.tsx`, `TabStrip.tsx`;
  - `ConnectOverlay.tsx`, `SessionEnded.tsx`;
  - `QuickConnect.tsx`.
- Modify:
  - `src/renderer/src/shell/sections.ts`: add `{ id: 'terminals', label: 'Terminals', path: '/terminals' }`
    as the **2nd** entry, after Products;
  - `Sidebar.tsx` (the icon is `SquareTerminal`, plus a live-session count
    badge);
  - `AppShell.tsx`: it mounts `<TerminalDeck visible={pathname === '/terminals'} />`
    once, outside `<Routes>`, calls `startSessionSync()` on mount, and calls
    `disposeAll()` on unmount. The `/terminals` route renders `null`.
- Test: `tests/renderer/terminals-page.test.tsx`, plus updates to
  `tests/renderer/shell.test.tsx` for the new section order and shortcuts.

**Behaviour:**
- **Tab strip.** Each tab shows:
  - a 3px left stripe in the session `color` (`--accent` for a local shell);
  - a status dot:
    - connecting: amber, pulsing when motion is safe;
    - ready: green;
    - failed: red;
    - closed: grey;
  - the label, and the environment name as a muted suffix when there is one;
  - a close ×.

  Tabs can be dragged to reorder (framer-motion `Reorder`), and middle-click
  closes one. Opening a tab enters with the spring. Closing collapses its
  width with `fast` and never blocks the next tab from showing.
- **Closing a ready session** asks first with `ConfirmDialog`:
  "Close <label>? The session will end." A connecting, failed or closed
  session closes at once.
- **ConnectOverlay**, while connecting, is drawn over the terminal area:
  - a horizontal chain `This Mac → hop… → target`;
  - each node is a dot plus a label;
  - the link between two nodes fills left to right while the next hop is
    `connecting`, and turns solid green when that hop is `up`;
  - a failed hop shakes once (motion-safe) and turns red;
  - the overlay fades out (`fast`) on ready.

  The terminal keeps receiving data underneath it, so typing is never
  blocked once the session is ready.
- **Failed state.** A card shows:
  - the error `message`;
  - the hop label;
  - for `host-key-changed`, the expected and got fingerprints. When the
    known entry came from `openssh`, it also shows the copyable command
    `ssh-keygen -R '<token>'`; when it came from `app`, an "Open known hosts"
    button.

  It has **Reconnect** (primary) and **Close** buttons.
- **Closed state.** "Session ended" sits on a thin bar at the bottom. The
  terminal stays readable above it, and Reconnect is available for SSH.
- **Empty state** (no sessions):
  - QuickConnect: a search field (autofocus) over hosts from the inventory
    store, fuzzy matched with `fuzzyMatch`;
  - recently connected hosts come first (`markRecent('connect:<hostId>')`);
  - Enter connects;
  - a secondary "New local shell" button;
  - the hint `⌘T local shell · ⌘K connect to any host`.
- **Shortcuts:** `mod+t`, `mod+w` (only while Terminals is visible),
  `mod+shift+]` and `mod+shift+[`. Section shortcuts now run `mod+1…mod+7`.

- [ ] **Step 1: Write the failing tests**
  - `section order puts Terminals second and mod+2 opens it`.
  - `deck stays mounted across navigation`: open a session, navigate to
    `/hosts` and back. The fake term was opened once and not disposed.
  - `tab shows env colour stripe and status dot per state`.
  - `connect overlay shows the hop chain and marks the failed hop`: feed
    state events with hops `[bastion: up, db: failed]`. The overlay names
    `bastion` and `db`, and `db` has `data-state="failed"`.
  - `failed host-key-changed shows both fingerprints and ssh-keygen command for openssh source`.
  - `closing a ready tab asks; closing a failed tab does not`.
  - `reconnect button calls session:reconnect`.
  - `QuickConnect filters hosts and Enter opens ssh with no environment`.
  - `mod+t opens a local shell; mod+shift+] cycles tabs`.
  - `reduced motion: no pulse class on the connecting dot`.

- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(terminal): terminals section with tabs, connect animation and quick connect`

---

### Task 9: Prompt dialogs and the known-hosts manager

**Files:**
- Create, in `src/renderer/src/pages/terminals/`:
  - `HostKeyDialog.tsx`;
  - `AuthPromptDialog.tsx`;
  - `KnownHostsDialog.tsx`;
  - `PromptHost.tsx`, which renders the head of `promptStore`. It is mounted
    in `AppShell`, so prompts appear on any page.
- Modify: `TerminalDeck.tsx` (the "Open known hosts" button), and
  `src/renderer/src/pages/hosts/HostsPage.tsx` (header menu item "Known
  hosts…").
- Also add the palette command "Known hosts…".
- Test: `tests/renderer/session-prompts.test.tsx`.

**Behaviour:**
- **HostKeyDialog** (`kind: 'host-key'`):
  - the title is `First time connecting to <hopLabel>`;
  - it shows the key type and the fingerprint in monospace, split into
    groups of 4 characters for reading;
  - when `info.known` is non-empty: "This host is known with a different key
    type (<types>)".
  - Buttons: **Trust and connect** (primary) and **Cancel**. Esc means
    cancel. Answering sends `{ kind: 'host-key', trust }`.
- **AuthPromptDialog:**
  - `password`: the title is `Password for <username>@<hopLabel>`, with one
    password field (`autocomplete="off"`) and the buttons Connect and Cancel.
  - `keyboard`: shows `name` and `instructions`, plus one field per prompt;
    `echo: false` gives a password input.
  - The field values are cleared from component state as soon as the answer
    is sent and when the dialog closes. They never go into a store, a toast
    or the console.
- **Prompts in general:**
  - A `session:promptDone` closes the matching dialog at once.
  - A second prompt waits for the first to finish (FIFO).
- **KnownHostsDialog:**
  - lists the app-store entries (`knownhost:list`), with host token, key
    type, fingerprint and first and last seen (relative);
  - has a search filter;
  - remove asks with `ConfirmDialog` first;
  - shows the note "Entries in ~/.ssh/known_hosts are read-only here; use
    ssh-keygen -R to remove them."

- [ ] **Step 1: Write the failing tests**
  - `host-key prompt shows grouped fingerprint and trust answers true`.
  - `cancel and Esc answer false`.
  - `password prompt answers and clears the field`: after Connect, the input
    is gone, and nothing typed appears in `document.body.textContent` after
    the dialog closes.
  - `keyboard prompt renders echo and non-echo fields`.
  - `promptDone closes the dialog; next prompt in queue appears`.
  - `known hosts dialog lists, filters, and removes after confirm`.

- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(terminal): host key and auth prompts, known hosts manager`

---

### Task 10: Connect entry points, host advanced fields, roadmap

**Files:**
- Modify:
  - `src/renderer/src/pages/hosts/HostView.tsx` (a **Connect** button);
  - `HostsPage.tsx` (a row action and double-click);
  - `src/renderer/src/pages/products/EnvironmentView.tsx` (a Connect action
    on each host row, with the environment context);
  - `src/renderer/src/inventory/commands.ts` (palette commands);
  - `src/renderer/src/pages/hosts/HostDialog.tsx` (an "Advanced" disclosure);
  - `src/renderer/src/pages/hosts/ConnectionCard.tsx` (shows the effective
    keepalive);
  - `docs/superpowers/plans/2026-10-16-roadmap.md` (row 4 done).
- Test:
  - `tests/renderer/host-view.test.tsx`, `hosts-page.test.tsx`,
    `products-page.test.tsx`;
  - `tests/renderer/inventory-commands.test.ts` (create it if it's missing).

**Behaviour:**
- **Connecting opens a session and goes to `/terminals`.**
  - HostView opened from Products, with an environment selected, passes that
    `environmentId`.
  - HostView on the Hosts page passes none.
  - EnvironmentView host rows pass their environment.
- **Palette:**
  - one `Connect to <label>` command per host (keywords: address, tags,
    environment names). It uses the host's only environment when the host
    has exactly one, and none otherwise.
  - `New local shell` (`mod+t`).
  - These register through the batched `registerCommands`.
- **HostDialog "Advanced"** (collapsed by default) holds:
  - **Keepalive:** inherit (30 s), off, or a number of seconds 1–3600;
  - **Environment variables:** a key/value list with add and remove, and the
    note "Sent to the server at login. Don't put secrets here."
  - Validation copy matches the store errors. As before, the patch sends
    only the fields that changed.
- **ConnectionCard** adds a row `Keepalive 30 s (default)` / `off` / `<n> s`.
- **Roadmap** row 4: `done (branch \`phase4-ssh\`)`.

- [ ] **Step 1: Write the failing tests**
  - `HostView connect in env context opens ssh with environmentId and navigates`.
  - `HostsPage double-click connects without environment`.
  - `EnvironmentView host row Connect passes the environment`.
  - `palette Connect uses the only environment, none when several`.
  - `HostDialog advanced edits keepalive and env vars and patches only changed fields`.
  - `env var name error shows inline and blocks save`.

- [ ] **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run the full suite and typecheck.**

- [ ] **Step 5: Commit**: `feat(terminal): connect from hosts, environments and the palette; host advanced fields`

---

## Self-review notes

- **Spec coverage:**
  - G3 is covered by T3.
  - G4 by T4, T5 and T8.
  - The G7 defaults come from the existing resolver plus T5/T10's
    environment context.
  - §6 known hosts by T2, T4 and T9; the terminal and its addons by T7; the
    local shell by T6.
  - §7 Host keepalive and env_vars by T1 and T10; KnownHost by T1 and T2.
  - §8.2 by T7 and T8: tabs, a reconnect button, copy on select, the
    environment colour in the tab header, and environment defaults.
    Split panes are deferred (§10, ruled out of v1 for now).
  - G16 by T2, T5 and T6.
- **Types:**
  - `SessionMeta`, `SessionPrompt`, `PromptAnswer`, `HostKeyInfo` and
    `KnownHostMeta` are defined in T1 and used unchanged in T5–T9.
  - `HopTarget`, `ConnectDeps` and `HostKeyError` are defined in T4 and used
    in T5.
  - `Pty` is defined in T5 and implemented in T6.
- **Deferred:**
  - the startup snippet (Phase 7);
  - SFTP and mosh (§4 non-goals);
  - agent forwarding (not in the spec);
  - Explain & fix on a failed connection (Phase 9; T8's failed card leaves
    room for the button).
