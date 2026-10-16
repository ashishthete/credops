# OpsDeck Phase 3: Products, Hosts and Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Product → Environment → Host inventory, with:
- CRUD for products, environments and hosts;
- many-to-many links: an environment can be shared by several products, and a
  host by several environments (with a role per environment);
- host ↔ vault links, with identity pickers that list linked vaults first;
- environment defaults (identity, port, jump host) and a resolver that says
  where each value came from (host → environment → global);
- an `~/.ssh/config` importer with a preview;
- a Products page that browses the tree with polished, motion-safe animation,
  and a flat Hosts page;
- an audit event for every mutation, with no secret value in the trail.

**Architecture:**
- Inventory rows are plain metadata in SQLite (migration 3). Three main-process
  stores own them: `HostStore`, `EnvironmentStore` and `ProductStore`
  (`src/main/inventory/`). Each mutation runs in one transaction and appends
  one audit event.
- `resolveHost(db, hostId, environmentId?)` is a pure read over those tables.
  It returns the effective address, port, identity reference and jump chain,
  each with its source, and never touches secret material. Phase 4 connects
  with it, adding `IdentityStore.resolve` for the key or password.
- The `~/.ssh/config` parser is a pure function over text
  (`parseSshConfig`). `SshImporter` reads the file only through an injected
  path, links keys through `KeyStore.link` and creates identities through
  `IdentityStore.create`, so their existing rules and audit events apply.
- The renderer keeps one inventory store (`useSyncExternalStore`, like the
  command registry). Pages derive their tree and lists from it with pure
  functions that are unit-tested on their own.

**Tech Stack:** Everything from Phases 1–2 (Electron, React, TypeScript,
`node:sqlite`, framer-motion, lucide-react, react-router, vitest). No new
runtime dependency. React Flow is Phase 6; this phase's "map" is the animated
tree and the product overview.

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md`:
- §1 hierarchy;
- §3 G1, G1a, G2, G7, G10 and G13 (smooth transitions);
- §5 anti-goals (no plaintext secrets; animation never blocks input);
- §7 Host, Product, ProductEnvironment, Environment, HostVault and
  EnvironmentHost, and "Credential and route resolution";
- §8.1 linking;
- §9 item 3;
- §10 feel.

Roadmap and cross-phase contracts: `docs/superpowers/plans/2026-10-16-roadmap.md`.
Conventions: `docs/superpowers/plans/2026-10-16-phase2-vaults.md`.

## Global Constraints

- **All Phase 1–2 constraints still hold:**
  - the window flags and CSP;
  - the renderer imports no Node, and the preload requires only `electron`;
  - modules under test import only *types* from `electron`;
  - storage is `node:sqlite`;
  - every IPC channel has a validator in `VALIDATORS`. Validator errors name
    the path and the rule, never the value.
- **Migration 3 only.** Migrations 1–2 are never edited. Deploy-related
  environment columns (`versioned`, `auto_rollback`, `qa_*`, `email_*`,
  `notify_events`, `teams_webhook_secret_id`), host `env_vars`, `keepalive`
  and `startup_snippet_id` are added later with `ALTER TABLE` by the phases
  that use them (YAGNI).
- **The whole app is behind `AuthGate`** (§6). Main still enforces it: every
  inventory **mutation** calls `vault.assertUnlocked()` and throws
  `Error(VAULT_LOCKED)` while locked. Reads (`*:list`, `host:resolve`,
  `sshconfig:preview`) work while locked. Renderer mutations go through
  `attempt(...)` (`withUnlock`), so a lock mid-edit brings up the gate and
  retries once.
- **Resolution order** (§7, verbatim intent):
  1. the host's own field;
  2. if opened from an environment, that environment's default;
  3. the global default: ssh-agent first, then `~/.ssh/id_ed25519`, then
     `~/.ssh/id_rsa`. The username defaults to the local user and the port
     to `22`.
  - Outside any environment, step 2 is skipped.
  - If the host is in several environments with different defaults for a
    field it leaves unset, that is a conflict. The UI shows a warning asking
    the host to set the field itself.
- **Pickers** (§7): identity and key pickers for a host list identities from
  the host's linked vaults first, then from every other usable vault. A
  corrupt vault (`status.corruptVaultIds`) is never listed.
- **SSH stays local.** Nothing in this phase opens a socket or runs `ssh`.
- **Tests never read the real `~/.ssh`.** The parser takes text. The importer
  and the IPC handler take `sshConfigPath` and `sshDir` from deps; tests
  pass a tmp dir or a fixture under `tests/fixtures/ssh/`.
- **Limits** (in `src/shared/inventory.ts`):
  - `MAX_NAME = 64` for product and environment names, trimmed;
  - host labels use `MAX_LABEL` (120), trimmed;
  - `MAX_ADDRESS = 253`. `HOST_ADDRESS = /^(?!-)[A-Za-z0-9_.:%-]+$/` is a
    hostname, IPv4 or IPv6 address with no spaces and no leading `-`, so it
    can never be read as an `ssh` option;
  - ports are integers 1–65535, and `DEFAULT_SSH_PORT = 22`;
  - `MAX_TAGS = 16`. A tag is 1–32 chars matching `TAG = /^[\p{L}\p{N}_.:/-]+$/u`,
    trimmed, and tags are deduped case-insensitively;
  - `MAX_NOTES = 4000`, `MAX_DESCRIPTION = 1000`;
  - `MAX_URL = 2048`. `REPO_URL = /^(https?:\/\/|ssh:\/\/|git@)\S+$/`;
  - colors match `VAULT_COLOR` (`#rrggbb`);
  - `MAX_JUMP_DEPTH = 8` hops;
  - `MAX_SSH_CONFIG_BYTES = 1 MiB`, per file, includes counted;
  - at most 64 ids in any id list (`MAX_LINKS = 64`) and 2000 import aliases.
- **Names:**
  - Product names are unique (case-insensitive).
  - Host labels are unique (case-insensitive).
  - Environment names may repeat across the app. They must be unique only
    within each product they belong to: two products can each have a
    `prod`. A link or rename that would give one product two environments of
    the same name throws `product <name> already has an environment named <env>`.
- **Roles:** `HOST_ROLES = ['app', 'db', 'bastion', 'other']`. The default
  role is `other`.
- **Delete semantics:**
  - Deleting a product removes its links only; its environments stay (they
    may be shared) and show under "Unassigned".
  - Deleting an environment removes its links; its hosts stay.
  - A host that another host or an environment uses as its jump host can't
    be deleted. It throws `host is the jump host for <label>`.
  - Deleting an identity or a vault sets the host and environment identity
    fields that pointed at it back to inherit (`ON DELETE SET NULL`).
    Deleting a vault drops its `host_vaults` links.
- **Audit:**
  - New actions are appended to `AUDIT_ACTIONS`:
    - `product.create`, `product.update`, `product.delete`;
    - `environment.create`, `environment.update`, `environment.delete`;
    - `environment.products`, `environment.host`;
    - `host.create`, `host.update`, `host.delete`, `host.vaults`,
      `host.import`.
  - The target is the entity, with its name or label.
  - `details` hold ids, changed-field *names*, roles, ops and counts only.
    They never hold notes, addresses, usernames or any value of a field.
- **Feel** (Phase 1 rule, unchanged):
  - springs `stiffness 400, damping 30` (`spring` from `ui/motion.ts`);
  - `fast` for fades;
  - ⌘K commands, shortcuts, toasts, skeletons and friendly empty states.
  - `useMotionSafe()` false ⇒ opacity-only transitions, no transforms, no
    looping pulses.
  - Animation never delays a click or a keypress: there are no exit-blocking
    `AnimatePresence` waits on navigation, and the next view renders
    immediately.
  - Use the `frontend-design` skill on Tasks 8–10.
- **Commits:** stage files explicitly (`git add <paths>`; new files are not
  picked up by `-a`). Every commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Jump-host loops through environment defaults.** Host A's explicit jump is
   B, and B sits in `prod`, whose default jump host is A. Each link is valid
   alone. `host:resolve(A, prod)` must fail with a clear `jump host loop: A → B → A`
   message, not overflow the stack or hang. A bastion in an environment whose
   default jump host is itself must resolve to no jump at all. Covered in
   Task 4 (`detects loops through env defaults`, `bastion never jumps through itself`).
2. **A hostile or messy `~/.ssh/config`:**
   - `HostName -oProxyCommand=touch /tmp/pwned`, `Host *` / `Host !bad *.prod`
     patterns, `Match` blocks, `Include` loops and outside paths, quoted
     values, `Key=value` syntax, CRLF, a 2 MB file, and an `IdentityFile`
     outside `~/.ssh`.
   - The preview never throws. Option-looking addresses are rejected as
     invalid, wildcard blocks act only as defaults, includes never leave
     `sshDir` or recurse forever, and every skipped item carries a warning.
   - Covered in Task 5 (`hostile fixture`) and Task 6
     (`rejects option-looking addresses`).
