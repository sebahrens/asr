import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { emitAudit } from './emit.js';
import { loadKeyRing } from './keyring.js';
import { verifyChain } from './verify.js';

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

describe('verifyChain', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    dbPath = join(tmpdir(), `asr-audit-verify-${randomUUID()}.sqlite`);
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

  function emitThree(database: Database.Database): {
    e1: ReturnType<typeof emitAudit>;
    e2: ReturnType<typeof emitAudit>;
    e3: ReturnType<typeof emitAudit>;
  } {
    const e1 = emitAudit(database, {
      action: 'submission.created',
      submissionId: 'sub_1',
      skillName: 'example-skill',
      version: '1.0.0',
      actor: 'submitter@example.com',
      actorType: 'user',
      detail: { source: 'cli' },
    });
    const e2 = emitAudit(database, {
      action: 'submission.classified',
      submissionId: 'sub_1',
      skillName: 'example-skill',
      version: '1.0.0',
      actor: 'system',
      actorType: 'system',
      detail: { classification: 'md-only' },
    });
    const e3 = emitAudit(database, {
      action: 'workflow.scan.completed',
      submissionId: 'sub_1',
      skillName: 'example-skill',
      version: '1.0.0',
      actor: 'system',
      actorType: 'system',
      detail: { findings: 0 },
    });
    return { e1, e2, e3 };
  }

  it('returns valid:true with eventCount and lastHash over a clean chain of three events', () => {
    const database = db!;
    const { e3 } = emitThree(database);

    const keys = loadKeyRing();
    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: true,
      eventCount: 3,
      lastHash: e3.hash,
      lastHmacKeyId: HMAC_KEY_ID,
    });
  });

  it('returns valid:true with eventCount:0 and genesis lastHash when no events exist', () => {
    const database = db!;
    const keys = loadKeyRing();

    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: true,
      eventCount: 0,
      lastHash: '0'.repeat(64),
      lastHmacKeyId: null,
    });
  });

  it('flags hash mismatch when a row detail is tampered with after insertion', () => {
    const database = db!;
    const { e2 } = emitThree(database);

    database
      .prepare('UPDATE audit_events SET detail = ? WHERE id = ?')
      .run(JSON.stringify({ classification: 'tampered' }), e2.id);

    const keys = loadKeyRing();
    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: false,
      brokenAt: e2.id,
      reason: 'hash mismatch',
    });
  });

  it('flags hash mismatch when actor_type is tampered with after insertion', () => {
    const database = db!;
    const { e2 } = emitThree(database);

    database
      .prepare('UPDATE audit_events SET actor_type = ? WHERE id = ?')
      .run('compliance', e2.id);

    const keys = loadKeyRing();
    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: false,
      brokenAt: e2.id,
      reason: 'hash mismatch',
    });
  });

  it('flags hash mismatch when hmac_key_id is swapped to another retained key', () => {
    const database = db!;
    const { e2 } = emitThree(database);
    const otherKeyId = 'k-retained';
    const otherKeyBytes = Buffer.alloc(32, 0x99).toString('base64');

    database
      .prepare('UPDATE audit_events SET hmac_key_id = ? WHERE id = ?')
      .run(otherKeyId, e2.id);

    const keys = loadKeyRing({
      AUDIT_HMAC_KEY_ID: HMAC_KEY_ID,
      AUDIT_HMAC_KEY_BYTES: HMAC_KEY_B64,
      [`AUDIT_HMAC_KEY_BYTES_${otherKeyId}`]: otherKeyBytes,
    });
    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: false,
      brokenAt: e2.id,
      reason: 'hash mismatch',
    });
  });

  it('flags prev_hash mismatch when a row prev_hash is rewritten', () => {
    const database = db!;
    const { e2 } = emitThree(database);

    database
      .prepare('UPDATE audit_events SET prev_hash = ? WHERE id = ?')
      .run('f'.repeat(64), e2.id);

    const keys = loadKeyRing();
    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: false,
      brokenAt: e2.id,
      reason: 'prev_hash mismatch',
    });
  });

  it('detects rows using the legacy hash format version', () => {
    const database = db!;
    const { e1 } = emitThree(database);

    database
      .prepare('UPDATE audit_events SET hash_version = 1 WHERE id = ?')
      .run(e1.id);

    const keys = loadKeyRing();
    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: false,
      brokenAt: e1.id,
      reason: 'legacy hash version',
    });
  });

  it('flags unknown key when an event references an hmac_key_id absent from the ring', () => {
    const database = db!;
    const { e1 } = emitThree(database);

    // Build a ring that doesn't have HMAC_KEY_ID
    const otherKeyId = 'k-other';
    const otherKeyBytes = Buffer.alloc(32, 0x99).toString('base64');
    const keys = loadKeyRing({
      AUDIT_HMAC_KEY_ID: otherKeyId,
      AUDIT_HMAC_KEY_BYTES: otherKeyBytes,
    });

    const result = verifyChain(database, keys);

    expect(result).toEqual({
      valid: false,
      brokenAt: e1.id,
      reason: 'unknown key',
    });
  });

  it('does not write to the database (read-only walker)', () => {
    const database = db!;
    emitThree(database);

    const countBefore = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    const lastHashBefore = database
      .prepare('SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1')
      .pluck()
      .get() as string;

    const keys = loadKeyRing();
    verifyChain(database, keys);
    verifyChain(database, keys);

    const countAfter = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    const lastHashAfter = database
      .prepare('SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1')
      .pluck()
      .get() as string;

    expect(countAfter).toBe(countBefore);
    expect(lastHashAfter).toBe(lastHashBefore);
  });
});
