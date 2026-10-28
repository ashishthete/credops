import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDiagnostics, collectCounts, collectNames, diagnosticsFrom, maskNames, NAME_MASK } from '../../src/main/diagnostics/bundle'
import { captureConsole, formatLogText, LogFile } from '../../src/main/diagnostics/log-file'
import { currentVersion } from '../../src/main/db/migrations'
import { createAppHandlers } from '../../src/main/ipc/handlers/app'
import { registerHandlers } from '../../src/main/ipc/register'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { REDACTED } from '../../src/main/security/redact'
import { CHANNELS } from '../../src/shared/ipc'
import { makeInventory, PRODUCT, REGION } from './inventory-helpers'
import { stubHandlers } from './ipc-helpers'

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'
const SECRET = 'S3cr3t-vault-value-9c1f'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'credops-logs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('log file redaction', () => {
  it('masks known secrets, PEM keys, sensitive pairs and sensitive object keys', () => {
    const log = new LogFile({ dir, knownSecrets: () => [SECRET] })
    log.error('unlock failed for value', SECRET, 'inline', `x${SECRET}y`)
    log.warn('key dump', PEM)
    log.warn('connect failed: password=hunter22 token: abc123 Authorization: Bearer eyJhbGciOi.zzz')
    log.error('payload', { user: 'bob', apiKey: 'k-0987654321', nested: { secret: 'n-111111', ok: 1 } })
    log.error(new Error(`spawn failed with ${SECRET}`))
    const text = readFileSync(log.file, 'utf8')
    for (const leak of [SECRET, 'b3BlbnNzaC1rZXktdjEAAAAA', 'hunter22', 'abc123', 'eyJhbGciOi', 'k-0987654321', 'n-111111']) {
      expect(text).not.toContain(leak)
    }
    expect(text).toContain(REDACTED)
    expect(text).toContain('user')
    expect(text).toContain('ok: 1')
    // One record per line: a multi-line PEM or stack stays on its line.
    expect(text.trim().split('\n')).toHaveLength(5)
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR unlock failed/)
  })

  it('reads the known secrets at write time', () => {
    let known: string[] = []
    const log = new LogFile({ dir, knownSecrets: () => known })
    known = [SECRET]
    log.info(`late ${SECRET}`)
    expect(readFileSync(log.file, 'utf8')).not.toContain(SECRET)
  })

  it('formats text without leaking a secret through util.inspect', () => {
    expect(formatLogText([{ password: SECRET }])).not.toContain(SECRET)
    expect(formatLogText([[`a ${SECRET}`]], [SECRET])).not.toContain(SECRET)
  })

  it('creates the file private', () => {
    const log = new LogFile({ dir })
    log.info('hello')
    expect(statSync(log.file).mode & 0o777).toBe(0o600)
  })

  it('never throws when the folder cannot be written', () => {
    const log = new LogFile({ dir: join(dir, 'missing', '\0bad') })
    expect(() => log.error('x')).not.toThrow()
  })
})

describe('log file rotation', () => {
  it('rotates past the size cap and keeps only `keep` copies', () => {
    const log = new LogFile({ dir, maxBytes: 300, keep: 2 })
    for (let i = 0; i < 40; i++) log.info(`line ${i} ${'x'.repeat(40)}`)
    expect(existsSync(join(dir, 'main.log'))).toBe(true)
    expect(existsSync(join(dir, 'main.1.log'))).toBe(true)
    expect(existsSync(join(dir, 'main.2.log'))).toBe(true)
    expect(existsSync(join(dir, 'main.3.log'))).toBe(false)
    for (const f of ['main.log', 'main.1.log', 'main.2.log']) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(300)
  })

  it('tails across the live file and the rotated copies, oldest first', () => {
    const log = new LogFile({ dir, maxBytes: 300, keep: 3 })
    for (let i = 0; i < 20; i++) log.info(`line ${i} ${'x'.repeat(40)}`)
    const tail = log.tail(6)
    expect(tail).toHaveLength(6)
    expect(tail.map((l) => / line (\d+) /.exec(l)![1])).toEqual(['14', '15', '16', '17', '18', '19'])
  })

  it('picks up the existing size after a restart', () => {
    new LogFile({ dir, maxBytes: 200 }).info('x'.repeat(150))
    new LogFile({ dir, maxBytes: 200 }).info('y'.repeat(150))
    expect(existsSync(join(dir, 'main.1.log'))).toBe(true)
  })
})

describe('console capture', () => {
  it('copies warn and error into the log, still prints them, and restores', () => {
    const printed: unknown[][] = []
    const target = { warn: (...a: unknown[]) => printed.push(a), error: (...a: unknown[]) => printed.push(a) }
    const log = new LogFile({ dir, knownSecrets: () => [SECRET] })
    const restore = captureConsole(log, target)
    target.warn('careful', SECRET)
    target.error('broke')
    expect(printed).toHaveLength(2)
    const text = readFileSync(log.file, 'utf8')
    expect(text).toMatch(/WARN  careful ‹redacted›/)
    expect(text).toMatch(/ERROR broke/)
    restore()
    target.warn('after')
    expect(readFileSync(log.file, 'utf8')).not.toContain('after')
  })

  it('does not recurse when writing logs to the console', () => {
    const target = { warn: vi.fn(), error: vi.fn() }
    const loud = { write: vi.fn(() => target.error('inner')) }
    captureConsole(loud, target)
    target.error('outer')
    expect(loud.write).toHaveBeenCalledTimes(1)
  })
})

