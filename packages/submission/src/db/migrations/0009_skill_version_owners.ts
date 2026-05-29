import type Database from 'better-sqlite3';
import { ownerFromPrincipal } from '../../identity/owners.js';
import type { Migration } from './index.js';

interface ExistingSkillVersionRow {
  skill_name: string;
  version: string;
  content_hash: string;
  submission_id: string;
  published_at: string;
  published_by: string;
  approved_by: string | null;
  pr_number: number;
  merge_commit: string;
  scan_report_id: string | null;
  yanked_at: string | null;
  yanked_by: string | null;
  yank_reason: string | null;
}

export const migration0009SkillVersionOwners: Migration = {
  id: 9,
  name: 'skill_version_owners',
  up(db: Database.Database): void {
    const rows = db.prepare('SELECT * FROM skill_versions').all() as ExistingSkillVersionRow[];

    db.exec(`
      DROP INDEX IF EXISTS idx_versions_hash;
      DROP INDEX IF EXISTS idx_versions_pub;
      DROP INDEX IF EXISTS idx_versions_yanked;

      ALTER TABLE skill_versions RENAME TO skill_versions_old;

      CREATE TABLE skill_versions (
        owner TEXT NOT NULL,
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
        yanked_at TEXT,
        yanked_by TEXT,
        yank_reason TEXT,
        PRIMARY KEY (owner, skill_name, version)
      );

      CREATE INDEX idx_versions_hash
        ON skill_versions(content_hash);

      CREATE INDEX idx_versions_pub
        ON skill_versions(published_at);

      CREATE INDEX idx_versions_owner_name_yanked
        ON skill_versions(owner, skill_name)
        WHERE yanked_at IS NULL;
    `);

    const insert = db.prepare(`
      INSERT INTO skill_versions (
        owner,
        skill_name,
        version,
        content_hash,
        submission_id,
        published_at,
        published_by,
        approved_by,
        pr_number,
        merge_commit,
        scan_report_id,
        yanked_at,
        yanked_by,
        yank_reason
      ) VALUES (
        @owner,
        @skill_name,
        @version,
        @content_hash,
        @submission_id,
        @published_at,
        @published_by,
        @approved_by,
        @pr_number,
        @merge_commit,
        @scan_report_id,
        @yanked_at,
        @yanked_by,
        @yank_reason
      )
    `);

    for (const row of rows) {
      insert.run({ ...row, owner: ownerFromPrincipal(row.published_by) });
    }

    db.exec('DROP TABLE skill_versions_old;');
  },
};