3. **Importing the same config twice,** or after renaming a host by hand.
   Existing labels are skipped as `exists`. No identity or key link is
   duplicated (the second run reuses them). The result counts say so.
   Covered in Task 6 (`re-import is idempotent`).
4. **Deleting something a host points at:**
   - an identity used as a host's identity or an environment default;
   - a vault the host links to;
   - a host used as another host's or an environment's jump host.
   - The host survives and falls back to inherit (identity, vault). A jump
     host refuses deletion with its user named. Nothing throws a raw
     `FOREIGN KEY constraint failed`.
   - Covered in Task 1 (`fk fallbacks`) and Task 2 (`refuses deleting a jump host`).
5. **A shared host or shared environment edited in one place.**
   - Removing host H from `staging` must leave its `prod` membership and role
     untouched.
   - Unlinking a shared environment from product A must leave it under
     product B.
   - The tree must show the change in every place the item appears, without a
     reload.
   - Covered in Task 3 (`shared links are independent`) and Task 8
     (`shared host updates everywhere`).

---

### Task 1: Schema, shared types, audit actions and `v.nullable`

**Files:**
- Create: `src/shared/inventory.ts`, `src/main/db/tx.ts`
- Modify: `src/main/db/migrations.ts` (append migration 3), `src/shared/audit.ts`, `src/main/ipc/validate.ts`
- Test: `tests/main/inventory-schema.test.ts`, `tests/main/validate.test.ts`

**Interfaces:**
- Consumes: `migrate`, `openDatabase`; `VAULT_COLOR`, `MAX_LABEL`,
  `IdentityAuth` (`src/shared/vault.ts`).
- Produces:
  - `src/shared/inventory.ts` (plain constants and types only; the renderer
    imports it):
    ```ts
    export const HOST_ROLES = ['app', 'db', 'bastion', 'other'] as const; export type HostRole
    export const PRODUCT_ICONS = ['boxes', 'leaf', 'globe', 'database', 'layers', 'rocket', 'sparkles', 'building'] as const; export type ProductIcon
    export const OS_ICONS = ['linux', 'windows', 'macos', 'other'] as const; export type OsIcon
    // limits and patterns from Global Constraints: MAX_NAME, MAX_ADDRESS, HOST_ADDRESS, DEFAULT_SSH_PORT, MAX_TAGS, MAX_TAG, TAG,
    // MAX_NOTES, MAX_DESCRIPTION, MAX_URL, REPO_URL, MAX_JUMP_DEPTH, MAX_SSH_CONFIG_BYTES, MAX_LINKS, MAX_IMPORT_ALIASES = 2000

    export interface ProductInput { name: string; color: string; icon: ProductIcon; description?: string; repoUrl?: string | null }
    export type ProductPatch = Partial<ProductInput>
    export interface ProductMeta { id: string; name: string; color: string; icon: ProductIcon; description: string; repoUrl: string | null
      environmentIds: string[]; createdAt: string; updatedAt: string }

    export interface Membership { environmentId: string; role: HostRole }
    export interface EnvironmentInput { name: string; color: string; protected?: boolean; defaultIdentityId?: string | null
      defaultPort?: number | null; defaultJumpHostId?: string | null; productIds?: string[] }
    export type EnvironmentPatch = Partial<Omit<EnvironmentInput, 'productIds'>>
    export interface EnvironmentMeta { id: string; name: string; color: string; protected: boolean; defaultIdentityId: string | null
      defaultPort: number | null; defaultJumpHostId: string | null; productIds: string[]; hosts: { hostId: string; role: HostRole }[]
      createdAt: string; updatedAt: string }

    export interface HostInput { label: string; address: string; port?: number | null; identityId?: string | null; jumpHostId?: string | null
      tags?: string[]; osIcon?: OsIcon; notes?: string; vaultIds?: string[]; environments?: Membership[] }
    export type HostPatch = Partial<Omit<HostInput, 'vaultIds' | 'environments'>>
    export interface HostMeta { id: string; label: string; address: string; port: number | null; identityId: string | null
      jumpHostId: string | null; tags: string[]; osIcon: OsIcon; notes: string; vaultIds: string[]; environments: Membership[]
      createdAt: string; updatedAt: string }

    export type ValueSource = 'host' | 'environment' | 'global'
    export type IdentityRef =
      | { source: 'host' | 'environment'; identityId: string; label: string; username: string; auth: IdentityAuth; vaultId: string }
      | { source: 'global'; username: string; auth: 'default' } // agent, then ~/.ssh/id_ed25519, then id_rsa
    export interface ResolvedHop { hostId: string; label: string; address: string; port: number; identity: IdentityRef }
    export interface InheritConflict { field: 'identity' | 'port' | 'jumpHost'; environmentIds: string[] }
    export interface ResolvedHost { hostId: string; environmentId: string | null; address: string
      port: { value: number; source: ValueSource }; identity: IdentityRef
      jump: { hostId: string | null; source: ValueSource | null }
      chain: ResolvedHop[]          // first hop to dial first; excludes the target
      conflicts: InheritConflict[] }

    export interface SshForward { type: 'L' | 'R'; spec: string }
    export interface SshConfigEntry { alias: string; hostName: string; port: number | null; user: string | null
      identityFile: string | null; proxyJump: string | null; forwards: SshForward[]; warnings: string[] }
    export interface SshImportCandidate extends SshConfigEntry { existingHostId: string | null; valid: boolean; jumpResolvable: boolean }
    export interface SshImportPreview { path: string; found: boolean; candidates: SshImportCandidate[]; warnings: string[] }
    export interface SshImportRequest { vaultId: string; aliases: string[]; environmentId?: string; role?: HostRole }
    export interface SshImportResult { created: HostMeta[]; skipped: { alias: string; reason: 'exists' | 'not-found' | 'invalid' }[]
      keysLinked: number; identitiesCreated: number; warnings: string[] }
    ```
  - `src/main/db/tx.ts`: `inTransaction<T>(db: Db, fn: () => T): T` does
    `BEGIN IMMEDIATE`, then `COMMIT`, or `ROLLBACK` and rethrow. Nested calls
    are not supported, and it throws if `db.isTransaction` is already true.
  - `v.nullable<T>(c: Check<T>): Check<T | null>` in `validate.ts` passes
    `null` through and checks everything else. In `v.object`, a key set to
    `null` counts as present.
  - The 13 audit actions from Global Constraints, appended to `AUDIT_ACTIONS`.
  - Migration 3 `inventory`, verbatim:
    ```sql
    CREATE TABLE products(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
      icon TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', repo_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE hosts(id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE COLLATE NOCASE, address TEXT NOT NULL,
      port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
      identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
      jump_host_id TEXT REFERENCES hosts(id),
      tags TEXT NOT NULL DEFAULT '[]', os_icon TEXT NOT NULL DEFAULT 'linux', notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (jump_host_id IS NULL OR jump_host_id <> id));
    CREATE TABLE environments(id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
      protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1)),
      default_identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
      default_port INTEGER CHECK (default_port IS NULL OR default_port BETWEEN 1 AND 65535),
      default_jump_host_id TEXT REFERENCES hosts(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE product_environments(product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, PRIMARY KEY(product_id, environment_id));
    CREATE TABLE environment_hosts(environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('app','db','bastion','other')), PRIMARY KEY(environment_id, host_id));
    CREATE TABLE host_vaults(host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, PRIMARY KEY(host_id, vault_id));
    CREATE INDEX product_environments_env ON product_environments(environment_id);
    CREATE INDEX environment_hosts_host ON environment_hosts(host_id);
    CREATE INDEX host_vaults_vault ON host_vaults(vault_id);
    ```

- [ ] **Step 1: Write the failing tests:**
  - `inventory-schema.test.ts` → `migrates to 3`: on `openDatabase(':memory:')`,
    `currentVersion(db)` is `3` and the six tables exist.
  - `inventory-schema.test.ts` → `fk fallbacks` (raw SQL inserts; vault from
    `makeVault`, unlocked):
    - Create a vault `Ops` with an identity I. Host H has `identity_id = I`,
      environment E has `default_identity_id = I`, and `host_vaults` has
      (H, Ops).
    - `vault.deleteVault(opsId)` succeeds. H and E still exist, their
      identity fields are `NULL`, and `host_vaults` is empty.
    - A raw `DELETE FROM hosts` of a host referenced by
      `environments.default_jump_host_id` fails with a foreign-key error.
      This is the DB backstop under Task 2's friendly check.
  - `inventory-schema.test.ts` → `role and port checks`: inserting role
    `'web'` or port `70000` fails a CHECK.
  - `validate.test.ts` → `nullable`: `v.object({p: v.optional(v.nullable(v.int()))})`
    accepts `{p:null}` → `{p:null}`, `{}` → `{}` and `{p:2}`, and rejects
    `{p:'x'}`.
