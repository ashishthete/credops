import type { DatabaseSync } from 'node:sqlite'
import './suppress-sqlite-warning'
import { backupBeforeMigrating } from './backup'
import { migrate, migrations, type Db } from './migrations'

export type { Db }

// Loaded lazily: bundlers hoist static imports of externals above the warning filter.
function sqlite(): typeof import('node:sqlite') {
  return process.getBuiltinModule('node:sqlite')
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
  return db
}
