import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0011AuditAnchorIntents: Migration = {
  id: 11,
  name: 'audit_anchor_intents',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_anchor_intents (
        tag_name TEXT PRIMARY KEY,
        last_hash TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        hmac_key_id TEXT NOT NULL,
        target_sha TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','anchored')),
        commit_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_anchor_intents_status
        ON audit_anchor_intents(status);
    `);
  },
};
