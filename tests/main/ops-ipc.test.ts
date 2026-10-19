import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createOpsHandlers } from '../../src/main/ipc/handlers/ops'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import type { ContainerService } from '../../src/main/ops/containers'
import type { Handlers } from '../../src/shared/ipc'
import { makeRunSetup } from './ops-helpers'
import { stubHandlers } from './ipc-helpers'

type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown

function register(handlers: Partial<Handlers>) {
  const registered = new Map<string, Fn>()
  registerHandlers(
    { handle: (c: string, fn: Fn) => void registered.set(c, fn) },
    stubHandlers(handlers),
    (u) => u === 'file:///ok',
    { validators: VALIDATORS },
  )
  const ev = { senderFrame: { url: 'file:///ok' } } as IpcMainInvokeEvent
  return (c: string, ...a: unknown[]) => Promise.resolve(registered.get(c)!(ev, ...a))
}

const LIST = { containers: [], truncated: false, skipped: 0, fetchedAt: '2026-10-19T00:00:00.000Z' }

function fakeContainers() {
  return {
    list: vi.fn(async () => LIST),
    action: vi.fn(async () => {}),
    logs: vi.fn(async () => 'tail'),
    follow: vi.fn(async () => 'follow-id'),
    unfollow: vi.fn(),
  }
}

describe('ops IPC', () => {
  it('every ops channel is wired and validated', async () => {
    const t = await makeRunSetup()
    const containers = fakeContainers()
    const call = register(createOpsHandlers({ snippets: t.snippets, runs: t.runs, containers: containers as unknown as ContainerService }))
    const host = randomUUID()
    const env = randomUUID()

    await expect(call('snippets:list')).resolves.toEqual([])
    await expect(call('runs:list')).resolves.toEqual([])

    await expect(call('containers:list', host, null)).resolves.toBe(LIST)
    expect(containers.list).toHaveBeenLastCalledWith(host, null)
    await call('containers:action', host, env, 'web-1', 'stop', 'prod')
    expect(containers.action).toHaveBeenLastCalledWith(host, env, 'web-1', 'stop', 'prod')
    await expect(call('containers:logs', host, null, 'web-1', 200)).resolves.toBe('tail')
    expect(containers.logs).toHaveBeenLastCalledWith(host, null, 'web-1', 200)
    await expect(call('containers:follow', host, null, 'web-1', 0)).resolves.toBe('follow-id')
    expect(containers.follow).toHaveBeenLastCalledWith(host, null, 'web-1', 0)
    const followId = randomUUID()
    await call('containers:unfollow', followId)
    expect(containers.unfollow).toHaveBeenLastCalledWith(followId)

    // Rejected by the validators before any handler runs; these strings are only ever refused.
    const bad: [string, ...unknown[]][] = [
      ['containers:list', 'not-a-uuid', null],
      ['containers:list', host, 7],
      ['containers:action', host, null, '-h', 'stop'],
      ['containers:action', host, null, 'web 1', 'stop'],
      ['containers:action', host, null, 'web-1', 'rm'],
      ['containers:logs', host, null, 'web-1', 5001],
      ['containers:logs', host, null, 'web-1', 1.5],
      ['containers:follow', host, null, 'web-1;x', 10],
      ['containers:follow', host, null, 'web-1', -1],
      ['containers:unfollow', 'nope'],
      ['runs:cancel', 'nope'],
      ['snippets:delete', 7],
    ]
    for (const [channel, ...args] of bad) await expect(call(channel, ...args)).rejects.toThrow()
    for (const fn of Object.values(containers)) expect(fn).toHaveBeenCalledTimes(1)
    expect(t.server.execs()).toEqual([])
  })
})
