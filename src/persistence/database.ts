import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations/index.ts';

export type Db = Database.Database;

export const IN_MEMORY = ':memory:';

/** Opens (creating if needed) the SQLite database and applies pending migrations. */
export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (path !== IN_MEMORY) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  runMigrations(db, migrations);
  return db;
}

/** Applies each unapplied migration in its own transaction. Returns the versions applied. */
export function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    ) STRICT;
  `);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  const versions = migrations.map((m) => m.version);
  if (
    new Set(versions).size !== versions.length ||
    versions.some((v, i) => i > 0 && v <= (versions[i - 1] ?? 0))
  ) {
    throw new Error('Migrations must have unique, strictly increasing versions');
  }

  const done: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    })();
    done.push(migration.version);
  }
  return done;
}
