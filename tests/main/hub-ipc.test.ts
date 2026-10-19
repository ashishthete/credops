import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { createHubHandlers } from '../../src/main/ipc/handlers/hub'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { CHANNELS } from '../../src/shared/ipc'
import { stubHandlers } from './ipc-helpers'

const HUB_CHANNELS = CHANNELS.filter((c) => c.startsWith('hub:'))
const UUID = '11111111-1111-4111-8111-111111111111'

describe('hub ipc validators', () => {
  it('every new channel has a validator', () => {
    expect(HUB_CHANNELS).toHaveLength(24)
    for (const c of HUB_CHANNELS) expect(typeof VALIDATORS[c]).toBe('function')
  })

  it('hub:connect rejects ftp:// and non-loopback http, naming the path only', () => {
    const v = VALIDATORS['hub:connect']
    expect(v(['https://hub.example.com'])).toEqual(['https://hub.example.com'])
    expect(v(['http://127.0.0.1:8787'])).toEqual(['http://127.0.0.1:8787'])
    for (const bad of ['ftp://hub.example.com/secret-path', 'http://10.0.0.5', 'nonsense', 'https://u:p@hub.example.com']) {
      let msg = ''
      try {
        v([bad])
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toMatch(/^invalid arguments: \[0\]/)
      expect(msg).not.toContain('10.0.0.5')
      expect(msg).not.toContain('secret-path')
    }
  })

  it('publish channels take one environment uuid', () => {
    expect(() => VALIDATORS['hub:publish'](['nope'])).toThrow(/invalid arguments: \[0\]/)
    expect(VALIDATORS['hub:unpublish']([UUID])).toEqual([UUID])
  })

  it('caps deploymentIds at 200 and checks action, scope and filter shapes', () => {
    const a = VALIDATORS['hub:access']
    const ids = Array.from({ length: 201 }, () => UUID)
    expect(() => a(['deploy.view', { environmentId: UUID, deploymentIds: ids }])).toThrow(/at most 200/)
    expect(() => a(['deploy.view', { environmentId: UUID, deploymentIds: ids.slice(1) }])).not.toThrow()
    expect(() => a(['nope', { environmentId: UUID }])).toThrow()
    expect(() => VALIDATORS['hub:addGrant']([UUID, { kind: 'environment' }])).toThrow(/environmentId/)
    expect(() => VALIDATORS['hub:addGrant']([UUID, { kind: 'all' }])).not.toThrow()
    expect(() => VALIDATORS['hub:updateUser']([UUID, { role: 'root' }])).toThrow()
    expect(() => VALIDATORS['hub:audit']([{ limit: 5, actions: ['hub.start'] }])).not.toThrow()
    expect(() => VALIDATORS['hub:audit']([{ evil: 1 }])).toThrow(/not an allowed key/)
  })
})

describe('hub handlers', () => {
  const frame = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
  function setup(client: Record<string, unknown>, secrets: string[] = []) {
    const audit = { append: vi.fn() }
    const vault = { assertUnlocked: vi.fn() }
    const conn = {
      client: () => client,
      status: vi.fn(),
      connect: vi.fn(),
      signIn: vi.fn(),
      cancelSignIn: vi.fn(),
      signOut: vi.fn(),
      unlink: vi.fn(),
      me: vi.fn(),
    }
    const handlers = createHubHandlers({ conn: conn as never, vault, audit, catalog: { refresh: vi.fn(async () => []) }, publisher: { publish: vi.fn(async () => ({ manifestHash: 'h', missingSecrets: [] })), unpublish: vi.fn(async () => undefined) } })
    const registered = new Map<string, (...a: unknown[]) => unknown>()
    registerHandlers({ handle: (c: string, fn: never) => void registered.set(c, fn) }, stubHandlers(handlers), (u) => u === 'file:///ok', {
      validators: VALIDATORS,
      knownSecrets: () => secrets,
    })
    return { audit, vault, conn, call: (c: string, ...a: unknown[]) => registered.get(c)!(frame, ...a) as Promise<unknown> }
  }

  it('mutations assert the vault is unlocked and audit hub.admin without values', async () => {
    const group = { id: UUID, name: 'Ops' }
    const client = { post: vi.fn(async () => group), patch: vi.fn(async () => ({ oid: UUID })), del: vi.fn(async () => undefined) }
    const t = setup(client)
    await t.call('hub:createGroup', { name: 'Ops', description: 'secret words' })
    expect(client.post).toHaveBeenCalledWith('/api/v1/admin/groups', { name: 'Ops', description: 'secret words' })
    expect(t.vault.assertUnlocked).toHaveBeenCalledTimes(1)
    expect(t.audit.append).toHaveBeenCalledWith({ action: 'hub.admin', outcome: 'success', details: { op: 'group.create', target: UUID } })
    await t.call('hub:updateUser', UUID, { role: 'admin', disabled: true })
    expect(t.audit.append.mock.calls.map((c) => (c[0] as { details: { op: string } }).details.op)).toEqual(['group.create', 'user.role', 'user.disable'])
    await t.call('hub:removeGrant', UUID)
    expect(client.del).toHaveBeenCalledWith(`/api/v1/admin/grants/${UUID}`)
  })

  it('removeMember and addGrant never return undefined when the group is gone', async () => {
    const client = { del: vi.fn(async () => undefined), post: vi.fn(async () => undefined), get: vi.fn(async (): Promise<unknown[]> => []) }
    const t = setup(client)
    await expect(t.call('hub:removeMember', UUID, UUID)).rejects.toThrow(/no longer exists/)
    await expect(t.call('hub:addGrant', UUID, { kind: 'all' })).rejects.toThrow(/no longer exists/)
    expect(t.audit.append).not.toHaveBeenCalled()
    client.get.mockImplementation(async () => [{ id: UUID, name: 'Ops' }])
    await expect(t.call('hub:removeMember', UUID, UUID)).resolves.toMatchObject({ id: UUID })
  })

  it('a locked vault stops a mutation before any Hub call', async () => {
    const client = { post: vi.fn() }
    const t = setup(client)
    t.vault.assertUnlocked.mockImplementation(() => {
      throw new Error('Vault is locked')
    })
    await expect(t.call('hub:createGroup', { name: 'Ops' })).rejects.toThrow(/locked/)
    expect(client.post).not.toHaveBeenCalled()
    expect(t.audit.append).not.toHaveBeenCalled()
  })

  it('a failed Hub call writes no audit and a token in its error text is redacted', async () => {
    const t = setup({ post: vi.fn(async () => { throw new Error('boom tok-secret-123') }) }, ['tok-secret-123'])
    const err = await t.call('hub:createGroup', { name: 'Ops' }).catch((e: unknown) => e)
    expect((err as Error).message).not.toContain('tok-secret-123')
    expect(t.audit.append).not.toHaveBeenCalled()
  })
})
