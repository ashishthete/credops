import './suppress-sqlite-warning'
import { DatabaseSync } from 'node:sqlite'
import { migrate, type Db } from './migrations'

export type { Db }

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  return db
}
