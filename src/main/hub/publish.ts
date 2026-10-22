import type { AuditInput } from '../../shared/audit'
import { parseEnvTemplate, type DeploymentMeta } from '../../shared/deploy'
import {
  EMPTY_HUB_INTEGRATIONS,
  type HubEnvManifest,
  type HubHop,
  type HubIntegrations,
  type HubMeta,
  type HubPublishResult,
  type HubSecretKind,
  type HubSecretList,
} from '../../shared/hub'
import { hasRepoCredentials, type ResolvedHost } from '../../shared/inventory'
import type { Runbook } from '../../shared/runbooks'
import type { EnvironmentIntegrations } from '../../shared/settings'
import { effectiveSteps, POST_HOOK_STEP_ID, PRE_HOOK_STEP_ID, type Step } from '../../shared/steps'
import type { SecretMeta } from '../../shared/vault'
import type { Db } from '../db/connection'
import { passwordMessage } from '../deploy/hostkeys'
import type { DeployStore } from '../deploy/deploy-store'
import type { RunbookStore } from '../deploy/runbook-store'
import type { ServiceStore } from '../deploy/service-store'
import type { EnvironmentStore } from '../inventory/environment-store'
import type { KnownHostStore } from '../ssh/known-hosts'
import { uuidv7 } from '../deploy/uuidv7'
import { HubError } from './client'
import { redact } from '../security/redact'

const ADMIN_ENVIRONMENTS = '/api/v1/admin/environments'
const ADMIN_SECRETS = '/api/v1/admin/secrets'
const META = '/api/v1/meta'

/** Said when an environment uses steps, a flow or runbooks and the Hub only reads schema 1. */
export const HUB_TOO_OLD_MESSAGE = 'This Hub is too old for custom steps, release flow or runbooks; update the Hub first'

export interface ManifestDeps {
  db: Db
  envs: Pick<EnvironmentStore, 'get'>
  deploys: Pick<DeployStore, 'list' | 'settings'>
  services: Pick<ServiceStore, 'list'>
  knownHosts: Pick<KnownHostStore, 'pinned'>
  secrets: { list(): SecretMeta[] }
  resolve: (hostId: string, environmentId: string) => ResolvedHost
  /** Phase 9 settings for the environment; defaults to none. */
  integrations?: (environmentId: string) => HubIntegrations
  /** The environment's runbooks; absent means none. */
  runbooks?: Pick<RunbookStore, 'list'>
}

interface SecretUse {
  secretId: string
  name: string
  usedBy: string[]
  kind: 'env' | 'become'
}

/** The vault secrets an environment's deployments, steps, flow and runbooks refer to (`${secret:id}`, become, step secrets), by id. */
function secretUsage(environmentId: string, deps: Pick<ManifestDeps, 'deploys' | 'secrets' | 'runbooks'>): SecretUse[] {
  const names = new Map(deps.secrets.list().map((s) => [s.id, s.name]))
  const used = new Map<string, { by: Set<string>; become: boolean }>()
  const add = (id: string, by: string, become: boolean): void => {
    if (!names.has(id)) throw new Error(`A secret used by "${by}" no longer exists`)
    const u = used.get(id) ?? { by: new Set<string>(), become: false }
    u.by.add(by)
    u.become ||= become
    used.set(id, u)
  }
  for (const d of deps.deploys.list(environmentId)) {
    for (const id of d.envTemplate ? parseEnvTemplate(d.envTemplate).secretIds : []) add(id, d.name, false)
    if (d.becomeSecretId) add(d.becomeSecretId, d.name, true)
    for (const st of d.steps) for (const sec of st.secrets) add(sec.secretId, d.name, false)
  }
  for (const st of deps.deploys.settings(environmentId).flow?.stages ?? []) {
    if (st.kind === 'step') for (const sec of st.step.secrets) add(sec.secretId, 'release flow', false)
  }
  for (const r of deps.runbooks?.list(environmentId) ?? []) {
    for (const item of r.items) if (item.type === 'step') for (const sec of item.step.secrets) add(sec.secretId, r.name, false)
  }
  return [...used].map(([secretId, u]) => ({ secretId, name: names.get(secretId) as string, usedBy: [...u.by].sort(), kind: u.become ? 'become' : 'env' }))
}

