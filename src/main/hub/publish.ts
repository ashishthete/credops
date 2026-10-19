import type { AuditInput } from '../../shared/audit'
import { parseEnvTemplate } from '../../shared/deploy'
import { EMPTY_HUB_INTEGRATIONS, type HubEnvManifest, type HubHop, type HubIntegrations, type HubPublishResult } from '../../shared/hub'
import type { ResolvedHost } from '../../shared/inventory'
import type { SecretMeta } from '../../shared/vault'
import type { Db } from '../db/connection'
import { passwordMessage } from '../deploy/hostkeys'
import type { DeployStore } from '../deploy/deploy-store'
import type { EnvironmentStore } from '../inventory/environment-store'
import type { KnownHostStore } from '../ssh/known-hosts'
import { HubError } from './client'

const ADMIN_ENVIRONMENTS = '/api/v1/admin/environments'

export interface ManifestDeps {
  db: Db
  envs: Pick<EnvironmentStore, 'get'>
  deploys: Pick<DeployStore, 'list' | 'listApps' | 'settings'>
  knownHosts: Pick<KnownHostStore, 'pinned'>
  secrets: { list(): SecretMeta[] }
  resolve: (hostId: string, environmentId: string) => ResolvedHost
  /** Phase 9 settings for the environment; defaults to none. */
  integrations?: (environmentId: string) => HubIntegrations
}

/** Everything a Hub needs to run the environment's deployments, and no secret value: only secret ids and names. */
export async function buildManifest(environmentId: string, deps: ManifestDeps): Promise<HubEnvManifest> {
  const env = deps.envs.get(environmentId)
  const settings = deps.deploys.settings(environmentId)
  const deployments = deps.deploys.list(environmentId)
  const apps = deps.deploys.listApps(environmentId)
  const labelOf = deps.db.prepare('SELECT label FROM hosts WHERE id = ?')

  const hostIds = [...new Set(deployments.map((d) => d.hostId))]
  const hosts: HubEnvManifest['hosts'] = []
  for (const hostId of hostIds) {
    const label = (labelOf.get(hostId) as { label: string } | undefined)?.label ?? 'host'
    const r = deps.resolve(hostId, environmentId)
    const stops = [
      ...r.chain.map((h) => ({ hostId: h.hostId as string | null, label: h.label, address: h.address, port: h.port, identity: h.identity })),
      { hostId: r.hostId as string | null, label, address: r.address, port: r.port.value, identity: r.identity },
    ]
    const hops: HubHop[] = []
    const lines = new Set<string>()
    for (const s of stops) {
      if (s.identity.auth === 'password') throw new Error(passwordMessage(s.label))
      const pinned = await deps.knownHosts.pinned(s.address, s.port)
      if (pinned.length === 0) throw new Error(`Connect to ${s.label} once from OpsDeck so its host key is pinned, then publish`)
      for (const l of pinned) lines.add(l)
      hops.push({ hostId: s.hostId, label: s.label, address: s.address, port: s.port, username: s.identity.username })
    }
    hosts.push({
      id: hostId,
      label,
      address: r.address,
      port: r.port.value,
      username: r.identity.username,
      useSudo: 'auto',
      hops,
      knownHosts: [...lines].sort(),
    })
  }

  const names = new Map(deps.secrets.list().map((s) => [s.id, s.name]))
  const used = new Map<string, Set<string>>()
  for (const d of deployments) {
    const ids = [...(d.envTemplate ? parseEnvTemplate(d.envTemplate).secretIds : []), ...(d.becomeSecretId ? [d.becomeSecretId] : [])]
    for (const id of ids) {
      if (!names.has(id)) throw new Error(`A secret used by "${d.name}" no longer exists`)
      used.set(id, (used.get(id) ?? new Set()).add(d.name))
    }
  }

  return {
    environment: {
      id: env.id,
      name: env.name,
      protected: env.protected,
      versioned: settings.versioned,
      autoRollback: settings.autoRollback,
      currentVersion: settings.currentVersion,
    },
    hosts,
    apps: apps.map((a) => ({ id: a.id, name: a.name, composeProject: a.composeProject, description: a.description })),
    deployments: deployments.map(({ vaultIds: _v, createdAt: _c, updatedAt: _u, ...d }) => d),
    integrations: deps.integrations?.(environmentId) ?? EMPTY_HUB_INTEGRATIONS,
    requiredSecrets: [...used].map(([secretId, by]) => ({ secretId, name: names.get(secretId) as string, usedBy: [...by].sort() })),
  }
}

export interface PublisherDeps extends ManifestDeps {
  audit: { append(input: AuditInput): unknown }
  vault: { assertUnlocked(): void }
  client: () => { put<T>(path: string, body?: unknown): Promise<T>; del(path: string): Promise<void> }
  hubId: () => string
  now?: () => Date
  onChanged?: () => void
}

export class HubPublisher {
  private readonly now: () => Date

  constructor(private readonly d: PublisherDeps) {
    this.now = d.now ?? ((): Date => new Date())
  }

  async publish(environmentId: string): Promise<HubPublishResult> {
    const d = this.d
    d.vault.assertUnlocked()
    const manifest = await buildManifest(environmentId, d)
    const result = await d.client().put<HubPublishResult>(`${ADMIN_ENVIRONMENTS}/${environmentId}`, manifest)
    d.db
      .prepare(
        `INSERT INTO hub_env_links(environment_id, hub_id, published_at, manifest_hash) VALUES (?,?,?,?)
         ON CONFLICT(environment_id) DO UPDATE SET hub_id = excluded.hub_id, published_at = excluded.published_at, manifest_hash = excluded.manifest_hash`,
      )
      .run(environmentId, d.hubId(), this.now().toISOString(), result.manifestHash)
    d.audit.append({
      action: 'hub.publish',
      outcome: 'success',
      targetType: 'environment',
      targetId: environmentId,
      targetLabel: manifest.environment.name,
      details: {
        manifestHash: result.manifestHash,
        hosts: manifest.hosts.length,
        deployments: manifest.deployments.length,
        missing: result.missingSecrets.length,
      },
    })
    d.onChanged?.()
    return result
  }

  async unpublish(environmentId: string): Promise<void> {
    const d = this.d
    d.vault.assertUnlocked()
    const name = (d.db.prepare('SELECT name FROM environments WHERE id = ?').get(environmentId) as { name: string } | undefined)?.name
    try {
      await d.client().del(`${ADMIN_ENVIRONMENTS}/${environmentId}`)
    } catch (err) {
      // Already gone from the Hub: still drop the local link.
      if (!(err instanceof HubError) || err.code !== 'not_found') throw err
    }
    d.db.prepare('DELETE FROM hub_env_links WHERE environment_id = ?').run(environmentId)
    d.audit.append({
      action: 'hub.unpublish',
      outcome: 'success',
      targetType: 'environment',
      targetId: environmentId,
      ...(name ? { targetLabel: name } : {}),
    })
    d.onChanged?.()
  }
}
