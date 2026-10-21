import { describe, expect, it } from 'vitest'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { REPO_URL_CREDENTIALS_MSG } from '../../src/shared/inventory'
import { makeDeployFixture } from './deploy-helpers'
import { makeInventory } from './inventory-helpers'

const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const check = (channel: string, args: unknown[]): unknown => (VALIDATORS as Record<string, (a: unknown[]) => unknown>)[channel](args)
// Fake values only.
const CRED_URLS = ['https://tok@host/r', 'https://u:p@host/r', 'https:///tok:pw@host/r', 'ssh://u:p@host/r']

describe('stores and IPC refuse repo URLs carrying credentials', () => {
  it('deploy-store', async () => {
    const f = await makeDeployFixture()
    for (const repoUrl of CRED_URLS) {
      let msg = ''
      try {
        f.deploys.create(f.input({ repoUrl }))
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg, repoUrl).toBeTruthy()
      expect(msg).not.toMatch(/tok|pw|u:p/)
    }
    expect(() => f.deploys.create(f.input({ repoUrl: 'https://tok@host/r' }))).toThrow(REPO_URL_CREDENTIALS_MSG)
    expect(f.deploys.list()).toEqual([])
    const d = f.deploys.create(f.input({ repoUrl: 'git@host:r.git' }))
    expect(() => f.deploys.update(d.id, { repoUrl: 'https://u:p@host/r' })).toThrow(REPO_URL_CREDENTIALS_MSG)
  })

  it('product-store', async () => {
    const f = await makeInventory()
    const p = f.products.create({ name: 'Web', color: '#112233', icon: 'boxes' })
    for (const repoUrl of ['https://tok@host/r', 'https://u:p@host/r']) {
      expect(() => f.products.create({ name: 'Api', color: '#112233', icon: 'boxes', repoUrl })).toThrow(REPO_URL_CREDENTIALS_MSG)
      expect(() => f.products.update(p.id, { repoUrl })).toThrow(REPO_URL_CREDENTIALS_MSG)
    }
    expect(f.products.update(p.id, { repoUrl: 'ssh://git@host/r' }).repoUrl).toBe('ssh://git@host/r')
  })

  it('IPC validators', () => {
    for (const repoUrl of ['https://tok@host/r', 'https://u:p@host/r']) {
      for (const [channel, args] of [
        ['product:create', [{ name: 'Web', color: '#112233', icon: 'boxes', repoUrl }]],
        ['product:update', [ID, { repoUrl }]],
      ] as [string, unknown[]][]) {
        expect(() => check(channel, args), `${channel} ${repoUrl}`).toThrow(REPO_URL_CREDENTIALS_MSG)
        try {
          check(channel, args)
        } catch (e) {
          expect((e as Error).message).not.toMatch(/tok|u:p/)
        }
      }
    }
    expect(() => check('product:update', [ID, { repoUrl: 'git@host:r.git' }])).not.toThrow()
  })
})
