import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0002ScanResults: Migration = {
  id: 2,
  name: 'scan_results',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scan_results (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submissions(id),
        content_hash TEXT NOT NULL,
        scanner_image TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('pass','block','review_required')),
        finding_count INTEGER NOT NULL,
        findings_json TEXT NOT NULL,
        tool_results_json TEXT NOT NULL,
        signature TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_scan_submission
        ON scan_results(submission_id);

      CREATE INDEX IF NOT EXISTS idx_scan_subm_hash
        ON scan_results(submission_id, content_hash);
    `);
  },
};
