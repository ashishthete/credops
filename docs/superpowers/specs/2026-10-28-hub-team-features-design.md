# CredOps Hub — Team features: safe publishing, client policy, approvals and freeze windows, SSH certificates

Date: 2026-10-28. Extends the Phase 10 Hub work (`docs/superpowers/plans/`
phase10-hub), `hub/src/*`, and the desktop Hub client in `src/main/hub/*`.
Calls marked "(controller's call)" were made when this spec was written;
"(builder's call)" are left to whoever plans the build. Open questions are in
section 8.

Design only: nothing here is built yet. There are four features in one
document, because they share the same plumbing (Hub migrations,
`HubMeta.capabilities`, the policy decision in `hub/src/access/policy.ts`, and
the live bus). Each part can be planned and built on its own.

## 0. Priority and order (controller's call)

| # | Part | Why this order | Rough effort |
|---|---|---|---|
| 1 | **A. Optimistic concurrency on publish** | It fixes silent data loss *today*: two admins publishing the same environment overwrite each other with no warning. It is small and only touches the server and the client | 2–3 days |
| 2 | **B. Client policy** (minimum version first) | A minimum app version is what lets C and D roll out safely: old desktops that do not understand approvals or certificates can be turned away. Auto-lock and AI providers come for free on the same channel | 3–4 days |
| 3 | **C. Two-person approval + freeze windows** | Governance for protected environments. It depends on B, so old clients cannot bypass the new flow | 6–8 days |
| 4 | **D. Short-lived SSH certificates** | The largest change: hosts' `sshd` must trust a CA, and there is library risk (`ssh2`). This is what makes C *enforceable* against someone deploying around the Hub | 8–12 days plus a spike |

---

## Part A. Optimistic concurrency on publish

### A1. Intent

`PUT /api/v1/admin/environments/:id` → `HubRegistry.publish(body, actor)`
upserts the whole manifest in one transaction, and the last writer wins. If
admin X publishes, and admin Y then publishes from a desktop that had not seen
X's change, X's hosts, deployments and services are silently replaced or
deleted (the "remove what is gone" deletes). The desktop already remembers what
it last published: `hub_env_links.manifest_hash` (desktop migration 9). The
Hub stores the current `environments.manifest_hash`. The building blocks are
there; nobody compares them.

### A2. Goals and non-goals

- **G1.** A publish says which version it was based on. The Hub refuses it with
  `409 stale_manifest` if the environment has changed since, and names who
  published the current version and when.
- **G2.** The desktop shows the conflict and offers: review what changed
  (a summary of hosts, deployments and services added, removed or changed) and
  publish over it on purpose, or cancel.
- **G3.** Old desktops keep working, and each such publish is audited as
  `unconditional`. An admin setting can require preconditions.
- **Non-goal:** merging. The manifest is a whole document from one desktop's
  database, so a three-way merge of inventory is out of scope.
- **Non-goal:** concurrency for groups and grants (admin CRUD is per row and
  fine-grained already). Secrets get the same `If-Match` treatment in A6 as an
  optional follow-up.

### A3. Design

- **Precondition:** the HTTP `If-Match: "<manifest_hash>"` header on the PUT.
  For a first publish of a new id, `If-None-Match: *`. The value is the hash the
  desktop already keeps in `hub_env_links.manifest_hash`, so the desktop needs
  no migration (controller's call: hash, not a revision counter. If the current
  content equals what the publisher started from, publishing over it loses
  nothing, so A→B→A is harmless).
- **Hub, `publish`:** inside the existing `inTransaction`, read the current
  `manifest_hash` and `unpublished_at`, then:
  - `If-Match` given and different → `HubHttpError(409, 'stale_manifest', …)`,
    with `{ current: { manifestHash, publishedBy, publishedAt } }` in the body;
  - `If-None-Match: *` and the row exists and is published → the same 409;
  - neither header → allowed unless `config.requirePublishPrecondition` is set
    (then `428 precondition_required`). Audit detail `precondition: 'none'`.
