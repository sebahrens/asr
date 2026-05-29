import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { AUDIT_HASH_FORMAT_VERSION, computeHash } from './hash.js';
import { emitAudit } from './emit.js';
import { loadKeyRing } from './keyring.js';

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
      expect(hash).toBe(
        computeHash(
          { ...unsigned, hashVersion: AUDIT_HASH_FORMAT_VERSION },
          HMAC_KEY_BYTES,
        ),
      );
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

  it('rejects a detail payload containing a PII key before any DB write', () => {
    const database = db!;

    expect(() =>
      emitAudit(database, {
        action: 'submission.created',
        submissionId: 'sub_1',
        actor: 'sub_1',
        actorType: 'user',
        detail: { email: 'x@y.z' },
      }),
    ).toThrow(/audit detail must not contain PII key: email/);

    const rowCount = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(rowCount).toBe(0);
  });

  it('rejects PII keys regardless of casing', () => {
    const database = db!;

    expect(() =>
      emitAudit(database, {
        action: 'submission.created',
        submissionId: 'sub_1',
        actor: 'sub_1',
        actorType: 'user',
        detail: { DisplayName: 'Alice' },
      }),
    ).toThrow(/audit detail must not contain PII key: DisplayName/);
  });

  it('inserts one row when the detail is PII-free', () => {
    const database = db!;

    emitAudit(database, {
      action: 'submission.created',
      submissionId: 'sub_1',
      actor: 'sub_1',
      actorType: 'user',
      detail: { submissionId: 's1' },
    });

    const rowCount = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(rowCount).toBe(1);
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

  it('signs with the KeyRing active key and stamps its id on the row', () => {
    const database = db!;

    const k2Bytes = Buffer.alloc(32, 0x22);
    const keys = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k2',
      AUDIT_HMAC_KEY_BYTES: k2Bytes.toString('base64'),
    });

    const event = emitAudit(
      database,
      {
        action: 'submission.created',
        submissionId: 'sub_1',
        actor: 'submitter@example.com',
        actorType: 'user',
        detail: { source: 'cli' },
      },
      keys,
    );

    expect(event.hmacKeyId).toBe('k2');
    const { hash, ...unsigned } = event;
    expect(hash).toBe(
      computeHash(
        { ...unsigned, hashVersion: AUDIT_HASH_FORMAT_VERSION },
        k2Bytes,
      ),
    );
  });

  it('picks up a rotated active key id on the next emit', () => {
    const database = db!;

    const k2Bytes = Buffer.alloc(32, 0x22);
    const k3Bytes = Buffer.alloc(32, 0x33);
    const keys = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k2',
      AUDIT_HMAC_KEY_BYTES: k2Bytes.toString('base64'),
    });

    const first = emitAudit(
      database,
      {
        action: 'submission.created',
        submissionId: 'sub_1',
        actor: 'submitter@example.com',
        actorType: 'user',
        detail: {},
      },
      keys,
    );
    expect(first.hmacKeyId).toBe('k2');

    keys.addKey('k3', k3Bytes);
    keys.setActive('k3');

    const second = emitAudit(
      database,
      {
        action: 'submission.classified',
        submissionId: 'sub_1',
        actor: 'system',
        actorType: 'system',
        detail: { classification: 'md-only' },
      },
      keys,
    );

    expect(second.hmacKeyId).toBe('k3');
    const { hash, ...unsigned } = second;
    expect(hash).toBe(
      computeHash(
        { ...unsigned, hashVersion: AUDIT_HASH_FORMAT_VERSION },
        k3Bytes,
      ),
    );
  });

  it('throws when the KeyRing has no bytes for its active id', () => {
    const database = db!;

    const keys = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: Buffer.alloc(32, 0x11).toString('base64'),
    });
    // Force a mismatch by mutating the underlying map via addKey on a
    // different id and overriding activeId would require setActive on an
    // unknown id (rejected). Instead, simulate via a hand-rolled KeyRing:
    const broken = {
      activeId: 'missing',
      get: () => undefined,
      addKey: () => {},
      setActive: () => {},
    };

    expect(() =>
      emitAudit(
        database,
        {
          action: 'submission.created',
          submissionId: 'sub_1',
          actor: 'submitter@example.com',
          actorType: 'user',
          detail: {},
        },
        broken,
      ),
    ).toThrow(/no bytes for active key id 'missing'/);
    void keys;
  });
});
