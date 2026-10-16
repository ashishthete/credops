# OpsDeck Phase 2: Vaults and Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypted vaults behind one master password, with:
- setup, unlock, lock, auto-lock and a Keychain / Touch ID unlock cache;
- multiple vaults (Default exists from the start);
- secrets, SSH keys (link from `~/.ssh`, import, generate ed25519) and identities;
- a polished Vaults page;
- an audit event for every vault action, with no secret value in the trail.

It also closes the Phase 1 hardening follow-ups and adds per-channel IPC
argument validation.

**Architecture:**
- The main process owns all key material.
  - `VaultService` derives a key-encryption key (KEK) from the master password
    with scrypt.
  - It unwraps one random 32-byte key per vault and keeps them in memory only
    while unlocked.
  - `SecretStore`, `KeyStore` and `IdentityStore` encrypt each secret field
    with AES-256-GCM under its vault's key. The AAD binds each ciphertext to
    its row and field.
- Metadata (names, labels, public keys, fingerprints) is plain, so lists work
  while locked.
- Plaintext reaches the renderer only from `secret:reveal`. `secret:copy`
  writes the clipboard from main.
- While unlocked, every decrypted value feeds `AuditLog`'s `knownSecrets` and
  the IPC error redactor.

**Tech Stack:**
- Everything from Phase 1;
- `node:crypto`: `scrypt`, `aes-256-gcm`, `generateKeyPairSync('ed25519')`,
  `createPrivateKey` / `createPublicKey`;
- Electron `safeStorage`, `systemPreferences.promptTouchID`, `powerMonitor`
  and `clipboard`, injected from `index.ts` only.
- No new runtime dependency. `ssh2` arrives in Phase 4.

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md` (§5 anti-goals,
§6 vault crypto, §7 Vault/Secret/SshKey/Identity, §8.1, §9 phase 2, §9a one
master password and Touch ID, §10 feel). Roadmap and cross-phase contracts:
`docs/superpowers/plans/2026-10-16-roadmap.md`. Carried items:
`docs/superpowers/plans/2026-10-16-phase1-followups.md`.

## Global Constraints

- **All Phase 1 constraints still hold:**
  - the window flags;
  - the renderer imports no Node;
  - the preload requires only `electron`;
  - modules under test import only *types* from `electron`;
  - storage is `node:sqlite` via `process.getBuiltinModule`. It is not
    `better-sqlite3`; that spec line was superseded in Phase 1.
- **KDF:** scrypt with `N = 2^17, r = 8, p = 1`, a 32-byte output, a random
  16-byte salt, and `maxmem = 256 MiB`.
  - Use async `crypto.scrypt`, never `scryptSync`, so the main process doesn't
    stall.
  - The params and salt are stored as JSON in every vault's `kdf_params`.
    Tests inject `N = 2^10`.
- **Ciphers:** AES-256-GCM, a fresh 12-byte IV per seal, a 16-byte tag.
  - Sealed text format:
    `v1.<b64url iv>.<b64url ciphertext>.<b64url tag>`.
  - AAD strings:
    - `vault:<vaultId>` for a wrapped vault key;
    - `secret:<id>:value`;
    - `key:<id>:private`;
    - `key:<id>:passphrase`;
    - `identity:<id>:password`.
- **One master password** unlocks all vaults (§9a). Each vault has its own
  random key, wrapped by the one KEK.
- **Master password:** at least 10 characters (`MIN_MASTER_PASSWORD = 10`),
  at most 1024. There are no composition rules; the UI shows a strength meter.
- **Brute-force backoff:**
  - The first 3 consecutive failures are free.
  - After that, the wait is `min(1000 · 2^(failures−3), 300000)` ms from the
    last failure.
  - The count is persisted in `vault_state`, so a restart doesn't reset it. A
    success resets it.
  - A throttled attempt runs no scrypt and adds no failure.
- **Auto-lock:**
  - Default 15 minutes of system idle. Choices: 1, 5, 15, 60 or never.
  - Also locks on `lock-screen`, on `suspend` and on quit.
  - Lock zeroes every key buffer (`fill(0)`).
- **Quick unlock** (`safeStorage` holds the KEK, never the password):
  - The modes are `off` (default), `touchId` (`promptTouchID` before every use)
    and `login` (Keychain only, explicit opt-in with a warning).
  - Enabling a mode requires the vaults to be unlocked.
  - A cache that fails to decrypt is deleted and the mode is set to `off`.
- **Secret limits:**
  - A value is 1–65536 characters.
  - Names and labels are 1–120 characters, trimmed.
  - A username is 1–256 characters.
  - Private key text is at most 16384 characters.
  - A color is `#rrggbb`.
- **Clipboard:** `secret:copy` clears the clipboard after 30 s
  (`CLIPBOARD_CLEAR_MS`), but only if it still holds that value. Lock and quit
  clear it under the same rule.
- **Reveal:** the UI hides a revealed value after 10 s (`REVEAL_HIDE_MS`).
- **Audit:**
  - Every vault, secret, key and identity mutation, reveal, copy, lock and
    unlock appends an event.
  - The target is the vault, secret, key or identity, with its name or label.
  - `details` hold ids, kinds and reasons only, never a value.
  - The actions are added to `AUDIT_ACTIONS`.
- **Every mutation requires unlocked.** Reads of metadata work while locked.
  - A locked call throws `Error(VAULT_LOCKED)` (`'vault locked'`). The renderer
    treats that message as "ask to unlock".
- **The feel** (Phase 1 rule, unchanged):
  - springs `stiffness 400, damping 30`, ⌘K commands, shortcuts, toasts,
    skeletons and animated empty states;
  - `prefers-reduced-motion` respected;
  - use the `frontend-design` skill on Tasks 9–10.
- **Commit attribution:** commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The process dies halfway through a master-password change.** Exactly one
   of the old and new passwords must unlock every vault, never a mix. Covered
   in Task 4 (`password change is atomic`).
2. **A ciphertext is moved or edited in the DB file** (copied to another row,
   or one byte flipped). Decrypt fails with a clean error and nothing crashes
   or partially unlocks. A tampered `wrapped_key` reads as `wrong-password`.
   Covered in Task 3 (`aad binds rows`) and Task 4
   (`tampered wrapped key fails closed`).
3. **Auto-lock fires while a copied secret sits on the clipboard,** or after
   the user has copied something else. Lock clears only our own value; the
   user's later copy survives. Covered in Task 6 (`lock clears only our clipboard`).
4. **Odd values:**
   - multi-line `.env` values, emoji, a 65536-character value, a value that
     looks like PEM;
   - an empty value, or one character over the cap.
   - The odd values round-trip byte-exact, and they never appear in the raw DB
     file or WAL. The empty and over-cap values are rejected at the IPC
     boundary, and the error doesn't echo the value.
   - Covered in Task 6 (`round-trips odd values`, `no plaintext on disk`,
     `ipc rejects bad secret args`).
5. **A messy `~/.ssh`:**
   - `known_hosts`, `config`, `authorized_keys`;
   - a `.pub` file without its private key;
   - a directory, a broken symlink, an unreadable file, a 5 MB file;
   - an encrypted key.
   - The scan lists only the private keys and never throws. An encrypted
     OpenSSH key still shows its type and fingerprint.
   - Covered in Task 8 (`scans a messy ~/.ssh`).

---

### Task 1: Phase 1 hardening (fuses, CSP, bigint, corrupt audit rows)

**Files:**
- Modify: `electron-builder.yml`, `src/renderer/index.html`, `src/main/security/redact.ts`, `src/main/audit/audit-log.ts`
- Test: `tests/main/hardening.test.ts`

**Interfaces:**
- Produces:
  - `redact` turns a `bigint` into its decimal string (`10n` → `'10'`) at
    any depth, so redacted output is JSON-safe for every sink.
  - `AuditLog.list` returns a row whose details don't parse as
    `details: { _corrupt: true, bytes: <raw length> }`. The raw text is never
    returned.

