import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertSchemaKnown, pendingMigrations, type Db, type Migration, type MigrateOptions } from './migrations'

/** How many pre-migration copies are kept beside the database; older ones are deleted. */
export const KEEP_BACKUPS = 3

const BACKUP_NAME = /^(.*)\.pre-v(\d+)\.bak$/

/** True when the database holds any table of its own or any recorded migration (schema_migrations exists by now). */
function hasData(db: Db): boolean {
  const tables = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'")
    .get() as { n: number }
  return tables.n > 0 || (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n > 0
}

/** Deletes all but the `keep` newest `<file>.pre-v<N>.bak` copies (newest = highest N). */
export function pruneBackups(file: string, keep = KEEP_BACKUPS): string[] {
  const dir = dirname(file)
  const base = basename(file)
  const found = readdirSync(dir)
    .map((name) => ({ name, m: BACKUP_NAME.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null && x.m[1] === base)
    .sort((a, b) => Number(b.m[2]) - Number(a.m[2]))
  const removed: string[] = []
  for (const { name } of found.slice(keep)) {
    rmSync(join(dir, name), { force: true })
    removed.push(name)
  }
  return removed
}

/**
 * Before pending migrations run on an existing database, writes a consistent copy of it (VACUUM INTO reads
 * one snapshot, WAL included) to `<file>.pre-v<N>.bak`, N being the highest version about to be applied, and
 * keeps only the newest few. A new or empty database, an in-memory one, or one with nothing pending is not
 * copied. A database written by a newer build is refused first (SchemaTooNewError), and never copied.
 * Returns the backup's path, or null when none was written.
 */
export function backupBeforeMigrating(
  db: Db,
  file: string,
  list: Migration[],
  opts: MigrateOptions = {},
): string | null {
  if (file === ':memory:' || file === '') return null
  assertSchemaKnown(db, list, opts)
  const pending = pendingMigrations(db, list)
  if (pending.length === 0 || !hasData(db)) return null
  const target = `${file}.pre-v${pending.at(-1)!.version}.bak`
  rmSync(target, { force: true })
  db.prepare('VACUUM INTO ?').run(target)
  chmodSync(target, 0o600)
  pruneBackups(file)
  return target
}
