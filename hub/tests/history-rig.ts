import { expect } from 'vitest'
import { A, FakeRunner } from '../../tests/main/fake-runner'
import type { HubEnvManifest } from '../../src/shared/hub'
import { testHub, type TestHub } from './helpers'
import { DEP_API, DEP_WEB, ENV_ID, HOST_ID, deployment, manifest } from './manifest'

/* A Hub with one environment of two checkouts (web, api) on one host, for the release history and scope tests. */

export const ADMIN = { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', upn: 'admin@example.com', name: 'Admin' }
/** Env-wide member. */
export const BOB = { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', upn: 'bob@example.com', name: 'Bob' }
/** Scoped to the api checkout only. */
export const CAROL = { oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', upn: 'carol@example.com', name: 'Carol' }
/** In a group with no grant on this environment. */
export const DAN = { oid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', upn: 'dan@example.com', name: 'Dan' }

export const SVC_WEB = '71111111-1111-4111-8111-111111111111'
export const SVC_API = '72222222-2222-4222-8222-222222222222'
export const OPTIONS = { backup: false, notify: false, qa: false }
export const PREV = 'b'.repeat(40)

export function envManifest(): HubEnvManifest {
  const m = manifest()
  m.environment.protected = false
  m.deployments = [deployment(DEP_WEB, 'web'), deployment(DEP_API, 'api', { position: 1 })]
  m.requiredSecrets = []
  m.services = [
    { id: SVC_WEB, name: 'web-svc', kind: 'service', composeService: 'web', deploymentId: DEP_WEB, hostId: HOST_ID, viaHostId: null },
    { id: SVC_API, name: 'api-svc', kind: 'service', composeService: 'api', deploymentId: DEP_API, hostId: HOST_ID, viaHostId: null },
  ]
  return m
}

export interface Rig {
  hub: TestHub
  fr: FakeRunner
  admin: string
  bob: string
  carol: string
  dan: string
  call: (token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) => Promise<{ statusCode: number; body: string; json: () => any }>
  publish: () => Promise<void>
  /** Bob's env grant and Carol's api-only grant, as an admin would add them. */
  grant: () => Promise<void>
  /** Preflight and start as `token`; resolves when the release has ended. */
  release: (token: string, serviceIds: string[]) => Promise<string>
}

export async function rig(): Promise<Rig> {
  const fr = new FakeRunner()
  const hub = await testHub({}, { runner: fr })
  const call: Rig['call'] = (token, method, url, payload) =>
    hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const admin = (await hub.signIn(ADMIN)).token
  const bob = (await hub.signIn(BOB)).token
  const carol = (await hub.signIn(CAROL)).token
  const dan = (await hub.signIn(DAN)).token
  const publish = async () => {
    const r = await call(admin, 'PUT', `/api/v1/admin/environments/${ENV_ID}`, envManifest())
    expect(r.statusCode, r.body).toBe(200)
    if (!hub.db.prepare('SELECT 1 FROM env_deploy_keys WHERE environment_id = ?').get(ENV_ID)) {
      expect((await call(admin, 'POST', `/api/v1/admin/environments/${ENV_ID}/deploy-key`)).statusCode).toBe(200)
    }
  }
  const group = async (name: string, oid: string) => {
    const id = (await call(admin, 'POST', '/api/v1/admin/groups', { name })).json().id as string
    await call(admin, 'POST', `/api/v1/admin/groups/${id}/members`, { oids: [oid] })
    return id
  }
  await publish()
  const ops = await group('Ops', BOB.oid)
  const api = await group('Api', CAROL.oid)
  await group('Other', DAN.oid)
  const grant = async () => {
    expect((await call(admin, 'POST', `/api/v1/admin/groups/${ops}/grants`, { scope: { kind: 'environment', environmentId: ENV_ID } })).statusCode).toBe(201)
    expect((await call(admin, 'POST', `/api/v1/admin/groups/${api}/grants`, { scope: { kind: 'deployment', environmentId: ENV_ID, deploymentId: DEP_API } })).statusCode).toBe(201)
  }
  await grant()
  // Each run moves its checkouts from PREV to the preflight head.
  fr.on.release = (plan) => ({ commits: Object.fromEntries(plan.deployments.map((d) => [d.runId, { previous: PREV, deployed: A }])) })
  const release = async (token: string, serviceIds: string[]) => {
    const pf = await call(token, 'POST', '/api/v1/releases/preflight', { environmentId: ENV_ID, serviceIds, bump: 'none', options: OPTIONS })
    expect(pf.statusCode, pf.body).toBe(201)
    const id = pf.json().releaseId as string
    await hub.app.releases.whenIdle()
    const st = await call(token, 'POST', `/api/v1/releases/${id}/start`, { redeploy: true })
    expect(st.statusCode, st.body).toBe(204)
    await hub.app.releases.whenIdle()
    return id
  }
  return { hub, fr, admin, bob, carol, dan, call, publish, grant, release }
}