- [ ] **Step 1: Write the failing tests** in `tests/main/hardening.test.ts`:
  - `csp blocks objects and base`: the CSP `content` of `src/renderer/index.html`
    contains `object-src 'none'` and `base-uri 'none'`, and still contains
    `script-src 'self'`.
  - `fuses are configured`: the text of `electron-builder.yml` contains each
    of these lines under `electronFuses:`:
    - `runAsNode: false`
    - `enableNodeOptionsEnvironmentVariable: false`
    - `enableNodeCliInspectArguments: false`
    - `enableEmbeddedAsarIntegrityValidation: true`
    - `onlyLoadAppFromAsar: true`
  - `redact stringifies bigint`: `redact({a: {n: 10n}, l: [2n]})` equals
    `{a: {n: '10'}, l: ['2']}`.
  - `corrupt audit rows never leak raw text`:
    - Insert a raw row through SQL with `details` set to
      `'{"password":"hunter22" -----BEGIN OPENSSH PRIVATE KEY-----'`.
    - `list()[0].details` equals `{_corrupt: true, bytes: <that length>}`.
    - `JSON.stringify(list())` does not contain `hunter22`.
- [ ] **Step 2:** Run `pnpm test tests/main/hardening.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add the `electronFuses` block to `electron-builder.yml`. Leave
    `grantFileProtocolExtraPrivileges` at its default, because `loadFile`
    needs it.
  - Add the two CSP directives.
  - Add a `typeof v === 'bigint'` branch in `redact`'s `walk`.
  - In `toEvent`'s tolerant branch, build `{ _corrupt: true, bytes }`.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Packaged launch check.**
  - Run `pnpm build:mac`.
  - Run `pnpm dlx @electron/fuses read --app dist/mac-arm64/OpsDeck.app`.
    Expected: RunAsNode, EnableNodeOptionsEnvironmentVariable and
    EnableNodeCliInspectArguments are Disabled; EnableEmbeddedAsarIntegrityValidation
    and OnlyLoadAppFromAsar are Enabled.
  - Run `open dist/mac-arm64/OpsDeck.app`. Expected: the window opens and the
    Audit page shows a new `app.start` row.
- [ ] **Step 6: Commit:** `git commit -am "fix: electron fuses, stricter csp, bigint and corrupt-row redaction"`

### Task 2: Per-channel IPC argument validation

**Files:**
- Create: `src/main/ipc/validate.ts`, `src/main/ipc/validators.ts`
- Modify: `src/main/ipc/register.ts`, `src/main/index.ts`
- Test: `tests/main/validate.test.ts`, `tests/main/ipc.test.ts`

**Interfaces:**
- Consumes: `CHANNELS`, `IpcContract`, `Channel` (`src/shared/ipc.ts`);
  `AUDIT_ACTIONS` (`src/shared/audit.ts`); `redact`.
- Produces in `src/main/ipc/validate.ts`:
  - `class InvalidArgs extends Error`. Its message is
    `invalid arguments: <path> <rule>`, e.g. `invalid arguments: [0].value must be at most 65536 chars`.
    It never contains the offending value.
  - `type Check<T> = (value: unknown, path: string) => T`
  - The combinators:
    - `v.str(opts?: { min?: number; max?: number; pattern?: RegExp; trim?: boolean })`
    - `v.int(opts?: { min?: number; max?: number })`
    - `v.bool()`
    - `v.oneOf<T extends string | number | null>(values: readonly T[])`
    - `v.optional(c)`
    - `v.array(c, max)`
    - `v.object(shape)` rejects unknown keys and requires the non-optional
      keys.
    - `v.uuid()`
  - `type ArgsValidator<A extends unknown[]> = (args: readonly unknown[]) => A`
  - `args(...checks): ArgsValidator<…>` validates positional args. Any extra
    args are dropped (arity truncation).
- Produces in `src/main/ipc/validators.ts`:
  - `asFilter: Check<AuditFilter>`. Its `actions` must be in `AUDIT_ACTIONS`;
    `limit` is an int from 1 to 1000; `beforeId` is an int ≥ 1; `text` is at
    most 200 chars.
  - `VALIDATORS: { [K in Channel]: ArgsValidator<IpcContract[K]['args']> }`.
    The mapped type makes a missing channel a type error. Each later task adds
    its own entries here.
- Changes `registerHandlers(ipc, handlers, trust, opts: { validators: typeof VALIDATORS; knownSecrets?: () => readonly string[] }): void`:
  - It validates before calling the handler, and passes only the validated
    args.
  - A handler error is rethrown as `new Error(redact(message, knownSecrets()))`.
- Test helper `stubHandlers(over?: Partial<Handlers>): Handlers`, built from
  `CHANNELS`, so `tests/main/ipc.test.ts` stops listing every channel by hand.

- [ ] **Step 1: Write the failing tests:**
  - `validate.test.ts` → `checks shapes without echoing values`:
    - `v.object({name: v.str({min:1,max:3})})({name:'hunter22'}, '[0]')`
      throws `InvalidArgs`. The message matches `/\[0\]\.name/` and does not
      contain `hunter22`.
    - An unknown key throws.
    - `v.uuid()('x','[0]')` throws.
  - `validate.test.ts` → `truncates extra args`:
    `args(v.int())([1, 'extra'])` equals `[1]`.
  - `validate.test.ts` → `asFilter`:
    - `{actions:['app.start'], limit: 5}` passes.
    - `{actions:['nope']}`, `{limit: 0}` and `{limit: 1.5}` throw.
  - `ipc.test.ts` → `rejects bad args before the handler runs`:
    `audit:list` called with `[{limit:'x'}]` rejects with `/invalid arguments/`,
    and the handler spy was not called.
  - `ipc.test.ts` → `passes only validated args`:
    `audit:verify` called with `['extra']` invokes its handler with zero args.
  - `ipc.test.ts` → `redacts handler errors`: a handler throwing
    `Error('boom hunter22')`, registered with `knownSecrets: () => ['hunter22']`,
    rejects with `'boom ‹redacted›'`.
  - `ipc.test.ts`, the follow-up cases:
    - an event with `senderFrame: null` is rejected as `untrusted sender`;
    - `isTrustedSender('file:///app/out/renderer/../../etc/passwd', …)` is false;
    - `isTrustedSender('file://host/app/out/renderer/index.html', …)` is false.
  - `ipc.test.ts` → `audit verify failure details`: on a tampered chain,
    `audit:verify` appends an `audit.verify` event with outcome `failure` and
    details `{count, brokenAtId, reason}`.
- [ ] **Step 2:** Run `pnpm test tests/main/validate.test.ts tests/main/ipc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `validate.ts`, `validators.ts` (entries for
  `app:info`, `audit:list`, `audit:verify`, `audit:exportCsv`) and the
  `registerHandlers` changes.
  - In `index.ts`, pass `{ validators: VALIDATORS, knownSecrets: () => [] }`.
    Task 6 replaces the empty secrets list.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: per-channel ipc argument validation and error redaction"`

### Task 3: Vault crypto primitives, schema and shared types

**Files:**
- Create: `src/main/vault/crypto.ts`, `src/shared/vault.ts`
- Modify: `src/main/db/migrations.ts` (append migration 2), `src/shared/audit.ts`
- Test: `tests/main/vault-crypto.test.ts`, `tests/main/db.test.ts`

**Interfaces:**
- Produces in `src/main/vault/crypto.ts`:
  - `interface KdfParams { alg: 'scrypt'; N: number; r: number; p: number; salt: string /* b64 */ }`
  - `DEFAULT_KDF: Omit<KdfParams,'salt'> = { alg:'scrypt', N: 2**17, r: 8, p: 1 }`
  - `newKdfParams(base?: Omit<KdfParams,'salt'>): KdfParams`: 16 random salt
    bytes.
  - `deriveKek(password: string, params: KdfParams): Promise<Buffer>`: 32
    bytes, `maxmem 256 MiB`, using the password's NFC-normalized UTF-8 bytes.
  - `randomKey(): Buffer` (32 bytes)
  - `seal(key: Buffer, plaintext: string | Buffer, aad: string): string`
  - `openSealed(key: Buffer, sealed: string, aad: string): Buffer`. It throws
    `Error('decrypt failed')` on a bad tag, an AAD mismatch or a bad format.
