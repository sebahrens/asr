import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitAudit } from '../../audit/emit.js';
import { runMigrations } from '../migrations/index.js';
import {
  getAllChronological,
  getBySkill,
  getBySubmission,
  getByUser,
} from './auditEvents.js';

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
    `sha256:${id}`,
    '2026-05-23T00:00:00.000Z',
    'submitter@example.com',
    'submitted',
    '{"phase":"submitted"}',
  );
}

describe('auditEvents repository', () => {
  let db: Database.Database | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    db = new Database(':memory:');
    runMigrations(db);
    seedSubmission(db, 'sub_a');
    seedSubmission(db, 'sub_b');

    // sub_a: skill "foo" v1.0.0 created by alice, then classified by system
    emitAudit(db, {
      action: 'submission.created',
      submissionId: 'sub_a',
      skillName: 'foo',
      version: '1.0.0',
      actor: 'alice',
      actorType: 'user',
      detail: { source: 'cli' },
    });
    emitAudit(db, {
      action: 'submission.classified',
      submissionId: 'sub_a',
      skillName: 'foo',
      version: '1.0.0',
      actor: 'system',
      actorType: 'system',
      detail: { classification: 'md-only' },
    });
    // sub_b: skill "foo" v2.0.0 created by bob
    emitAudit(db, {
      action: 'submission.created',
      submissionId: 'sub_b',
      skillName: 'foo',
      version: '2.0.0',
      actor: 'bob',
      actorType: 'user',
      detail: { source: 'cli' },
    });
    // bar skill event with no submission (e.g., yank) by alice
    emitAudit(db, {
      action: 'version.yanked',
      submissionId: null,
      skillName: 'bar',
      version: '0.1.0',
      actor: 'alice',
      actorType: 'user',
      detail: { reason: 'cve' },
    });
  });

  afterEach(() => {
    db?.close();
    db = undefined;

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

  it('getBySubmission returns only that submission events in chronological order', () => {
    const events = getBySubmission(db!, 'sub_a');
    expect(events.map((e) => e.action)).toEqual([
      'submission.created',
      'submission.classified',
    ]);
    expect(events.every((e) => e.submissionId === 'sub_a')).toBe(true);
    expect(events[0]!.detail).toEqual({ source: 'cli' });
    expect(events[1]!.detail).toEqual({ classification: 'md-only' });
  });

  it('getBySkill returns events across all versions when version is undefined', () => {
    const events = getBySkill(db!, 'foo');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.skillName === 'foo')).toBe(true);
    expect(events.map((e) => e.version)).toEqual(['1.0.0', '1.0.0', '2.0.0']);
    // none of bar's events leak in
    expect(events.some((e) => e.skillName === 'bar')).toBe(false);
  });

  it('getBySkill filters by version when provided', () => {
    const events = getBySkill(db!, 'foo', '1.0.0');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.skillName === 'foo' && e.version === '1.0.0')).toBe(
      true,
    );
    expect(events.map((e) => e.action)).toEqual([
      'submission.created',
      'submission.classified',
    ]);
  });

  it('getByUser returns only that actor events', () => {
    const events = getByUser(db!, 'alice');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor === 'alice')).toBe(true);
    expect(events.map((e) => e.action)).toEqual([
      'submission.created',
      'version.yanked',
    ]);
    expect(getByUser(db!, 'bob').map((e) => e.action)).toEqual([
      'submission.created',
    ]);
    expect(getByUser(db!, 'nobody')).toEqual([]);
  });

  it('getAllChronological returns every row in timestamp/rowid order', () => {
    const events = getAllChronological(db!);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.action)).toEqual([
      'submission.created',
      'submission.classified',
      'submission.created',
      'version.yanked',
    ]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.timestamp >= events[i - 1]!.timestamp).toBe(true);
    }
  });

  it('row mapping preserves snake_case -> camelCase fields and parses detail JSON', () => {
    const events = getBySubmission(db!, 'sub_a');
    const event = events[0]!;
    expect(event).toMatchObject({
      submissionId: 'sub_a',
      skillName: 'foo',
      version: '1.0.0',
      actor: 'alice',
      actorType: 'user',
      action: 'submission.created',
      hmacKeyId: HMAC_KEY_ID,
    });
    expect(event.detail).toEqual({ source: 'cli' });
    expect(event.prevHash).toBe('0'.repeat(64));
    expect(typeof event.hash).toBe('string');
    expect(event.hash).toHaveLength(64);
  });
});
