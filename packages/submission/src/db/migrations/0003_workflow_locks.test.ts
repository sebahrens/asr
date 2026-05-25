import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './index.js';

interface PragmaColumn {
  name: string;
  pk: number;
}

describe('migration0003WorkflowLocks', () => {
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
    dbPath = join(tmpdir(), `asr-workflow-locks-migration-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    return db;
  }

  function tableInfo(database: Database.Database, tableName: string): PragmaColumn[] {
    return database.pragma(`table_info(${tableName})`) as PragmaColumn[];
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

  it('creates pending_versions with a composite skill and version primary key', () => {
    const database = openDatabase();

    runMigrations(database);

    const columns = tableInfo(database, 'pending_versions');
    expect(columns.map((column) => column.name)).toEqual([
      'skill_name',
      'version',
      'submission_id',
      'acquired_at',
    ]);
    expect(
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
    ).toEqual(['skill_name', 'version']);

    insertSubmission(database, 'submission-1');
    insertSubmission(database, 'submission-2');

    const insertPendingVersion = database.prepare(`
      INSERT INTO pending_versions (
        skill_name,
        version,
        submission_id,
        acquired_at
      )
      VALUES (?, ?, ?, ?)
    `);

    insertPendingVersion.run(
      'owner/example',
      '1.0.0',
      'submission-1',
      '2026-05-24T00:00:00.000Z',
    );

    expect(() => {
      insertPendingVersion.run(
        'owner/example',
        '1.0.0',
        'submission-2',
        '2026-05-24T00:00:01.000Z',
      );
    }).toThrow();
  });

  it('creates publish_locks with skill_name as the primary key', () => {
    const database = openDatabase();

    runMigrations(database);

    const columns = tableInfo(database, 'publish_locks');
    expect(columns.map((column) => column.name)).toEqual(['skill_name']);
    expect(columns[0]?.pk).toBe(1);

    const insertPublishLock = database.prepare(
      'INSERT INTO publish_locks (skill_name) VALUES (?)',
    );

    insertPublishLock.run('owner/example');

    expect(() => {
      insertPublishLock.run('owner/example');
    }).toThrow();
  });
});