- Produces in `src/shared/vault.ts`. The renderer imports it, so it holds plain
  constants and types only:
  ```ts
  export const DEFAULT_VAULT_ID = '00000000-0000-4000-8000-000000000001'
  export const VAULT_LOCKED = 'vault locked'
  export const MIN_MASTER_PASSWORD = 10
  export const MAX_SECRET_VALUE = 65536
  export const CLIPBOARD_CLEAR_MS = 30_000
  export const REVEAL_HIDE_MS = 10_000
  export const SECRET_KINDS = ['password', 'token', 'env', 'webhook', 'api_key'] as const
  export type SecretKind = (typeof SECRET_KINDS)[number]
  export const QUICK_UNLOCK_MODES = ['off', 'touchId', 'login'] as const
  export type QuickUnlockMode = (typeof QUICK_UNLOCK_MODES)[number]
  export const AUTO_LOCK_CHOICES = [1, 5, 15, 60, null] as const // minutes; null = never
  export type LockReason = 'manual' | 'idle' | 'screen' | 'suspend' | 'quit'
  export interface VaultStatus { setUp: boolean; unlocked: boolean; quickUnlock: QuickUnlockMode; quickUnlockAvailable: { touchId: boolean; login: boolean }; autoLockMinutes: number | null; retryAfterMs: number }
  export type UnlockResult = { ok: true } | { ok: false; reason: 'wrong-password' | 'throttled' | 'unavailable' | 'cancelled'; retryAfterMs: number }
  export interface VaultInput { name: string; color: string }
  export interface VaultMeta extends VaultInput { id: string; isDefault: boolean; counts: { secrets: number; keys: number; identities: number }; createdAt: string; updatedAt: string }
  export interface SecretInput { vaultId: string; name: string; kind: SecretKind; value: string }
  export type SecretPatch = Partial<Omit<SecretInput, 'vaultId'>>
  export interface SecretMeta { id: string; vaultId: string; name: string; kind: SecretKind; createdAt: string; updatedAt: string }
  export type SshKeyType = 'ssh-ed25519' | 'ssh-rsa' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' | 'ecdsa-sha2-nistp521'
  export type SshKeySource = 'file' | 'imported' | 'generated'
  export interface SshKeyMeta { id: string; vaultId: string; label: string; keyType: SshKeyType; publicKey: string; fingerprint: string; source: SshKeySource; filePath: string | null; hasPassphrase: boolean; createdAt: string; updatedAt: string }
  export interface LocalKeyCandidate { path: string; keyType: SshKeyType; fingerprint: string; encrypted: boolean; alreadyLinked: boolean }
  export interface KeyLinkInput { vaultId: string; label: string; path: string; passphrase?: string }
  export interface KeyImportInput { vaultId: string; label: string; privateKey: string; passphrase?: string }
  export interface KeyGenerateInput { vaultId: string; label: string; comment?: string }
  export type IdentityAuth = 'agent' | 'key' | 'password'
  export interface IdentityInput { vaultId: string; label: string; username: string; auth: IdentityAuth; sshKeyId?: string; password?: string }
  export type IdentityPatch = Partial<Omit<IdentityInput, 'vaultId'>>
  export interface IdentityMeta { id: string; vaultId: string; label: string; username: string; auth: IdentityAuth; sshKeyId: string | null; hasPassword: boolean; createdAt: string; updatedAt: string }
  ```
- `AUDIT_ACTIONS` gains:
  - `vault.setup`, `vault.unlock`, `vault.lock`, `vault.rekey`,
    `vault.quickunlock`, `vault.autolock`, `vault.create`, `vault.update`,
    `vault.delete`;
  - `secret.create`, `secret.update`, `secret.delete`, `secret.reveal`,
    `secret.copy`;
  - `key.link`, `key.import`, `key.generate`, `key.update`, `key.delete`;
  - `identity.create`, `identity.update`, `identity.delete`.
- Migration 2 `vaults`:
  ```sql
  CREATE TABLE vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
    wrapped_key TEXT, kdf_params TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO vaults VALUES ('00000000-0000-4000-8000-000000000001','Default','#5b8cff',NULL,NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  CREATE TABLE secrets(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('password','token','env','webhook','api_key')),
    value_enc TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(vault_id, name));
  CREATE TABLE ssh_keys(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    label TEXT NOT NULL, key_type TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    private_key_enc TEXT, passphrase_enc TEXT,
    source TEXT NOT NULL CHECK (source IN ('file','imported','generated')), file_path TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK ((source = 'file') = (file_path IS NOT NULL)), CHECK (source = 'file' OR private_key_enc IS NOT NULL));
  CREATE TABLE identities(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    label TEXT NOT NULL, username TEXT NOT NULL, auth TEXT NOT NULL CHECK (auth IN ('agent','key','password')),
    ssh_key_id TEXT REFERENCES ssh_keys(id) ON DELETE RESTRICT, password_enc TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK (auth <> 'key' OR ssh_key_id IS NOT NULL), CHECK (auth <> 'password' OR password_enc IS NOT NULL));
  CREATE TABLE vault_state(id INTEGER PRIMARY KEY CHECK (id = 1), failed_attempts INTEGER NOT NULL DEFAULT 0,
    last_failed_at TEXT, quick_unlock TEXT NOT NULL DEFAULT 'off' CHECK (quick_unlock IN ('off','touchId','login')),
    quick_unlock_blob TEXT, auto_lock_minutes INTEGER DEFAULT 15);
  INSERT INTO vault_state(id) VALUES (1);
  ```
  Cascade deletes happen in one statement. `ON DELETE RESTRICT` on
  `identities.ssh_key_id` makes deleting a vault fail while a cross-vault
  link exists; Task 8 forbids cross-vault links, so this can't happen.

- [ ] **Step 1: Write the failing tests:**
  - `vault-crypto.test.ts` → `seals and opens`:
    `openSealed(k, seal(k,'héllo 🔑','a'), 'a').toString()` equals `'héllo 🔑'`.
    Two seals of the same text differ, and each matches
    `/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/`.
  - `vault-crypto.test.ts` → `aad binds rows`: opening with AAD
    `'secret:B:value'` a value sealed under `'secret:A:value'` throws
    `/decrypt failed/`.
  - `vault-crypto.test.ts` → `detects tampering`: flipping one character of the
    ciphertext segment throws `/decrypt failed/`. So does a wrong key, and so
    does `'garbage'`.
  - `vault-crypto.test.ts` → `derives deterministically`: with
    `{N: 2**10, r: 8, p: 1}`, the same password and salt give equal keys of
    length 32. A different salt gives a different key. The NFD and NFC forms
    of `'Pässword1!'` give equal keys.
  - `vault-crypto.test.ts` → `default params`: `DEFAULT_KDF` equals
    `{alg:'scrypt', N:131072, r:8, p:1}`.
  - `db.test.ts` → `seeds the default vault`: after `openDatabase(':memory:')`,
    `SELECT id,name,wrapped_key FROM vaults` equals
    `[{id: DEFAULT_VAULT_ID, name: 'Default', wrapped_key: null}]`, and
    `vault_state` has one row with `auto_lock_minutes 15`.
  - `db.test.ts` → `enforces key and identity shapes`:
    - inserting an `ssh_keys` row with `source 'file'` and `file_path NULL`
      throws;
    - inserting an `identities` row with `auth 'password'` and `password_enc NULL`
      throws.
- [ ] **Step 2:** Run `pnpm test tests/main/vault-crypto.test.ts tests/main/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `crypto.ts`, `shared/vault.ts`, the migration and
  the audit actions. `seal` uses `createCipheriv('aes-256-gcm', key, iv)` and
  `setAAD(Buffer.from(aad))`.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: vault crypto primitives and schema"`

### Task 4: VaultService (setup, unlock, lock, backoff, rekey, vault CRUD) and its IPC

**Files:**
- Create: `src/main/vault/vault-service.ts`, `src/main/ipc/handlers/vault.ts`, `tests/main/vault-helpers.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/index.ts`
- Test: `tests/main/vault-service.test.ts`

