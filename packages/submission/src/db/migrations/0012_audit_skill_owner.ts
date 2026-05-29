import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0012AuditSkillOwner: Migration = {
  id: 12,
  name: 'audit_skill_owner',
  up(db: Database.Database): void {
    const columns = db.pragma('table_info(audit_events)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'skill_owner')) {
      db.exec('ALTER TABLE audit_events ADD COLUMN skill_owner TEXT;');
    }

    db.exec(`
      UPDATE audit_events
      SET skill_owner = (
        SELECT sv.owner
        FROM skill_versions sv
        WHERE sv.skill_name = audit_events.skill_name
          AND sv.version = audit_events.version
          AND (
            audit_events.submission_id IS NULL
            OR sv.submission_id = audit_events.submission_id
          )
        ORDER BY
          CASE WHEN sv.submission_id = audit_events.submission_id THEN 0 ELSE 1 END,
          sv.published_at DESC
        LIMIT 1
      )
      WHERE skill_owner IS NULL
        AND skill_name IS NOT NULL
        AND version IS NOT NULL;

      DROP INDEX IF EXISTS idx_audit_skill;

      CREATE INDEX IF NOT EXISTS idx_audit_skill
        ON audit_events(skill_owner, skill_name, version);
    `);
  },
};
