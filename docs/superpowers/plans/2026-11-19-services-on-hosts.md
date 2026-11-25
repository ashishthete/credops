# Services on Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every service has a required host and a type (app / db / bastion). Environment membership is derived from services, and the UI is Product → Environment → Services.

**Architecture:** Migration 17 rebuilds `services` with `host_id NOT NULL` and `kind IN ('service','db','bastion')`, where `'service'` is shown as "App". It folds `via_host_id` into `host_id`, and replaces the `environment_hosts` table with a view over `services`. Code that used to write memberships now calls one helper, `ensureHostService`, which adds a placeholder service named after the host. Readers of `environment_hosts` and `EnvironmentMeta.hosts` are unchanged.

**Tech Stack:** Electron, node:sqlite, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-services-on-hosts-design.md`

## Global Constraints

- Internal kind values stay `'service' | 'db'`, plus `'bastion'`. The UI labels `'service'` "App". The Hub manifest (schema 2) and the config file keep their shapes. `viaHostId` is still written for db services and read on import. Bastion services are not published to the Hub.
- Role from services: bastion > app > db (`ROLE_ORDER`). Role `'other'` is no longer produced.
- Builder calls settled with the user's "fix all":
  - A checkout on a host with no service in that environment creates a placeholder app service.
  - A service's host is editable. A db's tunnel moves with it, through the existing restart prompt.
  - An old config import skips a placeholder when the host already runs a service in that environment.
- Keep the uncommitted "Duplicate service" work in the services UI.

## Review Focus

- A user's live database migrates with no loss. Fixture: 14 memberships, 1 db service with a null via host whose address equals a member host → 14 services, same memberships and roles.
- Removing a host from an environment deletes its services there, and the host's env tunnels fall back to host-only as before.
- Deleting a host cascades its services. The confirmation names how many.
- A db service whose host changes reports `tunnelRestartNeeded`.
- An ops run targeting `{environment, role: 'app'}` still selects the same hosts.

---

### Task 1: Schema and data migration
**Files:** `src/main/db/migrations.ts`, test `tests/main/services-on-hosts-migration.test.ts`
- [ ] Test: migrating a v16 fixture shaped like the live data yields services per the spec rules, and `environment_hosts` view rows are equal to the old table's rows, with `other` → `app`.
- [ ] Migration 17 `services_on_hosts`: rebuild `services` (new CHECKs per kind, `host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE`, no `via_host_id`), copy rows with the host resolution rules, add placeholders, drop the table, create the view. Audit any dropped hostless service.

### Task 2: Shared types and ServiceStore
**Files:** `src/shared/services.ts`, `src/main/deploy/service-store.ts`, `src/main/ipc/validators.ts`, `service-tunnel.ts`, `service-copy.ts`, `hub/publish.ts`, `config/export.ts`, `config/import.ts`, `config/segment.ts`, `shared/config-file.ts`, `shared/regions.ts`, tests.
- `ServiceBase.hostId: string`. `ServiceKind = 'service' | 'db' | 'bastion'`. `BastionServiceMeta { kind: 'bastion' }`. `ServiceInput` gets `hostId` on every kind, plus a `{ kind: 'bastion', environmentId, name, description?, hostId }` variant. `viaHostId` is removed from meta and input.
- App with a checkout: `hostId` must equal the checkout's host. A missing `hostId` defaults to it. App without a checkout: `composeService` may be `''` → stored NULL.
- `ensureHostService(db, environmentId, hostId, kind, now, ids)` in `src/main/deploy/host-service.ts`. It's a no-op when the host already has a service in the env. Otherwise it inserts one named after the host label (unique with " 2", " 3"…).

### Task 3: Membership writers
**Files:** `environment-store.ts` (`putHost`, `putHostInTx`, `removeHost`, create), `host-store.ts` (create memberships), `deploy-store.ts` (`ensureMembership`), `ssh-import.ts`, `config/import.ts`, tests.
- `putHost(env, host, role)` → `ensureHostService` with kind from role (`app`/`other` → `service`, `db` → `db` at 127.0.0.1 with engine `other` and port 5432, `bastion` → `bastion`). An existing host keeps its services, and a role change is a no-op.
- `removeHost` → delete that host's services in the env, then do the existing tunnel fallback.

### Task 4: UI
**Files:** `ServiceDialog.tsx` (Type segmented + Host picker), `ServicesSection.tsx` (one Add service, grouped by type, host on each row), `ServiceRow.tsx`, `EnvironmentView.tsx` (remove role host sections), `ProductsPage.tsx` (drop `addDatabase`), `InventoryTree.tsx` + `inventory/tree.ts` (services under environments), `HostView.tsx` (Services list replaces `MembershipEditor`), `CopyServicesDialog.tsx`, renderer tests.

### Task 5: Verify, build, migrate the user's data
- [ ] `pnpm typecheck && pnpm test`.
- [ ] Run migration 17 on a copy of the backup and compare memberships before and after.
- [ ] Build the app. The user's live database migrates on first launch (the app's pre-migration backup runs too).