**Interfaces:**
- Consumes: Task 3 (crypto, shared vault types, schema); `AuditLog`; `Db`.
- Produces in `vault-service.ts`:
  - `unlockDelayMs(failures: number): number`: `0` for fewer than 3 failures,
    otherwise `min(1000 * 2 ** (failures - 3), 300_000)`.
  - The class:
    ```ts
    class VaultService {
      constructor(db: Db, audit: AuditLog, opts?: { kdf?: Omit<KdfParams,'salt'>; now?: () => Date; quick?: QuickUnlockDeps })
      status(): VaultStatus
      isUnlocked(): boolean
      setup(password: string): Promise<VaultStatus>        // throws 'already set up' | 'password too short'
      unlock(password: string): Promise<UnlockResult>
      lock(reason: LockReason): void                        // no-op (no event) when already locked
      changePassword(current: string, next: string): Promise<UnlockResult>
      listVaults(): VaultMeta[]                             // works while locked; Default first, then by name
      createVault(input: VaultInput): VaultMeta
      updateVault(id: string, patch: Partial<VaultInput>): VaultMeta
      deleteVault(id: string): void                         // throws 'cannot delete the Default vault'
      seal(vaultId: string, aad: string, plaintext: string): string   // throws Error(VAULT_LOCKED)
      open(vaultId: string, aad: string, sealed: string): string
      assertUnlocked(): void
      onLock(fn: (reason: LockReason) => void): () => void
    }
    ```
    `QuickUnlockDeps` is declared here and used in Task 5.
- IPC channels, each with a `VALIDATORS` entry and a handler in
  `createVaultHandlers(vault: VaultService)`:
  - `'vault:status': { args: []; result: VaultStatus }`
  - `'vault:setup': { args: [password: string]; result: VaultStatus }`
  - `'vault:unlock': { args: [password: string]; result: UnlockResult }`
  - `'vault:lock': { args: []; result: void }`
  - `'vault:changePassword': { args: [current: string, next: string]; result: UnlockResult }`
  - `'vault:list': { args: []; result: VaultMeta[] }`
  - `'vault:create': { args: [input: VaultInput]; result: VaultMeta }`
  - `'vault:update': { args: [id: string, patch: Partial<VaultInput>]; result: VaultMeta }`
  - `'vault:delete': { args: [id: string]; result: void }`
- `tests/main/vault-helpers.ts`:
  - `FAST_KDF = { alg:'scrypt', N: 2**10, r: 8, p: 1 }`
  - `makeVault(opts?): { db: Db; audit: AuditLog; vault: VaultService; now: { t: number } }`.
    It uses an advanceable `now`.
  - `auditRows(db): string`: every audit row as one JSON string, used for
    "no secret value" asserts.

- [ ] **Step 1: Write the failing tests** in `tests/main/vault-service.test.ts`:
  - `starts not set up and locked`: `status()` matches
    `{setUp:false, unlocked:false, autoLockMinutes:15, retryAfterMs:0}`, and
    `listVaults()` returns the one Default vault.
  - `setup keys the default vault and unlocks`:
    - `await setup('correct horse')` → `status().unlocked` is true.
    - The Default row has a non-null `wrapped_key`, and its `kdf_params` JSON
      has `N` equal to `FAST_KDF.N` plus a salt.
    - A second `setup` rejects with `/already set up/`.
    - `setup('short')` on a fresh vault rejects with `/too short/`.
    - Audit has `vault.setup` with outcome `success`.
  - `unlock and lock`:
    - After `lock('manual')`, `isUnlocked()` is false and `seal(...)` throws
      `VAULT_LOCKED`.
    - `unlock('correct horse')` returns `{ok:true}`.
    - The audit sequence includes `vault.lock` (details `{reason:'manual'}`)
      and `vault.unlock` (details `{method:'password'}`).
    - A second `lock` adds no event.
  - `backs off after three failures`:
    - The 3 wrong attempts each return `wrong-password` with `retryAfterMs`
      of `0, 0, 1000`.
    - A 4th attempt right away returns `{ok:false, reason:'throttled', retryAfterMs:1000}`
      and runs no scrypt (spy on `deriveKek` through `vi.mock`).
    - After `now.t += 1000`, a wrong attempt returns `retryAfterMs 2000`.
    - A new `VaultService` on the same db still reports the throttle.
    - A correct password after the wait resets `failed_attempts` to 0.
    - `unlockDelayMs(50)` equals `300000`.
  - `tampered wrapped key fails closed`: overwrite one character of the
    Default `wrapped_key` in SQL → `unlock(correct)` returns `wrong-password`,
    and `isUnlocked()` is false.
  - `vault crud`:
    - `createVault({name:'Prod', color:'#ff0000'})` gets its own `wrapped_key`.
    - After lock and unlock, `open(prodId, 'x', seal(prodId, 'x', 'v'))` equals
      `'v'`.
    - A duplicate name (case-insensitive) throws `/already exists/`.
    - `updateVault` renames it.
    - `deleteVault(DEFAULT_VAULT_ID)` throws.
    - `deleteVault(prodId)` removes it.
    - Each mutation appends `vault.create`, `vault.update` or `vault.delete`
      with the target label.
    - Each one throws `VAULT_LOCKED` while locked.
  - `password change is atomic`:
    - With two vaults, `changePassword('correct horse','battery staple!')` →
      after a lock, only the new password unlocks, and both vaults open their
      sealed values.
    - A second run injects a failure on the second vault's UPDATE (replace
      `db.prepare` through a spy that throws on the 2nd `UPDATE vaults`). It
      rejects, the old password still unlocks both vaults, and the new one
      returns `wrong-password`.
    - The audit event is `vault.rekey`.
  - `no password in audit`: `auditRows(db)` does not contain `correct horse`
    or `battery staple!`.
- [ ] **Step 2:** Run `pnpm test tests/main/vault-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The in-memory state is the KEK plus `Map<vaultId, Buffer>`.
  - `unlock` derives the KEK with the Default vault's `kdf_params`, then unwraps
    every keyed vault. Any GCM failure counts as `wrong-password`, and every
    buffer derived so far is zeroed.
  - `changePassword` checks the current password through the same throttled
    path. It then builds new params and a new KEK, and re-wraps every vault key
    inside one `BEGIN IMMEDIATE` transaction.
  - `lock` zeroes the buffers, clears the map, then calls the `onLock`
    listeners.
  - In `index.ts`, construct one `VaultService` after `AuditLog` and spread
    `createVaultHandlers(vault)` into the handlers. On `before-quit`, call
    `vault.lock('quit')` before `app.quit` is audited.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: vault service with master password, backoff and rekey"`

### Task 5: Quick unlock (Keychain / Touch ID) and auto-lock

**Files:**
- Create: `src/main/vault/auto-lock.ts`
- Modify: `src/main/vault/vault-service.ts`, `src/main/ipc/handlers/vault.ts`, `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/index.ts`
- Test: `tests/main/quick-unlock.test.ts`, `tests/main/auto-lock.test.ts`

**Interfaces:**
- Consumes: `VaultService` (Task 4).
- Produces:
  - In `vault-service.ts`:
    ```ts
    interface QuickUnlockDeps {
      keychain: { available(): boolean; encrypt(plain: string): Buffer; decrypt(blob: Buffer): string } // safeStorage
      touchId: { available(): boolean; prompt(reason: string): Promise<void> }                       // systemPreferences
    }
    ```
  - New `VaultService` methods:
    - `setQuickUnlock(mode: QuickUnlockMode): VaultStatus`. It requires
      unlocked, throws `'quick unlock unavailable'` if the mode's dependency
      is unavailable, and stores `base64(keychain.encrypt(kek.toString('base64')))`.
    - `unlockQuick(): Promise<UnlockResult>`
    - `setAutoLock(minutes: number | null): VaultStatus`
  - `changePassword` re-caches the new KEK when a quick-unlock mode is on.
  - In `auto-lock.ts`:
    `class AutoLock { constructor(deps: { idleSeconds: () => number; minutes: () => number | null; isUnlocked: () => boolean; lock: (r: LockReason) => void }); tick(): void; start(intervalMs?: number): () => void }`.
    The default interval is 15000 ms. `tick` locks with `'idle'` when
    `idleSeconds() >= minutes*60`.
  - New channels:
    - `'vault:unlockQuick': { args: []; result: UnlockResult }`
    - `'vault:setQuickUnlock': { args: [mode: QuickUnlockMode]; result: VaultStatus }`
    - `'vault:setAutoLock': { args: [minutes: number | null]; result: VaultStatus }`
    - The validator restricts `minutes` to `AUTO_LOCK_CHOICES`.

