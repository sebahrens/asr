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
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const hasMigration = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .pluck() as Database.Statement<[number], 1 | undefined>;
  const recordMigration = db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)');

  const apply = db.transaction((pending: Migration[]) => {
    for (const migration of pending) {
      if (hasMigration.get(migration.id)) {
        continue;
      }

      migration.up(db);
      recordMigration.run(migration.id, migration.name);
    }
  });

  apply(migrations);
}
