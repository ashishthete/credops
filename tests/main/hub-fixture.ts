import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FakeEntra } from './fake-entra'
import type { HubEnvManifest } from '../../src/shared/hub'

/** The slice of hub/tests/helpers.ts these tests use. Loaded dynamically: the hub is a separate TS project. */
export interface TestHub {
  app: {
    listen(o: { host: string; port: number }): Promise<string>
    server: { address(): unknown }
    /** The Hub's release host (its service runs the scripted runner in these tests) and live bus. */
    releases: { whenIdle(): Promise<void> }
    live: { size(): number }
  }
  audit: { verify(): { ok: boolean } }
  db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): object | undefined } }
  config: { entra: { authority: string } }
  entra: FakeEntra
  signIn(user?: { oid: string; upn: string; name: string }): Promise<{ status: number; token: string }>
  close(): Promise<void>
}

/** `deps` are extra HubDeps, e.g. `{ runner }` to run releases on a scripted DeployRunner. */
export async function testHub(overrides: object = {}, deps: object = {}): Promise<TestHub> {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../hub/tests/helpers.ts')
  const mod = (await import(/* @vite-ignore */ file)) as { testHub(o?: object, d?: object): Promise<TestHub> }
  return mod.testHub(overrides, deps)
}

/** The Hub test manifest builders (ids and a published environment). */
export async function hubManifest(): Promise<{
  ENV_ID: string
  HOST_ID: string
  DEP_WEB: string
  DEP_API: string
  SECRET_DB: string
  SECRET_SUDO: string
  deployment(id: string, name: string, over?: Record<string, unknown>): Record<string, unknown>
  manifest(): Record<string, unknown> & { environment: Record<string, unknown>; deployments: unknown[]; services: unknown[] }
}> {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../hub/tests/manifest.ts')
  return (await import(/* @vite-ignore */ file)) as never
}

/** The Hub's own manifest reader, so a desktop manifest is checked by the code that will receive it. */
export async function hubReadManifest(): Promise<(input: unknown) => HubEnvManifest> {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../hub/src/registry.ts')
  return ((await import(/* @vite-ignore */ file)) as { readManifest(input: unknown): HubEnvManifest }).readManifest
}
