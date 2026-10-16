# OpsDeck Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A secure Electron + React + TypeScript desktop shell for OpsDeck with:
- a migrated SQLite database;
- a typed IPC bridge;
- an append-only, hash-chained audit trail with a viewer;
- the six-section navigation every later phase plugs into.

**Architecture:**
- The main process owns the database, the audit log and all IPC handlers.
- The preload exposes exactly one function, `window.opsdeck.invoke`, typed by a
  shared `IpcContract`.
- The renderer is a React UI with no Node access.
- Storage uses Node's built-in `node:sqlite` (`DatabaseSync`). There is no native
  module, so the same code runs under Vitest (Node 24) and inside Electron.

**Tech Stack:**
- pnpm, electron 44.x, electron-vite 6.x, TypeScript (strict);
- React 19, react-router 7 (HashRouter), Tailwind CSS 4 (`@tailwindcss/vite`),
  framer-motion;
- Vitest 5, @testing-library/react, jsdom;
- electron-builder (mac, unsigned).

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md` (§6 platform,
§7 AuditEvent, §8.8 audit trail, §9 phase 1). Roadmap:
`docs/superpowers/plans/2026-10-16-roadmap.md`.

## Global Constraints

- **Electron window:**
  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  - The renderer never imports Node modules.
- **Single app instance:** `app.requestSingleInstanceLock()`. A second launch
  focuses the existing window.
- **Database:**
  - The file is at `path.join(app.getPath('userData'), 'opsdeck.db')`.
  - Set `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
- **Audit trail:**
  - Written by the main process only, and append-only.
  - The actor is the OS user (`os.userInfo().username`) plus the machine
    (`os.hostname()`). There is no "app profile".
  - Secrets never go into the audit trail: `details` always passes through
    `redact()`.
- **Platform:** macOS only for packaging. Keep code free of mac-only APIs except
  where noted.
- **The feel: fun, not a nightmare** (user requirement). Highly interactive and
  polished:
  - spring-based motion (framer-motion) on hover, press, enter and exit;
  - a ⌘K command palette;
  - keyboard shortcuts everywhere;
  - toasts instead of modal alerts;
  - skeleton loaders instead of spinners;
  - friendly animated empty states.
  - Motion is fast: 120–250 ms, or springs `stiffness 400, damping 30`.
  - Motion never blocks input and never delays output.
  - Respect `prefers-reduced-motion`.
  - Use the `frontend-design` skill when building UI tasks.
- **Theme:** dark-first.
- **Commit attribution:** commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A migration fails halfway.** The database must be left exactly at the
   previous version, with no partial tables and no version row. Covered in
   Task 2 (`rolls back a failing migration`).
2. **Secrets nested deep inside audit details** (e.g.
   `{ssh: {identity: {password: "x"}}}`, or arrays of objects carrying a `token`)
   must be redacted at every depth. A known secret *value* that appears inside
   another string must be masked too. Covered in Task 3.
3. **Someone edits the DB file directly** (drops the triggers, changes a row).
   `verifyChain()` must report the first broken event id, not just "false".
   Covered in Task 4 (`detects a tampered row`).
4. **CSV export of labels containing commas, quotes, newlines or a leading `=`.**
   Values must be RFC 4180 quoted, and a leading `=`, `+`, `-` or `@` must be
   prefixed with `'` so spreadsheets don't execute it. Covered in Task 4
   (`escapes csv`).
5. **IPC from an untrusted frame, or to an unknown channel.** It is rejected with
   an error and nothing is executed. Covered in Task 5.

---

