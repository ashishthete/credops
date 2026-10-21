import type { AuditInput } from '../../../src/shared/audit'
import type { Actor, DeploymentMeta, EnvDeploySettings, EnvDeploySettingsPatch } from '../../../src/shared/deploy'
import { HUB_AUDIT_ACTIONS, type HubAction, type HubAuditAction, type HubDecision } from '../../../src/shared/hub'
import type { ResolvedHost } from '../../../src/shared/inventory'
import type { AppServiceMeta, ServiceMeta } from '../../../src/shared/services'
import type { DeployAccess, DeployAction } from '../../../src/main/deploy/access'
import type { DeployStore } from '../../../src/main/deploy/deploy-store'
import type { ReleaseInventory } from '../../../src/main/deploy/release-service'
import type { ServiceStore } from '../../../src/main/deploy/service-store'
import { HostKeyError } from '../../../src/main/ssh/connect'
import { fingerprintOf, hostToken, parseKnownHosts } from '../../../src/main/ssh/known-hosts'
import type { HostKeyCheck } from '../../../src/main/ssh/prompts'
import type { Directory } from '../access/directory'
import { decide } from '../access/policy'
import type { HubAudit } from '../audit'
import { PUBLISHED, type HubDb } from '../db'
import { HubHttpError } from '../errors'
import type { Registry } from '../registry'
import type { DeployKeys } from '../secrets/deploykeys'
import type { SecretStore } from '../secrets/store'

/* The seams ReleaseService needs, answered from the Hub's registry, secrets and directory. Nothing here reads a
   desktop vault: the Hub has no vault, so `assertUnlocked` is a no-op and identities are the environment deploy key. */

const envOfDeployment = (db: HubDb, id: string): string | null =>
  (db.prepare('SELECT environment_id FROM deployments WHERE id = ?').get(id) as { environment_id: string } | undefined)?.environment_id ?? null

const stamp = (db: HubDb, environmentId: string): string =>
  (db.prepare('SELECT published_at FROM environments WHERE id = ?').get(environmentId) as { published_at: string } | undefined)?.published_at ?? ''

export function hubDeploys(db: HubDb, registry: Registry): Pick<DeployStore, 'get' | 'list' | 'settings' | 'updateSettings'> {
  const metas = (environmentId: string): DeploymentMeta[] => {
    const at = stamp(db, environmentId)
    return registry.get(environmentId).deployments.map((d) => ({ ...d, vaultIds: [], createdAt: at, updatedAt: at }))
  }
  const settings = (environmentId: string): EnvDeploySettings => {
    const row = db.prepare('SELECT versioned, auto_rollback, current_version FROM environments WHERE id = ?').get(environmentId) as
      | { versioned: number; auto_rollback: number; current_version: string | null }
      | undefined
    if (!row) throw new Error('environment not found')
    return { environmentId, versioned: row.versioned === 1, autoRollback: row.auto_rollback === 1, currentVersion: row.current_version }
  }
  return {
    get: (id) => {
      const environmentId = envOfDeployment(db, id)
      const found = environmentId === null ? undefined : metas(environmentId).find((d) => d.id === id)
      if (!found) throw new Error('deployment not found')
      return found
    },
    list: (environmentId) => {
      if (environmentId !== undefined) return registry.exists(environmentId) ? metas(environmentId) : []
      const ids = db.prepare(`SELECT id FROM environments WHERE ${PUBLISHED}`).all() as { id: string }[]
      return ids.flatMap((e) => metas(e.id))
    },
    settings,
    updateSettings: (environmentId, patch: EnvDeploySettingsPatch) => {
      const before = settings(environmentId)
      const next = {
        versioned: patch.versioned ?? before.versioned,
        autoRollback: patch.autoRollback ?? before.autoRollback,
        currentVersion: patch.currentVersion === undefined ? before.currentVersion : patch.currentVersion,
      }
      db.prepare('UPDATE environments SET versioned = ?, auto_rollback = ?, current_version = ? WHERE id = ?').run(
        next.versioned ? 1 : 0,
        next.autoRollback ? 1 : 0,
        next.currentVersion,
        environmentId,
      )
      return settings(environmentId)
    },
  }
}