- [ ] **Step 2:** Run `pnpm test tests/main/inventory-schema.test.ts tests/main/validate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** migration 3, `inventory.ts`, `tx.ts`, `v.nullable`
  and the audit actions.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS. The
  Phase 1 `db.test.ts` version asserts are updated from 2 to 3 if they pin it.
- [ ] **Step 5: Commit:**
  `git add src/shared/inventory.ts src/main/db/tx.ts src/main/db/migrations.ts src/shared/audit.ts src/main/ipc/validate.ts tests/main && git commit -m "feat: inventory schema, shared types and nullable validator"`

### Task 2: HostStore (CRUD, vault links, jump validation) and its IPC

**Files:**
- Create: `src/main/inventory/host-store.ts`, `src/main/inventory/rows.ts`, `src/main/ipc/handlers/inventory.ts`, `tests/main/inventory-helpers.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/index.ts`, `tests/main/ipc-helpers.ts` (only if needed)
- Test: `tests/main/hosts.test.ts`

**Interfaces:**
- Consumes: `inTransaction`, the types and limits from Task 1, `VaultService`
  (`assertUnlocked`, `listVaults`) and `AuditLog`.
- Produces:
  - `rows.ts`: `hostMeta(db, id): HostMeta`, `environmentMeta(db, id): EnvironmentMeta`
    and `productMeta(db, id): ProductMeta`. Each throws
    `<kind> not found`, and Tasks 3 and 6 reuse them. There are also
    `checkName(raw, what, max)`, `checkColor` and `checkTags(raw): string[]`,
    which throw messages that never contain the value.
  - The class:
    ```ts
    class HostStore {
      constructor(db: Db, vault: VaultService, audit: AuditLog)
      list(): HostMeta[]                                    // sorted by label NOCASE; works locked
      create(input: HostInput, opts?: { auditDetails?: Record<string, unknown> }): HostMeta
      update(id: string, patch: HostPatch): HostMeta        // undefined = keep, null = inherit; no-op patch → no audit
      delete(id: string): void
      setVaults(id: string, vaultIds: string[]): HostMeta   // replaces the set; audit host.vaults {added, removed}
    }
    ```
  - Rules:
    - `identityId` must exist (`identity not found`).
    - `jumpHostId` must exist, must not be the host itself
      (`a host can't be its own jump host`), and following explicit
      `jump_host_id` links from it must not reach this host
      (`jump host loop: A → B → A`).
    - `vaultIds` must exist (`vault not found`).
    - `environments[].environmentId` must exist.
    - `create` writes the host, its memberships and its vault links in one
      transaction, then appends `host.create` with details
      `{ vaults: n, environments: n, ...auditDetails }`.
    - `update` appends `host.update` `{fields}`.
    - `delete` refuses with `host is the jump host for <label>`, naming the
      first host or environment that uses it. Otherwise it appends
      `host.delete` `{environments: n}`.
  - Channels (validators in brackets):
    - `'host:list': { args: []; result: HostMeta[] }`
    - `'host:create': { args: [input: HostInput]; result: HostMeta }`
      [`asHostInput`]
    - `'host:update': { args: [id: string, patch: HostPatch]; result: HostMeta }`
      [`v.uuid(), asHostPatch`]
    - `'host:delete': { args: [id: string]; result: void }`
    - `'host:setVaults': { args: [id: string, vaultIds: string[]]; result: HostMeta }`
      [`v.uuid(), v.array(v.uuid(), MAX_LINKS)`]
  - `createInventoryHandlers(deps: { hosts: HostStore })`. Later tasks widen
    `deps` with `environments`, `products` and `resolve`.
  - The test helper:
    `makeInventory(): Promise<VaultFixture & { hosts: HostStore; keys: KeyStore; identities: IdentityStore; sshDir: string }>`.
    It calls `makeVault`, unlocks, uses a tmp `sshDir`, and has a
    `makeIdentity(vaultId?)` shortcut. Task 3 adds `envs: EnvironmentStore`
    and `products: ProductStore`; Task 6 adds the importer deps.

- [ ] **Step 1: Write the failing tests** in `tests/main/hosts.test.ts`:
  - `creates with links in one go`:
    - `create({label:'web-1', address:'10.0.0.5', tags:['Prod','prod',' api '], vaultIds:[DEFAULT_VAULT_ID]})`
      returns `port null`, `identityId null`, `tags ['Prod','api']` and
      `vaultIds [DEFAULT_VAULT_ID]`.
    - Audit has one `host.create` with target label `web-1`.
  - `rejects bad input`, each with no value in the message:
    - duplicate label `WEB-1` → `/already exists/`;
    - address `-oProxyCommand=x` → `/address/`;
    - port `0`;
    - 17 tags;
    - an unknown `identityId`.
  - `null means inherit`: `update(id,{port:2222})`, then `update(id,{port:null})`,
    gives `port null`. `update(id,{})` adds no audit row.
  - `jump rules`:
    - self → `/own jump host/`;
    - A→B, then `update(B,{jumpHostId:A})` → `/jump host loop: B → A → B/`.
  - `refuses deleting a jump host`:
    - With B as A's jump host, `delete(B)` throws `/jump host for A/`.
    - With B as an environment's `default_jump_host_id`, it throws and names
      that environment.
  - `setVaults diffs`: `setVaults(id,[a,b])` then `setVaults(id,[b])` appends
    `host.vaults` with details `{added:[], removed:[a]}`.
  - `mutations need unlock`: after `vault.lock('manual')`, `create` throws
    `VAULT_LOCKED`, and `list()` still works.
  - `audit never carries values`: after creating a host with notes
    `root pw hunter22` and address `10.9.9.9`, then updating both,
    `auditRows(db)` contains neither `hunter22` nor `10.9.9.9`.
  - `ipc rejects bad host args`: through `registerHandlers` and
    `stubHandlers`, `host:create` with `{label:'x', address:'a b'}` or an
    extra key rejects with `/invalid arguments/`, without the value.