/** What a Hub run needs of an environment's Phase 9 settings: never the Teams webhook secret id (the Hub keeps its own) or timestamps. */
export function toHubIntegrations(i: EnvironmentIntegrations): HubIntegrations {
  return { notifyEvents: [...i.notifyEvents], emailTo: [...i.emailTo], emailCc: [...i.emailCc], qaOnDeploy: i.qaOnDeploy,
    // waitMinutes only when set: a manifest without it hashes exactly as before
    qa: i.qa === null ? null : { repo: i.qa.repo, workflow: i.qa.workflow, ref: i.qa.ref, ...(i.qa.waitMinutes !== undefined ? { waitMinutes: i.qa.waitMinutes } : {}) }, qaWait: i.qaWait }
}

/** Everything a Hub needs to run the environment's deployments, and no secret value: only secret ids and names. */
export async function buildManifest(environmentId: string, deps: ManifestDeps, o: { hubSchema: 1 | 2 } = { hubSchema: 1 }): Promise<HubEnvManifest> {
  const v2 = o.hubSchema === 2
  const env = deps.envs.get(environmentId)
  const settings = deps.deploys.settings(environmentId)
  const deployments = deps.deploys.list(environmentId)
  const runbooks = deps.runbooks?.list(environmentId) ?? []
  // A Hub that reads schema 1 has hooks and nothing else: anything newer is refused here, before a byte is sent.
  if (!v2 && (settings.flow !== null || runbooks.length > 0)) throw new Error(HUB_TOO_OLD_MESSAGE)
  // A URL with credentials is never published, and its text is never echoed: the error names the checkout only.
  for (const d of deployments) {
    if (d.repoUrl && hasRepoCredentials(d.repoUrl)) {
      throw new Error(`Checkout "${d.name}" has a repository URL with embedded credentials; remove them (use a deploy key) and publish again`)
    }
  }
  const hostOf = new Map(deployments.map((d) => [d.id, d.hostId]))
  const labelOf = deps.db.prepare('SELECT label FROM hosts WHERE id = ?')
  const regionOf = deps.db.prepare('SELECT r.code, r.display_name AS displayName FROM hosts h JOIN regions r ON r.id = h.region_id WHERE h.id = ?')
  const product = deps.db.prepare('SELECT id, name FROM products WHERE id = ?').get(env.productId) as { id: string; name: string }

  const services = deps.services.list(environmentId)
  // A db's via-host is published too, so the Hub can reach it even when no checkout runs there.
  const hostIds = [...new Set([...deployments.map((d) => d.hostId), ...services.flatMap((s) => (s.kind === 'db' && s.viaHostId ? [s.viaHostId] : []))])]
  const hosts: HubEnvManifest['hosts'] = []
  for (const hostId of hostIds) {
    const label = (labelOf.get(hostId) as { label: string } | undefined)?.label ?? 'host'
    const region = regionOf.get(hostId) as { code: string; displayName: string } | undefined
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
      ...(region ? { region: { code: region.code, displayName: region.displayName } } : {}),
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
      ...(v2 ? { parallelPrepare: settings.parallelPrepare, prepareCap: settings.prepareCap, ...(settings.flow ? { flow: settings.flow } : {}) } : {}),
      product: { id: product.id, name: product.name },
    },
    hosts,
    services: services.map((s): HubEnvManifest['services'][number] =>
      s.kind === 'service'
        ? { id: s.id, name: s.name, kind: 'service', composeService: s.composeService, deploymentId: s.deploymentId, hostId: s.deploymentId ? (hostOf.get(s.deploymentId) ?? null) : null, viaHostId: null, ...(v2 ? { skipUnchanged: s.skipUnchanged } : {}) }
        : { id: s.id, name: s.name, kind: 'db', composeService: null, deploymentId: null, hostId: null, viaHostId: s.viaHostId },
    ),
    deployments: deployments.map((d) => manifestDeployment(d, o.hubSchema)),
    integrations: deps.integrations?.(environmentId) ?? EMPTY_HUB_INTEGRATIONS,
    requiredSecrets: secretUsage(environmentId, deps).map(({ secretId, name, usedBy }) => ({ secretId, name, usedBy })),
    ...(v2 ? { schema: 2 as const } : {}),
    ...(v2 && runbooks.length > 0 ? { runbooks: runbooks.map(toManifestRunbook) } : {}),
  }
}

