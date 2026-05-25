import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { acquirePendingVersion, releasePendingVersion } from './pendingVersionLock.js';

describe('pending version locks', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function openMigratedDatabase(): Database.Database {
    db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  function insertSubmission(database: Database.Database, id = randomUUID()): string {
    database
      .prepare(
        `
          INSERT INTO submissions (
            id,
            manifest_json,
            classification,
            content_hash,
            submitted_at,
            submitted_by,
            status_phase,
            status_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        JSON.stringify({ name: 'demo', version: '1.0.0' }),
        'md-only',
        `sha256:${id}`,
        new Date().toISOString(),
        'reviewer@example.com',
        'submitted',
        JSON.stringify({ phase: 'submitted' }),
      );

    return id;
  }

  it('acquires each per-skill version once until released', () => {
    const database = openMigratedDatabase();
    const firstSubmissionId = insertSubmission(database);
    const secondSubmissionId = insertSubmission(database);
    const thirdSubmissionId = insertSubmission(database);

    expect(acquirePendingVersion(database, 'demo', '1.0.0', firstSubmissionId)).toBe(true);
    expect(acquirePendingVersion(database, 'demo', '1.0.0', secondSubmissionId)).toBe(false);

    releasePendingVersion(database, 'demo', '1.0.0');

    expect(acquirePendingVersion(database, 'demo', '1.0.0', thirdSubmissionId)).toBe(true);
  });
});