- [ ] **Step 1: Write the failing tests** (fake `keychain` encrypts by
  reversing and prefixing `kc:`; fake `touchId.prompt` is a `vi.fn`):
  - `quick-unlock.test.ts` → `touch id unlock`:
    - `setQuickUnlock('touchId')` → `status().quickUnlock` is `'touchId'`.
    - After a lock, `unlockQuick()` calls `prompt` once and returns `{ok:true}`.
    - Audit has `vault.quickunlock` (details `{mode:'touchId'}`) and
      `vault.unlock` (details `{method:'touchId'}`).
  - `quick-unlock.test.ts` → `cancelled prompt stays locked`: when `prompt`
    rejects, the result is `{ok:false, reason:'cancelled'}`, the vaults stay
    locked, and the mode stays `'touchId'`.
  - `quick-unlock.test.ts` → `login mode skips prompt`: `prompt` is not
    called.
  - `quick-unlock.test.ts` → `a broken cache is discarded`:
    - When `keychain.decrypt` throws, the result is
      `{ok:false, reason:'unavailable'}`.
    - The mode becomes `'off'` and `quick_unlock_blob` is NULL.
    - Audit has `vault.unlock` with outcome `failure`.
  - `quick-unlock.test.ts` → `requires unlocked and availability`:
    - While locked, `setQuickUnlock('login')` throws `VAULT_LOCKED`.
    - With `touchId.available()` false, `setQuickUnlock('touchId')` throws
      `/unavailable/`.
    - `status().quickUnlockAvailable` reflects both deps.
  - `quick-unlock.test.ts` → `rekey refreshes the cache`: after
    `changePassword`, a lock and `unlockQuick()` still give `{ok:true}`.
  - `quick-unlock.test.ts` → `cache holds no password`: the stored blob,
    decoded through the fake, is not the master password.
  - `auto-lock.test.ts` → `locks after idle`:
    - With minutes 5: idle 299 s does not lock; idle 300 s locks once with
      `'idle'`.
    - With minutes `null`, it never locks.
    - It never locks when already locked.
  - `auto-lock.test.ts` → `setAutoLock persists`: `setAutoLock(60)` →
    `status().autoLockMinutes` is 60 on a new service over the same db.
    Audit has `vault.autolock`.
- [ ] **Step 2:** Run `pnpm test tests/main/quick-unlock.test.ts tests/main/auto-lock.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Wire these in `index.ts`:
  - `keychain` uses `safeStorage.isEncryptionAvailable`, `encryptString` and
    `decryptString`;
  - `touchId` uses `systemPreferences.canPromptTouchID()` and
    `promptTouchID('unlock your OpsDeck vaults')`;
  - `new AutoLock({ idleSeconds: () => powerMonitor.getSystemIdleTime(), … }).start()`;
  - `powerMonitor.on('lock-screen', () => vault.lock('screen'))`, and the same
    for `'suspend'`.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: keychain and touch id unlock cache, auto-lock"`

### Task 6: Secrets (CRUD, reveal, copy with clipboard clear)

**Files:**
- Create: `src/main/vault/secret-store.ts`, `src/main/ipc/handlers/secrets.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/index.ts`
- Test: `tests/main/secrets.test.ts`

**Interfaces:**
- Consumes: `VaultService.seal/open/assertUnlocked/onLock` (Task 4); `makeVault` (Task 4 helper).
- Produces:
  ```ts
  interface ClipboardLike { writeText(text: string): void; readText(): string }
  class SecretStore {
    constructor(db: Db, vault: VaultService, audit: AuditLog, deps: { clipboard: ClipboardLike })
    list(vaultId?: string): SecretMeta[]                    // works while locked; sorted by name
    create(input: SecretInput): SecretMeta                  // throws /already exists/ on (vault, name) clash
    update(id: string, patch: SecretPatch): SecretMeta      // omitted value keeps the stored ciphertext
    delete(id: string): void
    reveal(id: string): { value: string }                   // audits secret.reveal
    copy(id: string): { clearsInMs: number }                // audits secret.copy; value never returned
    value(id: string): string                               // main-only, for later phases; not audited, not on IPC
    knownValues(): readonly string[]                        // [] when locked; decrypts all once per unlock, refreshed on change
  }
  ```
- Channels:
  - `'secret:list': { args: [vaultId?: string]; result: SecretMeta[] }`
  - `'secret:create': { args: [input: SecretInput]; result: SecretMeta }`
  - `'secret:update': { args: [id: string, patch: SecretPatch]; result: SecretMeta }`
  - `'secret:delete': { args: [id: string]; result: void }`
  - `'secret:reveal': { args: [id: string]; result: { value: string } }`
  - `'secret:copy': { args: [id: string]; result: { clearsInMs: number } }`
  - The validators enforce `SECRET_KINDS`, value length `1..MAX_SECRET_VALUE`
    and a trimmed name of 1–120 characters.
- In `index.ts`:
  - `AuditLog` is constructed with
    `knownSecrets: () => secrets?.knownValues() ?? []`, assigned once the
    stores exist. Task 8 adds `keys.knownValues()` and `identities.knownValues()`.
  - `registerHandlers` gets the same `knownSecrets` function.
  - Clipboard is Electron's `clipboard`.

- [ ] **Step 1: Write the failing tests** (fake clipboard; `vi.useFakeTimers()`):
  - `creates and lists without values`:
    - `create({vaultId: DEFAULT_VAULT_ID, name:'DB_PASS', kind:'env', value:'hunter22'})`
      returns meta that has no `value` key.
    - `list()` has 1 entry.
    - The `value_enc` column starts with `v1.` and does not contain `hunter22`.
  - `round-trips odd values`: `reveal` returns these exactly:
    - `'a\nb=c\r\n'`;
    - `'🔑ünïcødé'`;
    - `'x'.repeat(65536)`;
    - a 3-line `-----BEGIN OPENSSH PRIVATE KEY-----` text.
  - `update keeps or replaces the value`:
    - `update(id,{name:'DB_PASSWORD'})` keeps the old value.
    - `update(id,{value:'n3w-value'})` replaces it.
    - Each update appends `secret.update`, with details
      `{fields:['name']}` and `{fields:['value']}` respectively.
  - `reveal and copy are audited without values`:
    - After `reveal` and `copy`, audit has `secret.reveal` and `secret.copy`
      with targetLabel `DB_PASS`.
    - `auditRows(db)` contains no `hunter22`.
  - `copy clears the clipboard after 30 s`:
    - After `copy`, `clipboard.readText()` is `hunter22` and the result is
      `{clearsInMs: 30000}`.
    - After `vi.advanceTimersByTime(30000)` the clipboard reads `''`.
  - `lock clears only our clipboard`:
    - copy → `vault.lock('idle')` → the clipboard is `''`.
    - copy → the user writes `'mine'` → lock → the clipboard is still `'mine'`.
    - copy → the user writes `'mine'` → 30 s pass → still `'mine'`.
  - `known values follow lock state`:
    - While unlocked, `knownValues()` contains `hunter22`.
    - After a lock it is `[]`.
    - An audit append with `details: {note: 'x hunter22'}` made while
      unlocked stores `‹redacted›`.
  - `locked writes are refused`: after a lock, `create`, `update`, `delete`,
    `reveal` and `copy` all throw `VAULT_LOCKED`, while `list()` still works.
  - `no plaintext on disk`:
    - Use a file db in `mkdtempSync` and create a secret with value
      `'needle-7f3a'`.
    - Run `PRAGMA wal_checkpoint(FULL)`.
    - Neither `opsdeck.db` nor `opsdeck.db-wal` contains the bytes
      `needle-7f3a`.
  - `ipc rejects bad secret args`: through `registerHandlers` with the real
    `VALIDATORS`:
    - `secret:create` with an empty `value`, a 65537-char `value`, or
      `kind:'ssh'` rejects with `/invalid arguments/`.
    - The error message does not contain the value.
- [ ] **Step 2:** Run `pnpm test tests/main/secrets.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - IDs are `crypto.randomUUID()`, and the AAD is `secret:<id>:value`.
  - `copy` remembers `{value, timer}`. A clear writes `''` only when
    `readText() === value`.
  - `onLock` clears the clipboard under the same rule, cancels the timer and
    drops the known-values cache.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: vault secrets with audited reveal and self-clearing copy"`

