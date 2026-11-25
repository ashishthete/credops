# Services live on hosts

Date: 2026-11-19

## Intent

The user thinks of an environment as a set of **services**, each running on a **host**: `prod` runs an app on
`eu-prod`, an app on `prod`, a database on `DB`. Today the app models that twice and in neither place well:

- A host joins an environment with a **role** (app / db / bastion / other). The Products tree and the
  environment page list these hosts by role, so a host in two environments shows up twice.
- **Services** are a separate list. An app service only gets a host through a checkout. A database
  names a "via host" and an address, never the machine it is on. The "Add database" button sits in an empty
  section that the user could not make sense of.

The goal is one model: **Product → Environment → Services**, and every service runs on a host.

## Goals

- A service has a **type**: `app`, `db` or `bastion`, and a **required host**. A service can't exist without a
  host.
- A host can run many services, in one environment or several.
- The Products tree shows Product → Environment → Services. Each service row shows its type and its host.
- The environment page has a single Services section with one **Add service** button. The dialog asks for the type
  and the host, then shows the fields for that type.
- The Hosts tab lists each host **once**. A host's page lists the services it runs and their environments, and can
  add a service to it.
- A database works like this: it lives on a host, with its address as seen from that host. Its tunnel goes through
  that host. A managed database (RDS and the like) lives on the bastion that can reach it (user's choice "A").
- Nothing the user has set up is lost. Every membership, service, tunnel and checkout carries over.

## Non-goals

- No change to the Tunnels page, checkouts, or how releases run.
- No new kinds of service beyond app / db / bastion.
- Bastion services don't rewire jump hosts. An environment's default jump host stays its own setting.

## Anti-goals (a failure even if it "works")

- Any of the user's current setup has to be re-entered after the upgrade.
- A host appears more than once in the Hosts tab.
- A service row exists without a host, or the UI offers a way to make one.
- Two places to say "this host is in this environment" survive the change.

## Constraints

- Live data: 2 products, 6 environments, 11 hosts, 14 memberships, 1 db service (`demo-prod`, no via host,
  address `203.0.113.68` = host `demo-prod-db`), 4 tunnels, 3 checkouts. A verified backup of it is at
  `~/credops-backups/2026-11-19-before-services-redesign/credops.db`.
- Roles are read in many places: ops run targets (`environment` target with `role`, `run-manager.ts`,
  `ops/protect.ts`), the Map (`map/graph.ts`, `nodes.tsx`, `DetailPanel.tsx`, `MapList.tsx`), the tree
  (`inventory/tree.ts`), HostsPage's primary role, ssh-import, the config file (`config-file.ts`, export/import),
  the Hub manifest (`HubManifestService` and `hosts`), and `pickAppHost` for default via-hosts.
- The Hub manifest and the config file are shared formats. Older files and manifests must still read.
- `ServiceDialog.tsx`, `ServiceRow.tsx` and `ServicesSection.tsx` have **uncommitted** "Duplicate service" work in the
  main checkout that isn't part of this design. Build on top of it and keep it, and don't revert it.

## Approaches

1. **Services are the single record; membership comes from them (chosen).** `services` gets a required `host_id`
   and type `app | db | bastion`. A host is in an environment exactly when it runs a service there, and its role in
   that environment comes from its services. `EnvironmentMeta.hosts: { hostId, role }[]` keeps its shape and is
   computed. So ops targets, the Map and protection checks keep working almost unchanged.
2. **Remove memberships and roles entirely and rewrite every consumer to read services.** It's cleaner on paper,
   but it touches about 29 files and the shared Hub format with nothing the user would see. Rejected.
3. **Keep memberships with roles and only make the host required on services.** Two sources of truth stay, and
   that's exactly what the user objects to. Rejected.

## Design

### Data

- `services.kind` becomes `'service' | 'db' | 'bastion'`; `'service'` is shown as **App** (builder call: keeps the Hub
  and config formats unchanged). `via_host_id` is folded into a new `host_id TEXT NOT NULL REFERENCES hosts(id)`.
- **app:** checkout optional. With a checkout, `compose_service` is required and the checkout's host must equal the
  service's host (the store rejects a mismatch). Without a checkout, compose fields are empty. It's just a named app
  on a host. URL, health-check source and skip-unchanged stay as today.
- **db:** engine, address as seen from the host (default `127.0.0.1`), port, optional local port, tunnel. The tunnel
  goes through the service's host, as the via-host did before.
- **bastion:** name and description only.
- **Membership is derived.** `environment_hosts` stops being written. It becomes a SQL `VIEW` over `services`
  (distinct environment and host). Role precedence follows the existing `ROLE_ORDER` (bastion > app > db). Reads keep
  working, and the `'other'` role disappears.
- **Deleting a host** asks to confirm and lists the services it takes with it, by environment. A host in a protected
  environment needs that environment's name typed, as other protected deletes do.
- "Remove host from environment" becomes "delete its services in that environment".

### Migration (one schema step, in a transaction, after the usual pre-migration db backup)

1. Existing app services (`kind='service'`): host = the checkout's host. With no checkout, use `pickAppHost` for the
   environment. With no host available, use any member host of the environment.
2. Existing db services: host = `via_host_id` if set. Otherwise use the environment member host whose address equals
   `db_address`, and rewrite the address to `127.0.0.1`. Otherwise use the environment's db-role host, then its app
   host. On the live data, `demo-prod` lands on `demo-prod-db` with address `127.0.0.1`.
3. Each membership whose host has no service in that environment after steps 1 and 2 becomes one service. It's named
   after the host label (made unique within the environment), with type = role (`other` → `app`), no checkout.
4. A service that still has no host (an environment with no hosts at all) is not dropped silently. The migration
   logs it to the audit log and deletes it. Only possible with no hosts, and absent from the live data.
5. Replace the `environment_hosts` table with the view.

On the live data this gives 14 services: the 13 memberships minus `demo-prod-db`, plus the existing `demo-prod` db.
Every host stays in the same environments with the same role.

### UI

- **Products tree:** Product → Environment → Service rows. Icon by type, service name, host label (muted), region
  chip, type chip. Right-clicking an environment offers **Add service**. Selecting a service opens the environment page
  focused on it.
- **Environment page:** a single **Services** section grouped by type (Apps, Databases, Bastions), each row showing its
  host. The role-grouped host sections ("App 3" etc.) are removed. The empty state is one **Add service** button and
  one line of copy. The separate **Add database** entry points (section button, menu item, `addDatabase` action in
  `ProductsPage`) are removed.
- **Service dialog:** Name → **Type** (segmented: App / Database / Bastion) → **Host** (required; every host, grouped
  by region) → the type's fields. Picking a checkout sets the host to the checkout's host. The type can't change after
  creation, as today.
- **Hosts tab:** still one row per host. Its icon comes from its most significant service type. A host with no
  services reads "No services". The host page replaces `MembershipEditor` with a **Services** list (environment, type,
  name, open, delete) and an **Add service** button that preselects this host and asks for the environment.

### Shared formats

- **Config file:** write services with `hostId` (and `kind: 'bastion'` for bastions). Environment `hosts` roles are
  still written, computed from services, so older readers work. Reading an old file: `viaHostId` → `hostId`, and
  environment `hosts` roles become placeholder services, skipped when that host already runs a service there.
- **Hub manifest:** stays at schema 2. Every service carries `hostId`; a db also sets `viaHostId = hostId`. Bastion
  services are not published. No Hub server change.

### Other consumers

- Ops run target `{ kind: 'environment', role }` keeps working through the computed roles. A stored target with
  `role: 'other'` means every host in the environment.
- The Map draws the same graph from computed memberships. It shows service types where it shows roles today.
- Copy services to another environment: each copied service needs a host in the target. Default to the same host
  when it is already in the target environment. Otherwise the user picks one per source host in the copy dialog.

## Left to the builder

- Whether the view or an application-maintained table is easier to keep correct with the existing stores. The
  requirement is that membership is never written independently of services.
- Exact layout and copy of the tree rows, the grouped Services section and the host page list, within the app's
  existing components and tokens.
- The test split. Each migration rule needs a test on a fixture shaped like the live data.
