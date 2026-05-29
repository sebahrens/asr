import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './index.js';

describe('migration0008PublishedSkillIndexes', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;

  afterEach(() => {
    db?.close();

    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }

    db = undefined;
    dbPath = undefined;
  });

  it('adds expression indexes for published skill owner/name and kind lookups', () => {
    dbPath = join(tmpdir(), `asr-published-skill-indexes-${randomUUID()}.sqlite`);
    db = new Database(dbPath);

    runMigrations(db);

    const indexes = db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'index'
            AND tbl_name = 'submissions'
          ORDER BY name
        `,
      )
      .pluck()
      .all();

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_submissions_published_kind',
        'idx_submissions_published_owner_name',
      ]),
    );
  });
});
