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
import {
  assertRetainedAuditKeys,
  loadKeyRing,
  MissingAuditKeyMaterialError,
  rotateKey,
} from './keyring.js';
import { verifyChain } from './verify.js';

const keyB64 = (byte: number): string =>
  Buffer.alloc(32, byte).toString('base64');

describe('loadKeyRing', () => {
  it('loads the active key and previous keys from env vars', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: keyB64(0x11),
      AUDIT_HMAC_KEY_BYTES_k0: keyB64(0x00),
    };
    const ring = loadKeyRing(env);

    expect(ring.activeId).toBe('k1');

    const active = ring.get('k1');
    expect(active).toBeInstanceOf(Buffer);
    expect(active?.length).toBe(32);

    const previous = ring.get('k0');
    expect(previous).toBeInstanceOf(Buffer);
    expect(previous?.length).toBe(32);

    expect(ring.get('nope')).toBeUndefined();
  });

  it('throws when AUDIT_HMAC_KEY_BYTES does not decode to 32 bytes', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: Buffer.alloc(16, 0x11).toString('base64'),
    };
    expect(() => loadKeyRing(env)).toThrow(/32 bytes/);
  });

  it('throws when AUDIT_HMAC_KEY_ID or AUDIT_HMAC_KEY_BYTES is missing', () => {
    expect(() => loadKeyRing({ AUDIT_HMAC_KEY_ID: 'k1' })).toThrow();
    expect(() =>
      loadKeyRing({ AUDIT_HMAC_KEY_BYTES: keyB64(0x11) }),
    ).toThrow();
  });

  it('addKey extends the keyring at runtime', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: keyB64(0x11),
    };
    const ring = loadKeyRing(env);
    expect(ring.get('k2')).toBeUndefined();

    const k2 = Buffer.alloc(32, 0x22);
    ring.addKey('k2', k2);
    expect(ring.get('k2')).toEqual(k2);
  });

  it('does not override the active key with a same-id previous-key env var', () => {
    const active = keyB64(0x11);
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: active,
      AUDIT_HMAC_KEY_BYTES_k1: keyB64(0x99),
    };
    const ring = loadKeyRing(env);
    expect(ring.get('k1')?.equals(Buffer.from(active, 'base64'))).toBe(true);
  });

  it('setActive switches the active id to a known key', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: keyB64(0x11),
    };
    const ring = loadKeyRing(env);
    ring.addKey('k2', Buffer.alloc(32, 0x22));

    ring.setActive('k2');
    expect(ring.activeId).toBe('k2');
  });

  it('setActive rejects an unknown key id', () => {
    const env = {
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: keyB64(0x11),
    };
    const ring = loadKeyRing(env);
    expect(() => ring.setActive('nope')).toThrow(/unknown key id 'nope'/);
    expect(ring.activeId).toBe('k1');
  });
});

