import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0010AuditHashVersion: Migration = {
  id: 10,
  name: 'audit_hash_version',
  up(db: Database.Database): void {
    const columns = db
      .pragma('table_info(audit_events)') as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'hash_version')) {
      return;
    }

    db.exec(`
      ALTER TABLE audit_events
        ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1
    `);
  },
};
