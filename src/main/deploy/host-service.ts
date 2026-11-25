import { randomUUID } from 'node:crypto'
import type { HostRole } from '../../shared/inventory'
import type { Db } from '../db/connection'

/**
 * Puts a host in an environment the only way there is: by running a service there. A no-op (false) when the host
 * already runs one. Otherwise it adds a placeholder named after the host (made unique in the environment) whose type
 * follows `role`: an app for `app`/`other`, a database at 127.0.0.1 for `db`, a bastion for `bastion`. No
 * transaction and no audit: the caller's own write covers both.
 */
export function ensureHostService(db: Db, environmentId: string, hostId: string, role: HostRole, id: string = randomUUID()): boolean {
  if (db.prepare('SELECT 1 FROM services WHERE environment_id = ? AND host_id = ?').get(environmentId, hostId)) return false
  const host = db.prepare('SELECT label FROM hosts WHERE id = ?').get(hostId) as { label: string } | undefined
  if (!host) throw new Error('host not found')
  if (!db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) throw new Error('environment not found')
  const taken = new Set(
    (db.prepare('SELECT name FROM services WHERE environment_id = ?').all(environmentId) as { name: string }[]).map((r) => r.name.toLowerCase()),
  )
  let name = host.label
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${host.label} ${n}`
  const pos = (db.prepare('SELECT MAX(position) AS p FROM services WHERE environment_id = ?').get(environmentId) as { p: number | null }).p
  const position = pos === null ? 0 : pos + 1
  const ts = new Date().toISOString()
  if (role === 'db') {
    db.prepare(
      `INSERT INTO services(id, environment_id, host_id, name, kind, position, db_engine, db_address, db_port, created_at, updated_at)
        VALUES (?,?,?,?,'db',?,'other','127.0.0.1',5432,?,?)`,
    ).run(id, environmentId, hostId, name, position, ts, ts)
  } else if (role === 'bastion') {
    db.prepare(
      `INSERT INTO services(id, environment_id, host_id, name, kind, position, created_at, updated_at) VALUES (?,?,?,?,'bastion',?,?,?)`,
    ).run(id, environmentId, hostId, name, position, ts, ts)
  } else {
    db.prepare(
      `INSERT INTO services(id, environment_id, host_id, name, kind, position, url_check_from, created_at, updated_at)
        VALUES (?,?,?,?,'service',?,'mac',?,?)`,
    ).run(id, environmentId, hostId, name, position, ts, ts)
  }
  return true
}

/** Takes a host out of an environment: deletes the services it runs there. The number deleted. */
export function removeHostServices(db: Db, environmentId: string, hostId: string): number {
  return Number(db.prepare('DELETE FROM services WHERE environment_id = ? AND host_id = ?').run(environmentId, hostId).changes)
}