- **Unpublish** (`DELETE`) takes the same `If-Match`.
- **A force publish** is an ordinary conditional publish against the *current*
  hash, after the user has seen the conflict. No `force` flag is needed: the
  client re-reads `GET /api/v1/admin/environments/:id` (which returns
  `manifest_hash`) and resends with that hash. If someone published in between,
  it conflicts again, as it should.
- **`HubErrorCode`** gains `'stale_manifest'` and `'precondition_required'`.
- **`HubMeta.capabilities.publishPreconditions: true`.**

### A4. Desktop

`src/main/hub/publish.ts`: send `If-Match` from `hub_env_links`. On 409,
fetch the Hub's current manifest (admin GET), diff it against the local
`buildManifest` by id (hosts, deployments, services: added, removed, changed),
and return a `PublishConflict` to the renderer. The publish dialog shows "Y
published this environment 14 minutes ago. Publishing will: remove host
app-3, change deployment api (branch main → release)". The buttons are
"Publish anyway" and "Cancel". Optionally "Open their version" (read-only).

### A5. Compatibility

An old Hub ignores `If-Match` (Fastify does not enforce it), so a new desktop
behaves as today against it, and the dialog notes "this Hub cannot detect
conflicting publishes". An old desktop against a new Hub sends no header:
allowed and audited, unless the admin requires preconditions.

### A6. Tests and phases

Hub: a stale `If-Match` → 409 with details; a match → 200; none →
200 + audit, or 428 with the config flag; unpublish too. Desktop: the header
is sent; the conflict diff is built; resend with the current hash. Optional
follow-up (A′): `If-Match` on `PUT /admin/secrets/:id` with a per-secret
`updated_at` ETag.

---

## Part B. Policy pushed to clients

### B1. Intent

An organisation running a Hub wants a few desktop settings to be set by the
organisation for everyone linked to it:

- a **minimum app version** (a security fix, a protocol change, the
  approval flow);
- a **maximum auto-lock time** for the vault (`VaultStatus.autoLockMinutes`,
  with choices `AUTO_LOCK_CHOICES = [1, 5, 15, 60, null]`, where null is
  "never");
- **allowed AI providers.** Today there is only Anthropic
  (`src/main/ai/claude.ts`). The policy is "AI on/off" plus an allow-list, so
  it keeps working when more providers arrive.

### B2. Goals and non-goals

- **G1.** One policy document per Hub (environment overrides are a non-goal
  for v1), edited by admins, delivered on sign-in and on change over the live
  bus.
- **G2.** The minimum version is enforced **server-side** on every
  authenticated request, using a version header, not only by a check in the
  client.
- **G3.** The desktop applies the policy whenever it is linked to the Hub, and
  shows "Set by your organisation" in the settings it locks.
- **Non-goal:** making the policy binding on a desktop that unlinks from the
  Hub. Once unlinked, the user is just using a personal app. Server-side
  enforcement (version, and later C/D) covers everything that touches team
  resources.

### B3. Design

**Hub storage (migration 12, or the next free number):**

```sql
CREATE TABLE client_policy(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_app_version TEXT,            -- semver, NULL = none
  auto_lock_max_minutes INTEGER,   -- one of 1,5,15,60; NULL = no cap
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  ai_providers TEXT NOT NULL DEFAULT '["anthropic"]',  -- JSON allow-list
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT, updated_at TEXT);
```

**API:**

- `GET /api/v1/policy` (any signed-in user) → `HubClientPolicy`.
- `PUT /api/v1/admin/policy` (admin, `If-Match: "<revision>"`, the Part A
  pattern). Audited as `policy.update` and broadcast on the live bus
  (`hub/src/live/bus.ts`) as `{type: 'policy', revision}`.
- `/api/v1/meta` (unauthenticated) gains `minAppVersion`, so an outdated
  desktop can say "update CredOps to 1.9 to use this Hub" before the Entra
  sign-in.
