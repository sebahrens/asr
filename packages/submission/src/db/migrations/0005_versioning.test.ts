import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './index.js';

interface PragmaColumn {
  name: string;
}

describe('migration0005Versioning', () => {
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
    dbPath = join(tmpdir(), `asr-versioning-migration-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    return db;
  }

  function columnNames(database: Database.Database, tableName: string): string[] {
    return (database.pragma(`table_info(${tableName})`) as PragmaColumn[]).map(
      (column) => column.name,
    );
  }

  function insertSubmission(database: Database.Database, id: string): void {
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
        '{}',
        'md-only',
        `sha256:${id}`,
        '2026-05-24T00:00:00.000Z',
        'submitter@example.com',
        'submitted',
        '{"phase":"submitted"}',
      );
  }

  it('creates versioning tables and indexes', () => {
    const database = openDatabase();

    runMigrations(database);

    expect(columnNames(database, 'skill_versions')).toEqual([
      'skill_name',
      'version',
      'content_hash',
      'submission_id',
      'published_at',
      'published_by',
      'approved_by',
      'pr_number',
      'merge_commit',
      'scan_report_id',
      'yanked_at',
      'yanked_by',
      'yank_reason',
    ]);
    expect(columnNames(database, 'version_diffs')).toEqual([
      'submission_id',
      'from_version',
      'to_version',
      'diff_json',
      'risk',
      'computed_at',
    ]);
    expect(columnNames(database, 'blocked_hashes')).toEqual([
      'content_hash',
      'skill_name',
      'version',
      'blocked_at',
      'blocked_by',
      'reason',
      'source',
    ]);

    const indexes = database
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'index'
            AND tbl_name = 'skill_versions'
          ORDER BY name
        `,
      )
      .pluck()
      .all();

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_versions_hash',
        'idx_versions_pub',
        'idx_versions_yanked',
      ]),
    );
  });

  it('enforces primary key and enum constraints', () => {
    const database = openDatabase();
    runMigrations(database);

    insertSubmission(database, 'submission-1');
    insertSubmission(database, 'submission-2');

    const insertVersion = database.prepare(`
      INSERT INTO skill_versions (
        skill_name,
        version,
        content_hash,
        submission_id,
        published_at,
        published_by,
        pr_number,
        merge_commit
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertVersion.run(
      'owner/example',
      '1.0.0',
      'sha256:abc',
      'submission-1',
      '2026-05-24T00:00:00.000Z',
      'submitter@example.com',
      42,
      'merge-sha',
    );

    expect(() => {
      insertVersion.run(
        'owner/example',
        '1.0.0',
        'sha256:def',
        'submission-2',
        '2026-05-24T00:00:00.000Z',
        'submitter@example.com',
        43,
        'merge-sha-2',
      );
    }).toThrow();

    expect(() => {
      database
        .prepare(
          `
            INSERT INTO version_diffs (
              submission_id,
              to_version,
              diff_json,
              risk,
              computed_at
            )
            VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(
          'submission-2',
          '1.0.1',
          '{}',
          'bogus',
          '2026-05-24T00:00:00.000Z',
        );
    }).toThrow();

    expect(() => {
      database
        .prepare(
          `
            INSERT INTO blocked_hashes (
              content_hash,
              skill_name,
              version,
              blocked_at,
              blocked_by,
              reason,
              source
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'sha256:blocked',
          'owner/example',
          '1.0.0',
          '2026-05-24T00:00:00.000Z',
          'compliance@example.com',
          'malicious payload',
          'bogus',
        );
    }).toThrow();
  });

  it('is a no-op when migrations are run a second time', () => {
    const database = openDatabase();

    runMigrations(database);
    runMigrations(database);

    const appliedCount = database
      .prepare('SELECT COUNT(*) FROM schema_migrations WHERE id = 5')
      .pluck()
      .get();

    expect(appliedCount).toBe(1);
  });
});
