import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration0010AuditHashVersion } from './0010_audit_hash_version.js';

describe('migration0010AuditHashVersion', () => {
  it('marks pre-existing audit rows as legacy hash version 1', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL
        );
        INSERT INTO audit_events (id, hash) VALUES ('evt_1', 'abc');
      `);

      migration0010AuditHashVersion.up(db);

      const row = db
        .prepare('SELECT hash_version FROM audit_events WHERE id = ?')
        .get('evt_1') as { hash_version: number };
      expect(row.hash_version).toBe(1);
    } finally {
      db.close();
    }
  });

  it('is idempotent when the column already exists', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          hash_version INTEGER NOT NULL DEFAULT 2
        );
      `);

      migration0010AuditHashVersion.up(db);
      migration0010AuditHashVersion.up(db);

      const columns = db.pragma('table_info(audit_events)') as Array<{
        name: string;
      }>;
      expect(columns.filter((column) => column.name === 'hash_version')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
