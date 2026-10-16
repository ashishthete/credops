import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from '../../src/main/inventory/host-store'
import { IdentityStore } from '../../src/main/vault/identity-store'
import { KeyStore } from '../../src/main/vault/key-store'
import type { IdentityMeta } from '../../src/shared/vault'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeVault, type VaultFixture } from './vault-helpers'

export type InventoryFixture = VaultFixture & {
  hosts: HostStore
  keys: KeyStore
  identities: IdentityStore
  /** A tmp home; `sshDir` is its `.ssh`, which KeyStore confines key links to. */
  home: string
  sshDir: string
  makeIdentity(vaultId?: string): IdentityMeta
}

let n = 0

export async function makeInventory(): Promise<InventoryFixture> {
  const f = makeVault()
  await f.vault.setup('correct horse')
  const home = mkdtempSync(join(tmpdir(), 'opsdeck-inv-'))
  const sshDir = join(home, '.ssh')
  mkdirSync(sshDir)
  const clipboard = { text: '', async writeText(t: string) { this.text = t }, async readText() { return this.text } }
  const keys = new KeyStore(f.db, f.vault, f.audit, { sshDir, clipboard, defaultComment: 'tester@box' })
  const identities = new IdentityStore(f.db, f.vault, keys, f.audit)
  const hosts = new HostStore(f.db, f.vault, f.audit)
  return {
    ...f,
    hosts,
    keys,
    identities,
    home,
    sshDir,
    makeIdentity: (vaultId = DEFAULT_VAULT_ID) =>
      identities.create({ vaultId, label: `id-${++n}`, username: 'deploy', auth: 'agent' }),
  }
}
