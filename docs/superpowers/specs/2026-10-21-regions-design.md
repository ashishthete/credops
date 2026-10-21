# OpsDeck — Regions on hosts, one product per environment

Date: 2026-10-21. Extends `2026-10-16-opsdeck-design.md` (the main spec) and
`2026-10-19-services-design.md` (the services spec). Calls marked
"(controller's call)" were made when this spec was written; calls marked
"(builder's call)" are left to whoever plans the build. Everything else is the
user's.

## 1. Intent

The user drew an infrastructure ERD (`~/Downloads/infrastructure-erd.svg`)
with Product, Service, Deployment, Environment, Region, Environment-Region and
Host, and asked what they were missing. OpsDeck today has no region at all,
and products and environments are many-to-many.

During the conversation the user tried a full Product → Region → Environment
hierarchy, then found where it breaks: "issue arises when some service is not
on that region but belong same product and environment", for example "ai or
other document services is common to all", which "can be common sometimes not".
They settled on:

- "host and region have direct relationship", and it should be strict.
- "deployment derive region from hosts and services."
- "we can always show region based on host. user can name env or services based
  on region, its their choice."
- "environment now belong to exactly one product … yes" (the region half of
  that answer was later dropped by the points above).
- "hosts can be shared" across environments and products.
- SSH, DB tunnels and deploying an environment or picked services keep working
  as now.

So: **a region is a property of a host, and nothing else stores one.**
Environments, checkouts and services show the regions of the hosts they run on.
Separately, **each environment belongs to exactly one product.**

What the ERD had that this spec does **not** adopt:

