import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase } from '../../src/main/db/connection'
import { createAuditHandlers } from '../../src/main/ipc/handlers/audit'
import { isTrustedSender, registerHandlers } from '../../src/main/ipc/register'
import { CHANNELS, type Handlers } from '../../src/shared/ipc'

const actor = { osUser: 'tester', machine: 'box' }
const rendererFile = '/app/out/renderer/index.html'

const frame = (url: string): IpcMainInvokeEvent => ({ senderFrame: { url } }) as IpcMainInvokeEvent

describe('isTrustedSender', () => {
  it('trusts only the app renderer', () => {
    expect(isTrustedSender('file:///app/out/renderer/index.html#/audit', { rendererFile })).toBe(true)
    expect(isTrustedSender('file:///app/out/renderer/index.html?x=1', { rendererFile })).toBe(true)
    expect(isTrustedSender('file:///etc/passwd', { rendererFile })).toBe(false)
    expect(isTrustedSender('not a url', { rendererFile })).toBe(false)
    expect(isTrustedSender('http://localhost:5173/', { rendererFile })).toBe(false)
    const opts = { rendererFile, devServerUrl: 'http://localhost:5173' }
    expect(isTrustedSender('http://localhost:5173/#/x', opts)).toBe(true)
    expect(isTrustedSender('http://evil.test/', opts)).toBe(false)
    expect(isTrustedSender('http://localhost:5174/', opts)).toBe(false)
  })
})

describe('registerHandlers', () => {
  it('registers every channel and rejects untrusted frames', async () => {
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipc = { handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => void registered.set(c, fn) }
    const handlers: Handlers = {
      'app:info': () => ({ version: '1', platform: 'darwin', userDataPath: '/x', actor }),
      'audit:list': () => [],
      'audit:verify': () => ({ ok: true, count: 7 }),
      'audit:exportCsv': () => null,
    }
    const trust = (u: string): boolean => u === 'file:///ok'
    registerHandlers(ipc, handlers, trust)
    expect([...registered.keys()]).toEqual([...CHANNELS])
    const fn = registered.get('audit:verify')!
    await expect(fn(frame('http://evil.test/'))).rejects.toThrow(/untrusted sender/)
    await expect(fn(frame('file:///ok'))).resolves.toEqual({ ok: true, count: 7 })
  })
})

describe('audit handlers', () => {
  let log: AuditLog
  let dir: string
  beforeEach(() => {
    log = new AuditLog(openDatabase(':memory:'), { actor })
    dir = mkdtempSync(join(tmpdir(), 'opsdeck-ipc-'))
  })

  it('exports csv, paging past 1000 rows, and audits it', async () => {
    for (let i = 0; i < 1005; i++) log.append({ action: 'app.start', outcome: 'info' })
    const path = join(dir, 'out.csv')
    const h = createAuditHandlers(log, { saveDialog: async () => path })
    expect(await h['audit:exportCsv']({})).toEqual({ path })
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1006)
    const [ev] = log.list({ actions: ['audit.export'] })
    expect(ev.outcome).toBe('success')
    expect(ev.details).toEqual({ path, count: 1005 })
  })

  it('audits a failed export and rethrows', async () => {
    const path = join(dir, 'missing-dir', 'out.csv')
    const h = createAuditHandlers(log, { saveDialog: async () => path })
    await expect(h['audit:exportCsv']({})).rejects.toThrow(/ENOENT/)
    const [ev] = log.list({ actions: ['audit.export'] })
    expect(ev.outcome).toBe('failure')
    expect(ev.details['path']).toBe(path)
    expect(String(ev.details['reason'])).toMatch(/ENOENT/)
  })

  it('returns null and no event when the dialog is cancelled', async () => {
    const h = createAuditHandlers(log, { saveDialog: async () => undefined })
    expect(await h['audit:exportCsv']({})).toBeNull()
    expect(log.list({ actions: ['audit.export'] })).toHaveLength(0)
  })

  it('verify appends an audit.verify event', async () => {
    log.append({ action: 'app.start', outcome: 'info' })
    const h = createAuditHandlers(log, { saveDialog: async () => undefined })
    expect(await h['audit:verify']()).toEqual({ ok: true, count: 1 })
    const [ev] = log.list({ actions: ['audit.verify'] })
    expect(ev.outcome).toBe('success')
    expect(ev.details).toEqual({ count: 1 })
  })
})
