import { describe, expect, it } from 'vitest'
import type { HubActor } from '../../src/shared/hub'
import { HubAudit } from '../src/audit'
import { openHubDb } from '../src/db'

const alice: HubActor = { oid: 'oid-a', upn: 'a@x.com', name: 'Alice', role: 'admin' }
const bob: HubActor = { oid: 'oid-b', upn: 'b@x.com', name: 'Bob', role: 'maintainer' }

function setup(secrets: string[] = []) {
  const db = openHubDb(':memory:')
  let t = Date.parse('2026-10-19T10:00:00Z')
  const audit = new HubAudit(db, { now: () => new Date((t += 60_000)), knownSecrets: () => secrets })
  return { db, audit }
}

describe('HubAudit', () => {
  it('appends a linked chain and verifies', () => {
    const { audit } = setup()
    const a = audit.append({ action: 'hub.start', outcome: 'info', actor: null })
    const b = audit.append({ action: 'group.create', outcome: 'success', actor: alice, targetType: 'group', targetId: 'g1' })
    expect(a.prevHash).toBe('0'.repeat(64))
    expect(b.prevHash).toBe(a.hash)
    expect(b.actor).toEqual(alice)
    expect(audit.verify()).toEqual({ ok: true, count: 2 })
  })

  it('detects a tampered details field', () => {
    const { db, audit } = setup()
    audit.append({ action: 'hub.start', outcome: 'info', actor: null })
    const b = audit.append({ action: 'group.create', outcome: 'success', actor: alice, details: { n: 1 } })
    db.exec('DROP TRIGGER audit_no_update')
    db.exec(`UPDATE audit SET details = '{"n":2}' WHERE id = ${b.id}`)
    expect(audit.verify()).toEqual({ ok: false, count: 2, brokenAtId: b.id, reason: 'hash-mismatch' })
  })

  it('detects a removed row', () => {
    const { db, audit } = setup()
    audit.append({ action: 'hub.start', outcome: 'info', actor: null })
    const b = audit.append({ action: 'group.create', outcome: 'success', actor: alice })
    const c = audit.append({ action: 'group.delete', outcome: 'success', actor: alice })
    db.exec('DROP TRIGGER audit_no_delete')
    db.exec(`DELETE FROM audit WHERE id = ${b.id}`)
    expect(audit.verify()).toEqual({ ok: false, count: 2, brokenAtId: c.id, reason: 'prev-link-mismatch' })
  })

  it('redacts known secrets and sensitive keys before hashing', () => {
    const { db, audit } = setup(['SECRETVALUE1'])
    const e = audit.append({
      action: 'session.create',
      outcome: 'success',
      actor: alice,
      targetLabel: 'SECRETVALUE1',
      details: { token: 'x', note: 'has SECRETVALUE1 inside' },
    })
    expect(e.details).toEqual({ token: '‹redacted›', note: 'has ‹redacted› inside' })
    expect(e.targetLabel).toBe('‹redacted›')
    const raw = JSON.stringify(db.prepare('SELECT * FROM audit').all())
    expect(raw).not.toContain('SECRETVALUE1')
    expect(audit.verify().ok).toBe(true)
  })

  it('filters by action, actor and date', () => {
    const { audit } = setup()
    audit.append({ action: 'hub.start', outcome: 'info', actor: null })
    const b = audit.append({ action: 'group.create', outcome: 'success', actor: alice })
    const c = audit.append({ action: 'group.create', outcome: 'denied', actor: bob })
    audit.append({ action: 'group.delete', outcome: 'success', actor: alice })
    expect(audit.list({ actions: ['group.create'] }).map((e) => e.id)).toEqual([c.id, b.id])
    expect(audit.list({ actorOid: 'oid-b' }).map((e) => e.id)).toEqual([c.id])
    expect(audit.list({ outcome: 'denied' }).map((e) => e.id)).toEqual([c.id])
    expect(audit.list({ from: b.ts, to: c.ts }).map((e) => e.id)).toEqual([c.id, b.id])
    expect(audit.list({ beforeId: c.id, limit: 1 }).map((e) => e.id)).toEqual([b.id])
  })
})
