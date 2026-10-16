import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/main/audit/audit-log'
import { openDatabase } from '../../src/main/db/connection'
import { redact } from '../../src/main/security/redact'

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

describe('phase 1 hardening', () => {
  it('csp blocks objects and base', () => {
    const html = read('src/renderer/index.html')
    expect(html).toContain("object-src 'none'")
    expect(html).toContain("base-uri 'none'")
    expect(html).toContain("script-src 'self'")
  })

  it('fuses are configured', () => {
    const yml = read('electron-builder.yml')
    expect(yml).toContain('electronFuses:')
    for (const line of [
      'runAsNode: false',
      'enableNodeOptionsEnvironmentVariable: false',
      'enableNodeCliInspectArguments: false',
      'enableEmbeddedAsarIntegrityValidation: true',
      'onlyLoadAppFromAsar: true',
    ]) {
      expect(yml).toContain(`  ${line}`)
    }
  })

  it('redact stringifies bigint', () => {
    expect(redact({ a: { n: 10n }, l: [2n] })).toEqual({ a: { n: '10' }, l: ['2'] })
  })

  it('corrupt audit rows never leak raw text', () => {
    const db = openDatabase(':memory:')
    const log = new AuditLog(db, { actor: { osUser: 't', machine: 'm' } })
    const raw = '{"password":"hunter22" -----BEGIN OPENSSH PRIVATE KEY-----'
    db.prepare(
      `INSERT INTO audit_events(ts, actor_os_user, actor_machine, action, outcome, details, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('2026-01-01T00:00:00.000Z', 't', 'm', 'app.start', 'info', raw, '0'.repeat(64), 'f'.repeat(64))
    expect(log.list()[0].details).toEqual({ _corrupt: true, bytes: raw.length })
    expect(JSON.stringify(log.list())).not.toContain('hunter22')
  })
})
