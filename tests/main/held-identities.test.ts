import { describe, expect, it, vi } from 'vitest'
import { HeldIdentities } from '../../src/main/deploy/held-identities'
import type { ResolvedIdentity } from '../../src/main/vault/identity-store'

const KEY: ResolvedIdentity = { username: 'ubuntu', auth: 'key', privateKey: 'PRIVATE' }

/** A vault that locks on demand: resolve() then throws, as IdentityStore's assertUnlocked does. */
function vault() {
  let locked = false
  const resolve = vi.fn(async (_id: string): Promise<ResolvedIdentity> => {
    if (locked) throw new Error('vault locked')
    return KEY
  })
  return { resolve, lock: () => (locked = true) }
}

describe('held identities', () => {
  it("a started release's later plans reach the hosts after the vault locks", async () => {
    const v = vault()
    const held = new HeldIdentities(v)
    await expect(held.for('r1', 'release').resolve('i1')).resolves.toEqual(KEY)
    v.lock()
    await expect(held.for('r1', 'rollback').resolve('i1')).resolves.toEqual(KEY)
    await expect(held.for('r1', 'unlock').resolve('i1')).resolves.toEqual(KEY)
    expect(v.resolve).toHaveBeenCalledTimes(1)
  })

  it('a preflight holds nothing, and another release gets nothing of what one holds', async () => {
    const v = vault()
    const held = new HeldIdentities(v)
    await held.for('r1', 'preflight').resolve('i1')
    await held.for('r2', 'release').resolve('i1')
    v.lock()
    await expect(held.for('r1', 'release').resolve('i1')).rejects.toThrow('vault locked')
    await expect(held.for('r3', 'unlock').resolve('i1')).rejects.toThrow('vault locked')
    await expect(held.for('r2', 'preflight').resolve('i1')).rejects.toThrow('vault locked')
  })

  it('a finished release and a vault reset let go of what was held', async () => {
    const v = vault()
    const held = new HeldIdentities(v)
    await held.for('r1', 'release').resolve('i1')
    await held.for('r2', 'release').resolve('i1')
    v.lock()
    held.drop('r1')
    await expect(held.for('r1', 'unlock').resolve('i1')).rejects.toThrow('vault locked')
    await expect(held.for('r2', 'unlock').resolve('i1')).resolves.toEqual(KEY)
    held.dropAll()
    await expect(held.for('r2', 'unlock').resolve('i1')).rejects.toThrow('vault locked')
  })
})