- [ ] **Step 2:** Run `pnpm test tests/main/hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the channels, `CHANNELS`, the
  validators (`asHostInput` / `asHostPatch`: label, address with
  `HOST_ADDRESS` and `MAX_ADDRESS`, `v.nullable` for port, identityId and
  jumpHostId, `v.array` for tags and links, `v.oneOf(OS_ICONS)`), and the
  `index.ts` wiring (`new HostStore(db, service, log)`).
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
  `ipc.test.ts`'s channel-list assert follows `CHANNELS` automatically.
- [ ] **Step 5: Commit:**
  `git add src/main/inventory src/main/ipc src/shared/ipc.ts src/main/index.ts tests/main && git commit -m "feat: host store with vault links and jump host checks"`

### Task 3: Environments and products (links, roles, defaults) and their IPC

**Files:**
- Create: `src/main/inventory/environment-store.ts`, `src/main/inventory/product-store.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/ipc/handlers/inventory.ts`, `src/main/index.ts`, `tests/main/inventory-helpers.ts`
- Test: `tests/main/environments.test.ts`

**Interfaces:**
- Consumes: `rows.ts`, `inTransaction`, `HostStore` (fixtures) and the Task 1
  types.
- Produces:
  ```ts
  class EnvironmentStore {
    constructor(db: Db, vault: VaultService, audit: AuditLog)
    list(): EnvironmentMeta[]                                   // by name NOCASE; works locked
    create(input: EnvironmentInput): EnvironmentMeta           // links productIds in the same tx
    update(id: string, patch: EnvironmentPatch): EnvironmentMeta
    delete(id: string): void                                    // audit details {hosts: n, products: n}
    setProducts(id: string, productIds: string[]): EnvironmentMeta // audit environment.products {added, removed}
    putHost(id: string, hostId: string, role: HostRole): EnvironmentMeta    // upsert; audit environment.host {op:'add'|'role', hostId, role, from?}
    removeHost(id: string, hostId: string): EnvironmentMeta    // audit environment.host {op:'remove', hostId}
  }
  class ProductStore {
    constructor(db: Db, vault: VaultService, audit: AuditLog)
    list(): ProductMeta[]
    create(input: ProductInput): ProductMeta
    update(id: string, patch: ProductPatch): ProductMeta       // repoUrl null clears
    delete(id: string): void                                    // links only; environments stay
  }
  ```
- Rules:
  - The per-product unique environment name (Global Constraints) is checked
    by `create`, `update` (rename) and `setProducts`.
  - Product names are unique (`/already exists/`).
  - `defaultIdentityId` and `defaultJumpHostId` must exist.
  - `putHost` with the same role is a no-op with no audit. `removeHost` of a
    host that isn't a member throws `host is not in this environment`.
- Channels:
  - `'env:list': { args: []; result: EnvironmentMeta[] }`
  - `'env:create': { args: [input: EnvironmentInput]; result: EnvironmentMeta }`
  - `'env:update': { args: [id: string, patch: EnvironmentPatch]; result: EnvironmentMeta }`
  - `'env:delete': { args: [id: string]; result: void }`
  - `'env:setProducts': { args: [id: string, productIds: string[]]; result: EnvironmentMeta }`
  - `'env:putHost': { args: [id: string, hostId: string, role: HostRole]; result: EnvironmentMeta }`
  - `'env:removeHost': { args: [id: string, hostId: string]; result: EnvironmentMeta }`
  - `'product:list'`, `'product:create'`, `'product:update'` and
    `'product:delete'`, shaped like the `env:*` CRUD channels with
    `ProductInput` and `ProductPatch`.
  - `asProductInput` checks `icon` with `v.oneOf(PRODUCT_ICONS)`, `repoUrl`
    with `v.optional(v.nullable(v.str({max: MAX_URL, pattern: REPO_URL})))`,
    and `description` up to `MAX_DESCRIPTION`.

- [ ] **Step 1: Write the failing tests** in `tests/main/environments.test.ts`:
  - `shared environment across products`:
    - Products `Acme` and `Essentials`; environment `analytics-db` with
      both `productIds`.
    - Both `productMeta(...).environmentIds` contain it.
    - `product.delete(Acme)` leaves the environment with
      `productIds [Essentials]`.
  - `per-product unique names`:
    - Two `prod` environments in different products are fine.
    - `setProducts(prodB, [A, B])` throws
      `/product Acme already has an environment named prod/`.
    - Renaming a `staging` in A to `PROD` throws the same.
  - `shared links are independent`:
    - Host H is `db` in `prod` and `app` in `staging`.
    - `removeHost(staging, H)` leaves `hostMeta(H).environments` equal to
      `[{environmentId: prod, role:'db'}]`.
  - `role changes are audited once`:
    - `putHost(prod,H,'db')` twice adds one `environment.host` row.
    - `putHost(prod,H,'bastion')` adds `{op:'role', role:'bastion', from:'db'}`.
  - `defaults validate`: an unknown `defaultJumpHostId` → `/host not found/`,
    and `defaultPort: 70000` is rejected at the IPC boundary.
  - `delete keeps hosts`: deleting `prod` leaves H, now with only its
    `staging` membership. The audit details are `{hosts: 1, products: n}`.
  - `locked writes refused, reads fine`: the same as Task 2, for `env:create`
    and `product:create`.
- [ ] **Step 2:** Run `pnpm test tests/main/environments.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both stores, their channels and validators, and
  the `index.ts` wiring.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:**
  `git add src/main/inventory src/main/ipc src/shared/ipc.ts src/main/index.ts tests/main && git commit -m "feat: environments and products with shared links and host roles"`

### Task 4: Credential and route resolution

**Files:**
- Create: `src/main/inventory/resolve.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/ipc/handlers/inventory.ts`, `src/main/index.ts`
- Test: `tests/main/resolve.test.ts`

**Interfaces:**
- Consumes: the Task 1 tables and types; `identities` rows (label, username,
  auth, vault_id only).
- Produces:
  - `resolveHost(db: Db, hostId: string, environmentId: string | undefined, opts: { localUser: string }): ResolvedHost`
  - `inheritConflicts(db: Db, hostId: string): InheritConflict[]`
  - `'host:resolve': { args: [hostId: string, environmentId?: string]; result: ResolvedHost }`,
    with `localUser` from `userInfo().username` in `index.ts`. It works while
    locked and never reads a `*_enc` column.
- The algorithm. The parts the types don't fix:
  - If an `environmentId` is given but the host isn't a member, it throws
    `host is not in that environment`.
  - Each field is the host's value, then the environment's default (only
    with a context), then the global value: port `22`; identity
    `{source:'global', username: localUser, auth:'default'}`; jump none.
  - A resolved jump host equal to the host itself becomes no jump
    (`source: null`). A bastion never routes through itself.
  - `chain` is built by resolving each jump host in turn. A hop is resolved
    in the same environment context if it is a member of that environment,
    and otherwise outside any environment. It is prepended, so the first hop
    to dial comes first.
  - A visited set detects loops: `jump host loop: <labels joined by ' → '>`.
    More than `MAX_JUMP_DEPTH` hops throws `jump chain is longer than 8 hops`.
  - Conflicts: for each field the host leaves `null`, collect its
    environments' defaults, with `null` counting as a value. When the host is
    in two or more environments and those defaults differ, report
    `{field, environmentIds}`. Conflicts are reported whatever the context.

- [ ] **Step 1: Write the failing tests** in `tests/main/resolve.test.ts`
  (fixtures via `makeInventory`; identities `deploy` and `ops`):
  - `host beats env beats global`:
    - H has `port 2200`; `prod` has `defaultPort 2222` and
      `defaultIdentityId deploy`.
    - `resolveHost(H, prod)` gives `port {2200,'host'}` and
      `identity {source:'environment', label:'deploy', username:'deploy'}`.
    - `resolveHost(H)` gives `identity {source:'global', username:'tester', auth:'default'}`.
    - With `port null`, `resolveHost(H, prod).port` is `{2222,'environment'}`.
  - `outside env skips step 2`: `resolveHost(H)` port is `{22,'global'}`, even
    though `prod` sets 2222.
  - `not a member`: `resolveHost(H, staging)` throws `/not in that environment/`.
  - `jump chain`:
    - App → explicit jump `bastion`; `bastion` → explicit jump `edge`.
    - `chain.map(h => h.label)` equals `['edge','bastion']`.
    - Each hop carries its own resolved port and identity.
  - `env default jump`: `prod.defaultJumpHostId = bastion`, and H has no jump.
    `resolveHost(H, prod).jump` is `{hostId: bastion, source:'environment'}`.
  - `bastion never jumps through itself`: `resolveHost(bastion, prod)` has
    `jump {hostId:null, source:null}` and `chain []`.
  - `detects loops through env defaults`:
    - A's explicit jump is B. B is in `prod`, and `prod`'s default jump is A.
    - `resolveHost(A, prod)` throws `/jump host loop: A → B → A/`.
  - `depth cap`: a 9-hop explicit chain throws `/longer than 8 hops/`.
  - `conflicts`:
    - H is in `prod` (default identity `deploy`) and `staging` (default
      `ops`), with no own identity.
    - `conflicts` is `[{field:'identity', environmentIds:[prod, staging]}]`,
      with the ids sorted.
    - Setting H's identity clears it.
    - A host in a single environment never has conflicts.
  - `no secrets`: with a password identity as the default,
    `JSON.stringify(resolveHost(...))` contains no `v1.` sealed text and no
    password.
- [ ] **Step 2:** Run `pnpm test tests/main/resolve.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `resolve.ts` and the channel.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:**
  `git add src/main/inventory/resolve.ts src/main/ipc src/shared/ipc.ts src/main/index.ts tests/main/resolve.test.ts && git commit -m "feat: host credential and route resolution with sources and conflicts"`

### Task 5: `ssh_config` parser

**Files:**
- Create: `src/main/inventory/ssh-config.ts`, `tests/fixtures/ssh/basic.conf`, `tests/fixtures/ssh/hostile.conf`, `tests/fixtures/ssh/include/config`, `tests/fixtures/ssh/include/config.d/work.conf`
- Test: `tests/main/ssh-config.test.ts`

**Interfaces:**
- Consumes: the `SshConfigEntry` type and `MAX_SSH_CONFIG_BYTES`.
- Produces:
  ```ts
  interface ParseOptions {
    home: string                       // expands ~ and %d
    sshDir: string                     // relative Include paths resolve here
    include?: (pattern: string) => { path: string; text: string }[]  // main supplies a sshDir-confined reader
  }
  function parseSshConfig(text: string, opts: ParseOptions): { entries: SshConfigEntry[]; warnings: string[] }
  ```
  It is pure and never throws (input errors become warnings).
- Rules (ssh_config(5), the subset we need):
  - Lines are trimmed, CRLF is accepted, and empty lines and `#` comments
    are skipped.
  - `Keyword value` and `Keyword=value` are both accepted. Keywords are
    case-insensitive. Double-quoted arguments keep their spaces.
  - An entry is every concrete alias: a `Host` pattern without `*`, `?` or
    `!`. `Host web web.prod` gives two entries, in file order.
  - Values come from walking every block whose pattern list matches the
    alias, in file order. The first value obtained wins. Lines before any
    `Host` match everything. A block matches when a positive pattern
    glob-matches and no `!` pattern does.
  - Keywords taken:
    - `HostName`: `%h` is replaced by the alias and `%%` by `%`. It defaults
      to the alias.
    - `Port`: integers 1–65535; otherwise a warning and `null`.
    - `User`.
    - `IdentityFile`: the first one. `~/` and `%d/` are expanded. A relative
      path, or one outside `sshDir` after `path.resolve`, becomes a warning
      and `null`.
    - `ProxyJump`: `none` becomes `null`.
    - `LocalForward` and `RemoteForward` go into `forwards`. Tunnels arrive in
      Phase 5.
  - Other keywords are ignored silently.
  - `Match` blocks are ignored up to the next `Host`, with a warning
    `Match blocks are not imported (line N)`.
  - `Include`: patterns are resolved through `opts.include` at the point of
    the directive. Includes nest at most 4 deep, and a file already included
    is skipped with a warning, which stops loops. With no `include` option,
    a warning `Include not followed: <arg>` is given.
  - Text over `MAX_SSH_CONFIG_BYTES` gives `{entries: [], warnings: ['ssh config is larger than 1 MiB']}`.