function toManifestRunbook({ environmentId: _e, createdAt: _c, updatedAt: _u, ...r }: Runbook): NonNullable<HubEnvManifest['runbooks']>[number] {
  return r
}

/** Schema 2 carries the steps (hooks become steps); schema 1 carries hooks only, so a Hub that cannot read steps still gets them. */
function manifestDeployment(d: DeploymentMeta, hubSchema: 1 | 2): HubEnvManifest['deployments'][number] {
  const { vaultIds: _v, createdAt: _c, updatedAt: _u, steps: _s, ...rest } = d
  const steps = effectiveSteps(d)
  if (hubSchema === 2) return steps.length > 0 ? { ...rest, preHook: null, postHook: null, steps } : rest
  let preHook: string | null = null
  let postHook: string | null = null
  for (const st of steps) {
    // Only a step that is exactly a migrated hook goes back out as one.
    const asPre = st.id === PRE_HOOK_STEP_ID && sameStep(st, effectiveSteps({ steps: [], preHook: st.script, postHook: null })[0])
    const asPost = st.id === POST_HOOK_STEP_ID && sameStep(st, effectiveSteps({ steps: [], preHook: null, postHook: st.script })[0])
    if (asPre) preHook = st.script
    else if (asPost) postHook = st.script
    else throw new Error(HUB_TOO_OLD_MESSAGE)
  }
  return { ...rest, preHook, postHook }
}

const sameStep = (a: Step, b: Step | undefined): boolean => b !== undefined && JSON.stringify(a) === JSON.stringify(b)

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
    const manifest = await buildManifest(environmentId, d, { hubSchema: await this.hubSchema() })
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

  /** What the Hub reads, from its `/meta`. A Hub that cannot be asked, or says nothing, counts as schema 1. */
  private async hubSchema(): Promise<1 | 2> {
    const client = this.d.client()
    if (!client.get) return 1
    try {
      const meta = await client.get<Partial<HubMeta>>(META)
      return meta.capabilities?.manifestSchema === 2 ? 2 : 1
    } catch (err) {
      // An older Hub may not serve capabilities at all; a Hub that is down fails the publish itself next.
      if (err instanceof HubError && err.code === 'not_found') return 1
      throw err
    }
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
  /**
   * PUTs one vault value. The value is read here and is redacted from any error for the duration of the call,
   * whether or not the connection's own known-secrets list still holds it (the vault may lock mid-call).
   */
  private async send(path: string, body: { environmentId: string | null; name: string; kind: HubSecretKind }, secretId: string): Promise<void> {
    const value = (this.d.values as { value(id: string): string }).value(secretId)
    try {
      await this.d.client().put(path, { ...body, value })
    } catch (err) {
      if (err instanceof HubError) throw new HubError(err.code, redact(err.message, [value]), err.status)
      throw new Error(redact(err instanceof Error ? err.message : String(err), [value]))
    }
  }

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
      await this.send(`${ADMIN_SECRETS}/${id}`, { environmentId, name: use.name, kind: use.kind }, id)
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
    await this.send(`${ADMIN_SECRETS}/${uuidv7()}`, { environmentId, name: kind, kind }, secretId)
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
