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
import { CHANNELS, EVENTS } from '../../src/shared/ipc'
import type { ReleaseService } from '../../src/main/deploy/release-service'
import { createDeployHandlers } from '../../src/main/ipc/handlers/deploy'
import type { DeployStore } from '../../src/main/deploy/deploy-store'
import { createOpsHandlers } from '../../src/main/ipc/handlers/ops'
import type { ContainerService } from '../../src/main/ops/containers'
import type { RunManager } from '../../src/main/ops/run-manager'
import type { SnippetStore } from '../../src/main/ops/snippet-store'
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

describe('sign-in and factor contract', () => {
  type Fn = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown
  const SSO_CHANNELS = [
    'vault:setup',
    'vault:unlockPin',
    'vault:setPin',
    'vault:clearPin',
    'vault:setPassword',
    'vault:removePassword',
    'auth:check',
    'auth:signIn',
    'auth:changeAccount',
    'auth:disconnect',
    'auth:signOut',
  ] as const
  const PIN = '204816'
  const setup = (over: Parameters<typeof stubHandlers>[0]) => {
    const registered = new Map<string, Fn>()
    registerHandlers({ handle: (c: string, fn: Fn) => void registered.set(c, fn) }, stubHandlers(over), () => true, {
      validators: VALIDATORS,
    })
    return (c: string) => registered.get(c)!
  }
  const ev = frame('file:///ok')

  it('lists every channel, each validated', () => {
    for (const c of SSO_CHANNELS) {
      expect(CHANNELS).toContain(c)
      expect(typeof VALIDATORS[c]).toBe('function')
    }
  })

  it('rejects an over-long PIN before the vault sees it; the 6-8 digit rule is the vault’s', async () => {
    const spy = vi.fn(async () => ({ ok: true as const }))
    const fn = setup({ 'vault:unlockPin': spy })('vault:unlockPin')
    await expect(fn(ev, '1'.repeat(65))).rejects.toThrow(/invalid arguments/)
    await expect(fn(ev, '')).rejects.toThrow(/invalid arguments/)
    await expect(fn(ev, 204816)).rejects.toThrow(/invalid arguments/)
    expect(spy).not.toHaveBeenCalled()
    // Preflight F31: a pasted 13 digits reaches the vault, so its message is the one the user sees.
    await fn(ev, '1'.repeat(13))
    expect(spy).toHaveBeenCalledWith('1'.repeat(13))
  })

  it('checks setup options and reverify proofs', () => {
    expect(VALIDATORS['vault:setup']([{ pin: PIN, touchId: true }])).toEqual([{ pin: PIN, touchId: true }])
    expect(VALIDATORS['vault:setup']([{ password: 'correct horse' }])).toEqual([{ password: 'correct horse' }])
    expect(() => VALIDATORS['vault:setup'](['correct horse'])).toThrow(/invalid arguments/)
    expect(() => VALIDATORS['vault:setup']([{ touchId: 'yes' }])).toThrow(/invalid arguments/)
    expect(() => VALIDATORS['vault:setup']([{ pin: PIN, extra: 1 }])).toThrow(/invalid arguments/)
    const ok = [{ method: 'pin', pin: PIN }, { method: 'password', password: 'pw' }, { method: 'touchId' }]
    for (const proof of ok) expect(VALIDATORS['auth:changeAccount']([proof])).toEqual([proof])
    for (const bad of [{ method: 'pin' }, { method: 'face' }, { method: 'touchId', pin: PIN }, { method: 'password', pin: PIN }, 'pin']) {
      expect(() => VALIDATORS['auth:disconnect']([bad])).toThrow(/invalid arguments/)
    }
    expect(VALIDATORS['vault:setQuickUnlock'](['off'])).toEqual(['off', undefined])
    expect(VALIDATORS['vault:setPin']([PIN, { method: 'touchId' }])).toEqual([PIN, { method: 'touchId' }])
    expect(() => VALIDATORS['vault:setPin']([PIN])).toThrow(/invalid arguments/)
  })

  it('redacts a PIN, password or proof that reaches a thrown error', async () => {
    const leak = (...args: unknown[]) => {
      throw new Error(`failed with ${JSON.stringify(args)}`)
    }
    const get = setup({
      'vault:unlockPin': leak,
      'vault:setPin': leak,
      'vault:setPassword': leak,
      'vault:removePassword': leak,
      'vault:setup': leak,
      'auth:changeAccount': leak,
      'auth:disconnect': leak,
      'vault:setQuickUnlock': leak,
      'vault:changePassword': leak,
      'vault:unlock': leak,
    })
    const calls: [string, unknown[], string[]][] = [
      ['vault:unlockPin', [PIN], [PIN]],
      ['vault:setPin', ['482913', { method: 'pin', pin: PIN }], ['482913', PIN]],
      ['vault:setPassword', ['new horse battery', { method: 'password', password: 'old horse battery' }], ['new horse battery', 'old horse battery']],
      ['vault:removePassword', ['old horse battery'], ['old horse battery']],
      ['vault:setup', [{ password: 'new horse battery', pin: PIN }], ['new horse battery', PIN]],
      ['auth:changeAccount', [{ method: 'pin', pin: PIN }], [PIN]],
      ['auth:disconnect', [{ method: 'password', password: 'old horse battery' }], ['old horse battery']],
      ['vault:setQuickUnlock', ['touchId', { method: 'pin', pin: PIN }], [PIN]],
      ['vault:changePassword', ['old horse battery', 'new horse battery'], ['old horse battery', 'new horse battery']],
      ['vault:unlock', ['old horse battery'], ['old horse battery']],
    ]
    for (const [channel, args, secrets] of calls) {
      const err = await (get(channel)(ev, ...args) as Promise<unknown>).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      const msg = (err as Error).message
      expect(msg).toContain('‹redacted›')
      for (const s of secrets) expect(msg).not.toContain(s)
    }
  })
})

