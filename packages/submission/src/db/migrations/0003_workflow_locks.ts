import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0003WorkflowLocks: Migration = {
  id: 3,
  name: 'workflow_locks',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_versions (
        skill_name TEXT NOT NULL,
        version TEXT NOT NULL,
        submission_id TEXT NOT NULL REFERENCES submissions(id),
        acquired_at TEXT NOT NULL,
        PRIMARY KEY (skill_name, version)
      );

      CREATE TABLE IF NOT EXISTS publish_locks (
        skill_name TEXT PRIMARY KEY
      );
    `);
  },
};
