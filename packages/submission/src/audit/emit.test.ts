import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { computeHash } from './hash.js';
import { emitAudit } from './emit.js';

const HMAC_KEY_BYTES = Buffer.alloc(32, 0x42);
const HMAC_KEY_B64 = HMAC_KEY_BYTES.toString('base64');
const HMAC_KEY_ID = 'k-test';

function seedSubmission(db: Database.Database, id: string): void {
  db.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    '{}',
    'md-only',
    'sha256:test',
    '2026-05-23T00:00:00.000Z',
    'submitter@example.com',
    'submitted',
    '{"phase":"submitted"}',
  );
}

describe('emitAudit', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    dbPath = join(tmpdir(), `asr-audit-emit-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    runMigrations(db);
    seedSubmission(db, 'sub_1');
  });

  afterEach(() => {
    db?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    db = undefined;
    dbPath = undefined;

    if (originalKeyId === undefined) {
      delete process.env.AUDIT_HMAC_KEY_ID;
    } else {
      process.env.AUDIT_HMAC_KEY_ID = originalKeyId;
    }
    if (originalKeyBytes === undefined) {
      delete process.env.AUDIT_HMAC_KEY_BYTES;
    } else {
      process.env.AUDIT_HMAC_KEY_BYTES = originalKeyBytes;
    }
  });

  it('chains two sequential events and signs each row with computeHash', () => {
    const database = db!;

    const event1 = emitAudit(database, {
      action: 'submission.created',
      submissionId: 'sub_1',
      skillName: 'example-skill',
      version: '1.0.0',
      actor: 'submitter@example.com',
      actorType: 'user',
      detail: { source: 'cli' },
    });

    const event2 = emitAudit(database, {
      action: 'submission.classified',
      submissionId: 'sub_1',
      skillName: 'example-skill',
      version: '1.0.0',
      actor: 'system',
      actorType: 'system',
      detail: { classification: 'md-only' },
    });

    expect(event1.prevHash).toBe('0'.repeat(64));
    expect(event2.prevHash).toBe(event1.hash);

    for (const event of [event1, event2]) {
      const { hash, ...unsigned } = event;
      expect(hash).toBe(computeHash(unsigned, HMAC_KEY_BYTES));
    }

    const rowCount = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(rowCount).toBe(2);
  });

  it('rejects an unknown action before any DB write', () => {
    const database = db!;

    expect(() =>
      emitAudit(database, {
        // deliberately bypass typing to simulate a runtime mistake
        action: 'bogus.action' as never,
        submissionId: 'sub_1',
        actor: 'system',
        actorType: 'system',
        detail: {},
      }),
    ).toThrow(/unknown audit action: bogus\.action/);

    const rowCount = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(rowCount).toBe(0);
  });

  it('leaves zero audit rows when the caller transaction rolls back', () => {
    const database = db!;

    expect(() => {
      database.transaction(() => {
        emitAudit(database, {
          action: 'submission.created',
          submissionId: 'sub_1',
          actor: 'submitter@example.com',
          actorType: 'user',
          detail: {},
        });
        throw new Error('caller rollback');
      })();
    }).toThrow(/caller rollback/);

    const rowCount = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(rowCount).toBe(0);
  });

  it('does not open its own transaction (subsequent caller insert can still be rolled back)', () => {
    const database = db!;

    expect(() => {
      database.transaction(() => {
        emitAudit(database, {
          action: 'submission.created',
          submissionId: 'sub_1',
          actor: 'submitter@example.com',
          actorType: 'user',
          detail: {},
        });
        throw new Error('still inside caller tx');
      })();
    }).toThrow();

    const rowCount = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(rowCount).toBe(0);
  });
});
