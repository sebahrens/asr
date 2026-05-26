import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './index.js';

interface PragmaColumn {
  name: string;
}

interface PragmaIndex {
  name: string;
}

describe('migration0001Submissions', () => {
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

  function openDatabase(): Database.Database {
    dbPath = join(tmpdir(), `asr-submissions-migration-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    return db;
  }

  it('creates the submissions table schema and indexes', () => {
    const database = openDatabase();

    runMigrations(database);

    const columns = (database.pragma('table_info(submissions)') as PragmaColumn[]).map(
      (column) => column.name,
    );

    expect(columns).toEqual([
      'id',
      'manifest_json',
      'classification',
      'content_hash',
      'submitted_at',
      'submitted_by',
      'branch_name',
      'pr_number',
      'status_phase',
      'status_json',
      'lock_version',
    ]);

    const indexes = (database.pragma('index_list(submissions)') as PragmaIndex[]).map(
      (index) => index.name,
    );

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_submissions_content_hash',
        'idx_submissions_submitted_by',
        'idx_submissions_status_phase',
      ]),
    );
  });

  it('defaults lock_version and rejects unknown classifications', () => {
    const database = openDatabase();
    runMigrations(database);

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
        'submission-1',
        '{}',
        'md-only',
        'sha256:abc',
        '2026-05-24T00:00:00.000Z',
        'submitter@example.com',
        'submitted',
        '{"phase":"submitted"}',
      );

    const lockVersion = database
      .prepare('SELECT lock_version FROM submissions WHERE id = ?')
      .pluck()
      .get('submission-1');

    expect(lockVersion).toBe(0);
    expect(() => {
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
          'submission-2',
          '{}',
          'unknown',
          'sha256:def',
          '2026-05-24T00:00:00.000Z',
          'submitter@example.com',
          'submitted',
          '{"phase":"submitted"}',
        );
    }).toThrow();
  });
});