describe('diagnostics bundle', () => {
  it('masks saved names, addresses, IPs, emails and the home folder', () => {
    const out = maskNames('ssh to prod-db-1 (prod-db-1.corp.example.com, 10.1.2.3) as ops@corp.example.com in /Users/alice/x', ['prod-db-1', 'prod-db-1.corp.example.com'], '/Users/alice')
    expect(out).toBe(`ssh to ${NAME_MASK} (${NAME_MASK}, ‹ip›) as ‹email› in ~/x`)
  })

  it('holds versions, schema and counts, and no secrets or host and environment names', async () => {
    const f = await makeInventory()
    f.envs.create({ productId: PRODUCT, name: 'payments-prod', color: '#112233', domain: 'https://pay.acme-internal.net' })
    f.hosts.create({ regionId: REGION, label: 'pay-db-primary', address: 'db7.acme-internal.net' })
    f.hosts.create({ regionId: REGION, label: 'pay-web', address: '10.20.30.40' })

    const log = new LogFile({ dir })
    log.info('start: CredOps 1.2.3')
    log.error(`ssh to pay-db-primary (db7.acme-internal.net) failed`)
    log.warn(`tunnel to 10.20.30.40 for payments-prod; leaked ${SECRET}`)
    log.warn(`hub https://pay.acme-internal.net/api said no; user bob@acme.com in /Users/alice/app`)

    const text = diagnosticsFrom({
      db: f.db,
      log,
      knownSecrets: () => [SECRET],
      extraNames: ['alice', 'alice-mbp'],
      env: {
        appVersion: '1.2.3',
        platform: 'darwin',
        osRelease: '25.5.0',
        arch: 'arm64',
        versions: { electron: '38.0.0', node: '22.1.0', chrome: '140.0' },
        packaged: true,
        homeDir: '/Users/alice',
      },
    })

    expect(text).toContain('app: 1.2.3')
    expect(text).toContain('os: darwin 25.5.0 arm64')
    expect(text).toContain('electron: 38.0.0, node: 22.1.0')
    expect(text).toContain(`schema: ${currentVersion(f.db)}`)
    expect(text).toMatch(/counts: .*environments=1.*hosts=2/)
    expect(text).toContain('last 4 log lines:')
    expect(text).toContain('ERROR ssh to')
    for (const leak of [SECRET, 'pay-db-primary', 'pay-web', 'db7.acme-internal.net', 'acme-internal', '10.20.30.40', 'payments-prod', 'bob@acme.com', '/Users/alice', 'Fixture']) {
      expect(text).not.toContain(leak)
    }
  })

  it('counts rows and collects names from the schema', async () => {
    const f = await makeInventory()
    f.hosts.create({ regionId: REGION, label: 'h-one', address: 'h1.example.org' })
    expect(collectCounts(f.db)).toMatchObject({ hosts: 1, products: 1, environments: 0 })
    expect(collectNames(f.db)).toEqual(expect.arrayContaining(['h-one', 'h1.example.org', 'Fixture', 'test-1']))
  })

  it('re-masks secrets unlocked after a line was written', () => {
    const text = buildDiagnostics({
      appVersion: '1',
      platform: 'darwin',
      osRelease: 'x',
      arch: 'arm64',
      versions: {},
      packaged: false,
      schemaVersion: 3,
      counts: {},
      logLines: [`2026-01-01T00:00:00.000Z INFO  old line ${SECRET}`, `password=hunter22`],
      knownSecrets: [SECRET],
      names: [],
    })
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('hunter22')
    expect(text).toContain('app: 1 (dev)')
  })
})

describe('diagnostics IPC', () => {
  it('copies the built bundle to the clipboard and reports its size', async () => {
    const writeClipboard = vi.fn()
    const revealLog = vi.fn()
    const h = createAppHandlers(() => ({ version: '1', platform: 'darwin', userDataPath: '/x', actor: { osUser: 'u', machine: 'm' } }), {
      build: () => 'bundle text',
      writeClipboard,
      revealLog,
    })
    expect(await h['app:copyDiagnostics']()).toEqual({ chars: 11 })
    expect(writeClipboard).toHaveBeenCalledWith('bundle text')
    await h['app:revealLog']()
    expect(revealLog).toHaveBeenCalledOnce()
  })

  it('is registered and rejects untrusted senders', async () => {
    expect(CHANNELS).toContain('app:copyDiagnostics')
    expect(CHANNELS).toContain('app:revealLog')
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => Promise<unknown>>()
    const writeClipboard = vi.fn()
    const app = createAppHandlers(() => ({ version: '1', platform: 'darwin', userDataPath: '/x', actor: { osUser: 'u', machine: 'm' } }), {
      build: () => 'b',
      writeClipboard,
      revealLog: vi.fn(),
    })
    registerHandlers({ handle: (c: string, fn: never) => registered.set(c, fn) } as never, stubHandlers(app), (url) => url === 'app://ok', {
      validators: VALIDATORS,
    })
    const call = registered.get('app:copyDiagnostics')!
    const ev = (url: string) => ({ senderFrame: { url } }) as unknown as IpcMainInvokeEvent
    await expect(call(ev('app://ok'))).resolves.toEqual({ chars: 1 })
    await expect(call(ev('https://evil'))).rejects.toThrow('untrusted sender')
    expect(writeClipboard).toHaveBeenCalledTimes(1)
  })
})
