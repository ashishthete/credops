import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSessionHandlers, type SessionApi } from '../../src/main/ipc/handlers/sessions'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { KnownHostStore } from '../../src/main/ssh/known-hosts'
import { SessionLimitError } from '../../src/main/ssh/sessions'
import { SESSION_LIMIT, type SessionMeta } from '../../src/shared/ssh'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { stubHandlers } from './ipc-helpers'
import { generateKey } from './ssh-server'
import { makeVault } from './vault-helpers'

type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown

const meta = { id: 'm' } as SessionMeta

function fakeManager(): { [K in keyof SessionApi]: ReturnType<typeof vi.fn> } {
  return {
    openSsh: vi.fn(() => meta),
    openLocal: vi.fn(() => meta),
    reconnect: vi.fn(() => meta),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    list: vi.fn(() => [meta]),
    attach: vi.fn(() => ({ meta, buffer: 'b', end: 1 })),
    answer: vi.fn(),
  }
}

async function setup() {
  const f = makeVault()
  await f.vault.setup('correct horse')
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-sessions-ipc-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const knownHosts = new KnownHostStore(f.db, f.vault, f.audit, { knownHostsPath: join(dir, 'known_hosts') })
  const sessions = fakeManager()
  const registered = new Map<string, Fn>()
  registerHandlers(
    { handle: (c: string, fn: Fn) => void registered.set(c, fn) },
    stubHandlers(createSessionHandlers({ sessions: sessions as unknown as SessionApi, knownHosts })),
    (u) => u === 'file:///ok',
    { validators: VALIDATORS },
  )
  const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
  const call = (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
  return { ...f, knownHosts, sessions, call }
}

describe('session IPC', () => {
  it('delegates to the manager', async () => {
    const { sessions, call } = await setup()
    const id = randomUUID()
    const hostId = randomUUID()
    await expect(call('shell:open', { cols: 80, rows: 24 })).resolves.toBe(meta)
    expect(sessions.openLocal).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    await expect(call('ssh:open', { hostId, cols: 80, rows: 24 })).resolves.toBe(meta)
    expect(sessions.openSsh).toHaveBeenCalledWith({ hostId, cols: 80, rows: 24 })
    await call('session:reconnect', id)
    expect(sessions.reconnect).toHaveBeenCalledWith(id)
    await call('session:write', id, 'ls\r')
    expect(sessions.write).toHaveBeenCalledWith(id, 'ls\r')
    await call('session:resize', id, 1000, 500)
    expect(sessions.resize).toHaveBeenCalledWith(id, 1000, 500)
    await call('session:close', id)
    expect(sessions.close).toHaveBeenCalledWith(id)
    await expect(call('session:list')).resolves.toEqual([meta])
    await expect(call('session:attach', id)).resolves.toEqual({ meta, buffer: 'b', end: 1 })
    await call('session:answer', id, { kind: 'host-key', trust: true })
    await call('session:answer', id, { kind: 'password', password: null })
    await call('session:answer', id, { kind: 'keyboard', responses: ['', '123456'] })
    expect(sessions.answer).toHaveBeenCalledTimes(3)
    expect(sessions.answer).toHaveBeenLastCalledWith(id, { kind: 'keyboard', responses: ['', '123456'] })
  })

  it('validators reject bad args, naming the path and never the value', async () => {
    const { sessions, call } = await setup()
    const id = randomUUID()
    const hostId = randomUUID()
    await expect(call('shell:open', { cols: 0, rows: 24 })).rejects.toThrow('invalid arguments: [0].cols must be at least 1')
    await expect(call('ssh:open', { hostId, cols: 0, rows: 24 })).rejects.toThrow('invalid arguments: [0].cols must be at least 1')
    await expect(call('ssh:open', { hostId, cols: 80, rows: 501 })).rejects.toThrow('invalid arguments: [0].rows must be at most 500')
    await expect(call('ssh:open', { hostId: 42, cols: 80, rows: 24 })).rejects.toThrow('invalid arguments: [0].hostId must be a uuid')
    await expect(call('session:resize', id, 80, 501)).rejects.toThrow('invalid arguments: [2] must be at most 500')
    const long = 'x'.repeat(65_537)
    const err = await call('session:write', id, long).catch((e: Error) => e)
    expect((err as Error).message).toBe('invalid arguments: [1] must be at most 65536 chars')
    await expect(call('session:answer', id, { kind: 'host-key', trust: 'yes' })).rejects.toThrow(
      'invalid arguments: [1].trust must be a boolean',
    )
    const bad = await call('session:answer', id, { kind: 'secret-hunter2' }).catch((e: Error) => e)
    expect((bad as Error).message).toBe('invalid arguments: [1].kind is not an allowed value')
    await expect(call('session:answer', id, null)).rejects.toThrow('invalid arguments: [1] must be an object')
    await expect(call('session:answer', id, { kind: 'password', password: 'p', extra: 1 })).rejects.toThrow(
      '[1].extra is not an allowed key',
    )
    for (const fn of Object.values(sessions)) expect(fn).not.toHaveBeenCalled()
  })

  it('knownhost:list and knownhost:remove go to the store; remove needs the vault unlocked', async () => {
    const f = await setup()
    const key = generateKey().public
    const row = f.knownHosts.trust('127.0.0.1', 2222, key.type, key.getPublicSSH().toString('base64'))
    await expect(f.call('knownhost:list')).resolves.toEqual([row])
    f.vault.lock('manual')
    await expect(f.call('knownhost:remove', row.id)).rejects.toThrow(VAULT_LOCKED)
    await expect(f.call('knownhost:list')).resolves.toHaveLength(1)
  })

  it('the session limit crosses IPC as its shared message (only messages survive)', async () => {
    const { sessions, call } = await setup()
    sessions.openSsh.mockImplementation(() => {
      throw new SessionLimitError()
    })
    sessions.reconnect.mockImplementation(() => {
      throw new SessionLimitError()
    })
    const open = await call('ssh:open', { hostId: randomUUID(), cols: 80, rows: 24 }).catch((e: Error) => e)
    expect(open).toBeInstanceOf(Error)
    expect((open as Error).message).toBe(SESSION_LIMIT)
    expect((open as { code?: string }).code).toBeUndefined()
    await expect(call('session:reconnect', randomUUID())).rejects.toThrow(SESSION_LIMIT)
  })
})
