import type { Db } from './connection'

/** Runs `fn` in one `BEGIN IMMEDIATE` transaction: commits, or rolls back and rethrows. Not reentrant. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) throw new Error('nested transactions are not supported')
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw err
  }
}
