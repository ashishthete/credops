import { describe, expect, it } from 'vitest'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { REPO_URL_CREDENTIALS_MSG } from '../../src/shared/inventory'
import { makeDeployFixture } from './deploy-helpers'
import { makeInventory } from './inventory-helpers'

const ID = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
const check = (channel: string, args: unknown[]): unknown => (VALIDATORS as Record<string, (a: unknown[]) => unknown>)[channel](args)
// Fake values only.
const DEPLOY_INPUT = (repoUrl: string) => ({ name: 'api', environmentId: ID, hostId: ID, repoPath: '/srv/api', defaultBranch: 'main', deployTag: 'deployed', repoUrl })
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
    expect(f.deploys.get(d.id).repoUrl).toBe('git@host:r.git')
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
        ['deploy:create', [DEPLOY_INPUT(repoUrl)]],
        ['deploy:update', [ID, { repoUrl }]],
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

describe('rows stored before the rule stay editable', () => {
  const LEGACY = ['https://tok:pw@host/r', 'git@https://tok:pw@github.com/a', 'https:///tok@host/r']

  it('deploy-store: an update that leaves repoUrl alone succeeds; changing it is checked', async () => {
    const f = await makeDeployFixture()
    for (const legacy of LEGACY) {
      const d = f.deploys.create(f.input({ name: `d${LEGACY.indexOf(legacy)}`, repoUrl: null }))
      f.db.prepare('UPDATE deployments SET repo_url = ? WHERE id = ?').run(legacy, d.id)
      expect(f.deploys.update(d.id, { name: `${d.name}-renamed` }).name).toBe(`${d.name}-renamed`)
      expect(f.deploys.update(d.id, { repoUrl: legacy, healthStatus: 204 }).healthStatus).toBe(204)
      expect(f.deploys.get(d.id).repoUrl).toBe(legacy)
      expect(() => f.deploys.update(d.id, { repoUrl: 'https://other:pw@host/r' })).toThrow(REPO_URL_CREDENTIALS_MSG)
      expect(f.deploys.update(d.id, { repoUrl: 'git@host:r.git' }).repoUrl).toBe('git@host:r.git')
    }
  })

  it('product-store: an update that leaves repoUrl alone succeeds; changing it is checked', async () => {
    const f = await makeInventory()
    const p = f.products.create({ name: 'Web', color: '#112233', icon: 'boxes' })
    f.db.prepare('UPDATE products SET repo_url = ? WHERE id = ?').run('https://tok:pw@host/r', p.id)
    expect(f.products.update(p.id, { name: 'Web2' }).repoUrl).toBe('https://tok:pw@host/r')
    expect(f.products.update(p.id, { repoUrl: 'https://tok:pw@host/r', description: 'x' }).description).toBe('x')
    expect(() => f.products.update(p.id, { repoUrl: 'https://tok2:pw@host/r' })).toThrow(REPO_URL_CREDENTIALS_MSG)
    expect(f.products.update(p.id, { repoUrl: null }).repoUrl).toBeNull()
  })

  it('stores refuse an http(s) URL that does not parse', async () => {
    const f = await makeDeployFixture()
    expect(() => f.deploys.create(f.input({ repoUrl: 'https://host%40x/r' }))).toThrow(/repository URL/)
  })
})
