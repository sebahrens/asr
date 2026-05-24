import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0001Submissions: Migration = {
  id: 1,
  name: 'submissions',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
};
