import type Database from 'better-sqlite3';
import { migration0001Submissions } from './0001_submissions.js';
import { migration0002ScanResults } from './0002_scan_results.js';
import { migration0003WorkflowLocks } from './0003_workflow_locks.js';
import { migration0004AuditEvents } from './0004_audit_events.js';
import { migration0005Versioning } from './0005_versioning.js';
import { migration0006Principals } from './0006_principals.js';
import { migration0007WorkflowRuns } from './0007_workflow_runs.js';
import { migration0008PublishedSkillIndexes } from './0008_published_skill_indexes.js';

export interface Migration {
  id: number;
  name: string;
  up(db: Database.Database): void;
}

export const migrations: Migration[] = [
  migration0001Submissions,
  migration0002ScanResults,
  migration0003WorkflowLocks,
  migration0004AuditEvents,
  migration0005Versioning,
  migration0006Principals,
  migration0007WorkflowRuns,
  migration0008PublishedSkillIndexes,
];

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
