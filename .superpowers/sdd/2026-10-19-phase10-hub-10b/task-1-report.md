# Phase 10b Task 1: Environment registry, publish and catalog

Status: DONE_WITH_CONCERNS. BASE ccc9fa3.

## Hub
- Migration 2 (`environments`, `hosts`, `apps`, `deployments`) in `hub/src/db.ts`.
- `hub/src/registry.ts`: `readManifest` (strict validation, unknown fields dropped), `hashManifest`, `Registry` (publish upserts by id then deletes stale rows in one transaction, unpublish, get, list, `catalogFor` filtered by `decide('deploy.view')`).
- `hub/src/routes/registry.ts`: PUT/DELETE/GET admin environments (admin only via `deploy.edit`) and `GET /api/v1/catalog`.
- `Directory.addGrant` now 404s for an unpublished environment or deployment.
- Audit `env.publish` / `env.unpublish` carry `{name, hosts, deployments, manifestHash}` only.

## Desktop
- `src/main/hub/publish.ts`: `buildManifest` (hops from the Phase 3 chain, target last; pinned keys per hop; password identity and unpinned-hop refusals), `HubPublisher` (PUT, upsert `hub_env_links`, audit `hub.publish`; unpublish treats Hub 404 as done).
- `src/main/hub/catalog.ts`: in-memory `HubCatalog`; loads on sign-in, clears on sign-out, shares concurrent refreshes.
- IPC: `hub:catalog`, `hub:publish`, `hub:unpublish`, `hub:adminEnvironments` with validators, event `hub:catalog`; `RoutingAccess.isHubTarget` is now links or catalog.
- `KnownHostStore.pinned`, exported `passwordMessage`, audit actions `hub.publish`, `hub.unpublish`, `hub.secret.set`.

## Tests
hub: 9 files, 92 tests pass (13 in registry.test.ts). app: 114 files, 1753 tests pass. tsc node/web/hub clean.

## Concerns
- `HubIntegrations` is a loose local type (Phase 9 types are not on this branch); `integrations` dep defaults to empty.
- `requiredSecrets` is stored inside the `integrations` JSON column (the brief schema has no column).
- Release-lock check, `missingSecrets` and `deployKey` probe `sqlite_master` until migrations 3 and 4 land.
- Case-insensitive duplicate environment names are refused (409), beyond the brief.
- Host `useSudo` is published as `auto`; only hosts used by a deployment are published.
- The audit key `missingSecrets` is redacted by key name, so the detail is `missing`.
- `KnownHostStore.pinned` (Phase 4) and the `passwordMessage` export (Phase 8) were added.
- `hub:catalog` event payload is an empty object.
