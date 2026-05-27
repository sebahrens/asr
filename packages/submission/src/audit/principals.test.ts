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
import { getPrincipal, purgePrincipal, upsertPrincipal } from './principals.js';

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

interface PrincipalSnapshot {
  sub: string;
  email: string | null;
  display_name: string | null;
  first_seen: string;
  last_seen: string;
}

function snapshot(
  db: Database.Database,
  sub: string,
): PrincipalSnapshot | undefined {
  return db
    .prepare(
      'SELECT sub, email, display_name, first_seen, last_seen FROM principals WHERE sub = ?',
    )
    .get(sub) as PrincipalSnapshot | undefined;
}

describe('principals helpers', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    dbPath = join(tmpdir(), `asr-principals-${randomUUID()}.sqlite`);
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

  it('upsertPrincipal then getPrincipal returns the email and displayName', () => {
    const database = db!;

    upsertPrincipal(database, {
      sub: 'entra-sub-1',
      email: 'alice@example.com',
      displayName: 'Alice Example',
    });

    expect(getPrincipal(database, 'entra-sub-1')).toEqual({
      email: 'alice@example.com',
      displayName: 'Alice Example',
    });
  });

  it('returns null for an unknown sub', () => {
    const database = db!;
    expect(getPrincipal(database, 'never-seen')).toBeNull();
  });

  it('second upsert with new email overwrites it while first_seen is unchanged', async () => {
    const database = db!;

    upsertPrincipal(database, {
      sub: 'entra-sub-2',
      email: 'old@example.com',
      displayName: 'Old Name',
    });

    const before = snapshot(database, 'entra-sub-2');
    expect(before).toBeDefined();
    const firstSeenBefore = before!.first_seen;
    const lastSeenBefore = before!.last_seen;

    // Ensure the clock advances so last_seen changes.
    await new Promise((resolve) => setTimeout(resolve, 5));

    upsertPrincipal(database, {
      sub: 'entra-sub-2',
      email: 'new@example.com',
      displayName: 'New Name',
    });

    const after = snapshot(database, 'entra-sub-2');
    expect(after).toBeDefined();
    expect(after!.email).toBe('new@example.com');
    expect(after!.display_name).toBe('New Name');
    expect(after!.first_seen).toBe(firstSeenBefore);
    expect(after!.last_seen >= lastSeenBefore).toBe(true);
  });

  it('purgePrincipal returns true when a row is removed, false when absent', () => {
    const database = db!;

    upsertPrincipal(database, {
      sub: 'entra-sub-3',
      email: 'bob@example.com',
      displayName: 'Bob Example',
    });

    expect(purgePrincipal(database, 'entra-sub-3')).toBe(true);
    expect(purgePrincipal(database, 'entra-sub-3')).toBe(false);
    expect(purgePrincipal(database, 'never-existed')).toBe(false);
  });

  it('purgePrincipal erases PII without deleting any audit row or breaking the chain', () => {
    const database = db!;
    const sub = 'entra-sub-purge';

    upsertPrincipal(database, {
      sub,
      email: 'purgeme@example.com',
      displayName: 'Purge Me',
    });

    emitAudit(database, {
      action: 'submission.created',
      submissionId: 'sub_1',
      skillName: 'example-skill',
      version: '1.0.0',
      actor: sub,
      actorType: 'user',
      detail: { source: 'cli' },
    });
    emitAudit(database, {
      action: 'submission.classified',
      submissionId: 'sub_1',
      skillName: 'example-skill',
      version: '1.0.0',
      actor: sub,
      actorType: 'user',
      detail: { classification: 'md-only' },
    });

    const auditCountBefore = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(auditCountBefore).toBe(2);

    expect(purgePrincipal(database, sub)).toBe(true);

    expect(getPrincipal(database, sub)).toBeNull();

    const auditCountAfter = database
      .prepare('SELECT COUNT(*) FROM audit_events')
      .pluck()
      .get() as number;
    expect(auditCountAfter).toBe(auditCountBefore);

    const keys = loadKeyRing();
    const result = verifyChain(database, keys);
    expect(result.valid).toBe(true);
  });
});
