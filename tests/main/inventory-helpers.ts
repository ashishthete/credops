import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInventoryHandlers } from '../../src/main/ipc/handlers/inventory'
import { EnvironmentStore } from '../../src/main/inventory/environment-store'
import { HostStore } from '../../src/main/inventory/host-store'
import { ProductStore } from '../../src/main/inventory/product-store'
import { resolveHost } from '../../src/main/inventory/resolve'
import { SshImporter } from '../../src/main/inventory/ssh-import'
import { IdentityStore } from '../../src/main/vault/identity-store'
import { TunnelStore } from '../../src/main/tunnels/tunnel-store'
import { KeyStore } from '../../src/main/vault/key-store'
import type { IdentityMeta } from '../../src/shared/vault'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import type { Db } from '../../src/main/db/connection'
import type { QuickUnlockDeps } from '../../src/main/vault/vault-service'
import { makeVault, type VaultFixture } from './vault-helpers'

export type InventoryFixture = VaultFixture & {
  hosts: HostStore
  envs: EnvironmentStore
  products: ProductStore
  keys: KeyStore
  identities: IdentityStore
  tunnels: TunnelStore
  /** A tmp home; `sshDir` is its `.ssh`, which KeyStore confines key links to. */
  home: string
  sshDir: string
  makeIdentity(vaultId?: string): IdentityMeta
}

let n = 0

export async function makeInventory(opts: { db?: Db; quick?: QuickUnlockDeps } = {}): Promise<InventoryFixture> {
  const f = makeVault(opts)
  await f.vault.setup('correct horse')
  const home = mkdtempSync(join(tmpdir(), 'opsdeck-inv-'))
  const sshDir = join(home, '.ssh')
  mkdirSync(sshDir)
  const clipboard = { text: '', async writeText(t: string) { this.text = t }, async readText() { return this.text } }
  const keys = new KeyStore(f.db, f.vault, f.audit, { sshDir, clipboard, defaultComment: 'tester@box' })
  const identities = new IdentityStore(f.db, f.vault, keys, f.audit)
  const hosts = new HostStore(f.db, f.vault, f.audit)
  const envs = new EnvironmentStore(f.db, f.vault, f.audit)
  const products = new ProductStore(f.db, f.vault, f.audit)
  const tunnels = new TunnelStore({ db: f.db, audit: f.audit, vault: f.vault })
  return {
    ...f,
    hosts,
    envs,
    products,
    keys,
    identities,
    tunnels,
    home,
    sshDir,
    makeIdentity: (vaultId = DEFAULT_VAULT_ID) =>
      identities.create({ vaultId, label: `id-${++n}`, username: 'deploy', auth: 'agent' }),
  }
}

/** The inventory IPC handlers over a fixture; resolution runs as local user `tester`. */
export function inventoryHandlers(f: InventoryFixture): ReturnType<typeof createInventoryHandlers> {
  return createInventoryHandlers({
    hosts: f.hosts,
    environments: f.envs,
    products: f.products,
    resolve: (hostId, environmentId) => resolveHost(f.db, hostId, environmentId, { localUser: 'tester' }),
  })
}

/** An importer over the fixture's tmp home; `sshConfigPath` defaults to `<sshDir>/config`. Local user `tester`. */
export function makeImporter(f: InventoryFixture, sshConfigPath = join(f.sshDir, 'config')): SshImporter {
  return new SshImporter({
    db: f.db,
    vault: f.vault,
    audit: f.audit,
    hosts: f.hosts,
    keys: f.keys,
    identities: f.identities,
    tunnels: f.tunnels,
    sshConfigPath,
    sshDir: f.sshDir,
    home: f.home,
    localUser: 'tester',
  })
}