### Task 1: Project scaffold with a secure window

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml` (none; single package), `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/main/index.ts`, `src/main/window.ts`, `src/preload/index.ts` (empty bridge for now), `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`
- Test: `tests/main/window.test.ts`

**Interfaces:**
- Produces:
  - `windowOptions(preloadPath: string): Electron.BrowserWindowConstructorOptions`
    in `src/main/window.ts`;
  - npm scripts `dev`, `build`, `typecheck`, `test`, `lint` (tsc only).

- [ ] **Step 1: Scaffold.**
  - Set up the electron-vite layout (`src/main`, `src/preload`, `src/renderer`)
    by hand or from `pnpm create @quick-start/electron` (react-ts). Strip the
    template's demo content.
  - Add Tailwind 4 through `@tailwindcss/vite` in the renderer config.
  - Add a Vitest config with two projects: `main` (environment `node`,
    `tests/main/**`) and `renderer` (environment `jsdom`, `tests/renderer/**`).
  - `.gitignore`: `node_modules`, `out`, `dist`, `*.db`.
- [ ] **Step 2: Write the failing test** `tests/main/window.test.ts`:
  ```ts
  it('creates a locked-down window', () => {
    const o = windowOptions('/p/preload.js')
    expect(o.webPreferences).toMatchObject({
      preload: '/p/preload.js', contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
    })
    expect(o.backgroundColor).toBe('#0b0d12')
    expect(o.titleBarStyle).toBe('hiddenInset')
  })
  ```
- [ ] **Step 3:** Run `pnpm test tests/main/window.test.ts`. Expected: FAIL
  (module not found).
- [ ] **Step 4: Implement `windowOptions`.**
  - Window size: 1280×820, minimum 960×640, `show: false`.
  - In `src/main/index.ts`:
    - the single-instance lock (on `second-instance`, restore and focus);
    - create the window and show it on `ready-to-show`;
    - load the dev server URL or `out/renderer/index.html`;
    - quit when all windows are closed, including on macOS (keep it simple
      for v1).
  - `setWindowOpenHandler` returns `{action:'deny'}` and opens http(s) URLs
    with `shell.openExternal`.
- [ ] **Step 5:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS, and 0
  tsc errors.
- [ ] **Step 6:** Run `pnpm dev`. Expected: an empty dark window titled "OpsDeck"
  opens. Close it.
- [ ] **Step 7: Commit:** `git add -A && git commit -m "feat: electron-vite scaffold with locked-down window"`

### Task 2: SQLite connection and migrations

**Files:**
- Create: `src/main/db/connection.ts`, `src/main/db/migrations.ts`
- Test: `tests/main/db.test.ts`

**Interfaces:**
- Produces:
  - `type Db = import('node:sqlite').DatabaseSync`
  - `interface Migration { version: number; name: string; up: string }` (`up`
    is SQL text)
  - `migrations: Migration[]` (versions strictly increasing from 1)
  - `migrate(db: Db, list?: Migration[]): { from: number; to: number }`
  - `openDatabase(file: string): Db`: opens the file, sets the pragmas, runs
    `migrate`. `':memory:'` is allowed.
  - `currentVersion(db: Db): number`

- [ ] **Step 1: Write the failing tests** in `tests/main/db.test.ts`:
  - `applies migrations in order`: `openDatabase(':memory:')` →
    `currentVersion(db)` equals `migrations.at(-1)!.version`. Table
    `audit_events` exists.
  - `is idempotent`: calling `migrate(db)` a second time returns
    `{from: N, to: N}`.
  - `rolls back a failing migration`:
    - list = `[{version:1,name:'a',up:'CREATE TABLE a(x)'},{version:2,name:'b',up:'CREATE TABLE b(x); SELECT * FROM nope'}]`.
    - `migrate` on a fresh `:memory:` db throws.
    - After that, `currentVersion` is 1, table `a` exists, and table `b` does
      not exist.
  - `enables foreign keys`: `db.prepare('PRAGMA foreign_keys').get()` equals
    `{foreign_keys: 1}`.
- [ ] **Step 2:** Run `pnpm test tests/main/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`.
  - Run each pending migration inside `BEGIN IMMEDIATE … COMMIT` with `db.exec`,
    and `ROLLBACK` on error.
  - Migration 1 `init_audit` creates:
    ```sql
    CREATE TABLE audit_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, actor_os_user TEXT NOT NULL, actor_machine TEXT NOT NULL,
      action TEXT NOT NULL, target_type TEXT, target_id TEXT, target_label TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','denied','info')),
      details TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
    CREATE INDEX audit_events_ts ON audit_events(ts);
    CREATE INDEX audit_events_action ON audit_events(action);
    CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
    ```
  - Suppress the `node:sqlite` ExperimentalWarning only for that warning type,
    using `process.removeAllListeners` / a filtered `process.on('warning')`
    installed in `connection.ts`.
- [ ] **Step 4:** Run `pnpm test tests/main/db.test.ts`. Expected: PASS.
- [ ] **Step 5:** Wire `openDatabase(join(app.getPath('userData'),'opsdeck.db'))`
  into `src/main/index.ts` at `app.whenReady()`, and close it on `will-quit`.
- [ ] **Step 6: Commit:** `git commit -am "feat: sqlite connection with transactional migrations"`

### Task 3: Secret redaction

**Files:**
- Create: `src/main/security/redact.ts`
- Test: `tests/main/redact.test.ts`

**Interfaces:**
- Produces:
  - `REDACTED = '‹redacted›'`
  - `redact<T>(value: T, knownSecrets?: readonly string[]): T`, a deep copy:
    - The value of any object key matching
      `/pass(word|phrase)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|webhook/i`
      becomes `REDACTED`.
    - Every occurrence of any `knownSecrets` entry with length ≥ 4 inside any
      string becomes `REDACTED`.
    - PEM blocks (`-----BEGIN [A-Z ]*PRIVATE KEY-----` … `-----END … -----`)
      inside strings become `REDACTED`.
    - Non-plain objects (Date, Buffer) are stringified first.
    - Cycles become `'[circular]'`.

- [ ] **Step 1: Write the failing tests:**
  - `redacts sensitive keys at any depth`:
    `redact({ssh:{identity:{username:'u',password:'x'}},list:[{token:'t',ok:1}]})`
    equals `{ssh:{identity:{username:'u',password:REDACTED}},list:[{token:REDACTED,ok:1}]}`.
  - `masks known secret values inside strings`:
    `redact({cmd:'PGPASSWORD=hunter22 pg_dump'},['hunter22']).cmd` equals
    `'PGPASSWORD=‹redacted› pg_dump'`.
  - `ignores short known secrets`: `redact('abc', ['ab'])` equals `'abc'`.
  - `strips PEM private keys`: the result for a string containing a 3-line
    `-----BEGIN OPENSSH PRIVATE KEY-----` block does not contain `BEGIN`.
  - `does not mutate input and survives cycles`: `a.self = a` →
    `redact(a).self === '[circular]'`, and `a.password` is unchanged on the
    original.
- [ ] **Step 2:** Run `pnpm test tests/main/redact.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `redact`. Escape known secrets with a regex-escape
  helper, and replace longest first.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: deep secret redaction"`

### Task 4: Audit log (append, hash chain, query, verify, CSV)

**Files:**
- Create: `src/shared/audit.ts` (types shared with the renderer), `src/main/audit/audit-log.ts`, `src/main/audit/csv.ts`
- Test: `tests/main/audit.test.ts`

**Interfaces:**
- Consumes: `Db`, `openDatabase` (Task 2), `redact` (Task 3).
- Produces in `src/shared/audit.ts`:
  ```ts
  export type AuditOutcome = 'success' | 'failure' | 'denied' | 'info'
  export type AuditAction = 'app.start' | 'app.quit' | 'audit.verify' | 'audit.export' // later phases extend
  export interface AuditInput { action: AuditAction; outcome: AuditOutcome; targetType?: string; targetId?: string; targetLabel?: string; details?: Record<string, unknown> }
  export interface AuditEvent extends Required<Omit<AuditInput,'details'|'targetType'|'targetId'|'targetLabel'>> { id: number; ts: string; actorOsUser: string; actorMachine: string; targetType: string | null; targetId: string | null; targetLabel: string | null; details: Record<string, unknown>; prevHash: string; hash: string }
  export interface AuditFilter { actions?: AuditAction[]; outcome?: AuditOutcome; actor?: string; targetType?: string; from?: string; to?: string; text?: string; limit?: number; beforeId?: number }
  export type ChainVerification = { ok: true; count: number } | { ok: false; count: number; brokenAtId: number; reason: 'hash-mismatch' | 'prev-link-mismatch' }
  ```
- Produces in `src/main/audit/audit-log.ts`:
  - `class AuditLog { constructor(db: Db, opts?: { actor?: { osUser: string; machine: string }; now?: () => Date; knownSecrets?: () => readonly string[] }) }`
  - `append(input: AuditInput): AuditEvent`
  - `list(filter?: AuditFilter): AuditEvent[]`: newest first; default
    `limit` 200, maximum 1000.
  - `verifyChain(): ChainVerification`
  - `GENESIS_HASH = '0'.repeat(64)`
- Produces in `src/main/audit/csv.ts`: `toCsv(events: AuditEvent[]): string`.
  - Header:
    `id,ts,actor_os_user,actor_machine,action,target_type,target_id,target_label,outcome,details`.
  - Line endings are CRLF.

- [ ] **Step 1: Write the failing tests** (each uses `openDatabase(':memory:')`
  and a fixed `now`/actor):
  - `appends with actor and redacted details`:
    `append({action:'app.start',outcome:'info',details:{password:'p'}})` returns
    `id 1`, `actorOsUser 'tester'`, and `details.password === '‹redacted›'`.
  - `chains hashes`:
    - The first `prevHash` equals `GENESIS_HASH`.
    - The second `prevHash` equals the first `hash`.
    - `hash` equals `sha256(prevHash + canonical(eventWithoutHashAndId))`,
      recomputed in the test with `node:crypto`. `canonical` is
      `JSON.stringify` with sorted keys; export it as
      `canonicalJson(v: unknown): string`.
  - `is append-only`:
    `db.exec("UPDATE audit_events SET outcome='success'")` throws
    `/append-only/`.
  - `filters and pages`:
    - Insert 5 events (3 `app.start`, 2 `audit.verify`).
    - `list({actions:['audit.verify']})` has length 2, newest first.
    - `list({limit:2})` has length 2.
    - `list({beforeId: 3})` returns ids `[2,1]`.
    - `list({text:'web-01'})` matches `targetLabel` containing `web-01`.
  - `verifies an intact chain`: `verifyChain()` equals `{ok:true,count:5}`.
  - `detects a tampered row`:
    - Run `DROP TRIGGER audit_no_update`, then
      `UPDATE audit_events SET target_label='x' WHERE id=3`.
    - `verifyChain()` equals
      `{ok:false,count:5,brokenAtId:3,reason:'hash-mismatch'}`.
  - `escapes csv`:
    - For an event with `targetLabel: 'a,"b"\nc'`, the row contains
      `"a,""b""\nc"`.
    - For `targetLabel: '=cmd()'`, the cell is `'=cmd()`.
    - The first line equals the header.
- [ ] **Step 2:** Run `pnpm test tests/main/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `AuditLog` and `toCsv`.**
  - `ts` is ISO-8601 UTC.
  - The hashed payload has the fields `ts, actorOsUser, actorMachine, action,
    targetType, targetId, targetLabel, outcome, details, prevHash`.
  - `verifyChain` walks rows in id order, recomputes each hash, and checks each
    `prevHash` link.
  - The default actor comes from `os.userInfo().username` and `os.hostname()`.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** In `src/main/index.ts`, create one `AuditLog` after the DB
  opens. Append `app.start` (outcome `info`, details `{version: app.getVersion()}`)
  and append `app.quit` on `before-quit`.
- [ ] **Step 6: Commit:** `git commit -am "feat: append-only hash-chained audit log"`

### Task 5: Typed IPC bridge with sender validation

**Files:**
- Create: `src/shared/ipc.ts`, `src/main/ipc/register.ts`, `src/main/ipc/handlers/app.ts`, `src/main/ipc/handlers/audit.ts`
- Modify: `src/preload/index.ts`, `src/main/index.ts`
- Create: `src/renderer/src/lib/api.ts`, `src/renderer/src/env.d.ts`
- Test: `tests/main/ipc.test.ts`

**Interfaces:**
- Consumes: `AuditLog`, `toCsv`, and the shared audit types (Task 4).
- Produces in `src/shared/ipc.ts`:
  ```ts
  export interface AppInfo { version: string; platform: NodeJS.Platform; userDataPath: string; actor: { osUser: string; machine: string } }
  export interface IpcContract {
    'app:info': { args: []; result: AppInfo }
    'audit:list': { args: [filter: AuditFilter]; result: AuditEvent[] }
    'audit:verify': { args: []; result: ChainVerification }
    'audit:exportCsv': { args: [filter: AuditFilter]; result: { path: string } | null }
  }
  export type Channel = keyof IpcContract
  export const CHANNELS: readonly Channel[] // every key, listed literally; a type test asserts completeness
  export type Handlers = { [K in Channel]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']> | IpcContract[K]['result'] }
  export interface OpsDeckBridge { invoke<K extends Channel>(channel: K, ...args: IpcContract[K]['args']): Promise<IpcContract[K]['result']> }
  ```
- Produces in `src/main/ipc/register.ts`:
  - `isTrustedSender(frameUrl: string, opts: { devServerUrl?: string; rendererFile: string }): boolean`:
    true only when the URL is the `file://` URL of `rendererFile`
    (`pathToFileURL`, ignoring the hash), or when the origin equals the
    `devServerUrl` origin.
  - `registerHandlers(ipc: Pick<Electron.IpcMain,'handle'>, handlers: Handlers, trust: (frameUrl: string) => boolean): void`.
    For each `CHANNELS` entry it registers `ipc.handle`, which throws
    `Error('untrusted sender')` when `!trust(event.senderFrame.url)`.
- The preload exposes `contextBridge.exposeInMainWorld('opsdeck', bridge)`. The
  bridge rejects any channel not in `CHANNELS` with `Error('unknown channel: x')`
  before calling `ipcRenderer.invoke`.
- `src/renderer/src/lib/api.ts`: `export const api: OpsDeckBridge = window.opsdeck`.

- [ ] **Step 1: Write the failing tests:**
  - `trusts only the app renderer`:
    - `isTrustedSender('file:///app/out/renderer/index.html#/audit', {rendererFile:'/app/out/renderer/index.html'})`
      is true.
    - `file:///etc/passwd` is false.
    - With `devServerUrl:'http://localhost:5173'`,
      `'http://localhost:5173/#/x'` is true and
      `'http://evil.test/'` is false.
  - `registers every channel and rejects untrusted frames`:
    - Use a fake `ipc` that records `(channel, fn)`.
    - The recorded channels equal `CHANNELS`.
    - Calling the `audit:verify` fn with
      `{senderFrame:{url:'http://evil.test/'}}` rejects with
      `/untrusted sender/`.
    - With a trusted url it resolves to the handler's value.
  - `audit handlers`:
    - `createAuditHandlers(log, { saveDialog })` (export from
      `handlers/audit.ts`).
    - `exportCsv` with a `saveDialog` stub returning a path in `os.tmpdir()`
      writes the file, returns `{path}`, and appends an `audit.export` event.
    - A stub returning `undefined` gives `null` and no event.
    - `verify` appends an `audit.verify` event with outcome `success` when ok.
- [ ] **Step 2:** Run `pnpm test tests/main/ipc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `createAppHandlers(info: () => AppInfo)` and
    `createAuditHandlers(log: AuditLog, deps: { saveDialog: () => Promise<string | undefined> })`.
    In `index.ts`, `saveDialog` wraps `dialog.showSaveDialog` with default name
    `opsdeck-audit-YYYY-MM-DD.csv`.
  - The export calls `list` with `limit` 1000 per page, looping with
    `beforeId` until exhausted.
  - Wire `registerHandlers` in `index.ts` before the window loads.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: typed ipc bridge with sender validation"`

### Task 6: Design system, motion kit, command palette and toasts

**Files:**
- Create: `src/renderer/src/ui/tokens.css`, `src/renderer/src/ui/motion.ts`, `src/renderer/src/ui/Button.tsx`, `src/renderer/src/ui/Badge.tsx`, `src/renderer/src/ui/Skeleton.tsx`, `src/renderer/src/ui/EmptyState.tsx`, `src/renderer/src/ui/Toaster.tsx`, `src/renderer/src/ui/CommandPalette.tsx`, `src/renderer/src/ui/shortcuts.ts`
- Test: `tests/renderer/ui.test.tsx`

**Interfaces:**
- Produces:
  - `motion.ts`: `spring = {type:'spring', stiffness:400, damping:30}`,
    `fast = {duration:0.15}`, `useMotionSafe(): boolean`. It returns false under
    reduced motion, and every animated component checks it.
  - `toast(opts: {title: string; description?: string; tone?: 'info'|'success'|'warn'|'error'; action?: {label: string; run: () => void}}): string`
    and `<Toaster/>`.
    - At most 4 visible, stacked bottom-right with spring enter and exit.
    - Auto-dismiss after 5 s, but `error` stays until dismissed.
    - Hovering pauses the timer.
  - `registerCommand(cmd: {id: string; title: string; section: string; keywords?: string[]; shortcut?: string; run: () => void}): () => void`
    (returns an unregister function) and `<CommandPalette/>`.
    - Opened with ⌘K, closed with Esc.
    - Fuzzy match on title and keywords; ↑/↓/Enter navigation.
    - Recent commands first.
  - `useShortcut(combo: string, handler: () => void)`: combos like `mod+k`,
    `mod+1`…`mod+6`. It ignores events from inputs, except `mod+k`.
  - `Button` variants `primary|ghost|danger`: press scales to 0.97, hover lift,
    loading state with an inline spinner. `Badge` tones match the toasts.
    `Skeleton` has a shimmer. `EmptyState` has an animated icon, title, text and
    an optional action.
  - `tokens.css` holds the CSS variables (`--bg #0b0d12`, `--surface #12151c`,
    `--surface-2 #181c25`, `--border #222734`, `--text #e6e8ee`, `--muted #8a91a3`,
    `--accent #5b8cff`, `--ok #2fbf71`, `--warn #f2a93b`, `--err #ef5b5b`),
    `--radius 10px`, the Inter UI font, and JetBrains Mono for code.

- [ ] **Step 1: Write the failing tests:**
  - `command palette opens with mod+k and runs a command`:
    - Register a `{id:'go-audit',title:'Go to Audit'}`.
    - Fire `keydown` Meta+K, type "aud", press Enter.
    - Expect `run` to have been called and the palette to have closed.
  - `palette ignores unregistered`: after `unregister()`, typing "aud" shows "No
    results".
  - `toasts stack and cap at 4`: calling `toast` 6 times renders 4 toasts.
  - `error toasts persist`: after `vi.advanceTimersByTime(6000)` an `error`
    toast is still present, and an `info` toast is gone.
  - `shortcuts ignore inputs`: `mod+1` fired inside an `<input>` does not call
    its handler, while `mod+k` does.
- [ ] **Step 2:** Run `pnpm test tests/renderer/ui.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement the components. Fuzzy match is a simple
  subsequence score; don't add a dependency for it.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: design system, motion kit, command palette, toasts"`

### Task 7: App shell and audit viewer

**Files:**
- Create: `src/renderer/src/shell/AppShell.tsx`, `src/renderer/src/shell/Sidebar.tsx`, `src/renderer/src/shell/sections.ts`, `src/renderer/src/pages/PlaceholderPage.tsx`, `src/renderer/src/pages/AuditPage.tsx`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`
- Test: `tests/renderer/shell.test.tsx`, `tests/renderer/audit-page.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 5), `AuditEvent` / `AuditFilter` / `ChainVerification` (Task 4), and the UI kit, `toast`, `registerCommand` and `useShortcut` (Task 6).
- Produces in `sections.ts`:
  `SECTIONS = [{id:'environments',label:'Environments',path:'/environments'},{id:'hosts',label:'Hosts',path:'/hosts'},{id:'vaults',label:'Vaults',path:'/vaults'},{id:'tunnels',label:'Tunnels',path:'/tunnels'},{id:'deployments',label:'Deployments',path:'/deployments'},{id:'audit',label:'Audit',path:'/audit'}] as const`.
  The default route `/` redirects to `/environments`. Later phases replace
  `PlaceholderPage` for their section.

- [ ] **Step 1: Write the failing tests** (mock `window.opsdeck.invoke` with
  `vi.fn`):
  - `shell renders all sections and navigates`:
    - The six links are present, in `SECTIONS` order.
    - Clicking "Audit" renders the heading "Audit trail".
    - The active link has `aria-current="page"`.
  - `audit page lists events`:
    - `invoke('audit:list', …)` resolves 2 events.
    - A row shows the action, actor `tester@mac`, target label and an outcome
      badge.
    - Typing in the search box calls `audit:list` with `{text:'web'}`
      (debounced 250 ms; use fake timers).
  - `mod+6 jumps to Audit`: firing Meta+6 renders "Audit trail".
  - `verify chain shows result`:
    - Clicking "Verify chain" with `{ok:true,count:2}` shows a success toast
      "Chain intact · 2 events".
    - With `{ok:false,count:5,brokenAtId:3,reason:'hash-mismatch'}` it shows an
      error toast "Chain broken at event #3".
  - `export csv`: clicking "Export CSV" calls `invoke('audit:exportCsv', currentFilter)`.
- [ ] **Step 2:** Run `pnpm test tests/renderer`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Sidebar: 232 px wide, dark surface, app name at the top, sections with icons
    (lucide-react), and actor info from `app:info` at the bottom.
  - Page transitions: a shared-layout spring on the active sidebar indicator,
    and a 150 ms fade/slide between pages.
  - `mod+1`…`mod+6` jump to the sections; each section is also registered as a
    palette command.
  - Placeholder pages use `EmptyState` with "Coming in phase N".
  - Rows stagger in on first load. Loading shows `Skeleton` rows.
  - Verify and export results show as toasts.
  - Audit page:
    - filter bar: search, outcome select, action select, from/to date;
    - a virtualized-enough table (plain table with "Load more" via `beforeId`);
    - a details drawer showing pretty JSON;
    - "Verify chain" and "Export CSV" buttons.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Run `pnpm dev`, open Audit, and confirm the `app.start` row
  appears. Verify chain shows "Chain intact"; Export CSV writes a file.
- [ ] **Step 6: Commit:** `git commit -am "feat: app shell and audit trail viewer"`

### Task 8: Mac packaging

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json` (script `build:mac`)

- [ ] **Step 1: Configure electron-builder.**
  - `appId: dev.opsdeck.app`, `productName: OpsDeck`.
  - `mac.target: [dmg, dir]`, `mac.identity: null` (unsigned, per spec §9a).
  - `files: [out/**]`, `asar: true`.
- [ ] **Step 2:** Run `pnpm build:mac`. Expected: `dist/mac-arm64/OpsDeck.app`
  exists.
- [ ] **Step 3:** Run `open dist/mac-arm64/OpsDeck.app`. Expected: the window
  opens and the Audit page shows a new `app.start` row. The database is at
  `~/Library/Application Support/OpsDeck/opsdeck.db`.
- [ ] **Step 4: Commit:** `git commit -am "build: unsigned mac packaging"`
