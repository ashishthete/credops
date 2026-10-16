import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { createAuditHandlers } from '../../src/main/ipc/handlers/audit'
import { isTrustedSender, registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { CHANNELS } from '../../src/shared/ipc'
import { stubHandlers } from './ipc-helpers'

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
    expect(isTrustedSender('file:///app/out/renderer/../../etc/passwd', { rendererFile })).toBe(false)
    expect(isTrustedSender('file://host/app/out/renderer/index.html', { rendererFile })).toBe(false)
  })
})

describe('registerHandlers', () => {
  type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown
  const setup = (over: Parameters<typeof stubHandlers>[0], knownSecrets?: () => readonly string[]) => {
    const registered = new Map<string, Fn>()
    const ipc = { handle: (c: string, fn: Fn) => void registered.set(c, fn) }
    registerHandlers(ipc, stubHandlers(over), (u) => u === 'file:///ok', { validators: VALIDATORS, knownSecrets })
    return registered
  }

  it('registers every channel and rejects untrusted frames', async () => {
    const registered = setup({ 'audit:verify': () => ({ ok: true, count: 7 }) })
    expect([...registered.keys()]).toEqual([...CHANNELS])
    const fn = registered.get('audit:verify')!
    await expect(fn(frame('http://evil.test/'))).rejects.toThrow(/untrusted sender/)
    await expect(fn(frame('file:///ok'))).resolves.toEqual({ ok: true, count: 7 })
  })

  it('rejects a missing sender frame', async () => {
    const fn = setup({ 'audit:verify': () => ({ ok: true, count: 0 }) }).get('audit:verify')!
    await expect(fn({ senderFrame: null } as IpcMainInvokeEvent)).rejects.toThrow(/untrusted sender/)
  })

  it('rejects bad args before the handler runs', async () => {
    const spy = vi.fn(() => [])
    const fn = setup({ 'audit:list': spy }).get('audit:list')!
    await expect(fn(frame('file:///ok'), { limit: 'x' })).rejects.toThrow(/invalid arguments/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('passes only validated args', async () => {
    const spy = vi.fn(() => ({ ok: true as const, count: 0 }))
    const fn = setup({ 'audit:verify': spy }).get('audit:verify')!
    await fn(frame('file:///ok'), 'extra')
    expect(spy).toHaveBeenCalledWith()
  })

  it('redacts handler errors', async () => {
    const fn = setup(
      { 'audit:verify': () => { throw new Error('boom hunter22') } },
      () => ['hunter22'],
    ).get('audit:verify')!
    await expect(fn(frame('file:///ok'))).rejects.toThrow(new Error('boom ‹redacted›'))
    await expect(fn(frame('file:///ok'))).rejects.toThrow(/^boom ‹redacted›$/)
  })
})

describe('audit handlers', () => {
  let log: AuditLog
  let db: Db
  let dir: string
  beforeEach(() => {
    db = openDatabase(':memory:')
    log = new AuditLog(db, { actor })
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

  it('verify failure details on a tampered chain', async () => {
    log.append({ action: 'app.start', outcome: 'info' })
    log.append({ action: 'app.start', outcome: 'info' })
    db.exec('DROP TRIGGER audit_no_update')
    db.prepare("UPDATE audit_events SET outcome = 'denied' WHERE id = 1").run()
    const h = createAuditHandlers(log, { saveDialog: async () => undefined })
    const res = await h['audit:verify']()
    expect(res.ok).toBe(false)
    const [ev] = log.list({ actions: ['audit.verify'] })
    expect(ev.outcome).toBe('failure')
    expect(ev.details).toEqual({ count: res.count, brokenAtId: 1, reason: 'hash-mismatch' })
  })
})