### Task 7: OpenSSH key formats (generate ed25519, parse, fingerprint)

**Files:**
- Create: `src/main/vault/openssh.ts`
- Test: `tests/main/openssh.test.ts`

**Decision:** Generate keys with Node's `generateKeyPairSync('ed25519')` and
write the `openssh-key-v1` container ourselves (unencrypted, `cipher none`).
The vault encrypts the key at rest, so there's no passphrase. `ssh2` isn't
needed until Phase 4, and it reads this format.

**Interfaces:**
- Produces:
  - `interface ParsedKey { keyType: SshKeyType; publicKey: string /* "type b64" */; fingerprint: string; encrypted: boolean; comment: string }`
  - `generateEd25519(comment: string): { privateKey: string; publicKey: string /* "ssh-ed25519 AAAA… comment" */; fingerprint: string }`
  - `parsePrivateKey(text: string, passphrase?: string): ParsedKey`. It
    handles:
    - `openssh-key-v1`, encrypted or not. The public key comes from the
      plaintext header, so no passphrase is needed. Passphrases of encrypted
      OpenSSH keys aren't verified here; Phase 4's `ssh2` does that.
    - PEM `RSA`, `EC` and `PKCS8` keys, plain or `ENCRYPTED`, through
      `createPrivateKey({ key, passphrase })` → `createPublicKey` → JWK →
      SSH wire blob.
    - It throws `'unsupported key format'`, `'passphrase required'` or
      `'wrong passphrase'`.
  - `parsePublicKeyLine(line: string): { keyType: SshKeyType; blob: Buffer; comment: string }`
  - `fingerprintOf(blob: Buffer): string`: `SHA256:` + unpadded base64 of
    `sha256(blob)`.

  The `openssh-key-v1` layout. The format isn't determined by the signatures;
  `string` means a uint32 length followed by that many bytes:
  ```
  "openssh-key-v1\0" | string "none" | string "none" | string "" | uint32 1
  | string pubblob(string "ssh-ed25519", string pub32)
  | string priv( uint32 check, uint32 check, string "ssh-ed25519", string pub32,
                 string seed32‖pub32, string comment, pad 1,2,3… to a multiple of 8 )
  PEM: "-----BEGIN OPENSSH PRIVATE KEY-----\n" + base64 wrapped at 70 + "\n-----END OPENSSH PRIVATE KEY-----\n"
  ```
  The seed and public key come from `privateKey.export({format:'jwk'})` (`d`
  and `x`).

- [ ] **Step 1: Write the failing tests** (`hasSshKeygen` = `spawnSync('ssh-keygen',['-?']).error === undefined`):
  - `generates a parseable ed25519 key`:
    - `g = generateEd25519('me@mac')`.
    - `g.privateKey` starts with `-----BEGIN OPENSSH PRIVATE KEY-----`.
    - `parsePrivateKey(g.privateKey)` equals
      `{keyType:'ssh-ed25519', publicKey: g.publicKey minus comment, fingerprint: g.fingerprint, encrypted:false, comment:'me@mac'}`.
  - `it.skipIf(!hasSshKeygen)('interoperates with ssh-keygen')`:
    - Write `g.privateKey` to a tmp file with mode `0o600`.
    - `ssh-keygen -y -f` prints `g.publicKey` (ignoring the comment).
    - `ssh-keygen -lf` on the `.pub` contains `g.fingerprint`.
  - `it.skipIf(!hasSshKeygen)('reads keys made by ssh-keygen')`. For
    `-t ed25519 -N ''`, `-t rsa -b 2048 -N ''`, `-t ecdsa -N ''`, and
    `-t ed25519 -N 'pw'`:
    - `parsePrivateKey` gives the same fingerprint as `ssh-keygen -lf`.
    - `encrypted` is true only for the `pw` key.
  - `reads pem keys`:
    - From `generateKeyPairSync('rsa',{modulusLength:2048})`, a PKCS8 PEM and
      a PKCS1 PEM give a `ssh-rsa` key with matching fingerprints.
    - An `ENCRYPTED PRIVATE KEY` (aes-256-cbc, passphrase `pw`):
      - without a passphrase throws `/passphrase required/`;
      - with `'nope'` throws `/wrong passphrase/`;
      - with `'pw'` parses.
  - `rejects junk`: `parsePrivateKey('hello')` and a public-key line throw
    `/unsupported key format/`.
- [ ] **Step 2:** Run `pnpm test tests/main/openssh.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `openssh.ts` with a small `SshWriter` / `SshReader`
  for the `string`, `uint32` and `mpint` encodings. An `mpint` gets a leading
  zero byte when the high bit is set.
- [ ] **Step 4:** Run `pnpm test tests/main/openssh.test.ts`. Expected: PASS
  (the ssh-keygen cases run on macOS).
- [ ] **Step 5: Commit:** `git commit -am "feat: openssh key generation, parsing and fingerprints"`

### Task 8: SSH key store, identities and their IPC

**Files:**
- Create: `src/main/vault/key-store.ts`, `src/main/vault/identity-store.ts`, `src/main/ipc/handlers/keys.ts`, `src/main/ipc/handlers/identities.ts`
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validators.ts`, `src/main/index.ts`
- Test: `tests/main/keys-identities.test.ts`

**Interfaces:**
- Consumes: `generateEd25519`, `parsePrivateKey` and `parsePublicKeyLine`
  (Task 7); `VaultService` (Task 4); `ClipboardLike` (Task 6).
- Produces:
  ```ts
  class KeyStore {
    constructor(db: Db, vault: VaultService, audit: AuditLog, deps: { sshDir: string; clipboard: ClipboardLike; defaultComment: string })
    list(vaultId?: string): SshKeyMeta[]
    scanLocal(): Promise<LocalKeyCandidate[]>            // no unlock needed; never throws
    link(input: KeyLinkInput): Promise<SshKeyMeta>        // source 'file': stores path + public key, never the private key
    import(input: KeyImportInput): SshKeyMeta             // source 'imported'
    importFile(input: Omit<KeyImportInput,'privateKey'>, path: string): Promise<SshKeyMeta>
    generate(input: KeyGenerateInput): SshKeyMeta         // source 'generated'; comment defaults to deps.defaultComment
    update(id: string, patch: { label?: string }): SshKeyMeta
    delete(id: string): void                              // throws 'key is used by identity <label>'
    copyPublic(id: string): void                          // public key line to clipboard; not cleared, not audited
    material(id: string): Promise<{ privateKey: string; passphrase?: string }> // main-only, for Phase 4; file keys read at call time
    knownValues(): readonly string[]                      // passphrases (private keys are covered by the PEM rule)
  }
  type ResolvedIdentity =
    | { username: string; auth: 'agent' }
    | { username: string; auth: 'key'; privateKey: string; passphrase?: string }
    | { username: string; auth: 'password'; password: string }
  class IdentityStore {
    constructor(db: Db, vault: VaultService, keys: KeyStore, audit: AuditLog)
    list(vaultId?: string): IdentityMeta[]
    create(input: IdentityInput): IdentityMeta            // 'key' needs sshKeyId in the same vault; 'password' needs password
    update(id: string, patch: IdentityPatch): IdentityMeta // switching away from 'password' clears password_enc
    delete(id: string): void
    resolve(id: string): Promise<ResolvedIdentity>        // main-only, for Phase 4
    knownValues(): readonly string[]
  }
  ```
