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

interface PragmaIndex {
  name: string;
}

describe('migration0004AuditEvents', () => {
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
    dbPath = join(tmpdir(), `asr-audit-events-migration-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    return db;
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

  it('creates the audit_events table schema and indexes', () => {
    const database = openDatabase();

    runMigrations(database);

    const columns = (database.pragma('table_info(audit_events)') as PragmaColumn[]).map(
      (column) => column.name,
    );

    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'submission_id',
        'actor_type',
        'action',
        'detail',
        'prev_hash',
        'hash',
        'hmac_key_id',
      ]),
    );

    const indexes = (database.pragma('index_list(audit_events)') as PragmaIndex[]).map(
      (index) => index.name,
    );

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_audit_submission',
        'idx_audit_skill',
        'idx_audit_actor',
        'idx_audit_action',
        'idx_audit_timestamp',
      ]),
    );
  });

  it('rejects unknown actor types', () => {
    const database = openDatabase();
    runMigrations(database);
    insertSubmission(database, 'submission-1');

    const insertAuditEvent = database.prepare(`
      INSERT INTO audit_events (
        id,
        submission_id,
        skill_name,
        version,
        timestamp,
        actor,
        actor_type,
        action,
        detail,
        prev_hash,
        hash,
        hmac_key_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    expect(() => {
      insertAuditEvent.run(
        'audit-1',
        'submission-1',
        'owner/example',
        '1.0.0',
        '2026-05-24T00:00:00.000Z',
        'robot@example.com',
        'robot',
        'submission.created',
        '{}',
        'genesis',
        'hash-1',
        'key-1',
      );
    }).toThrow();
  });
});
