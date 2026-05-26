import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0004AuditEvents: Migration = {
  id: 4,
  name: 'audit_events',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        submission_id TEXT,
        skill_name TEXT,
        version TEXT,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user','system','compliance')),
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        hmac_key_id TEXT NOT NULL,
        FOREIGN KEY (submission_id) REFERENCES submissions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_audit_submission
        ON audit_events(submission_id);

      CREATE INDEX IF NOT EXISTS idx_audit_skill
        ON audit_events(skill_name, version);

      CREATE INDEX IF NOT EXISTS idx_audit_actor
        ON audit_events(actor);

      CREATE INDEX IF NOT EXISTS idx_audit_action
        ON audit_events(action);

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp
        ON audit_events(timestamp);
    `);
  },
};