- Also produce `readSshIncludes(sshDir: string): (pattern: string) => { path: string; text: string }[]`
  in the same file:
  - `*` and `?` match within the basename only. The directory part resolves
    against `sshDir`.
  - Matches whose `realpath` is outside `realpath(sshDir)` are skipped.
  - Regular files only, each at most `MAX_SSH_CONFIG_BYTES`.
  - Errors are swallowed per file.

- [ ] **Step 1: Write the failing tests** in `tests/main/ssh-config.test.ts`.
  Fixtures are read with `readFileSync` from `tests/fixtures/ssh`. `home` is
  `/home/t` and `sshDir` is `/home/t/.ssh`; nothing touches the real `~`.
  - `basic.conf`, which holds:
    - `Host web-1` (`HostName 10.0.0.5`, `User deploy`, `Port 2222`,
      `IdentityFile ~/.ssh/id_ed25519`);
    - `Host db-1` (`HostName db.internal`, `ProxyJump bastion`,
      `LocalForward 5433 localhost:5432`);
    - `Host bastion` (`HostName 52.1.2.3`);
    - a final `Host *` (`User fallback`, `Port 22`).
    - Three entries in order. web-1 has `port 2222`, `user 'deploy'` and
      `identityFile '/home/t/.ssh/id_ed25519'`. db-1 has `user 'fallback'`,
      `proxyJump 'bastion'` and
      `forwards [{type:'L', spec:'5433 localhost:5432'}]`. bastion has
      `hostName '52.1.2.3'` and `port 22`.
  - `first value wins`: `Host *` with `User a` *before* `Host web` with
    `User b` gives `user 'a'`.
  - `patterns`: `Host !bad-* *.prod` gives no entry, but applies to
    `api.prod`. `Host bad-1.prod` doesn't get its values. `Host %h-x` with
    `HostName %h.example.com` expands.
  - `syntax`: `HostName=10.1.1.1`, `IdentityFile "/home/t/.ssh/my key"`,
    tabs and CRLF all parse.
  - `hostile fixture` (`hostile.conf`):
    - `Host evil` / `HostName -oProxyCommand=touch /tmp/pwned` is returned
      as-is, because rejection is the importer's job (Task 6).
    - `Port 99999` → `null` plus a warning.
    - `IdentityFile /etc/shadow` → `null` plus a warning.
    - A `Match host x` block → a warning, and its `User` is not applied.
    - `Include /etc/*` → a warning when no `include` option is given.
    - Nothing throws.
  - `includes stay inside and stop loops`:
    - The `include/` fixture is copied to a tmp `sshDir`. `config` holds
      `Include config.d/*`; `work.conf` holds `Host work` and
      `Include ../config`, which is a loop.
    - A symlink `config.d/out.conf` points at a file outside `sshDir`.
    - Parsing with `include: readSshIncludes(tmpSshDir)` yields `work`
      exactly once, plus a loop warning. `out.conf` is not read.
  - `size cap`: a 2 MB string gives the size warning and no entries.
- [ ] **Step 2:** Run `pnpm test tests/main/ssh-config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `parseSshConfig` and `readSshIncludes`. Globs
  compile to an anchored RegExp: escape everything except `*` (`.*`) and `?`
  (`.`).
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:**
  `git add src/main/inventory/ssh-config.ts tests/fixtures/ssh tests/main/ssh-config.test.ts && git commit -m "feat: ssh_config parser with patterns, includes and warnings"`

### Task 6: `~/.ssh/config` import (preview and import) and its IPC

**Files:**
- Create: `src/main/inventory/ssh-import.ts`, `src/main/ipc/handlers/ssh-import.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/index.ts`, `tests/main/inventory-helpers.ts`
- Test: `tests/main/ssh-import.test.ts`

**Interfaces:**
- Consumes:
  - `parseSshConfig` and `readSshIncludes` (Task 5);
  - `HostStore.create` (with `auditDetails`) and `rows.hostMeta`;
  - `inTransaction`;
  - `KeyStore.list` and `KeyStore.link(input: KeyLinkInput): Promise<SshKeyMeta>`;
  - `IdentityStore.list` and `IdentityStore.create(input: IdentityInput): IdentityMeta`;
  - `EnvironmentStore` (for membership validation).
- Produces:
  ```ts
  class SshImporter {
    constructor(deps: { db: Db; vault: VaultService; audit: AuditLog; hosts: HostStore; keys: KeyStore; identities: IdentityStore
      sshConfigPath: string; sshDir: string; home: string; localUser: string })
    preview(): Promise<SshImportPreview>          // works locked; missing file → { found:false, candidates:[], warnings:[] }
    import(req: SshImportRequest): Promise<SshImportResult>   // needs unlock
  }
  ```
  - `'sshconfig:preview': { args: []; result: SshImportPreview }`
  - `'sshconfig:import': { args: [req: SshImportRequest]; result: SshImportResult }`.
    Its validator: `vaultId` uuid, `aliases` an array of strings 1–`MAX_LABEL`
    with at most `MAX_IMPORT_ALIASES` items, `environmentId` an optional
    uuid, `role` an optional `HOST_ROLES` value.
  - `createSshImportHandlers(importer)`.
  - In `index.ts`, `sshConfigPath = join(homedir(), '.ssh', 'config')`,
    `sshDir = join(homedir(), '.ssh')`, and `home = homedir()`.
- Rules:
  - The preview and the import read and parse the file again, every time.
    The renderer sends aliases only, never config text.
  - In the preview:
    - `valid` is false when the alias fails the host label rules or
      `hostName` fails `HOST_ADDRESS`/`MAX_ADDRESS`. Its warning says
      `address isn't a plain hostname or IP; skipped`.
    - `existingHostId` comes from a case-insensitive label match.
    - `jumpResolvable` is true when `proxyJump` is a single hop
      (`[user@]host[:port]`) whose host matches another candidate alias or an
      existing host label.
    - A comma chain gives the warning
      `ProxyJump chains aren't imported; set the jump host by hand`.
    - Forwards give `N port forwards will be offered when Tunnels arrive`.
  - The import, in order:
    1. Re-parse. Classify each requested alias as `not-found`, `invalid` or
       `exists` (skipped), or as to-create.
    2. For each distinct `identityFile` among the to-create entries, reuse a
       key in `req.vaultId` with `source 'file'` and the same `filePath`.
       Otherwise call `keys.link({vaultId, label: basename, path})`. A link
       failure becomes a warning, and that entry falls back to agent auth.
    3. For each distinct (username, key) pair, reuse an identity in the
       vault with the same `username`, `auth` and `sshKeyId`. Otherwise
       create one, labelled `user` or `user · <key label>`. The username is
       `user ?? localUser`, but no identity at all is made when the entry
       has neither `User` nor `IdentityFile`; the host then inherits.
    4. In one `inTransaction`:
       - create each host (label = alias, address = hostName, port, identityId,
         `vaultIds: [vaultId]` when it has an identity, and
         `environments: [{environmentId, role: role ?? 'other'}]` when one was
         given), with `auditDetails {source:'ssh_config'}`;
       - then set the resolvable jump hosts with a direct `UPDATE`, checking
         for loops with the Task 2 rule (a loop is skipped with a warning);
       - then append one `host.import` event: target type `ssh_config`,
         details `{created, skipped, keysLinked, identitiesCreated}`.
  - Steps 2–3 run before the transaction, because `link` is async. Their
    rows stay if step 4 fails, and they are audited by their own stores.

