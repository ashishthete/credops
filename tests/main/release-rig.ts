import { localAllowAll, type DeployAccess } from '../../src/main/deploy/access'
import { noopFinalize, type FinalizeSteps } from '../../src/main/deploy/finalize'
import { ReleaseService, type ReleaseServiceDeps } from '../../src/main/deploy/release-service'
import { resolveHost } from '../../src/main/inventory/resolve'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_RELEASE_OPTIONS, type DeploymentMeta, type RunEvent } from '../../src/shared/deploy'
import type { AppServiceMeta } from '../../src/shared/services'
import { makeDeployFixture, type DeployFixture } from './deploy-helpers'
import { A, FakeRunner } from './fake-runner'

export { A, FakeRunner }
export type { Emit, Handler } from './fake-runner'

/** The Phase 8a release rig: a real ReleaseService over the deploy fixture with a scripted DeployRunner. */
export const B = 'b'.repeat(40)
export const C = 'c'.repeat(40)
export const NOW = Date.parse('2026-10-19T12:00:00Z')
export const SECRET = 'sekret-value-1'

export interface Rig {
  f: DeployFixture
  svc: ReleaseService
  runner: FakeRunner
  batches: RunEvent[][]
  states: string[]
  timers: (() => void)[]
  tick(): void
  valueCalls: string[]
  /** While set, decrypting a secret fails (a deleted secret, a locked vault). */
  failValue: { on: boolean }
  setup: { access: DeployAccess; finalize: FinalizeSteps }
}

export async function rig(
  over: { access?: DeployAccess; finalize?: FinalizeSteps; maxEvents?: number; audit?: ReleaseServiceDeps['audit']; now?: () => Date } = {},
): Promise<Rig> {
  const f = await makeDeployFixture({ maxEvents: over.maxEvents })
  // The fixture shares app1 with protected prod; most tests want an unprotected staging, so unshare it here.
  f.db.prepare('DELETE FROM environment_hosts WHERE environment_id = ?').run(f.prod.id)
  const runner = new FakeRunner()
  const clipboard = { async writeText(): Promise<void> {}, async readText(): Promise<string> { return '' } }
  const store = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const valueCalls: string[] = []
  const failValue = { on: false }
  const batches: RunEvent[][] = []
  const states: string[] = []
  const timers: (() => void)[] = []
  const setup = { access: over.access ?? localAllowAll, finalize: over.finalize ?? noopFinalize }
  const svc = new ReleaseService({
    db: f.db,
    deploys: f.deploys,
    services: f.services,
    releases: f.releases,
    runner,
    access: setup.access,
    finalize: setup.finalize,
    audit: over.audit ?? f.audit,
    vault: f.vault,
    resolve: (hostId, envId) => resolveHost(f.db, hostId, envId, { localUser: 'tester' }),
    secrets: {
      value: (id: string) => {
        valueCalls.push(id)
        if (failValue.on) throw new Error('secret unavailable')
        return store.value(id)
      },
    },
    emit: (b) => void batches.push(b),
    emitState: (s) => void states.push(`${s.id}:${s.status}`),
    actor: { osUser: 'tester', machine: 'box' },
    now: over.now ?? (() => new Date(NOW)),
    clock: { setTimeout: (fn) => timers.push(fn) as unknown, clearTimeout: () => undefined },
  })
  return { f, svc, runner, batches, states, timers, tick: () => timers.splice(0).forEach((t) => t()), valueCalls, failValue, setup }
}

export const dep = (r: Rig, name: string, over: Record<string, unknown> = {}) =>
  r.f.deploys.create(r.f.input({ name, repoPath: `/srv/${name}`, deployTag: `deploy_${name}`, ...over }))

/** The checkout's tracked services, or one new service named after it (`<name>-<n>`) when it has none. */
export const tracked = (r: Rig, d: DeploymentMeta): AppServiceMeta[] => {
  const have = r.f.services.forCheckout(d.id)
  if (have.length) return have
  const n = r.f.services.list(d.environmentId).length
  return [r.f.services.create({ kind: 'service', environmentId: d.environmentId, name: `${d.name}-${n}`, deploymentId: d.id }) as AppServiceMeta]
}

/** Preflights every tracked service of `deps` (each checkout whole), or exactly `serviceIds`/`checkoutIds` when given. */
export async function ready(
  r: Rig,
  deps = [dep(r, 'api')],
  over: { bump?: 'major' | 'minor' | 'patch' | 'none'; envId?: string; serviceIds?: string[]; checkoutIds?: string[] } = {},
): Promise<string> {
  const { releaseId } = await r.svc.preflight({
    environmentId: over.envId ?? r.f.staging.id,
    serviceIds: over.serviceIds ?? deps.flatMap((d) => tracked(r, d).map((s) => s.id)),
    ...(over.checkoutIds ? { checkoutIds: over.checkoutIds } : {}),
    bump: over.bump ?? 'none',
    options: DEFAULT_RELEASE_OPTIONS,
  })
  for (let i = 0; i < 200 && r.svc.detail(releaseId).status === 'preflight'; i++) await new Promise((res) => setImmediate(res))
  return releaseId
}
