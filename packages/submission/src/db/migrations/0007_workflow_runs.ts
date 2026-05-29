import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0007WorkflowRuns: Migration = {
  id: 7,
  name: 'workflow_runs',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
        serialized_context TEXT NOT NULL,
        context_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
        ON workflow_runs(status);

      CREATE INDEX IF NOT EXISTS idx_workflow_runs_updated_at
        ON workflow_runs(updated_at);
    `);
  },
};