- [ ] **Step 1: Write the failing tests** in `tests/main/ssh-import.test.ts`.
  Use a tmp home with `.ssh/config` written from `basic.conf`, plus an
  `id_ed25519` made by `generateEd25519` (Phase 2) in it. Nothing touches the
  real `~`.
  - `preview lists candidates`: three candidates. db-1 has
    `jumpResolvable: true` and a forwards warning. `found: true`. It works
    while locked.
  - `missing file`: `sshConfigPath` pointing nowhere gives `{found:false, candidates:[]}`.
  - `imports with keys, identities and jumps`:
    - `import({vaultId: DEFAULT_VAULT_ID, aliases:['web-1','db-1','bastion'], environmentId: prod, role:'db'})`
      creates 3 hosts. db-1's `jumpHostId` is bastion's id. web-1's
      identity has username `deploy` and `auth 'key'`, and its key has
      `source 'file'`.
    - `keysLinked 1`, and `identitiesCreated` is 2 (`deploy · id_ed25519`
      and `fallback`).
    - Every host has membership `prod/db` and `vaultIds [DEFAULT_VAULT_ID]`.
    - Audit has `key.link`, `identity.create` ×2, `host.create` ×3 and one
      `host.import`.
  - `re-import is idempotent`: the same import again gives `created []`,
    `skipped` with all three as `exists`, `keysLinked 0` and
    `identitiesCreated 0`. The row counts are unchanged.
  - `rejects option-looking addresses`: with `hostile.conf`'s `evil` alias,
    the preview has `valid:false`, and `import` reports
    `skipped [{alias:'evil', reason:'invalid'}]` and creates no host.
  - `unknown alias`: `aliases:['nope']` gives `not-found`.
  - `needs unlock`: while locked, `import` throws `VAULT_LOCKED`.
  - `no secrets in audit`: `auditRows(db)` has no `BEGIN OPENSSH`.
