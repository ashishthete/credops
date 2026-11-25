import { chmodSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import './suppress-sqlite-warning'
import { backupBeforeMigrating } from './backup'
import { migrate, migrations, type Db } from './migrations'

export type { Db }

// Loaded lazily: bundlers hoist static imports of externals above the warning filter.
function sqlite(): typeof import('node:sqlite') {
  return process.getBuiltinModule('node:sqlite')
}

/** The database holds host addresses, the audit log and encrypted secrets: only its owner reads it, as with its backups. */
function ownerOnly(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(f, 0o600)
    } catch {
      // the side files exist only while there is something in them
    }
  }
}

export function openDatabase(file: string): Db {
  const db: DatabaseSync = new (sqlite().DatabaseSync)(file)
  db.exec('PRAGMA foreign_keys = ON')
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  try {
    // Refuses a database from a newer build, then copies an existing one aside before changing its schema.
    backupBeforeMigrating(db, file, migrations)
    migrate(db)
  } catch (err) {
    db.close()
    throw err
  }
  if (file !== ':memory:') ownerOnly(file)
  return db
}
