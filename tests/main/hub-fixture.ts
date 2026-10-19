import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FakeEntra } from './fake-entra'

/** The slice of hub/tests/helpers.ts these tests use. Loaded dynamically: the hub is a separate TS project. */
export interface TestHub {
  app: { listen(o: { host: string; port: number }): Promise<string>; server: { address(): unknown } }
  db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): object | undefined } }
  config: { entra: { authority: string } }
  entra: FakeEntra
  signIn(user?: { oid: string; upn: string; name: string }): Promise<{ status: number; token: string }>
  close(): Promise<void>
}

export async function testHub(): Promise<TestHub> {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../hub/tests/helpers.ts')
  const mod = (await import(/* @vite-ignore */ file)) as { testHub(): Promise<TestHub> }
  return mod.testHub()
}