- Channels (and validators):
  - `'key:list': { args: [vaultId?: string]; result: SshKeyMeta[] }`
  - `'key:scanLocal': { args: []; result: LocalKeyCandidate[] }`
  - `'key:link': { args: [input: KeyLinkInput]; result: SshKeyMeta }`
  - `'key:import': { args: [input: KeyImportInput]; result: SshKeyMeta }`
  - `'key:importFile': { args: [input: Omit<KeyImportInput,'privateKey'>]; result: SshKeyMeta | null }`.
    Main opens the file dialog at `sshDir`, so the key text never passes
    through the renderer.
  - `'key:generate': { args: [input: KeyGenerateInput]; result: SshKeyMeta }`
  - `'key:update': { args: [id: string, patch: { label?: string }]; result: SshKeyMeta }`
  - `'key:delete': { args: [id: string]; result: void }`
  - `'key:copyPublic': { args: [id: string]; result: void }`
  - `'identity:list': { args: [vaultId?: string]; result: IdentityMeta[] }`
  - `'identity:create': { args: [input: IdentityInput]; result: IdentityMeta }`
  - `'identity:update': { args: [id: string, patch: IdentityPatch]; result: IdentityMeta }`
  - `'identity:delete': { args: [id: string]; result: void }`
  - `createKeyHandlers(keys, { openDialog: (dir: string) => Promise<string | undefined> })`
  - `createIdentityHandlers(ids)`
- In `index.ts`:
  - `sshDir` is `join(os.homedir(), '.ssh')`.
  - `defaultComment` is `${osUser}@${machine}`.
  - `knownSecrets` concatenates the three stores.

- [ ] **Step 1: Write the failing tests** (a tmp `sshDir`; keys made with
  `generateEd25519`, plus `ssh-keygen` where noted, guarded by `skipIf`):
  - `scans a messy ~/.ssh`:
    - The dir holds `id_ed25519` and `id_ed25519.pub`, an encrypted
      `id_work` (ssh-keygen `-N pw`), `known_hosts`, `config`,
      `authorized_keys`, `orphan.pub`, a subdir `old/`, a broken symlink
      `gone`, a `chmod 000` file `locked`, and a 5 MB file `big`.
    - `scanLocal()` returns exactly `id_ed25519` and `id_work`, sorted by
      path.
    - `id_work` has `encrypted: true` and a fingerprint.
    - After `link` of `id_ed25519`, its `alreadyLinked` is true.
    - Size cap: files over 64 KiB are skipped without being read.
  - `link stores a reference only`:
    - `link({vaultId, label:'laptop', path})` gives a row with `source 'file'`,
      `file_path = path`, `private_key_enc NULL` and the right fingerprint.
    - `material(id).privateKey` equals the file's content.
    - Audit has `key.link`.
    - A path outside `sshDir` (`/etc/hosts`) throws `/outside ~\/.ssh/`.
  - `import and generate encrypt at rest`:
    - `import(...)` and `generate({vaultId,label:'deploy'})` store
      `private_key_enc` starting with `v1.`.
    - `material(id).privateKey` round-trips.
    - `generate` uses the comment `tester@box`.
    - Audit has `key.import` and `key.generate`.
    - `auditRows(db)` contains no `BEGIN OPENSSH` and no passphrase.
  - `import with passphrase`: an encrypted PEM imported with `passphrase:'pw'`
    gives `hasPassphrase: true`, and `knownValues()` contains `'pw'` while
    unlocked.
  - `delete refuses keys in use`: with an identity `auth:'key'` on the key,
    `delete(keyId)` throws `/used by identity/`. After the identity is
    deleted, it succeeds.
  - `identities validate their auth`:
    - `create({auth:'key'})` without `sshKeyId`, or with a key from another
      vault, throws.
    - `create({auth:'password', password:'pw12345'})` gives `hasPassword: true`.
    - `update(id,{auth:'agent'})` clears `password_enc`.
    - Audit has `identity.create`, `identity.update` and `identity.delete`.
  - `resolve returns material`: `resolve` gives
    `{username:'deploy', auth:'key', privateKey: …}` for a key identity,
    `{auth:'password', password:'pw12345'}` for a password identity, and
    throws `VAULT_LOCKED` while locked.
  - `copyPublic`: the clipboard holds the public key line, and no audit event
    is added.
- [ ] **Step 2:** Run `pnpm test tests/main/keys-identities.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `scanLocal` uses `readdir` with `withFileTypes`, `lstat` and `stat`, and
    skips non-regular files, files over 64 KiB, and the names `known_hosts*`,
    `config`, `authorized_keys*` and `*.pub`. It reads only files whose first
    line matches `/^-----BEGIN [A-Z ]*PRIVATE KEY-----/`, and catches each
    file's error separately.
  - `link` resolves `realpath` and requires it to be inside `realpath(sshDir)`.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: ssh keys (link, import, generate) and identities"`

### Task 9: Renderer lock flow (setup, unlock dialog, sidebar lock, vault settings)

**Files:**
- Create:
  - `src/renderer/src/ui/Dialog.tsx`, `src/renderer/src/ui/Field.tsx`;
  - `src/renderer/src/vault/status.ts`, `src/renderer/src/vault/unlock.ts`,
    `src/renderer/src/vault/strength.ts`;
  - `src/renderer/src/vault/UnlockDialog.tsx`,
    `src/renderer/src/vault/SetupCard.tsx`,
    `src/renderer/src/vault/VaultSettingsDialog.tsx`;
  - `src/renderer/src/shell/VaultLockButton.tsx`.
- Modify: `src/renderer/src/App.tsx` (mount `<UnlockDialog/>`), `src/renderer/src/shell/Sidebar.tsx`, `tests/renderer/helpers.tsx`
- Test: `tests/renderer/vault-lock.test.tsx`

**Interfaces:**
- Consumes: the `vault:*` channels and shared types (Tasks 3–5); `api`, `toast`,
  `registerCommand`, `useShortcut`, `Button`, `motion` (Phase 1).
- Produces:
  - `Dialog`:
    `<Dialog open: boolean; onClose: () => void; title: string; description?: string; children; footer?: ReactNode/>`.
    - Focus trap; Esc closes; focus returns to the opener.
    - Spring scale-in from 0.96, with a blurred backdrop.
  - `Field.tsx`: `TextField`, `SecretField` (a password input with an eye
    toggle, `autoComplete="off"`, `spellCheck={false}`), `SelectField` and
    `TextAreaField`. Each takes a `label`, an `error?`, and native input props.
  - `status.ts`:
    - `vaultStatusStore`;
    - `useVaultStatus(): VaultStatus | null`. It polls `vault:status` every
      5 s and on window `focus`; the poll stops when no subscriber is left.
    - `refreshVaultStatus(): Promise<VaultStatus>`
  - `unlock.ts`:
    - `ensureUnlocked(): Promise<boolean>`: resolves at once when unlocked,
      otherwise opens the dialog.
    - `withUnlock<T>(fn: () => Promise<T>): Promise<T | undefined>`. It runs
      `fn`. If `fn` rejects with `VAULT_LOCKED`, it refreshes the status, calls
      `ensureUnlocked` and retries once. Every later phase uses this for
      secret-needing actions.
  - `strength.ts`: `passwordStrength(pw: string): 0 | 1 | 2 | 3 | 4`. The
    score comes from length (≥10, ≥14, ≥20) plus character-class variety;
    any length under 10 scores 0.
  - Copy, used verbatim:
    - "Create master password"
    - "At least 10 characters"
    - "Passwords don't match"
    - "Wrong password"
    - "Try again in N s"
    - "Unlock with Touch ID"
    - "Vaults locked"
    - "Vaults unlocked"
  - The palette commands "Lock vaults" (`mod+l`), "Unlock vaults" and "Vault
    settings…".
- `helpers.tsx` gains:
  - `vaultStatus(over?: Partial<VaultStatus>): VaultStatus` (default: set up,
    locked, mode off, auto-lock 15);
  - and the defaults `vault:status` → `vaultStatus()`, `vault:list` → one
    Default vault, and `[]` for `secret:list`, `key:list` and
    `identity:list`.

