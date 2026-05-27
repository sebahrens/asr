import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { auditChainGuard } from './degraded.js';
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

function seedThreeEvents(database: Database.Database): {
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

function buildApp(database: Database.Database): Hono {
  const keys = loadKeyRing();
  const app = new Hono();
  app.use('*', auditChainGuard(database, keys, { cacheMs: 0 }));
  app.get('/api/v1/skills', (c) => c.json({ ok: true }));
  app.post('/api/v1/submissions', (c) => c.json({ ok: true }));
  return app;
}

describe('auditChainGuard', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    dbPath = join(tmpdir(), `asr-audit-degraded-${randomUUID()}.sqlite`);
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

  it('lets a POST through when the chain is clean', async () => {
    const database = db!;
    seedThreeEvents(database);
    const app = buildApp(database);

    const res = await app.request('/api/v1/submissions', { method: 'POST' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('blocks POST with 503 audit_chain_broken once a row is tampered with, and emits exactly one audit.verify.failed', async () => {
    const database = db!;
    const { e2 } = seedThreeEvents(database);

    database
      .prepare('UPDATE audit_events SET detail = ? WHERE id = ?')
      .run(JSON.stringify({ classification: 'tampered' }), e2.id);

    const app = buildApp(database);

    const res = await app.request('/api/v1/submissions', { method: 'POST' });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: 'audit_chain_broken',
      brokenAt: e2.id,
    });

    // Hit it again — should still be blocked but must NOT re-emit.
    const res2 = await app.request('/api/v1/submissions', { method: 'POST' });
    expect(res2.status).toBe(503);
    await expect(res2.json()).resolves.toEqual({
      error: 'audit_chain_broken',
      brokenAt: e2.id,
    });

    const failedCount = database
      .prepare(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'audit.verify.failed'",
      )
      .pluck()
      .get() as number;
    expect(failedCount).toBe(1);
  });

  it('never blocks GET requests, even when the chain is broken', async () => {
    const database = db!;
    const { e1 } = seedThreeEvents(database);
    database
      .prepare('UPDATE audit_events SET prev_hash = ? WHERE id = ?')
      .run('f'.repeat(64), e1.id);

    const app = buildApp(database);

    const res = await app.request('/api/v1/skills');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    const failedCount = database
      .prepare(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'audit.verify.failed'",
      )
      .pluck()
      .get() as number;
    expect(failedCount).toBe(0);
  });

  it('caches the verify result for the configured TTL to avoid scanning on every write', async () => {
    const database = db!;
    seedThreeEvents(database);
    const keys = loadKeyRing();

    let verifyCallCount = 0;
    const sniffingDb: Database.Database = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string, ...rest: unknown[]) => {
            if (sql.includes('FROM audit_events ORDER BY rowid')) {
              verifyCallCount += 1;
            }
            return (target.prepare as (s: string, ...r: unknown[]) => unknown)(
              sql,
              ...rest,
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database.Database;

    const app = new Hono();
    app.use('*', auditChainGuard(sniffingDb, keys, { cacheMs: 60_000 }));
    app.post('/api/v1/submissions', (c) => c.json({ ok: true }));

    const r1 = await app.request('/api/v1/submissions', { method: 'POST' });
    const r2 = await app.request('/api/v1/submissions', { method: 'POST' });
    const r3 = await app.request('/api/v1/submissions', { method: 'POST' });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(verifyCallCount).toBe(1);
  });
});
