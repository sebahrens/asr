import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0001Submissions: Migration = {
  id: 1,
  name: 'submissions',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        classification TEXT NOT NULL CHECK(classification IN ('md-only','code-containing')),
        content_hash TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        branch_name TEXT,
        pr_number INTEGER,
        status_phase TEXT NOT NULL,
        status_json TEXT NOT NULL,
        lock_version INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_submissions_content_hash
        ON submissions(content_hash);

      CREATE INDEX IF NOT EXISTS idx_submissions_submitted_by
        ON submissions(submitted_by);

      CREATE INDEX IF NOT EXISTS idx_submissions_status_phase
        ON submissions(status_phase);
    `);
  },
};
