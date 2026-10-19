import { existsSync } from 'node:fs'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BindError, isLoopback, listen, parseLsof, realExecFile, whoHolds, type ExecFile } from '../../src/main/tunnels/bind'

const open: net.Server[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const s of open.splice(0)) s.close()
})

async function hold(): Promise<number> {
  const s = net.createServer()
  open.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return (s.address() as net.AddressInfo).port
}

describe('parseLsof', () => {
  it('parses lsof field output', () => {
    expect(parseLsof('p812\ncpostgres\n')).toEqual({ pid: 812, command: 'postgres' })
    expect(parseLsof('p812\ncpostgres\np900\ncnginx\n')).toEqual({ pid: 812, command: 'postgres' })
    expect(parseLsof('')).toBeNull()
    expect(parseLsof('garbage\n\u0000')).toBeNull()
  })
})

describe('whoHolds', () => {
  it('runs lsof with fixed args and cleans the command name', async () => {
    const calls: string[][] = []
    const fake: ExecFile = (file, args, _o, cb) => {
      calls.push([file, ...args])
      cb(null, `p7\nc${'x'.repeat(100)}\u001b[31m\n`)
    }
    const r = await whoHolds(5433, { execFile: fake })
    expect(calls).toEqual([['lsof', '-nP', '-iTCP:5433', '-sTCP:LISTEN', '-Fpc']])
    expect(r?.command).toBe('x'.repeat(64))
  })

  it('gives null on error', async () => {
    expect(await whoHolds(5433, { execFile: (_f, _a, _o, cb) => cb(new Error('exit 1'), '') })).toBeNull()
  })

  it('gives null on timeout', async () => {
    vi.useFakeTimers()
    const p = whoHolds(5433, { execFile: () => undefined, timeoutMs: 2000 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBeNull()
  })

  it.skipIf(!existsSync('/usr/sbin/lsof'))('real lsof finds our own listener', async () => {
    const port = await hold()
    expect(await whoHolds(port, { execFile: realExecFile })).toMatchObject({ pid: process.pid })
  })
})

describe('listen', () => {
  it('names the process holding the port', async () => {
    const held = await hold()
    const err = await listen('127.0.0.1', held, { whoHolds: async () => ({ pid: 812, command: 'postgres' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(BindError)
    expect(err.code).toBe('port-in-use')
    expect(err.message).toBe(`Port ${held} on 127.0.0.1 is in use by postgres (pid 812)`)
  })

  it('falls back when the holder is unknown', async () => {
    const held = await hold()
    const err = await listen('localhost', held, { whoHolds: async () => null }).catch((e) => e)
    expect(err.message).toBe(`Port ${held} on 127.0.0.1 is already in use`)
  })

  it('names another tunnel without binding', async () => {
    const createServer = vi.fn()
    const err = await listen('127.0.0.1', 5433, {
      whoHolds: async () => null,
      inUseBy: () => 'db replica',
      createServer
    }).catch((e) => e)
    expect(err.code).toBe('port-in-use')
    expect(err.message).toBe('Port 5433 on 127.0.0.1 is used by tunnel "db replica"')
    expect(createServer).not.toHaveBeenCalled()
  })

  it('binds and returns the server', async () => {
    const s = await listen('127.0.0.1', 0, { whoHolds: async () => null })
    open.push(s)
    expect((s.address() as net.AddressInfo).port).toBeGreaterThan(0)
  })

  it.skipIf(process.platform !== 'darwin')('maps EADDRNOTAVAIL', async () => {
    const err = await listen('127.0.0.9', 0, { whoHolds: async () => null }).catch((e) => e)
    expect(err).toBeInstanceOf(BindError)
    expect(err.code).toBe('bind-denied')
    expect(err.message).toBe("127.0.0.9 isn't an address on this machine")
  })

  it('maps EACCES', async () => {
    const stub = Object.assign(new EventEmitter(), {
      listen() {
        queueMicrotask(() => stub.emit('error', Object.assign(new Error('x'), { code: 'EACCES' })))
      },
      close() {}
    }) as unknown as net.Server
    const err = await listen('127.0.0.1', 80, { whoHolds: async () => null, createServer: () => stub }).catch((e) => e)
    expect(err.code).toBe('bind-denied')
    expect(err.message).toBe('Port 80 needs admin rights; pick a port above 1023')
  })
})

describe('isLoopback', () => {
  it('splits loopback from exposed', () => {
    for (const a of ['localhost', '127.0.0.1', '127.4.5.6', '::1']) expect(isLoopback(a)).toBe(true)
    for (const a of ['0.0.0.0', '::', '192.168.1.2', '10.0.0.1']) expect(isLoopback(a)).toBe(false)
  })
})
