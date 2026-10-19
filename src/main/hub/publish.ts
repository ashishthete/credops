import type { AuditInput } from '../../shared/audit'
import { parseEnvTemplate } from '../../shared/deploy'
import {
  EMPTY_HUB_INTEGRATIONS,
  type HubEnvManifest,
  type HubHop,
  type HubIntegrations,
  type HubPublishResult,
  type HubSecretKind,
  type HubSecretList,
} from '../../shared/hub'
import type { ResolvedHost } from '../../shared/inventory'
import type { SecretMeta } from '../../shared/vault'
import type { Db } from '../db/connection'
import { passwordMessage } from '../deploy/hostkeys'
import type { DeployStore } from '../deploy/deploy-store'
import type { EnvironmentStore } from '../inventory/environment-store'
import type { KnownHostStore } from '../ssh/known-hosts'
import { uuidv7 } from '../deploy/uuidv7'
import { HubError } from './client'

const ADMIN_ENVIRONMENTS = '/api/v1/admin/environments'
const ADMIN_SECRETS = '/api/v1/admin/secrets'

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

interface SecretUse {
  secretId: string
  name: string
  usedBy: string[]
  kind: 'env' | 'become'
}

/** The vault secrets an environment's deployments refer to (`${secret:id}` and become), by id. */
function secretUsage(environmentId: string, deps: Pick<ManifestDeps, 'deploys' | 'secrets'>): SecretUse[] {
  const names = new Map(deps.secrets.list().map((s) => [s.id, s.name]))
  const used = new Map<string, { by: Set<string>; become: boolean }>()
  for (const d of deps.deploys.list(environmentId)) {
    const refs: [string, boolean][] = [
      ...(d.envTemplate ? parseEnvTemplate(d.envTemplate).secretIds : []).map((id): [string, boolean] => [id, false]),
      ...(d.becomeSecretId ? [[d.becomeSecretId, true] as [string, boolean]] : []),
    ]
    for (const [id, become] of refs) {
      if (!names.has(id)) throw new Error(`A secret used by "${d.name}" no longer exists`)
      const u = used.get(id) ?? { by: new Set<string>(), become: false }
      u.by.add(d.name)
      u.become ||= become
      used.set(id, u)
    }
  }
  return [...used].map(([secretId, u]) => ({ secretId, name: names.get(secretId) as string, usedBy: [...u.by].sort(), kind: u.become ? 'become' : 'env' }))
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
    requiredSecrets: secretUsage(environmentId, deps).map(({ secretId, name, usedBy }) => ({ secretId, name, usedBy })),
  }
}

export interface PublisherDeps extends ManifestDeps {
  audit: { append(input: AuditInput): unknown }
  vault: { assertUnlocked(): void }
  client: () => { put<T>(path: string, body?: unknown): Promise<T>; del(path: string): Promise<void>; get?<T>(path: string, query?: Record<string, string>): Promise<T> }
  /** Vault values, read in main only. They go to the Hub and nowhere else. */
  values?: { value(id: string): string }
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

  /**
   * Sends the environment's vault secrets to the Hub: the ones it is missing, or `ids`. Values are read here in main,
   * one at a time; they are never returned, audited or logged.
   */
  async uploadSecrets(environmentId: string, ids?: string[]): Promise<{ uploaded: number }> {
    const d = this.d
    d.vault.assertUnlocked()
    if (!d.values || !d.client().get) throw new Error('Secret upload is not available')
    const required = secretUsage(environmentId, d)
    const byId = new Map(required.map((r) => [r.secretId, r]))
    let wanted: string[]
    if (ids) {
      for (const id of ids) if (!byId.has(id)) throw new Error('A selected secret is not used by this environment')
      wanted = [...new Set(ids)]
    } else {
      const list = await d.client().get!<HubSecretList>(ADMIN_SECRETS, { environmentId })
      wanted = (list.missing[environmentId] ?? []).map((m) => m.secretId).filter((id) => byId.has(id))
    }
    let uploaded = 0
    for (const id of wanted) {
      const use = byId.get(id) as SecretUse
      await d.client().put(`${ADMIN_SECRETS}/${id}`, { environmentId, name: use.name, kind: use.kind, value: d.values.value(id) })
      uploaded += 1
      d.audit.append({
        action: 'hub.secret.set',
        outcome: 'success',
        targetType: 'secret',
        targetId: id,
        targetLabel: use.name,
        details: { name: use.name, environmentId },
      })
    }
    return { uploaded }
  }

  /** Sets a Hub integration secret (Teams webhook, SendGrid, GitHub, Anthropic) from a local vault secret. */
  async setIntegrationSecret(environmentId: string | null, kind: HubSecretKind, secretId: string): Promise<void> {
    const d = this.d
    d.vault.assertUnlocked()
    if (!d.values) throw new Error('Secret upload is not available')
    const name = d.secrets.list().find((s) => s.id === secretId)?.name
    if (!name) throw new Error('That secret no longer exists')
    await d.client().put(`${ADMIN_SECRETS}/${uuidv7()}`, { environmentId, name: kind, kind, value: d.values.value(secretId) })
    d.audit.append({
      action: 'hub.secret.set',
      outcome: 'success',
      targetType: 'secret',
      targetId: secretId,
      targetLabel: name,
      details: { name: kind, environmentId },
    })
  }
}
