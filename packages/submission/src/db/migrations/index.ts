import type Database from 'better-sqlite3';
import { migration0001Submissions } from './0001_submissions.js';
import { migration0002ScanResults } from './0002_scan_results.js';

export interface Migration {
  id: number;
  name: string;
  up(db: Database.Database): void;
}

export const migrations: Migration[] = [migration0001Submissions, migration0002ScanResults];

export function runMigrations(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedIds = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .pluck()
      .all() as number[],
  );
  const recordMigration = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    db.transaction(() => {
      migration.up(db);
      recordMigration.run(migration.id, migration.name, new Date().toISOString());
      appliedIds.add(migration.id);
    })();
  }
}