- [ ] **Step 1: Write the failing tests** in `tests/renderer/vault-lock.test.tsx`:
  - `setup validates and submits`:
    - Render `<SetupCard/>`. Typing `short` shows "At least 10 characters", and
      "Create master password" is disabled.
    - A mismatched confirm shows "Passwords don't match".
    - Valid input calls `invoke('vault:setup', 'correct horse')`.
  - `strength meter`: `passwordStrength('short')` is 0. `'correct horse'` is
    at most 2, and `'c0rrect-Horse-battery-staple'` is 4.
  - `unlock dialog`:
    - `ensureUnlocked()` opens the dialog.
    - A `{ok:false, reason:'wrong-password', retryAfterMs:0}` result shows
      "Wrong password", and the input stays focused and is emptied.
    - Then `{ok:true}` resolves the promise to `true`, closes the dialog and
      shows the toast "Vaults unlocked".
    - Esc resolves to `false`.
  - `throttle countdown`:
    - With `retryAfterMs: 3000`, the submit button shows "Try again in 3 s"
      and is disabled.
    - After `vi.advanceTimersByTime(3000)` it is enabled.
  - `touch id`:
    - With status `quickUnlock: 'touchId'`, the button "Unlock with Touch ID"
      calls `invoke('vault:unlockQuick')`.
    - The dialog calls it once automatically on open.
    - It is not called when the mode is `'off'`.
  - `withUnlock retries once`:
    - `fn` rejects with `Error('vault locked')`, then resolves `'ok'`.
    - After an unlock succeeds, `withUnlock(fn)` resolves to `'ok'` and `fn`
      ran 2 times.
  - `sidebar lock button`:
    - While unlocked, clicking "Lock vaults" calls `invoke('vault:lock')` and
      shows the toast "Vaults locked".
    - Meta+L does the same.
    - While locked, the button opens the unlock dialog.
  - `status polling flips the lock`:
    - Fake timers; the status mock returns unlocked, then locked.
    - After 5 s, the sidebar button's accessible name changes to
      "Unlock vaults".
  - `settings`:
    - The quick-unlock select only offers the available modes.
    - Choosing "Never" calls `invoke('vault:setAutoLock', null)`.
    - The change-password form calls
      `invoke('vault:changePassword', 'correct horse', 'battery staple!')`.
      On `wrong-password` it shows "Wrong password".
- [ ] **Step 2:** Run `pnpm test tests/renderer/vault-lock.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The padlock icon in `VaultLockButton` springs between its closed and open
    shackle. It sits above the actor footer.
  - On "Wrong password", the dialog card shakes: an x keyframe
    `[0,-8,8,-5,5,0]` over 250 ms, skipped under reduced motion.
  - The setup strength meter is 4 segments filling with a spring, tinted
    err → warn → ok.
  - After setup, a success toast offers the action "Enable Touch ID" when it
    is available.
  - Use the `frontend-design` skill.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: vault setup, unlock dialog, lock button and settings"`

### Task 10: Vaults page (vaults, secrets, keys, identities)

**Files:**
- Create:
  - `src/renderer/src/pages/vaults/VaultsPage.tsx`,
    `src/renderer/src/pages/vaults/VaultRail.tsx`;
  - `src/renderer/src/pages/vaults/SecretsPanel.tsx`,
    `src/renderer/src/pages/vaults/SecretDialog.tsx`;
  - `src/renderer/src/pages/vaults/KeysPanel.tsx`,
    `src/renderer/src/pages/vaults/KeyDialogs.tsx`;
  - `src/renderer/src/pages/vaults/IdentitiesPanel.tsx`,
    `src/renderer/src/pages/vaults/IdentityDialog.tsx`.
- Modify: `src/renderer/src/shell/AppShell.tsx` (drop `vaults` from `PLACEHOLDERS` and route `/vaults` to `VaultsPage`)
- Test: `tests/renderer/vaults-page.test.tsx`

**Interfaces:**
- Consumes:
  - every `vault:*`, `secret:*`, `key:*` and `identity:*` channel (Tasks 4–8);
  - `useVaultStatus`, `withUnlock`, `SetupCard`, `Dialog` and `Field`
    (Task 9);
  - the Phase 1 UI kit.
- Produces:
  - The route `/vaults?vault=<id>&tab=secrets|keys|identities`. It defaults to
    Default and `secrets`.
  - The page:
    - When `!status.setUp`, it shows `SetupCard` and nothing else.
    - Otherwise:
      - a vault rail on the left (color dot, name, counts, "New vault"; a row
        menu for rename, recolor and delete);
      - a header with the vault name, a lock state chip and a search box that
        filters the current tab by name or label;
      - tabs.
  - Copy, used verbatim:
    - "No secrets yet"
    - "No SSH keys yet"
    - "No identities yet"
    - "Copied · clears in 30 s"
    - "Public key copied"
    - "Reveal"
    - "Copy"
    - "Generate key"
    - "Import key"
    - "Link from ~/.ssh"
  - Palette commands, registered while the page is mounted: "New secret",
    "Generate SSH key", "New identity" and "New vault". `mod+n` opens the
    "new" dialog of the current tab.

- [ ] **Step 1: Write the failing tests** in `tests/renderer/vaults-page.test.tsx`
  (`mockBridge`; render in a `MemoryRouter` at `/vaults`, with `<UnlockDialog/>`
  and `<Toaster/>`):
  - `shows setup when not set up`: with status `setUp:false`, "Create master
    password" is visible and no tabs are rendered.
  - `lists vaults and masked secrets`:
    - Two vaults: the rail shows `Default` and `Prod` with their secret counts.
    - Two secrets: rows show the name, a kind badge (`env`) and `••••••••`.
    - No call other than `secret:reveal` returns a value, and no value text
      is in the DOM.
  - `reveal shows then hides`:
    - With fake timers, clicking "Reveal" calls
      `invoke('secret:reveal', id)`, and `hunter22` is visible.
    - After 10 s it is gone.
  - `copy toasts`: clicking "Copy" calls `invoke('secret:copy', id)` and shows
    "Copied · clears in 30 s".
  - `locked reveal asks to unlock`:
    - Status is locked, and the first `secret:reveal` rejects with
      `vault locked`.
    - The unlock dialog opens. After `vault:unlock` gives `{ok:true}`,
      `secret:reveal` is called again and the value shows.
  - `creates a secret with mod+n`:
    - On the Secrets tab, Meta+N opens "New secret".
    - Fill in the name `API_TOKEN`, the kind `token` and a value, then save.
    - `invoke('secret:create', {vaultId: DEFAULT_VAULT_ID, name:'API_TOKEN', kind:'token', value:'abc12345'})`
      is called, and the new row appears.
  - `generates a key`:
    - On the Keys tab, "Generate key" with the label `deploy` calls
      `invoke('key:generate', {vaultId, label:'deploy'})`.
    - The row shows `ssh-ed25519` and its `SHA256:` fingerprint.
    - "Copy public key" calls `key:copyPublic` and shows the toast "Public key
      copied".
  - `links from ~/.ssh`:
    - `key:scanLocal` returns two candidates, one with `alreadyLinked: true`.
    - The linked one is disabled, marked "Linked", and shows the
      `Encrypted` badge when encrypted.
    - Choosing the other calls `key:link` with its path.
  - `identity needs a key for key auth`:
    - In the New identity dialog with auth `key`, Save stays disabled until a
      key is picked.
    - The key select lists only keys whose `vaultId` matches the current
      vault.
    - Auth `password` shows a `SecretField`.
  - `delete vault confirms by name`:
    - In Prod's row menu, "Delete" keeps the button disabled until the user
      types `Prod`.
    - Confirming calls `invoke('vault:delete', prodId)`.
    - Default's menu has no Delete.
  - `empty states`: with no keys, the Keys tab shows "No SSH keys yet" with the
    action "Generate key".
  - Update `tests/renderer/shell.test.tsx`: navigating to Vaults renders the
    heading `Vaults`, not a placeholder.
- [ ] **Step 2:** Run `pnpm test tests/renderer`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Tabs use a shared-layout spring underline. Rows stagger in on first load,
    and loading shows `Skeleton` rows.
  - The revealed value fades from the dots in a monospace font, with a
    10-second draining bar.
  - Key rows show the fingerprint in JetBrains Mono and a source badge
    (`file`, `imported` or `generated`).
  - Error toasts use `cleanIpcErrorMessage`.
  - Use the `frontend-design` skill.
- [ ] **Step 4:** Run `pnpm test`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Manual check.**
  - Run `pnpm dev`. Set a master password, add a secret, then Reveal it and
    Copy it. Paste after 30 s; the clipboard is empty.
  - Generate a key, link `~/.ssh/id_ed25519`, and create an identity.
  - Lock with ⌘L, then unlock (and with Touch ID if available).
  - The Audit page shows every action, with no value in its details.
- [ ] **Step 6: Commit:** `git commit -am "feat: vaults page with secrets, ssh keys and identities"`
