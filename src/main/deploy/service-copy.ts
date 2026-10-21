import type { CopyServicesRequest, CopyServicesResult, ServiceMeta } from '../../shared/services'
import { stripSecretRefs } from '../../shared/services'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { DeployStore } from './deploy-store'
import type { ServiceStore } from './service-store'

export interface CopyDeps {
  db: Db
  deploys: DeployStore
  services: ServiceStore
  audit: AuditLog
  vault: { assertUnlocked(): void }
}

const CHECKOUT_EXISTS = 'a checkout with that name already exists'
const CHECKOUT_SKIPPED = 'its checkout was skipped'
const SERVICE_EXISTS = 'a service with that name already exists'

const envName = (db: Db, id: string): string | null =>
  (db.prepare('SELECT name FROM environments WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null

const members = (db: Db, environmentId: string): Set<string> =>
  new Set((db.prepare('SELECT host_id FROM environment_hosts WHERE environment_id = ?').all(environmentId) as { host_id: string }[]).map((r) => r.host_id))

/**
 * Copies an environment's checkouts and services into another one (spec §8.5), in one transaction with one
 * `services.copy` audit and no per-row audits. Name conflicts are skipped and listed. Secrets, vault links, URLs,
 * backups, tunnels and deploy history are not copied; nothing runs, so a protected target needs no confirmation.
 */
export function copyServices(deps: CopyDeps, req: CopyServicesRequest): CopyServicesResult {
  const { db, deploys, services, audit } = deps
  deps.vault.assertUnlocked()
  if (req.sourceEnvironmentId === req.targetEnvironmentId) throw new Error('the target must be another environment')
  const sourceName = envName(db, req.sourceEnvironmentId)
  const targetName = envName(db, req.targetEnvironmentId)
  if (sourceName === null || targetName === null) throw new Error('environment not found')

  const result = inTransaction(db, () => {
    const checkouts = new Map(deploys.list(req.sourceEnvironmentId).map((d) => [d.id, d]))
    const sourceServices = services.list(req.sourceEnvironmentId)
    const wanted = new Map<string, CopyServicesRequest['checkouts'][number]>()
    for (const c of req.checkouts) {
      if (!checkouts.has(c.deploymentId)) throw new Error('a checkout in the copy is not in the source environment')
      if (wanted.has(c.deploymentId)) throw new Error('a source checkout is listed twice')
      wanted.set(c.deploymentId, c)
    }
    const dbRows = new Map(req.dbs.map((d) => [d.serviceId, d]))
    for (const s of sourceServices) {
      if (s.kind === 'service' && s.deploymentId !== null && !wanted.has(s.deploymentId)) {
        throw new Error('every source checkout that has services must be in the copy')
      }
    }
    const sourceDbs = sourceServices.filter((s) => s.kind === 'db')
    if (dbRows.size !== req.dbs.length || dbRows.size !== sourceDbs.length || !sourceDbs.every((s) => dbRows.has(s.id))) {
      throw new Error('every source db service must be in the copy')
    }

    const hostsBefore = members(db, req.targetEnvironmentId)
    const takenCheckouts = new Set(deploys.list(req.targetEnvironmentId).map((d) => d.name.toLowerCase()))
    const takenServices = new Set(services.list(req.targetEnvironmentId).map((s) => s.name.toLowerCase()))
    const skipped: CopyServicesResult['skipped'] = []
    const newCheckout = new Map<string, string>()

    // Source position order, so the copy lists the same way.
    for (const d of [...wanted.keys()].map((id) => checkouts.get(id)!).sort((a, b) => a.position - b.position)) {
      if (takenCheckouts.has(d.name.toLowerCase())) {
        skipped.push({ kind: 'checkout', name: d.name, reason: CHECKOUT_EXISTS })
        continue
      }
      const row = wanted.get(d.id)!
      const id = deploys.insertInTx({
        name: d.name,
        environmentId: req.targetEnvironmentId,
        hostId: row.hostId,
        repoUrl: d.repoUrl,
        composeProject: d.composeProject,
        repoPath: row.repoPath,
        defaultBranch: row.branch,
        composeFile: d.composeFile,
        deployTag: row.deployTag,
        position: d.position,
        healthStatus: d.healthStatus,
        healthTimeoutSec: d.healthTimeoutSec,
        preHook: d.preHook,
        postHook: d.postHook,
        buildTimeoutSec: d.buildTimeoutSec,
        composeTimeoutSec: d.composeTimeoutSec,
        useSudo: d.useSudo,
        managedEnv: false,
        envTemplate: d.envTemplate === null ? null : stripSecretRefs(d.envTemplate),
      }, d.repoUrl)
      newCheckout.set(d.id, id)
      takenCheckouts.add(d.name.toLowerCase())
    }

    let created = 0
    for (const s of sourceServices) {
      const skip = (reason: string): void => void skipped.push({ kind: 'service', name: s.name, reason })
      if (s.kind === 'service' && s.deploymentId !== null && !newCheckout.has(s.deploymentId)) {
        skip(CHECKOUT_SKIPPED)
        continue
      }
      if (takenServices.has(s.name.toLowerCase())) {
        skip(SERVICE_EXISTS)
        continue
      }
      services.insertInTx(copyOf(s, req.targetEnvironmentId, newCheckout, dbRows), s.position)
      takenServices.add(s.name.toLowerCase())
      created++
    }

    const hostsAfter = members(db, req.targetEnvironmentId)
    const addedHosts = [...hostsAfter].filter((h) => !hostsBefore.has(h)).length
    return { created: { services: created, checkouts: newCheckout.size }, skipped, addedHosts }
  })

  audit.append({
    action: 'services.copy',
    outcome: 'success',
    targetType: 'environment',
    targetId: req.targetEnvironmentId,
    targetLabel: targetName,
    details: {
      sourceEnvironment: sourceName,
      targetEnvironment: targetName,
      serviceCount: result.created.services,
      checkoutCount: result.created.checkouts,
      hostCount: result.addedHosts,
    },
  })
  services.onChanged?.(req.targetEnvironmentId)
  return result
}

/** Names, kinds, compose services, URL check origins, engines and descriptions carry over; URLs, history and tunnels do not. */
function copyOf(
  s: ServiceMeta,
  environmentId: string,
  newCheckout: Map<string, string>,
  dbRows: Map<string, CopyServicesRequest['dbs'][number]>,
): Parameters<ServiceStore['insertInTx']>[0] {
  if (s.kind === 'service') {
    return {
      kind: 'service',
      environmentId,
      name: s.name,
      description: s.description,
      deploymentId: s.deploymentId === null ? null : newCheckout.get(s.deploymentId)!,
      composeService: s.composeService,
      urlCheckFrom: s.urlCheckFrom,
    }
  }
  const row = dbRows.get(s.id)!
  return {
    kind: 'db',
    environmentId,
    name: s.name,
    description: s.description,
    dbEngine: s.dbEngine,
    dbAddress: row.dbAddress,
    dbPort: row.dbPort,
    viaHostId: row.viaHostId,
  }
}