- **Server-side version gate:** the desktop client (`src/main/hub/client.ts`)
  sends `X-CredOps-Version: <app.getVersion()>` on every request. An auth hook
  in `hub/src/auth/plugin.ts` returns `426 upgrade_required` when the header is
  missing or older than the minimum, on every route except `/meta`, `/healthz`
  and `DELETE /session`.
  - A missing header counts as "old" only when a minimum is set
    (controller's call). Today's desktops send no header, so setting a minimum
    turns them away, which is the point.

**Desktop:**

- `src/main/hub/connection.ts` fetches the policy after sign-in and on each
  live `policy` event, and stores it in memory plus the `settings` table (key
  `hub.policy`), so it also applies offline while still linked.
- **Version:** if the policy's minimum is above the app's version, Hub actions
  are disabled and a banner says "Your organisation requires CredOps ≥ X". It
  links to the updater if there is one (Q-B1).
- **Auto-lock:** the vault's effective auto-lock is
  `min(user choice, policy cap)`, and "never" (null) is not allowed under a
  cap. The setting control shows choices above the cap as disabled, with
  "Set by your organisation". This is enforced where the idle timer is armed
  (vault service), not only in the UI.
- **AI:** `ai_enabled = 0` hides the AI features (explain, release notes,
  command suggestions) and makes the AI IPC handlers refuse with a fixed
  `AiFailure('refused', 'Turned off by your organisation')`. A provider that is
  not on the allow-list is treated the same way.
  - Does this apply to work outside Hub environments? Controller's call:
    **yes, while linked.** Prompts about local hosts still leave the machine,
    and the organisation is asking about data leaving it (Q-B2).

### B4. Compatibility and tests

`HubMeta.capabilities.clientPolicy: true`. An old Hub: no policy, the desktop
behaves as today. An old desktop and a new Hub with a minimum version: 426 on
every call, which the old client shows as a generic error ("This Hub runs an
incompatible version" already exists for `incompatible`; the old client maps
an unknown 426 to its generic failure). Tests: the version comparison
(pre-release tags, missing header); the 426 hook exemptions; the auto-lock clamp
in the vault service; AI handlers refuse; live update applies without a
restart.

---

## Part C. Two-person approval and freeze windows for protected environments

### C1. Intent

Protected environments (`environment.protected`) today need a typed-name
confirm (`confirmProtected`). That checks the operator is paying attention, not
that a second person agrees. Teams also want a *scheduled* freeze ("no
releases Friday 16:00 to Monday 08:00", "code freeze Dec 20 to Jan 3"). Today
there is only the ad hoc manual freeze lock (`EnvLocks`, `kind: 'manual'`,
`expires_at`, at most `FREEZE_MAX_HOURS = 24`).

### C2. Goals and non-goals

- **G1. Approval.** On an environment with approval required, a Hub release
  (and a runbook operation that changes state; read-only runbooks are exempt)
  cannot start until a **different** user with deploy permission on that scope
  has approved **that exact review hash**.
- **G2.** An approval expires (default 30 minutes) and is single-use. It is
  void if the playbook changes, including an edit, a different service
  selection or `forceServiceIds`. The `reviewHash` already covers all of these.
- **G3. Freeze windows.** Recurring windows (weekday plus time range in a time
  zone) and one-off windows (from/to), per environment or for all
  environments. During a window, `start` is refused.
- **G4. Break-glass.** An admin can override a freeze or approval with a
  mandatory reason. It is audited and notifies the environment's notify
  targets (Teams/email through `hub/src/notify`).
- **G5. Rollbacks are never blocked** by a freeze or by approval
  (controller's call: the most common emergency action must stay one click).
  They are still audited, and still subject to locks.
- **Non-goal:** approvals for releases run locally by a desktop on a
  desktop-only environment. Approvals apply to Hub environments, where the Hub
  runs the release (`hub/src/releases/service.ts`). Part D is what stops
  someone deploying around the Hub with personal SSH keys.

### C3. Where it plugs in

- `HubReleases.start(user, releaseId, confirm)`: today it checks the lock,
  confirm and current state, then runs. New checks, in this order, before the
  lock is taken: (1) freeze window active → `409 env_frozen` unless
  `confirm.breakGlass` comes from an admin; (2) approval required → the
  release must have an `approved`, unexpired, unused approval whose
  `review_hash` equals the hash `start` computes now, and whose approver ≠
  `user.oid` and still passes `decide()` for the deploy action on the same
  deployments.
- `HubReleases.rollback` skips both checks (G5).
- `decide()` gains the action `release.approve`. The default is "anyone who
  may deploy the same scope". An environment can narrow it to a group.

### C4. Data model (Hub migration, next free number)

```sql
CREATE TABLE env_governance(
  environment_id TEXT PRIMARY KEY REFERENCES environments(id),
  approval_required INTEGER NOT NULL DEFAULT 0,
  approver_group_id TEXT,              -- NULL = anyone who may deploy the scope
  approval_ttl_minutes INTEGER NOT NULL DEFAULT 30,
  updated_by TEXT, updated_at TEXT);

CREATE TABLE approvals(
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  environment_id TEXT NOT NULL,
  review_hash TEXT NOT NULL,
  requested_by_oid TEXT NOT NULL, requested_by_name TEXT NOT NULL,
  requested_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  note TEXT,                           -- the requester's "why", ≤ 280 chars
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','used','void')),
  decided_by_oid TEXT, decided_by_name TEXT, decided_at TEXT, decision_note TEXT);

CREATE TABLE freeze_windows(
  id TEXT PRIMARY KEY,
  environment_id TEXT,                 -- NULL = every environment
  kind TEXT NOT NULL CHECK (kind IN ('recurring','once')),
  tz TEXT NOT NULL,                    -- IANA zone
  days TEXT,                           -- recurring: JSON [1..7]
  start_local TEXT, end_local TEXT,    -- recurring: 'HH:MM'; may wrap midnight
  from_utc TEXT, to_utc TEXT,          -- once
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
```

Governance lives in Hub-only tables, **not in the published manifest**
(controller's call). Publishing inventory should not be able to switch
approvals off by accident, and putting governance in the manifest would change
its hash.

### C5. API and UI

- `POST /api/v1/releases/:id/approval` {note} → creates a pending approval for
  the release's current review hash, notifies approvers (live bus + notify
  sinks).
- `POST /api/v1/approvals/:id/approve|reject` {note}. The approver's client
  shows the same playbook preview (`previewPlaybook`) and preflight report, and
  the hash must match.
- `GET /api/v1/approvals?status=pending` drives a desktop "Waiting for you"
  badge.
- `GET/PUT /api/v1/admin/environments/:id/governance` and CRUD for
  `/api/v1/admin/freeze-windows`.
- **Desktop:**
  - the release dialog on an approval-required environment replaces Deploy
    with "Request approval", then "Waiting for approval (expires in 28:10)",
    then "Deploy";
  - approvers get a toast and an approvals list;
  - the environment header shows "Frozen until Mon 08:00 (weekend freeze)";
  - preflight shows a blocking check, `freeze`, so nobody discovers it only at
    Deploy.

### C6. Failure modes

- **Approver loses permission between approving and start:** rechecked at
  start, and the approval becomes void.
- **The playbook changes after approval:** the hash differs, the approval
  becomes void, and the UI says why.
- **Time zones and DST:** windows are evaluated in their zone with `Intl` (the
  Hub's Node), with a table test across DST changes. A recurring window that
  wraps midnight is allowed.
- **Clock skew:** only the Hub's clock counts.
- **The manual freeze lock** (`EnvLocks`) stays as it is. Scheduled windows do
  not create lock rows. They are checked at preflight and start, so a release
  already running when a window opens finishes (Q-C3).
- **Self-approval through two accounts:** out of scope. Entra identity is the
  boundary.

### C7. Tests and phases

Policy unit tests (approver ≠ requester, group restriction, expiry, single use,
void on hash change); window evaluation (DST, wraparound, global and
per-environment); start/rollback paths; break-glass audit and notify; desktop
dialog states. Phases: C1 freeze windows (2–3 days); C2 approvals server
(3 days); C3 desktop UI (2 days).

---

## Part D. Short-lived SSH certificates issued by the Hub

### D1. Intent

Two long-lived credentials reach production hosts today:

1. **The Hub's environment deploy key** (`env_deploy_keys`, ed25519, sealed
   with the keyring, `privateForRun`). Every Hub release dials every hop with
   it (`hubIdentities` in `hub/src/releases/adapters.ts`). Its public half sits
   in `authorized_keys` indefinitely.
2. **Each person's own keys** from their desktop vault, used for terminal
   sessions, tunnels and desktop-run releases. They are revoked only by
   editing `authorized_keys` on every host.

An SSH CA on the Hub replaces both with certificates that expire in minutes or
hours. Each certificate is tied to a person or a release, and it is
authorized by the Hub's grants at issue time. When someone leaves the team,
removing them from the Entra group revokes their access within one certificate
lifetime.

### D2. Goals and non-goals

- **G1.** A Hub CA key (ed25519) generated at first use and sealed with
  `KeyRing`, like deploy keys. It has a rotation path (two CA public keys
  trusted during an overlap).
- **G2. Release certificates.** For each Hub release, the Hub creates an
  ephemeral key pair in memory and signs it. Valid for the release's expected
  length plus a margin (cap 3 h). Key ID `credops:release:<releaseId>:<upn>`,
  principal per environment `credops-<env-slug>`.
- **G3. User certificates.** `POST /api/v1/ssh/certificates` {publicKey,
  environmentId, purpose: 'session'|'tunnel'|'release'} → `decide()` checks
  the matching action for that environment's scope, then signs. Valid 1 h by
  default (8 h max, policy setting). Key ID `credops:user:<upn>:<nonce>`. The
  desktop generates the key pair in memory (vault `generateEd25519` in
  `src/main/vault/openssh.ts`), so the private key never leaves the desktop.
- **G4.** Hosts opt in per environment. `sshAuth: 'deploy-key' | 'certificate'
  | 'both'`, default `deploy-key`. Nothing breaks until a host trusts the CA.
- **Non-goals:** host certificates (CredOps keeps pinning host keys through
  `known_hosts` and `knownHosts` in the manifest); a CRL or KRL (short lifetime
  is the revocation); managing `sshd_config` on hosts automatically.

### D3. Host side (an operator step, documented, never run by CredOps without the user)

```
/etc/ssh/credops_ca.pub            # from GET /api/v1/ssh/ca (public)
TrustedUserCAKeys /etc/ssh/credops_ca.pub
AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u   # contains: credops-<env-slug>
```

CredOps offers a builtin runbook "Trust CredOps Hub CA". The user runs it with
sudo, it writes these three things and validates with `sshd -t` before
reloading, and preflight gains a check, `ca-trusted`, that reads them
read-only. Shared hosts (a host in several environments) list several
principals.

### D4. Client side and the library risk

- **Ansible path** (Hub and desktop releases): it goes through the in-process
  agent (`src/main/deploy/agent.ts`). The agent protocol carries certificates
  as identities (`ssh-ed25519-cert-v01@openssh.com` key blob, signed with the
  underlying key), so the agent must serve the certificate blob as the identity
  and sign with the private key. This is a contained change.
- **Terminal, tunnels and connect checks** use `ssh2` (`src/main/ssh/connect.ts`).
  **Spike first:** confirm `ssh2`'s client sends an OpenSSH user certificate in
  `publickey` auth. If it does not, the options are (a) a small patch or
  wrapper that sets the public-key blob to the certificate, or (b) using the
  agent path for `ssh2` too (`agent:` option with our agent), which then
  serves the certificate. (b) is preferred if it works (builder's call after
  the spike).
- **Certificate cache:** in memory only, keyed by environment and purpose, and
  refreshed when it has less than 5 minutes left. It is never written to disk.

### D5. Data model (Hub migration, next free number)

```sql
CREATE TABLE ssh_ca(
  key_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_enc TEXT NOT NULL,
  ring_key_id TEXT NOT NULL, created_at TEXT NOT NULL, retired_at TEXT);
CREATE TABLE ssh_certs_issued(                -- audit trail; no key material
  serial INTEGER PRIMARY KEY AUTOINCREMENT, key_id_text TEXT NOT NULL,
  subject_oid TEXT NOT NULL, environment_id TEXT NOT NULL, purpose TEXT NOT NULL,
  principals TEXT NOT NULL, valid_after TEXT NOT NULL, valid_before TEXT NOT NULL,
  public_key_fp TEXT NOT NULL, release_id TEXT, issued_at TEXT NOT NULL);
```

`environments.playbook_ops` (or `env_governance`) gains `sshAuth`. The
manifest is unchanged.

### D6. Failure modes and safety

- **Hub down:** no new certificates. Terminal sessions to certificate-only
  hosts fail, which is why `both` is the recommended transition mode and the
  break-glass path is a personal key on the host, not in CredOps (Q-D2).
- **Clock skew on hosts:** `valid_after` is backdated 5 minutes.
- **CA key compromise:** rotate. `GET /ssh/ca` returns all non-retired keys,
  and the runbook installs them all.
- **Principal sprawl:** one principal per environment, so access to the
  environment means access to its hosts as the configured user. Finer-grained
  scope (per deployment) is a non-goal, because SSH access to a host is
  host-wide anyway.
- **Certificate lifetime vs a long release:** a release certificate lasts the
  expected length plus margin. An Ansible connection already open survives
  the certificate expiring (sshd checks at auth time only), but a reconnect
  does not. The certificate is re-issued per play if needed (builder's call).

### D7. Tests and phases

Signing (a golden certificate parsed by `ssh-keygen -L` in a local test);
the `decide()` gate; agent identity with the certificate (local sshd in a
container on the developer's machine only); expiry refresh. Phases: D0 `ssh2`
spike (1–2 days); D1 CA and issuance API (2–3 days); D2 Hub releases with
certificates (2 days); D3 desktop sessions and tunnels with certificates
(3 days); D4 runbook and preflight `ca-trusted` (1–2 days).

---

## Shared rollout notes

- Every part announces itself through `HubMeta.capabilities`
  (`publishPreconditions`, `clientPolicy`, `governance`, `sshCertificates`).
  The desktop features light up only when the capability is present.
- Hub migrations are additive (new tables and nullable columns). The Hub's
  `migrate()` comes from desktop `src/main/db/migrations` (see the decoupling
  spec).
- Build B's minimum version before switching on C or D in an organisation, so
  old desktops cannot skip approval prompts or certificate flows.

## Open questions for the user

- **Q-A1.** Should `requirePublishPrecondition` default on for new Hubs, which
  would turn away publishes from desktops older than this feature?
- **Q-B1.** Is there an auto-updater, or should the minimum-version banner
  just link to the download page?
- **Q-B2.** Should "AI off" apply to the whole app while it is linked to the
  Hub, or only to Hub environments?
- **Q-C1.** Who may approve by default: anyone who may deploy the same scope,
  or a named group per environment?
- **Q-C2.** Should rollbacks really be exempt from freeze and approval (the
  design says yes)?
- **Q-C3.** Should a scheduled freeze stop a release that is already running
  when the window opens, or only block new starts (the design says only block
  new starts)?
- **Q-D1.** Is installing a CA in `sshd_config` on your hosts acceptable
  operationally? Who would own that change?
- **Q-D2.** For certificate-only hosts, what is the break-glass when the Hub is
  down: a personal key kept outside CredOps, or keep `both` permanently?