export function hubServices(db: HubDb, registry: Registry): Pick<ServiceStore, 'list' | 'recordDeployed'> {
  const state = (environmentId: string): Map<string, { commit: string | null; releaseId: string | null }> =>
    new Map(
      (db.prepare('SELECT service_id, last_deployed_commit, last_release_id FROM service_deploy_state WHERE environment_id = ?').all(environmentId) as {
        service_id: string
        last_deployed_commit: string | null
        last_release_id: string | null
      }[]).map((r) => [r.service_id, { commit: r.last_deployed_commit, releaseId: r.last_release_id }]),
    )
  const listOf = (environmentId: string): ServiceMeta[] => {
    const at = stamp(db, environmentId)
    const last = state(environmentId)
    return registry.get(environmentId).services.map((s, position): ServiceMeta => {
      const base = { id: s.id, environmentId, name: s.name, position, description: '', createdAt: at, updatedAt: at }
      if (s.kind === 'service') {
        const l = last.get(s.id)
        const app: AppServiceMeta = {
          ...base,
          kind: 'service',
          deploymentId: s.deploymentId,
          composeService: s.composeService as string,
          url: null,
          urlCheckFrom: 'host',
          lastDeployedCommit: l?.commit ?? null,
          lastReleaseId: l?.releaseId ?? null,
        }
        return app
      }
      return { ...base, kind: 'db', dbEngine: 'other', dbAddress: '', dbPort: 0, viaHostId: s.viaHostId, localPort: null, tunnelId: null }
    })
  }
  return {
    list: (environmentId) => {
      if (environmentId !== undefined) return registry.exists(environmentId) ? listOf(environmentId) : []
      return (db.prepare(`SELECT id FROM environments WHERE ${PUBLISHED} ORDER BY name COLLATE NOCASE`).all() as { id: string }[]).flatMap((e) => listOf(e.id))
    },
    recordDeployed: (entries) => {
      const envOf = db.prepare("SELECT environment_id FROM services WHERE id = ? AND kind = 'service'")
      const put = db.prepare(
        `INSERT INTO service_deploy_state(service_id, environment_id, last_deployed_commit, last_release_id) VALUES (?,?,?,?)
         ON CONFLICT(service_id) DO UPDATE SET last_deployed_commit = excluded.last_deployed_commit, last_release_id = excluded.last_release_id`,
      )
      for (const e of entries) {
        const row = envOf.get(e.serviceId) as { environment_id: string } | undefined
        if (row) put.run(e.serviceId, row.environment_id, e.commit, e.releaseId)
      }
    },
  }
}

/** Environments and hosts from the registry. A Hub host row belongs to exactly one environment and no product. */
export function hubInventory(db: HubDb, registry: Registry): ReleaseInventory {
  return {
    environment: (id) => {
      const name = registry.nameOf(id)
      if (name === null) throw new Error('environment not found')
      const row = db.prepare('SELECT protected FROM environments WHERE id = ?').get(id) as { protected: number }
      return { id, name, protected: row.protected === 1, productIds: [] }
    },
    hostLabel: (hostId, environmentId) => {
      const row = db.prepare('SELECT label FROM hosts WHERE id = ? AND environment_id = ?').get(hostId, environmentId) as { label: string } | undefined
      if (!row) throw new Error('host not found')
      return row.label
    },
    productName: () => 'Hub',
    environmentsOfHosts: () => [],
  }
}

/** Phase 8's deploy.edit (discard) is a release-start decision on the Hub; the admin-only actions keep their meaning. */
const ACTION: Record<DeployAction, HubAction> = {
  'deploy.view': 'deploy.view',
  'deploy.edit': 'release.start',
  'release.start': 'release.start',
  'release.rollback': 'release.rollback',
  'release.cancel': 'release.cancel',
  'lock.break': 'lock.break',
}

/** The group a decision went through, as the audit trail names it. */
export function viaGroupOf(d: HubDecision): string | null {
  if (!d.allowed) return null
  if (d.via.groupName !== null) return d.via.groupName
  return d.via.role === 'admin' ? 'admin' : null
}

export class HubDeployAccess implements DeployAccess {
  /** `<oid>:<environmentId>` to the group of the latest allowed decision, for the audit rows that follow. */
  private readonly via = new Map<string, string | null>()

  constructor(private readonly deps: { directory: Pick<Directory, 'get' | 'listGroups'> }) {}

  async check(actor: Actor, action: DeployAction, target: { environmentId: string; deploymentIds?: string[] }): Promise<{ allowed: boolean; reason?: string }> {
    const user = actor.hubUserId ? this.deps.directory.get(actor.hubUserId) : null
    if (!user) return { allowed: false, reason: 'You are not signed in to this Hub' }
    const d = decide(user, this.deps.directory.listGroups(), ACTION[action], target)
    if (!d.allowed) return { allowed: false, reason: d.reason }
    this.via.set(`${user.oid}:${target.environmentId}`, viaGroupOf(d))
    return { allowed: true }
  }

  viaFor(oid: string, environmentId: string): string | null {
    return this.via.get(`${oid}:${environmentId}`) ?? null
  }
}

const AUDIT_ACTIONS: ReadonlySet<string> = new Set(HUB_AUDIT_ACTIONS)

/** ReleaseService's audit rows into the Hub's hash-chained audit, attributed to the signed-in person. */
export function hubAudit(deps: { audit: Pick<HubAudit, 'append'>; directory: Pick<Directory, 'get'>; access: HubDeployAccess; envOfTarget: (type: string | undefined, id: string | undefined) => string | null }): {
  append(input: AuditInput & { actor: Actor }): unknown
} {
  return {
    append: (input) => {
      if (!AUDIT_ACTIONS.has(input.action)) throw new Error(`unknown audit action ${input.action}`)
      const oid = input.actor.hubUserId
      const user = oid ? deps.directory.get(oid) : null
      const envId = deps.envOfTarget(input.targetType, input.targetId)
      return deps.audit.append({
        action: input.action as HubAuditAction,
        outcome: input.outcome,
        actor: oid
          ? { oid, upn: user?.upn ?? input.actor.osUser, name: user?.name ?? input.actor.osUser, role: user?.role ?? null }
          : null,
        viaGroup: oid && envId ? deps.access.viaFor(oid, envId) : null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        details: input.details ?? {},
      })
    },
  }
}