describe('rotateKey', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;

  beforeEach(() => {
    dbPath = join(tmpdir(), `asr-keyring-rotate-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    runMigrations(db);
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
  });

  it('emits a key.rotated event signed by the OLD key and flips active to the new key', () => {
    const database = db!;
    const k1Bytes = Buffer.alloc(32, 0x11);
    const k2Bytes = Buffer.alloc(32, 0x22);

    const ring = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: k1Bytes.toString('base64'),
    });

    const first = emitAudit(
      database,
      {
        action: 'submission.created',
        actor: 'submitter@example.com',
        actorType: 'user',
        detail: { source: 'cli' },
      },
      ring,
    );
    expect(first.hmacKeyId).toBe('k1');

    rotateKey(database, ring, 'k2', k2Bytes);

    expect(ring.activeId).toBe('k2');

    const rotated = database
      .prepare(
        `SELECT id, action, hmac_key_id AS hmacKeyId, detail
           FROM audit_events
          WHERE action = 'key.rotated'
          ORDER BY rowid DESC
          LIMIT 1`,
      )
      .get() as
      | { id: string; action: string; hmacKeyId: string; detail: string }
      | undefined;
    expect(rotated).toBeDefined();
    expect(rotated!.hmacKeyId).toBe('k1');
    expect(JSON.parse(rotated!.detail)).toEqual({
      oldKeyId: 'k1',
      newKeyId: 'k2',
    });

    const next = emitAudit(
      database,
      {
        action: 'submission.classified',
        actor: 'system',
        actorType: 'system',
        detail: { classification: 'md-only' },
      },
      ring,
    );
    expect(next.hmacKeyId).toBe('k2');
    const { hash: nextHash, ...nextUnsigned } = next;
    expect(nextHash).toBe(
      computeHash(
        { ...nextUnsigned, hashVersion: AUDIT_HASH_FORMAT_VERSION },
        k2Bytes,
      ),
    );

    const firstRow = database
      .prepare(
        `SELECT id, submission_id AS submissionId, skill_name AS skillName,
                version, timestamp, actor, actor_type AS actorType, action,
                detail, prev_hash AS prevHash, hash, hmac_key_id AS hmacKeyId
           FROM audit_events
          WHERE id = ?`,
      )
      .get(first.id) as
      | {
          id: string;
          submissionId: string | null;
          skillName: string | null;
          version: string | null;
          timestamp: string;
          actor: string;
          actorType: 'user' | 'system' | 'compliance';
          action: string;
          detail: string;
          prevHash: string;
          hash: string;
          hmacKeyId: string;
        }
      | undefined;
    expect(firstRow).toBeDefined();
    const firstK1 = ring.get('k1');
    expect(firstK1).toBeInstanceOf(Buffer);
    const recomputed = computeHash(
      {
        id: firstRow!.id,
        submissionId: firstRow!.submissionId,
        skillName: firstRow!.skillName,
        version: firstRow!.version,
        timestamp: firstRow!.timestamp,
        actor: firstRow!.actor,
        actorType: firstRow!.actorType,
        action: firstRow!.action as never,
        detail: JSON.parse(firstRow!.detail),
        prevHash: firstRow!.prevHash,
        hmacKeyId: firstRow!.hmacKeyId,
        hashVersion: AUDIT_HASH_FORMAT_VERSION,
      },
      firstK1!,
    );
    expect(firstRow!.hash).toBe(recomputed);
  });

  it('fails startup retention check when a historical rotated key is missing', () => {
    const database = db!;
    const k1Bytes = Buffer.alloc(32, 0x11);
    const k2Bytes = Buffer.alloc(32, 0x22);

    const initialRing = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: k1Bytes.toString('base64'),
    });

    emitAudit(
      database,
      {
        action: 'submission.created',
        actor: 'submitter@example.com',
        actorType: 'user',
        detail: { source: 'cli' },
      },
      initialRing,
    );
    rotateKey(database, initialRing, 'k2', k2Bytes);

    const restartedRing = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k2',
      AUDIT_HMAC_KEY_BYTES: k2Bytes.toString('base64'),
    });

    expect(() => assertRetainedAuditKeys(database, restartedRing)).toThrow(
      MissingAuditKeyMaterialError,
    );
    expect(() => assertRetainedAuditKeys(database, restartedRing)).toThrow(
      /AUDIT_HMAC_KEY_BYTES_<id>/,
    );
  });

  it('accepts a retired key retained for verification after restart', () => {
    const database = db!;
    const k1Bytes = Buffer.alloc(32, 0x11);
    const k2Bytes = Buffer.alloc(32, 0x22);

    const initialRing = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k1',
      AUDIT_HMAC_KEY_BYTES: k1Bytes.toString('base64'),
    });

    emitAudit(
      database,
      {
        action: 'submission.created',
        actor: 'submitter@example.com',
        actorType: 'user',
        detail: { source: 'cli' },
      },
      initialRing,
    );
    rotateKey(database, initialRing, 'k2', k2Bytes);

    const restartedRing = loadKeyRing({
      AUDIT_HMAC_KEY_ID: 'k2',
      AUDIT_HMAC_KEY_BYTES: k2Bytes.toString('base64'),
      AUDIT_HMAC_KEY_BYTES_k1: k1Bytes.toString('base64'),
    });

    expect(() => assertRetainedAuditKeys(database, restartedRing)).not.toThrow();
    expect(verifyChain(database, restartedRing)).toMatchObject({
      valid: true,
      eventCount: 2,
      lastHmacKeyId: 'k1',
    });
  });
});
