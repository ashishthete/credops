import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const EXAMPLE = join(__dirname, '..', 'hub.config.example.json')
const base = (): Record<string, any> => JSON.parse(readFileSync(EXAMPLE, 'utf8'))

function write(cfg: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'hub-cfg-')), 'hub.json')
  writeFileSync(file, JSON.stringify(cfg))
  return file
}

describe('loadConfig', () => {
  it('expands ${CREDENTIALS_DIRECTORY} in masterKeyFile, and refuses it when unset', () => {
    const file = write({ ...base(), masterKeyFile: '${CREDENTIALS_DIRECTORY}/master-key' })
    const prev = process.env.CREDENTIALS_DIRECTORY
    try {
      process.env.CREDENTIALS_DIRECTORY = '/run/credentials/credops-hub.service'
      expect(loadConfig(file).masterKeyFile).toBe('/run/credentials/credops-hub.service/master-key')
      delete process.env.CREDENTIALS_DIRECTORY
      expect(() => loadConfig(file)).toThrow(/masterKeyFile.*CREDENTIALS_DIRECTORY/)
    } finally {
      if (prev === undefined) delete process.env.CREDENTIALS_DIRECTORY
      else process.env.CREDENTIALS_DIRECTORY = prev
    }
  })

  it('loads the example config with defaults', () => {
    const c = loadConfig(EXAMPLE)
    expect(c.listen).toEqual({ host: '127.0.0.1', port: 8787 })
    expect(c.sessionTtlHours).toBe(12)
    expect(c.entra.authority).toBe(`https://login.microsoftonline.com/${c.entra.tenantId}/v2.0`)
    expect(c.entra.jwksUri).toBe(`https://login.microsoftonline.com/${c.entra.tenantId}/discovery/v2.0/keys`)
    expect(c.firstAdmin).toEqual({ upn: 'admin@example.com' })
  })

  it('rejects a non-guid tenant and names the path only', () => {
    const cfg = base()
    cfg.entra.tenantId = 'super-secret-not-a-guid'
    expect(() => loadConfig(write(cfg))).toThrow(/entra\.tenantId/)
    try {
      loadConfig(write(cfg))
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-not-a-guid')
    }
  })

  it('requires firstAdmin to have a field', () => {
    const cfg = base()
    cfg.firstAdmin = {}
    expect(() => loadConfig(write(cfg))).toThrow(/firstAdmin/)
  })

  it('requires tls for a non-loopback listen host', () => {
    const cfg = base()
    cfg.listen = { host: '0.0.0.0', port: 8787 }
    expect(() => loadConfig(write(cfg))).toThrow(/tls/)
    cfg.tls = { certFile: '/c.pem', keyFile: '/k.pem' }
    expect(loadConfig(write(cfg)).tls).toEqual({ certFile: '/c.pem', keyFile: '/k.pem' })
  })

  it('allows http authority only on loopback', () => {
    const cfg = base()
    cfg.entra.authority = 'http://login.example.com/x'
    expect(() => loadConfig(write(cfg))).toThrow(/entra\.authority/)
    cfg.entra.authority = 'http://127.0.0.1:9000/x'
    expect(loadConfig(write(cfg)).entra.authority).toBe('http://127.0.0.1:9000/x')
    cfg.entra.jwksUri = 'http://evil.example.com/keys'
    expect(() => loadConfig(write(cfg))).toThrow(/entra\.jwksUri/)
  })
})