/** Environment secrets by the vault ids the manifest names. A missing one names only its secret name. */
export function hubSecrets(deps: { secrets: Pick<SecretStore, 'resolveForRun'>; registry: Pick<Registry, 'get'> }): { value(id: string, environmentId?: string): string } {
  return {
    value: (id, environmentId) => {
      if (environmentId === undefined) throw new HubHttpError(409, 'conflict', 'This release has no environment')
      const v = deps.secrets.resolveForRun(environmentId, [id]).get(id)
      if (v !== undefined) return v
      const name = deps.registry.get(environmentId).requiredSecrets.find((s) => s.secretId === id)?.name ?? 'a required secret'
      throw new HubHttpError(409, 'conflict', `Secret "${name}" isn't set on the Hub. Ask a Hub admin to upload it.`)
    },
  }
}

/** Every hop dials with the environment's deploy key; the chain comes from the published manifest. */
export function hubResolve(deps: { db: HubDb; registry: Pick<Registry, 'get'> }): (hostId: string, environmentId?: string) => ResolvedHost {
  return (hostId, environmentId) => {
    // A shared host has a row per environment; without the environment, only a host published once is unambiguous.
    const rows = deps.db.prepare('SELECT environment_id FROM hosts WHERE id = ?').all(hostId) as { environment_id: string }[]
    const env = environmentId ?? (rows.length === 1 ? rows[0].environment_id : undefined)
    if (env === undefined || !rows.some((r) => r.environment_id === env)) throw new Error('host not found')
    const host = deps.registry.get(env).hosts.find((h) => h.id === hostId)
    if (!host) throw new Error('host not found')
    const identity = (username: string): ResolvedHost['identity'] => ({ source: 'environment', identityId: env, label: 'Deploy key', username, auth: 'key', vaultId: '' })
    const hops = host.hops.slice(0, -1)
    return {
      hostId,
      environmentId: env,
      address: host.address,
      addressSource: 'host',
      port: { value: host.port, source: 'host' },
      identity: identity(host.username),
      jump: { hostId: hops.length ? hops[hops.length - 1].hostId : null, source: hops.length ? 'host' : null },
      chain: hops.map((h) => ({ hostId: h.hostId as string, label: h.label, address: h.address, port: h.port, addressSource: 'host', identity: identity(h.username) })),
      conflicts: [],
    }
  }
}

/** The deploy key as the identity store would hand it out; the PEM is remembered for redaction while a run holds it. */
export function hubIdentities(deps: { deployKeys: Pick<DeployKeys, 'privateForRun'>; loaded: Map<string, string> }): {
  resolve(id: string): Promise<{ username: string; auth: 'key'; privateKey: string }>
} {
  return {
    resolve: async (environmentId) => {
      const privateKey = deps.deployKeys.privateForRun(environmentId)
      deps.loaded.set(environmentId, privateKey)
      return { username: '', auth: 'key', privateKey }
    },
  }
}

/**
 * Trust only the host keys published with the environment. There is no trust-on-first-use and no prompt: a key
 * that is not in the manifest, or differs from it, ends the attempt.
 */
export function hubVerify(deps: { db: HubDb; registry: Pick<Registry, 'get'> }): (_knownHosts: unknown, _prompts: unknown, c: HostKeyCheck) => Promise<boolean> {
  return async (_k, _p, c) => {
    const env = (deps.db.prepare('SELECT environment_id FROM releases WHERE id = ?').get(c.ownerId) as { environment_id: string } | undefined)?.environment_id
    const lines = env ? deps.registry.get(env).hosts.flatMap((h) => h.knownHosts) : []
    const parsed = parseKnownHosts(lines.join('\n'))
    const token = hostToken(c.hop.address, c.hop.port)
    const mine = parsed.filter((l) => l.matches(token))
    const info = (): ConstructorParameters<typeof HostKeyError>[1] => ({
      host: token,
      keyType: c.keyType,
      fingerprint: fingerprintOf(c.keyBase64),
      known: mine.map((l) => ({ keyType: l.keyType, fingerprint: fingerprintOf(l.key), source: 'app' as const })),
    })
    if (mine.some((l) => l.marker === 'revoked' && l.key === c.keyBase64)) throw new HostKeyError('host-key-revoked', info())
    if (mine.some((l) => l.marker === null && l.keyType === c.keyType && l.key === c.keyBase64)) return true
    throw new HostKeyError(mine.length > 0 ? 'host-key-changed' : 'host-key-rejected', info())
  }
}
