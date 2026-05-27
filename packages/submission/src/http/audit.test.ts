import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitAudit } from '../audit/emit.js';
import { loadKeyRing } from '../audit/keyring.js';
import type { VerifyResult } from '../audit/verify.js';
import type { AuthVariables, Identity } from '../auth/types.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAuditRoutes } from './audit.js';

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

function makeApp(db: Database.Database, identity: Identity | null) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    if (identity) c.set('identity', identity);
    await next();
  });
  app.route('/api/v1/audit', createAuditRoutes({ db, keys: loadKeyRing() }));
  return app;
}

describe('GET /api/v1/audit routes', () => {
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

    // foo events (two versions, two actors)
    emitAudit(db, {
      action: 'submission.created',
      submissionId: 'sub_a',
      skillName: 'foo',
      version: '1.0.0',
      actor: 's1',
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
    emitAudit(db, {
      action: 'submission.created',
      submissionId: 'sub_b',
      skillName: 'foo',
      version: '2.0.0',
      actor: 's2',
      actorType: 'user',
      detail: { source: 'cli' },
    });
    // a different skill, must not appear in /skill/o/foo
    emitAudit(db, {
      action: 'version.yanked',
      submissionId: null,
      skillName: 'bar',
      version: '0.1.0',
      actor: 's1',
      actorType: 'user',
      detail: { reason: 'cve' },
    });
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    if (originalKeyId === undefined) delete process.env.AUDIT_HMAC_KEY_ID;
    else process.env.AUDIT_HMAC_KEY_ID = originalKeyId;
    if (originalKeyBytes === undefined) delete process.env.AUDIT_HMAC_KEY_BYTES;
    else process.env.AUDIT_HMAC_KEY_BYTES = originalKeyBytes;
  });

  it('GET /skill/:owner/:name returns 200 with only that skill events for Compliance', async () => {
    const app = makeApp(db!, { sub: 'r1', roles: ['Compliance'] });
    const res = await app.request('/api/v1/audit/skill/o/foo');
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<{ skillName: string | null; version: string | null; action: string }>;
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.skillName === 'foo')).toBe(true);
    expect(events.some((e) => e.skillName === 'bar')).toBe(false);
    // chronological order
    expect(events.map((e) => e.action)).toEqual([
      'submission.created',
      'submission.classified',
      'submission.created',
    ]);
  });

  it('GET /skill/:owner/:name/v/:version filters to a single version', async () => {
    const app = makeApp(db!, { sub: 'r1', roles: ['Admin'] });
    const res = await app.request('/api/v1/audit/skill/o/foo/v/1.0.0');
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<{ version: string | null }>;
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.version === '1.0.0')).toBe(true);
  });

  it('GET /skill/... returns 403 for Submitter and 401 when unauthenticated', async () => {
    const forbidden = await makeApp(db!, { sub: 's1', roles: ['Submitter'] }).request(
      '/api/v1/audit/skill/o/foo',
    );
    expect(forbidden.status).toBe(403);

    const unauth = await makeApp(db!, null).request('/api/v1/audit/skill/o/foo');
    expect(unauth.status).toBe(401);
  });

  it('GET /user/:sub returns 403 for Compliance but 200 for Admin', async () => {
    const compliance = await makeApp(db!, { sub: 'r1', roles: ['Compliance'] }).request(
      '/api/v1/audit/user/s1',
    );
    expect(compliance.status).toBe(403);

    const admin = await makeApp(db!, { sub: 'r1', roles: ['Admin'] }).request(
      '/api/v1/audit/user/s1',
    );
    expect(admin.status).toBe(200);
    const events = (await admin.json()) as Array<{ actor: string; action: string }>;
    expect(events.every((e) => e.actor === 's1')).toBe(true);
    expect(events.map((e) => e.action)).toEqual(['submission.created', 'version.yanked']);
  });

  it('GET /verify as Admin returns 200 with { valid:true, eventCount, lastHash }', async () => {
    const app = makeApp(db!, { sub: 'r1', roles: ['Admin'] });
    const res = await app.request('/api/v1/audit/verify');
    expect(res.status).toBe(200);
    const result = (await res.json()) as VerifyResult;
    if (!result.valid) {
      throw new Error(`expected valid:true, got ${JSON.stringify(result)}`);
    }
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(4);
    expect(result.lastHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('GET /verify as Compliance returns 403', async () => {
    const app = makeApp(db!, { sub: 'r1', roles: ['Compliance'] });
    const res = await app.request('/api/v1/audit/verify');
    expect(res.status).toBe(403);
  });
});
