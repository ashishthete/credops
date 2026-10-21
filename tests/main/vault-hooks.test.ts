import { describe, expect, it, vi } from 'vitest'
import { wireVaultHooks, type VaultHookTargets } from '../../src/main/vault/hooks'
import { SecretStore } from '../../src/main/vault/secret-store'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeVault } from './vault-helpers'

/** Targets that record each call, in order, across all of them. */
function recording() {
  const calls: string[] = []
  const rec = (name: string) => () => void calls.push(name)
  const targets: VaultHookTargets = {
    sessions: { vaultLocked: rec('sessions.vaultLocked'), closeAll: (reason) => void calls.push(`sessions.closeAll(${reason})`) },
    tunnels: { vaultLocked: rec('tunnels.vaultLocked'), vaultUnlocked: rec('tunnels.vaultUnlocked'), vaultReset: rec('tunnels.vaultReset') },
    runs: { vaultLocked: rec('runs.vaultLocked'), vaultReset: rec('runs.vaultReset') },
    links: { vaultLocked: rec('links.vaultLocked'), closeForReset: rec('links.closeForReset') },
    containers: { vaultLocked: rec('containers.vaultLocked'), vaultReset: rec('containers.vaultReset') },
    releases: { vaultReset: rec('releases.vaultReset') },
    prompts: { cancelAll: rec('prompts.cancelAll') },
  }
  return { calls, targets }
}

describe('wireVaultHooks', () => {
  it('runs the lock, unlock and reset hooks in order on a real vault', async () => {
    const { vault } = makeVault()
    const { calls, targets } = recording()
    wireVaultHooks(vault, targets)

    await vault.setup('correct horse')
    expect(calls.splice(0)).toEqual(['tunnels.vaultUnlocked'])
    vault.lock('manual')
    expect(calls.splice(0)).toEqual([
      'sessions.vaultLocked',
      'tunnels.vaultLocked',
      'runs.vaultLocked',
      'containers.vaultLocked',
      'links.vaultLocked',
      'prompts.cancelAll',
    ])
    await vault.reset('RESET')
    expect(calls.splice(0)).toEqual([
      'releases.vaultReset',
      'sessions.closeAll(reset)',
      'tunnels.vaultReset',
      'runs.vaultReset',
      'containers.vaultReset',
      'links.closeForReset',
    ])
  })

  it('stops everything before the erase, while the secrets are still there', async () => {
    const { vault, db, audit } = makeVault()
    const { calls, targets } = recording()
    const secrets = (): number => Number((db.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number }).n)
    const seen: string[] = []
    targets.releases.vaultReset = () => void seen.push(`releases with ${secrets()} secret`)
    targets.links.closeForReset = () => void seen.push(`links with ${secrets()} secret`)
    wireVaultHooks(vault, targets)
    await vault.setup('correct horse')
    const clipboard = { async writeText() {}, async readText() { return '' } }
    new SecretStore(db, vault, audit, { clipboard }).create({ vaultId: DEFAULT_VAULT_ID, name: 'db', kind: 'password', value: 'pw-1' })
    vault.lock('manual')
    await vault.reset('RESET')
    expect(seen).toEqual(['releases with 1 secret', 'links with 1 secret'])
    expect(calls.splice(0)).toContain('runs.vaultReset')
    expect(secrets()).toBe(0)
  })

  it('a throwing hook never skips the ones after it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { vault } = makeVault()
    const { calls, targets } = recording()
    const boom = (): never => {
      throw new Error('boom')
    }
    targets.sessions.closeAll = boom
    targets.sessions.vaultLocked = boom
    wireVaultHooks(vault, targets)
    await vault.setup('correct horse')
    vault.lock('manual')
    await vault.reset('RESET')
    expect(calls).toContain('prompts.cancelAll')
    expect(calls.at(-1)).toBe('links.closeForReset')
    expect(error.mock.calls.map((c) => c[0])).toEqual(['vault lock listener failed:', 'vault reset listener failed:'])
    error.mockRestore()
  })
})
