import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditLog, GENESIS_HASH, canonicalJson } from '../../src/main/audit/audit-log'
import { toCsv } from '../../src/main/audit/csv'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { REDACTED } from '../../src/main/security/redact'

const actor = { osUser: 'tester', machine: 'box' }
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

let db: Db
let tick: number
let log: AuditLog

beforeEach(() => {
  db = openDatabase(':memory:')
  tick = 0
  log = new AuditLog(db, { actor, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) })
})

function seedFive(): void {
  log.append({ action: 'app.start', outcome: 'info', targetLabel: 'web-01 primary' })
  log.append({ action: 'app.start', outcome: 'info' })
  log.append({ action: 'audit.verify', outcome: 'success' })
  log.append({ action: 'app.start', outcome: 'info' })
  log.append({ action: 'audit.verify', outcome: 'failure' })
}

describe('AuditLog', () => {
  it('appends with actor and redacted details', () => {
    const e = log.append({ action: 'app.start', outcome: 'info', details: { password: 'p' } })
    expect(e.id).toBe(1)
    expect(e.actorOsUser).toBe('tester')
    expect(e.details['password']).toBe(REDACTED)
    expect(e.ts).toBe('2026-01-01T00:00:00.000Z')
  })

  it('chains hashes', () => {
    const a = log.append({ action: 'app.start', outcome: 'info', details: { b: 1, a: { z: 1, y: [2, 1] } } })
    const b = log.append({ action: 'app.quit', outcome: 'info', targetLabel: 'x' })
    expect(a.prevHash).toBe(GENESIS_HASH)
    expect(b.prevHash).toBe(a.hash)
    const { id: _id, hash: _hash, ...rest } = b
    expect(b.hash).toBe(sha256(b.prevHash + canonicalJson(rest)))
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
  })

  it('appendInTx commits or rolls back with the caller', () => {
    expect(() => log.appendInTx({ action: 'app.start', outcome: 'info' })).toThrow(/open transaction/)
    const a = log.append({ action: 'app.start', outcome: 'info' })
    db.exec('BEGIN IMMEDIATE')
    log.appendInTx({ action: 'app.quit', outcome: 'info' })
    db.exec('ROLLBACK')
    expect(log.list().map((e) => e.id)).toEqual([a.id])
    db.exec('BEGIN IMMEDIATE')
    const b = log.appendInTx({ action: 'app.quit', outcome: 'info' })
    db.exec('COMMIT')
    expect(b.prevHash).toBe(a.hash)
    expect(log.verifyChain().ok).toBe(true)
  })

  it('stringifies bigint details without throwing', () => {
    const e = log.append({ action: 'app.start', outcome: 'info', details: { n: 10n } })
    expect(e.details['n']).toBe('10')
    expect(log.verifyChain().ok).toBe(true)
  })

  it('redacts known secrets', () => {
    const l = new AuditLog(db, { actor, knownSecrets: () => ['hunter2hunter2'] })
    const e = l.append({ action: 'app.start', outcome: 'info', details: { msg: 'x hunter2hunter2 y' } })
    expect(JSON.stringify(e)).not.toContain('hunter2hunter2')
  })

  it('redacts known secrets in target label and id', () => {
    const l = new AuditLog(db, { actor, knownSecrets: () => ['hunter2hunter2'] })
    const e = l.append({
      action: 'app.start',
      outcome: 'info',
      targetId: 'id-hunter2hunter2',
      targetLabel: 'web-01 hunter2hunter2',
    })
    expect(e.targetLabel).toBe(`web-01 ${REDACTED}`)
    expect(e.targetId).toBe(`id-${REDACTED}`)
    expect(JSON.stringify(l.list())).not.toContain('hunter2hunter2')
    expect(l.verifyChain().ok).toBe(true)
  })

  it('is append-only', () => {
    seedFive()
    expect(() => db.exec("UPDATE audit_events SET outcome='success'")).toThrow(/append-only/)
  })

  it('filters and pages', () => {
    seedFive()
    const v = log.list({ actions: ['audit.verify'] })
    expect(v.map((e) => e.id)).toEqual([5, 3])
    expect(log.list({ limit: 2 })).toHaveLength(2)
    expect(log.list({ beforeId: 3 }).map((e) => e.id)).toEqual([2, 1])
    expect(log.list({ text: 'WEB-01' }).map((e) => e.targetLabel)).toEqual(['web-01 primary'])
    expect(log.list({ outcome: 'failure' }).map((e) => e.id)).toEqual([5])
    expect(log.list({ actor: 'tester' })).toHaveLength(5)
    expect(log.list({ from: '2026-01-01T00:00:01.000Z', to: '2026-01-01T00:00:02.000Z' }).map((e) => e.id)).toEqual([3, 2])
    expect(log.list({ limit: 0 })).toHaveLength(1)
    expect(log.list({ limit: 99999 })).toHaveLength(5)
  })

  it('treats LIKE wildcards in text literally and binds values', () => {
    seedFive()
    expect(log.list({ text: '%' })).toHaveLength(0)
    expect(log.list({ text: '_' })).toHaveLength(0)
    expect(log.list({ text: "'; DROP TABLE audit_events;--" })).toHaveLength(0)
    expect(log.list()).toHaveLength(5)
  })

  it('verifies an intact chain', () => {
    seedFive()
    expect(log.verifyChain()).toEqual({ ok: true, count: 5 })
  })

  it('detects a tampered row', () => {
    seedFive()
    db.exec('DROP TRIGGER audit_no_update')
    db.exec("UPDATE audit_events SET target_label='x' WHERE id=3")
    expect(log.verifyChain()).toEqual({ ok: false, count: 5, brokenAtId: 3, reason: 'hash-mismatch' })
  })

  it('tolerates corrupt details JSON', () => {
    seedFive()
    db.exec('DROP TRIGGER audit_no_update')
    db.exec("UPDATE audit_events SET details='{' WHERE id=4")
    expect(log.verifyChain()).toEqual({ ok: false, count: 5, brokenAtId: 4, reason: 'hash-mismatch' })
    const rows = log.list()
    expect(rows).toHaveLength(5)
    expect(rows.find((e) => e.id === 4)?.details).toEqual({ _corrupt: true, bytes: 1 })
  })

  it('detects a broken prev link', () => {
    seedFive()
    db.exec('DROP TRIGGER audit_no_delete')
    db.exec('DELETE FROM audit_events WHERE id=2')
    expect(log.verifyChain()).toMatchObject({ ok: false, brokenAtId: 3, reason: 'prev-link-mismatch' })
  })
})

describe('toCsv', () => {
  it('escapes csv', () => {
    const a = log.append({ action: 'app.start', outcome: 'info', targetLabel: 'a,"b"\nc' })
    const b = log.append({ action: 'app.start', outcome: 'info', targetLabel: '=cmd()' })
    const c = log.append({ action: 'app.start', outcome: 'info', targetLabel: '+x,y' })
    const csv = toCsv([a, b, c])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('id,ts,actor_os_user,actor_machine,action,target_type,target_id,target_label,outcome,details')
    expect(csv).toContain('"a,""b""\nc"')
    expect(csv).toContain(",'=cmd(),")
    expect(csv).toContain(`"'+x,y"`)
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})
