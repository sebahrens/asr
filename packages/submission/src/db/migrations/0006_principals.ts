import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0006Principals: Migration = {
  id: 6,
  name: 'principals',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS principals (
        sub TEXT PRIMARY KEY,
        email TEXT,
        display_name TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_principals_email
        ON principals(email);
    `);
  },
};
