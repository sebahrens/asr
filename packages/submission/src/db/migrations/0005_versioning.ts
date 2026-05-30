import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0005Versioning: Migration = {
  id: 5,
  name: 'versioning',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_versions (
        skill_name TEXT NOT NULL,
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        submission_id TEXT NOT NULL REFERENCES submissions(id),
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL,
        approved_by TEXT,
        pr_number INTEGER NOT NULL,
        merge_commit TEXT NOT NULL,
        scan_report_id TEXT REFERENCES scan_results(id),
        risk_assessment TEXT NOT NULL CHECK(risk_assessment IN ('low','medium','high')),
        yanked_at TEXT,
        yanked_by TEXT,
        yank_reason TEXT,
        PRIMARY KEY (skill_name, version)
      );

      CREATE TABLE IF NOT EXISTS version_diffs (
        submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
        from_version TEXT,
        to_version TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        risk TEXT NOT NULL CHECK(risk IN ('low','medium','high')),
        computed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blocked_hashes (
        content_hash TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        version TEXT NOT NULL,
        blocked_at TEXT NOT NULL,
        blocked_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('rejected','yanked','incident'))
      );

      CREATE INDEX IF NOT EXISTS idx_versions_hash
        ON skill_versions(content_hash);

      CREATE INDEX IF NOT EXISTS idx_versions_pub
        ON skill_versions(published_at);

      CREATE INDEX IF NOT EXISTS idx_versions_yanked
        ON skill_versions(skill_name)
        WHERE yanked_at IS NULL;
    `);
  },
};