describe('ops contract', () => {
  const OPS_CHANNELS = [
    'snippets:list',
    'snippets:create',
    'snippets:update',
    'snippets:delete',
    'snippets:render',
    'runs:start',
    'runs:cancel',
    'runs:list',
    'runs:get',
    'runs:dismiss',
    'containers:list',
    'containers:action',
    'containers:logs',
    'containers:follow',
    'containers:unfollow',
  ]

  it('lists every ops channel and event', () => {
    expect(CHANNELS).toEqual(expect.arrayContaining(OPS_CHANNELS))
    expect(EVENTS).toEqual(expect.arrayContaining(['run:event', 'containers:logs']))
  })

  it('wires every ops channel', () => {
    const handlers = createOpsHandlers({ snippets: {} as SnippetStore, runs: {} as RunManager, containers: {} as ContainerService })
    expect(Object.keys(handlers).sort()).toEqual([...OPS_CHANNELS].sort())
  })
})

describe('deploy contract', () => {
  const DEPLOY_CHANNELS = [
    'deploy:list',
    'deploy:create',
    'deploy:update',
    'deploy:delete',
    'deploy:reorder',
    'deploy:settings',
    'deploy:updateSettings',
    'deploy:applyBatch',
    'deploy:tooling',
    'deploy:previewPlaybook',
    'deploy:savePlaybook',
    'release:savePlaybook',
    'release:validateEdit',
    'release:preflight',
    'release:preflightOperation',
    'release:start',
    'release:cancel',
    'release:rollback',
    'release:break-lock',
    'release:discard',
    'release:set-notes',
    'release:retry-version',
    'release:list',
    'release:get',
    'release:events',
    'release:active',
    'release:latest',
    'runbook:list',
    'runbook:save',
    'runbook:delete',
  ]

  it('lists every deploy channel and the changed event, all validated', () => {
    expect(CHANNELS).toEqual(expect.arrayContaining(DEPLOY_CHANNELS))
    expect(EVENTS).toContain('deploy:changed')
    expect(EVENTS).toEqual(expect.arrayContaining(['deploy:event', 'release:state']))
    for (const c of DEPLOY_CHANNELS) expect(VALIDATORS).toHaveProperty([c])
  })

  it('wires every deploy channel', () => {
    const handlers = createDeployHandlers({ deploys: {} as DeployStore, releases: {} as ReleaseService, tooling: async () => ({}) as never })
    expect(Object.keys(handlers).sort()).toEqual([...DEPLOY_CHANNELS].sort())
  })
})

describe('audit handlers', () => {
  let log: AuditLog
  let db: Db
  let dir: string
  beforeEach(() => {
    db = openDatabase(':memory:')
    log = new AuditLog(db, { actor })
    dir = mkdtempSync(join(tmpdir(), 'credops-ipc-'))
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