| ERD | Here |
|---|---|
| ENVIRONMENT_REGION (environments placed in regions) | Environments have no region. Their regions are worked out from their hosts. |
| SERVICE owned by PRODUCT, DEPLOYMENT = one running copy of a service | Services stay per environment; a deployment stays a checkout running several services. |
| Deployment without a host | Every checkout runs on a host. |
| owner_team, cost_center, tier, type, stage, host_type, provider_ref, host status, config_overrides | Left out (controller's call; the user picked none). Each is a later, additive column. |

## 2. Goals

- G1. A **Region** has a code (e.g. `eu-west-1`), a provider (free text, e.g.
  `aws`, `azure`, `on-prem`; may be empty) and a display name. One list for the
  whole app.
- G2. **Every host belongs to exactly one region.** This is strict: required
  on create, import and in the database.
- G3. **Derived regions, never stored elsewhere.**
  - A checkout's region is its host's region.
  - An app service's region is its checkout host's region.
  - A db service's region is its via-host's region, or none if it has no
    via-host.
  - An environment's regions are the distinct regions of its member hosts,
    checkout hosts and via-hosts.
- G4. **Each environment belongs to exactly one product.** Today it is
  many-to-many.
- G5. Region is display, grouping and filtering. It never blocks linking a host
  anywhere, and it never takes part in SSH or tunnel resolution (host →
  environment → global stays as is).
- G6. The Hub can publish two environments that share a host (§6.1). This is a
  bug today and a must-fix now that sharing is a stated goal.
- G7. Existing data upgrades with nothing lost and nothing silently re-linked
  (§5).

## 3. Non-goals

- A region level in the products tree, or a region on environments.
- Same-region rules or blocks of any kind.
- Shared environments or "common services" linked into several environments.
  The user raised the case (an AI or document service used by many
  environments); for now they model it as they like, e.g. a separate
  environment. Listed in §9.
- Region-wide deploys, region defaults (identity, port, jump host), or Hub
  grants by region or product.
- Cloud provider integration (discovering regions or hosts).
- Any of the ERD-only fields.

## 4. Anti-goals

- A host with no region, or with a region the user didn't choose, appearing
  after any create, import or upgrade path.
- A deploy confirm step that hides that the deploy reaches more than one region.
- Region chips on every row of a single-region environment (noise for the common
  case).
- An upgrade that silently drops a product link without telling the user.

## 5. Data model and upgrade (desktop)

Migration 12 (`regions`), SQL only, in one transaction like every migration.

| Table | Change |
|---|---|
| `regions` | New: `id` (UUID), `code` (unique, case-insensitive, `^[a-z0-9][a-z0-9-]{0,62}$`), `provider` (text, default `''`), `display_name`, `created_at`, `updated_at`. |
| `hosts` | Add `region_id` → `regions(id)`. Required. |
| `environments` | Add `product_id` → `products(id)`. Required. |
| `product_environments` | Dropped after the migration copies it. |

`migrate()` runs inside `BEGIN IMMEDIATE`, and `PRAGMA foreign_keys` can't
change inside a transaction, so the tables can't be rebuilt to make the new
columns `NOT NULL`. They are added nullable, and two layers enforce them:

- triggers that abort an insert or update leaving them NULL (the backstop);
- the stores, which reject first with a readable message.

Environment names stay unique within their product (`checkNamesFree`), now with
one product. Add a unique index `(product_id, name COLLATE NOCASE)`.

**Upgrade steps:**

1. Create `regions` with one row: code `default`, display name "Default",
   empty provider. The UUID is generated in SQL (builder's call on the
   expression; the Hub validates ids as UUIDs). **Only when hosts exist**
   (controller's call): a fresh database starts with no regions, and the
   user creates one, inline, before their first host. No banner or audit
   event appears when there is nothing to report.
2. Set every host's `region_id` to it.
3. Fill `environments.product_id`:
   - **One product:** that product.
   - **Several products:** the product whose name sorts first
     (case-insensitive). Record the dropped links.
   - **No product:** a product named "Unassigned" (created only if needed;
     neutral colour, icon `boxes`; "Unassigned 2" and so on if the name is
     taken). Record it. If two of these environments share a name, the later
     one by `created_at` gets " (2)". Record that too.
4. Drop `product_environments`, then add the triggers and the index.

The record goes into `settings` (`migration.regions.report`, JSON), not
`audit_events`, because that table is hash-chained and written by the app. On
first launch after upgrading, the app:

- writes one audit event summarising the report;
- shows a dismissible banner on the Products page:
  - It says "Hosts now have a region. Everything is in **Default** for now.
    Create your regions and move hosts."
  - It lists any environment that lost a product link ("kept Leaf, removed
    Globe"), with links.
  - Dismissal is stored in `settings`.

**Rules:**

- **Deleting a region** is refused while any host uses it.
- **Deleting a product** is refused while it has environments. Today they become
  "unassigned", and that state no longer exists. The message offers to show
  them.
- **Changing a host's region** is always allowed. The derived regions update
  everywhere.
- **Moving an environment to another product** is allowed, except while it is
  Hub-linked (controller's call: there is no manifest-change tracking to build
  on). The message says: unpublish, move, publish again.

**Types (`src/shared/inventory.ts`):**

- Add `RegionMeta`/`RegionInput`/`RegionPatch`.
- `HostInput` and `HostMeta` gain `regionId`.
- In `EnvironmentInput` and `EnvironmentMeta`, `productIds: string[]` becomes
  `productId: string`.
- Every reader of `productIds` changes, including:
  - `rows.ts`;
  - `environment-store.ts` (`setProducts`, `addProductsInTx`,
    `checkNamesFree`);
  - `release-service.ts` (`productIds[0]` becomes `productId`);
  - config export and import;
  - the renderer inventory store (`setEnvironmentProducts`);
  - `EnvironmentDialog`, the products tree, the map graph, `EnvPicker` and the
    palette commands.

Derived regions are worked out where they're shown (renderer helpers over the
inventory store). The main process needs them only for the deploy confirm step
(§7.4). The builder decides where that helper lives.

**Config files:** `CONFIG_VERSION` becomes 2. Version 2 adds `regions[]`,
`ConfigHost.regionId`, and `ConfigEnvironment.productId` in place of
`productIds`. The validator accepts versions 1 and 2. Import still merges and
never moves anything:

- **Matching:** regions by id, then by code. Hosts and environments as today.
- **Version 1 files** have no regions. The preview gets a required "Put new
  hosts in region" picker. It's preset when only one region exists, and it
  offers "New region…". It never silently recreates `default`. Product links
  map with step 3's rules, and the preview shows the mapping.
- **An existing host whose region in the file differs:** it keeps its local
  region and is listed as "region not changed".
- **An existing environment whose product in the file differs:** everything
  else about it merges as normal, its product is left alone, and it is listed
  as "product not changed" (controller's call, mirroring hosts).

## 6. Hub

### 6.1 Shared hosts (must-fix, can ship first)

Today `publish.ts` sends the desktop host id, and the Hub `hosts` table is keyed
by `id` alone with one `environment_id`. `guardForeign` returns 409 "An id in
the manifest belongs to another environment" when a second environment
publishes the same host.

Required outcome: **two environments sharing a host both publish, and each
keeps its own host row.** Each row carries that environment's resolved address,
user and hops, and these can legitimately differ.

The mechanism is the builder's call:

- **Hub side:** key hosts by `(environment_id, id)`. This needs a Hub migration
  that rebuilds `hosts` and `deployments`, which references `hosts(id)`.
- **Publish side:** a per-environment id, such as a UUIDv5 of the environment
  id and the host id. The desktop id stays in the manifest for display. Check
  anything that matches Hub host ids back to desktop hosts (runs, live view).

Add a test that publishes two environments sharing a host. This doesn't depend
on anything else here and should land first.

### 6.2 Product and region on the Hub

- `HubEnvManifest.environment` gains `product { id, name }`. Each manifest host
  gains `region { code, displayName }`. The Hub stores both, in nullable
  columns, because an older desktop's manifest has neither.
- `hub/src/releases/adapters.ts` uses the manifest's product name, falling back
  to today's `'Hub'`.
- The Hub groups environments by product **name** (case-insensitive), never by
  id. Ids are local to each desktop (controller's call).
- Compatibility: a newer desktop must still publish to an older Hub, or be told
  clearly to upgrade it. Built: it still publishes. An older Hub copies only
  the fields it knows, so it drops product and region and the environment stays
  under "Team (Hub)"; both fields are optional, so an older desktop publishes to
  a newer Hub unchanged (builder's call).
- Already-published environments aren't flagged after the upgrade. Their Hub
  rows get product and region on their next normal publish.

## 7. UI and UX

Region shows up as a host field, as a group or filter wherever hosts are
listed, and as derived chips on environments, services and deploys. The products
tree keeps its shape.

### 7.1 Regions management

- No new sidebar section (controller's call: regions change rarely). A
  **Regions…** button on the Hosts page rail opens a dialog. It shows each
  region's code, provider, display name and host count, with edit and delete.
  Delete is refused while the region is used.
- "New region…" is also inline in the Host and Import dialogs.
- Palette: "Manage regions".

### 7.2 Hosts

- **Hosts page:** grouped by region, with collapsible headers and counts.
  - A region filter sits beside the tag filter.
  - Search also matches region code and name.
- **HostDialog:**
  - **Region** is required and comes right after Address.
  - It's preset from context: the region group the user was in, or, when
    opened from an environment, that environment's only region.
- **HostView:** shows the region under the label, with "Change region…".
- **Import from ~/.ssh/config:** a required region picker. All hosts imported
  in one go go to that region.
- Host pickers (jump host, checkout host, via-host, tunnel host, the Copy
  services host fields) show each host's region beside its label and group by
  region.

### 7.3 Products page

- **Tree** keeps its shape, with these changes:
  - Each environment appears once, under its single product.
  - The "Unassigned" environments group goes away. Hosts with no environment
    stay in an Unassigned hosts group.
  - Host nodes show a region chip only when their environment spans more than
    one region.
- **Shared markers:**
  - The environment "Shared" badge (several products) is removed, since that
    can't happen any more.
  - The host Link2 icon and the "Also in …" tooltip stay. The tooltip now
    reads "Also in Globe · staging".
- **Drag and drop:**
  - Dropping an environment onto another product becomes **Move to Globe?**, a
    confirm, since the drop now re-parents instead of adding a link.
  - Dropping a host onto an environment is unchanged.
- **EnvironmentDialog:** the multi-select product chips become a single
  **Product** select, preset and locked when the dialog opens from a product.
- **EnvironmentView:**
  - The header shows derived chips: **Regions: eu-west-1 · us-east-1**, or one
    chip, or nothing when there are no hosts yet.
  - Host rows and service rows get a region chip only when the environment
    spans more than one region.
  - "Remove from <product>" goes away.
- **Soft hint:** adding a host to an environment from a region it doesn't use
  yet (tree drop, membership editor, new host, checkout host, via-host) shows an
  inline note, never a block: "prod's hosts are all in eu-west-1; app-us-1 is in
  us-east-1." The note only appears when the environment already has hosts.
- **First-launch banner** from §5.

### 7.4 Deployments

- **EnvPicker:** pills grouped by product. The "No product" group goes away.
  "Team (Hub)" environments are grouped by product name when their manifest has
  one, and under "Team (Hub)" when it doesn't.
- **DeployWizard confirm step:**
  - It shows the derived regions of the checkouts it will touch: "Deploys
    orders-api, web · eu-west-1, us-east-1".
  - When those regions span more than one, they are emphasised (the warning
    style already used in the wizard).
  - The protected confirmation is unchanged: type the environment name.
- **DeploymentDialog** and **Copy services:** host selects show and group by
  region (§7.2). Nothing else changes.

### 7.5 Map

- Host cards show their region chip.
- Toolbar: a **Region** filter (`?region=`). It keeps hosts in that region and
  dims the rest, without removing environments. Search matches region code and
  name.
- Each environment has one product now, so the "primary product" and secondary
  membership edges go away.
- The DetailPanel shows a host's region, and an environment's derived regions.
- Builder's call: whether List mode also offers "group by region".

### 7.6 Tunnels, SSH, Ops, Hub page

- **Tunnels page:** host groups show the host's region chip.
- **SSH:** entry points are unchanged. The palette's "Connect to <host>" shows
  the region.
- **Ops Composer:** host lists show region chips. Builder's call: whether to add
  a region filter to the host list.
- **Hub page:**
  - EnvironmentsPanel is grouped by product.
  - GrantPicker's environment select is grouped by product.
  - Hub host lists show the region when the manifest has it.

## 8. Changes to the existing specs

These edits keep the older specs true. They land with the build, not before.

**`2026-10-16-opsdeck-design.md`**

- §1 Intent: the hierarchy stays Product → Environment → Host → Vault. Add:
  "Each host is in one region."
- §3 G1a: replace "Each environment belongs to one or more products (an
  environment can be shared between products …)" with "each environment belongs
  to exactly one product (user 2026-10-21); a host can be shared between
  environments and products."
- §3 G2: add "Every host belongs to one region; environments show the regions
  of their hosts."
- §7 Data model:
  - Add the Region row.
  - Host gains `region_id`.
  - Remove ProductEnvironment.
  - Environment gains `product_id`.
  - "Credential and route resolution" gets one line: region never takes part.
- §8.5 Visualization: host cards show the region, with a region filter.
- §8.9 Hub:
  - The manifest carries the product and each host's region.
  - Shared hosts publish in every environment (§6.1 here).
- §9 Build order, item 3: "many-to-many linking" becomes "one product per
  environment; environment ↔ host linking".

**`2026-10-19-services-design.md`**

- §8.1 Environment view: derived region chips (§7.3 here).
- §8.3 Deploy: the confirm step shows the regions it touches (§7.4 here).
- Addendum (config import/export): format version 2 and the version 1 mapping
  (§5 here).

**`2026-10-16-roadmap.md`**

- Add a phase for this spec after Hub, with §6.1 as an item that can land
  first.
- The roadmap says "earlier migrations are never edited", but the services
  spec §12.1 says it amended Migration 7 in place. The roadmap should say which
  rule holds. This spec assumes Migration 12 is new and nothing earlier is
  touched.

## 9. Later

- **Common services:** a service (AI, documents) deployed in one place and used
  by several environments. It would show read-only in each of them and never be
  redeployed by their deploys. The user said it "can be common sometimes not".
  Revisit once regions are in use.
- Region-wide deploys, region defaults, and Hub grants by region or product.
- The ERD-only fields. Host status could later stop deploys to a host that is
  being drained.

## 10. Left to the builder

- Mechanism for §6.1.
- SQL for the region UUID, the tie-breaks and the triggers in §5.
- Where the derived-region helpers live (§5).
- Hub manifest compatibility (§6.2).
- Visual design of region headers and chips, using existing components.
- The small calls marked "builder's call" in §7.

## 11. Calls made when writing this spec

- The `Default` region is created on upgrade only when hosts exist.
- Migration 12 (`regions`); Migrations 10 and 11 were already taken on master.

- Leave out every ERD-only field.
- Regions are managed from the Hosts page, not a new sidebar section.
- Region chips on environment rows appear only when the environment spans more
  than one region.
- A soft hint when adding a host from a region the environment doesn't use yet.
- The deploy confirm step shows the regions it touches.
- Deleting a product with environments is refused.
- Upgrade:
  - every host goes into `Default`;
  - environments with several products keep the product whose name sorts
    first;
  - environments with no product go to "Unassigned".
- Moving a Hub-linked environment to another product is refused.
- Config import never changes an existing host's region or environment's
  product.
- The Hub groups by product name, not id.