- [ ] **Step 2:** Run `pnpm test tests/main/ssh-import.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the importer, its handlers, the validators and the
  `index.ts` wiring.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:**
  `git add src/main/inventory/ssh-import.ts src/main/ipc src/shared/ipc.ts src/main/index.ts tests/main && git commit -m "feat: import hosts from ~/.ssh/config with preview"`

### Task 7: Renderer inventory store and pure view helpers

**Files:**
- Move: `src/renderer/src/pages/vaults/common.tsx` → `src/renderer/src/ui/common.tsx`
  (`git mv`, then update the vault page imports; no behavior change)
- Create: `src/renderer/src/inventory/store.ts`, `src/renderer/src/inventory/tree.ts`, `src/renderer/src/inventory/choices.ts`
- Modify: `tests/renderer/helpers.tsx` (`mockBridge` defaults: `product:list`, `env:list` and `host:list` → `[]`, plus `product()`, `environment()` and `host()` builders)
- Test: `tests/renderer/inventory-tree.test.ts`, `tests/renderer/inventory-store.test.ts`

**Interfaces:**
- Consumes: the `product:*`, `env:*`, `host:*`, `identity:list` and
  `vault:list` channels; `attempt` and `fail` (now in `ui/common.tsx`).
- Produces:
  - `store.ts`:
    ```ts
    interface InventoryData { products: ProductMeta[]; environments: EnvironmentMeta[]; hosts: HostMeta[]
      identities: IdentityMeta[]; vaults: VaultMeta[] }
    const inventoryStore            // { get, set, subscribe }, like commandStore
    function loadInventory(): Promise<void>   // parallel lists; failure → toast "Couldn't load your inventory"
    function useInventory(): InventoryData | null   // null until the first load
    // Mutations: each calls attempt(failTitle, …), then upserts or removes the returned row(s) in the store.
    // A host or environment change also refreshes the rows on the other side of the link, so shared items update everywhere.
    const inv: {
      saveProduct(input: ProductInput, id?: string): Promise<ProductMeta | undefined>
      deleteProduct(id: string): Promise<boolean>
      saveEnvironment(input: EnvironmentInput, id?: string): Promise<EnvironmentMeta | undefined>
      deleteEnvironment(id: string): Promise<boolean>
      setEnvironmentProducts(id: string, productIds: string[]): Promise<EnvironmentMeta | undefined>
      putHost(envId: string, hostId: string, role: HostRole): Promise<EnvironmentMeta | undefined>
      removeHost(envId: string, hostId: string): Promise<EnvironmentMeta | undefined>
      saveHost(input: HostInput, id?: string): Promise<HostMeta | undefined>
      deleteHost(id: string): Promise<boolean>
      setHostVaults(id: string, vaultIds: string[]): Promise<HostMeta | undefined>
    }
    ```
  - `tree.ts`:
    ```ts
    type NodeKey = string   // 'p:<id>', 'p:<id>/e:<id>', 'p:<id>/e:<id>/h:<id>', 'u', 'u/e:<id>', 'u/e:<id>/h:<id>', 'u/h:<id>'
    interface TreeRow { key: NodeKey; kind: 'product' | 'environment' | 'host' | 'group'; id: string; depth: 0 | 1 | 2
      parentKey: NodeKey | null; label: string; color: string; role?: HostRole; protected?: boolean
      sharedCount: number    // other places this env or host appears; 0 = not shared
      expandable: boolean; expanded: boolean; childCount: number }
    function buildTree(data: InventoryData, expanded: ReadonlySet<NodeKey>): TreeRow[]   // visible rows, in order
    function moveFocus(rows: TreeRow[], key: NodeKey, keyName: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'):
      { focus: NodeKey; toggle?: NodeKey }
    function selectionFromKey(key: NodeKey): { productId?: string; environmentId?: string; hostId?: string }
    ```
    The order: products by name. Inside a product, its environments by name.
    Inside an environment, its hosts by role (`bastion`, `app`, `db`,
    `other`), then by label. Last comes the group `u` "Unassigned",
    holding environments with no product and hosts with no environment. It
    is shown only when non-empty.
  - `choices.ts`:
    ```ts
    function identityChoices(identities: IdentityMeta[], vaults: VaultMeta[], linkedVaultIds: string[], corruptVaultIds: string[]):
      { group: 'Linked vaults' | 'Other vaults'; vault: VaultMeta; identities: IdentityMeta[] }[]
    function jumpHostChoices(hosts: HostMeta[], selfId: string | null): HostMeta[]   // excludes self and hosts whose explicit chain reaches self
    function sourceLabel(source: ValueSource | null, envName?: string): string
    // 'host' → 'From this host'; 'environment' → `Inherited from ${envName}`; 'global' → 'App default'; null → 'None'
    ```

- [ ] **Step 1: Write the failing tests:**
  - `inventory-tree.test.ts` → `builds the product tree`:
    - Products `Acme` and `Essentials`. `analytics-db` is shared by both.
      `prod` (Acme) holds `web-1` (app) and `bastion` (bastion). `orphan`
      is a host with no environment.
    - With everything expanded, the labels in order are `Acme`,
      `analytics-db`, `prod`, `bastion`, `web-1`, `Essentials`,
      `analytics-db`, `Unassigned`, `orphan`.
    - Both `analytics-db` rows have `sharedCount 1`.
  - `inventory-tree.test.ts` → `collapsed hides children`: with an empty
    `expanded`, only the products and `Unassigned` show.
  - `inventory-tree.test.ts` → `keyboard moves`:
    - ArrowRight on a collapsed product gives `toggle` for that product.
    - ArrowRight on an expanded one focuses its first child.
    - ArrowLeft on a host focuses its environment.
    - Home and End go to the first and last rows.
  - `inventory-tree.test.ts` → `identity choices`:
    - Vaults `Default` (linked), `Ops` (not linked) and `Broken` (corrupt).
    - The groups are `['Linked vaults','Other vaults']` with vault names
      `Default` and `Ops`. `Broken` is absent.
    - With no links, there is a single `Other vaults` group.
  - `inventory-tree.test.ts` → `jump choices`: with A→B explicit,
    `jumpHostChoices(hosts, B)` excludes B and A.
  - `inventory-store.test.ts` → `shared host updates everywhere`:
    - After `loadInventory()` with H in two environments,
      `inv.removeHost(staging, H)` resolves.
    - The store's `staging.hosts` lacks H, and `hosts[H].environments` keeps
      only `prod`. The store re-reads `host:list` (or uses the returned row)
      without a full reload.
  - `inventory-store.test.ts` → `locked mutation unlocks then retries`: the
    first `host:create` rejects with `vault locked`. After the mocked unlock,
    it is retried once and the host appears. This mirrors the Phase 2
    `withUnlock` test.
- [ ] **Step 2:** Run `pnpm test tests/renderer/inventory-tree.test.ts tests/renderer/inventory-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the move, the store and the helpers.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS. The
  vault page tests are unchanged.
- [ ] **Step 5: Commit:**
  `git add -A src/renderer/src/ui src/renderer/src/pages/vaults src/renderer/src/inventory tests/renderer && git commit -m "feat: renderer inventory store, tree model and picker helpers"`

### Task 8: Products page (animated tree, product and environment views)

**Files:**
- Create:
  - `src/renderer/src/pages/products/ProductsPage.tsx`,
    `src/renderer/src/pages/products/InventoryTree.tsx`;
  - `src/renderer/src/pages/products/ProductView.tsx`,
    `src/renderer/src/pages/products/EnvironmentView.tsx`;
  - `src/renderer/src/pages/products/ProductDialog.tsx`,
    `src/renderer/src/pages/products/EnvironmentDialog.tsx`.
- Modify:
  - `src/renderer/src/shell/sections.ts`: the first section becomes
    `{ id: 'products', label: 'Products', path: '/products' }`, replacing
    `environments`. There are still 6 sections, so `mod+1`–`mod+6` still
    hold.
  - `src/renderer/src/shell/Sidebar.tsx`: the `products` icon is `Boxes`.
  - `src/renderer/src/shell/AppShell.tsx`: drop the `environments` and
    `hosts` placeholders. Route `/products` to `ProductsPage` and redirect
    `/environments` to `/products`.
  - `tests/renderer/shell.test.tsx`: `Environments` becomes `Products`.
- Test: `tests/renderer/products-page.test.tsx`

**Interfaces:**
- Consumes:
  - Task 7's `useInventory`, `inv`, `buildTree`, `moveFocus`,
    `selectionFromKey` and `identityChoices`;
  - `ConfirmDialog` and `RowMenu` (`ui/common.tsx`);
  - `Dialog`, `Field`, `Badge`, `EmptyState`, `Skeleton`, `spring`, `fast`
    and `useMotionSafe`;
  - `HostView` (Task 9). Until Task 9 lands, a host selection renders its
    label only.
- Produces:
  - The route `/products?node=<NodeKey>`. The URL selection survives reloads,
    and it defaults to the first product.
  - `InventoryTree({ rows, selected, onSelect, onToggle, onDropHost, onDropEnvironment })`
    has `role="tree"`, rows with `role="treeitem"`, `aria-level`,
    `aria-expanded` and `aria-selected`, and a roving `tabIndex`. Keys go
    through `moveFocus`, and Enter or Space selects.
  - **Motion, the parts that are decisions:**
    - Children expand and collapse with `AnimatePresence` height `auto` and
      `spring`. The chevron rotates 0→90°.
    - The selected row has a shared-layout highlight (`layoutId="tree-active"`),
      like the sidebar.
    - Hovering a shared host or environment (`sharedCount > 0`) rings every
      other row with the same id: a soft pulse while motion is safe, a static
      ring otherwise.
    - The product view shows its environments as cards that stagger in (30 ms
      apart, the first load only). Each card has its color stripe, a
      `Protected` badge, host counts per role and a "Shared" badge with the
      other product names.
    - The environment view groups hosts by role with counts. A defaults card
      shows identity, port and jump host, each with a `sourceLabel`.
    - With reduced motion: opacity only, no height or transform animation,
      no pulse.
  - **Drag and drop** (HTML5, plus menu equivalents in Task 9):
    - Dropping a host row on an environment row calls
      `inv.putHost(env, host, currentRoleOr('other'))`. The toast reads
      "Added web-1 to staging", and the host is now shared.
    - Dropping an environment row on a product row calls
      `inv.setEnvironmentProducts(env, [...productIds, product])`.
    - Valid drop targets glow while dragging. A drop that changes nothing
      is ignored.
  - Copy, used verbatim:
    - "No products yet"
    - "Create your first product to group environments."
    - "New product"
    - "New environment"
    - "Unassigned"
    - "Shared"
    - "Protected"
    - "No hosts in this environment yet"
  - The environment dialog has: name, color (`ColorPicker`), a `Protected`
    toggle, the products it belongs to (multi-select chips), a default
    identity (grouped by `identityChoices`, with linked vaults empty, so
    every usable vault shows as "Other vaults"), a default port (blank =
    22), and a default jump host.
  - Deleting a protected environment uses `typeToConfirm` with its name.
  - Palette commands while mounted: "New product" and "New environment".
    `mod+n` opens New environment when a product is selected, and New product
    otherwise.

- [ ] **Step 1: Write the failing tests** in `tests/renderer/products-page.test.tsx`.
  Use `mockBridge` with the Task 7 builders, render in a `MemoryRouter` at
  `/products`, include `<Toaster/>`, and stub `matchMedia` for
  reduced-motion cases where noted.
  - `empty state`: with no products, "No products yet" and the "New product"
    action show.
  - `renders the tree`:
    - It holds `Acme`, `analytics-db` (with a "Shared" badge) and `prod`.
    - Clicking the `Acme` chevron collapses it, and `aria-expanded`
      becomes `false`.
    - `getAllByRole('treeitem')` follows `buildTree` order.
  - `keyboard navigation`: focus the first item. ArrowDown moves
    `aria-selected` to the next row, ArrowLeft collapses, and Enter sets the
    URL `node`.
  - `creates a product`: "New product" with name `Essentials` and icon
    `leaf` calls `invoke('product:create', {name:'Essentials', color:'#5b8cff', icon:'leaf', description:''})`,
    and the tree shows it.
  - `environment dialog saves defaults`:
    - New environment under `Acme` with name `staging`, port `2222` and
      default identity `deploy`.
    - `env:create` is called with
      `{name:'staging', color, protected:false, defaultPort:2222, defaultIdentityId, defaultJumpHostId:null, productIds:[acme]}`.
  - `shared host updates everywhere`:
    - Drag `web-1` (in `prod`) onto `staging`. `env:putHost` is called with
      `(staging, web1, 'app')`, and the toast reads "Added web-1 to staging".
    - `web-1` now appears under both environments, with the "Shared" ring
      on hover.
  - `protected delete types the name`: deleting `prod` (protected) keeps
    Confirm disabled until `prod` is typed, then calls `env:delete`.
  - `reduced motion`: with `matchMedia('(prefers-reduced-motion: reduce)')`
    true, expanding still shows the children immediately (no waiting on
    animation). The test asserts the children are present right after the
    click, without `findBy`.
  - `shell.test.tsx`: `mod+1` lands on `Products`, and there is no "Coming
    in phase 3".
- [ ] **Step 2:** Run `pnpm test tests/renderer`. Expected: FAIL.
- [ ] **Step 3: Implement**, using the `frontend-design` skill. The tree rail
  is 272px wide and styled like `VaultRail`. Detail panes use the Vaults
  page header pattern (color dot glow, title, badges).
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Manual check:** run `pnpm dev`, unlock, create two products,
  share an environment by drag, expand and collapse with the keyboard, then
  turn on macOS "Reduce motion" and repeat. The Audit page shows each
  action, with no values in its details.
- [ ] **Step 6: Commit:**
  `git add src/renderer/src/pages/products src/renderer/src/shell tests/renderer && git commit -m "feat: products page with animated product, environment and host tree"`

### Task 9: Host view, host dialog and resolved connection card

**Files:**
- Create: `src/renderer/src/pages/hosts/HostView.tsx`, `src/renderer/src/pages/hosts/HostDialog.tsx`, `src/renderer/src/pages/hosts/ConnectionCard.tsx`, `src/renderer/src/pages/hosts/MembershipEditor.tsx`
- Modify: `src/renderer/src/pages/products/ProductsPage.tsx` (render `HostView` for host selections, passing the environment from the node key as context)
- Test: `tests/renderer/host-view.test.tsx`

**Interfaces:**
- Consumes: `host:resolve`; Task 7's `inv`, `identityChoices`,
  `jumpHostChoices` and `sourceLabel`; `useVaultStatus` (`corruptVaultIds`).
- Produces:
  - `HostView({ hostId, environmentId?: string })` shows:
    - a header (label, address in mono, OS icon, tags);
    - `ConnectionCard`;
    - linked vaults (chips plus "Link vault" with a multi-select that calls
      `inv.setHostVaults`);
    - the environments it belongs to (`MembershipEditor`: a role select per
      environment, "Add to environment…", and remove);
    - notes;
    - a row menu: Edit, Delete (confirm).
  - `ConnectionCard({ hostId, environmentId? })`:
    - It calls `host:resolve(hostId, environmentId)` on mount and after any
      inventory change touching that host, an environment it is in, or its
      jump hosts.
    - It renders rows for User (`identity.username`, plus the identity label
      and auth), Port and Jump via, each with a `sourceLabel` chip. The
      jump chain renders as `edge → bastion → web-1` chips.
    - The context switcher is a segmented control, "Outside any
      environment" plus each environment the host belongs to. Switching
      re-resolves, and the changed values cross-fade
      (`AnimatePresence mode="popLayout"` keyed by value; opacity only with
      reduced motion).
    - For each `conflicts` entry it shows a warning, verbatim:
      `Environments disagree on the ${'identity'|'port'|'jump host'}. Set it on this host.`
    - A resolve error (a loop or depth) shows in the card as an error
      badge with the message, never as a crash.
  - `HostDialog({ open, host?, presetEnvironment?: Membership, onClose, onSaved })` has:
    - label and address fields, plus a port field where blank means inherit;
    - the identity select, grouped by `identityChoices(identities, vaults, linkedVaultIds, corruptIds)`.
      Option groups are labelled "Linked vaults" and "Other vaults", and the
      first option is `Inherit (${sourceLabel…})`;
    - the jump host select from `jumpHostChoices`, with an "Inherit" option;
    - tags (chips, Enter or comma to add, Backspace to remove), the OS icon
      and notes;
    - when creating, the linked vaults default to `[DEFAULT_VAULT_ID]`, and
      `presetEnvironment` becomes `environments`.
  - Copy, used verbatim:
    - "New host"
    - "Inherit"
    - "Linked vaults"
    - "Other vaults"
    - "Outside any environment"
    - "App default"
    - "Add to environment…"

- [ ] **Step 1: Write the failing tests** in `tests/renderer/host-view.test.tsx`:
  - `connection card shows sources`:
    - `host:resolve` returns port `{2222,'environment'}`, identity `deploy`
      from the environment, and chain `[bastion]`.
    - The card shows `2222`, "Inherited from prod" and `bastion → web-1`.
  - `context switch re-resolves`:
    - Clicking "Outside any environment" calls `host:resolve(web1)` with no
      environment.
    - Port then shows `22` and "App default".
  - `conflict warning`: `conflicts: [{field:'identity', environmentIds:[prod, staging]}]`
    shows "Environments disagree on the identity. Set it on this host."
  - `resolve error is contained`: `host:resolve` rejecting with
    `jump host loop: A → B → A` shows that text, and the rest of the view
    still renders.
  - `identity picker lists linked vaults first`:
    - The host is linked to `Ops`. Identities exist in `Ops` and `Default`,
      and `Broken` is corrupt.
    - The `<optgroup>` labels in order are `Linked vaults` then
      `Other vaults`. `Ops`'s identity comes first, and `Broken`'s identity
      is absent.
  - `jump picker excludes self and loops`: as in Task 7's test, through the
    dialog's options.
  - `create from an environment`:
    - "New host" with `presetEnvironment {prod, 'db'}`, label `db-2` and
      address `10.0.0.9`.
    - `host:create` is called with
      `{label:'db-2', address:'10.0.0.9', port:null, identityId:null, jumpHostId:null, tags:[], osIcon:'linux', notes:'', vaultIds:[DEFAULT_VAULT_ID], environments:[{environmentId: prod, role:'db'}]}`.
  - `role change and add to environment`:
    - Changing the role select to `bastion` calls
      `env:putHost(prod, web1, 'bastion')`.
    - "Add to environment…" → `staging` calls
      `env:putHost(staging, web1, 'other')`.
  - `edit to inherit`: clearing the port and saving sends `{port: null}` in
    `host:update`.
- [ ] **Step 2:** Run `pnpm test tests/renderer/host-view.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, using the `frontend-design` skill. Source chips
  use tones: `host` is accent, `environment` takes the environment's color,
  and `global` is muted.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:**
  `git add src/renderer/src/pages/hosts src/renderer/src/pages/products tests/renderer && git commit -m "feat: host view with resolved connection, vault links and memberships"`

### Task 10: Hosts page, `~/.ssh/config` import wizard and palette navigation

**Files:**
- Create: `src/renderer/src/pages/hosts/HostsPage.tsx`, `src/renderer/src/pages/hosts/ImportDialog.tsx`, `src/renderer/src/inventory/commands.ts`
- Modify: `src/renderer/src/shell/AppShell.tsx` (route `/hosts`, and call `useInventoryCommands()` once inside the shell)
- Test: `tests/renderer/hosts-page.test.tsx`

**Interfaces:**
- Consumes: `sshconfig:preview` and `sshconfig:import` (Task 6); `HostView`
  and `HostDialog` (Task 9); Task 7's store; `registerCommand`.
- Produces:
  - Route `/hosts?host=<id>`. The page has:
    - a list of every host (label, address in mono, environment chips in
      their colors, a role icon, tags), with a search box over label,
      address and tags;
    - tag filter chips;
    - `HostView` for the selected host in a right pane, outside any
      environment;
    - "New host" and "Import from ~/.ssh/config" buttons;
    - rows that stagger in on first load;
    - `Skeleton` rows while loading;
    - the empty state "No hosts yet", with both actions.
  - `ImportDialog` is a 2-step wizard:
    1. **Preview.** It calls `sshconfig:preview`. Candidates show as
       checkbox rows (alias, `user@hostName:port`, a key badge, a jump
       badge, warnings as amber chips). Existing and invalid rows are
       disabled, with "Already added" or "Skipped". "Select all" covers only
       the valid new rows. When `found` is false, it shows
       "No ~/.ssh/config found".
    2. **Where.** The vault for identities and keys (default `Default`), an
       optional environment and role. "Import N hosts" calls
       `sshconfig:import`. The result screen counts up the created hosts
       with a spring (static with reduced motion) and lists `skipped` and
       `warnings`. Steps slide `x: 16` with `spring`, or fade with reduced
       motion.
  - `useInventoryCommands()` (in `inventory/commands.ts`) registers, from the
    store:
    - `Go to ${host.label}` for each host (section `Hosts`, keywords address
      and tags), running `navigate('/hosts?host=<id>')`;
    - `Go to ${env.name} · ${productNames}` for each environment (section
      `Environments`), running `navigate('/products?node=<key>')`;
    - "New host" and "Import from ~/.ssh/config".
    - Commands are re-registered when the store changes, and each
      registration is cleaned up.
  - Copy, used verbatim:
    - "No hosts yet"
    - "Import from ~/.ssh/config"
    - "No ~/.ssh/config found"
    - "Already added"
    - "Skipped"
    - "Import N hosts"
    - "Imported N hosts"

- [ ] **Step 1: Write the failing tests** in `tests/renderer/hosts-page.test.tsx`:
  - `lists and filters`: three hosts. Typing `10.0.0` in search leaves the
    two matching rows. Clicking tag `db` leaves one.
  - `import wizard`:
    - `sshconfig:preview` returns `web-1` (new), `bastion` (with
      `existingHostId`) and `evil` (`valid:false`, with a warning).
    - `bastion` shows "Already added" and `evil` shows "Skipped". Both are
      disabled, and "Select all" checks only `web-1`.
    - Next, choose environment `prod` and role `app`, then "Import 1 hosts".
      Copy pluralises: "Import 1 host".
    - `sshconfig:import` is called with
      `{vaultId: DEFAULT_VAULT_ID, aliases:['web-1'], environmentId: prod, role:'app'}`.
    - The result shows "Imported 1 host", and the list shows `web-1`.
  - `no config`: `found:false` shows "No ~/.ssh/config found".
  - `locked import unlocks first`: `sshconfig:import` rejects once with
    `vault locked`, the unlock flow runs, and it retries.
  - `palette navigates`:
    - Open ⌘K and type `web`. "Go to web-1" is listed.
    - Choosing it lands on `/hosts?host=<id>`, and `HostView` shows `web-1`.
    - Deleting the host removes the command.
  - `shell.test.tsx`: Hosts no longer shows a placeholder.
- [ ] **Step 2:** Run `pnpm test tests/renderer`. Expected: FAIL.
- [ ] **Step 3: Implement**, using the `frontend-design` skill.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Manual check:**
  - Run `pnpm dev`. Import from your real `~/.ssh/config`. This is the only
    place the real file is read, by the running app and not by tests.
  - Check that the preview warnings make sense. Import into an environment,
    open a host from the tree and from the Hosts page, and compare the
    connection card in both contexts.
  - Use ⌘K "Go to …".
  - The Audit page shows `host.import` with counts only.
- [ ] **Step 6: Commit:**
  `git add src/renderer/src/pages/hosts src/renderer/src/inventory src/renderer/src/shell tests/renderer && git commit -m "feat: hosts page, ssh config import wizard and palette navigation"`

After Task 10, update the roadmap row 3 status to done
(`docs/superpowers/plans/2026-10-16-roadmap.md`) in the final commit of the
phase.
