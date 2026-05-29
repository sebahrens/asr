import type { ForgejoClient } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthVariables, Identity } from '../../src/auth/types.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import {
  getSkillVersion,
  resolveLatestVersion,
} from '../../src/db/repositories/skillVersions.js';
import { getBlockedHash } from '../../src/db/repositories/versions.js';
import { createYankRoutes } from '../../src/http/yank.js';

const HMAC_KEY_B64 = Buffer.alloc(32, 0x42).toString('base64');
const HMAC_KEY_ID = 'k-yank-test';

const OWNER = 'acme';
const SKILL = 'x';
const VERSION = '1.0.0';
const CONTENT_HASH = 'sha256:abcd1234';

describe('POST /api/v1/skills/:owner/:name/versions/:version/yank', () => {
  let db: Database.Database | undefined;
  let forgejo: FakeForgejoClient | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    db = new Database(':memory:');
    runMigrations(db);
    seedPublishedVersion(db, { publishedBy: 'alice' });
    forgejo = new FakeForgejoClient();
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    forgejo = undefined;

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

  it('returns 201 with blocked_hash and marks the version yanked when a Compliance principal differs from publisher', async () => {
    const app = makeApp(db!, forgejo!, { sub: 'carol', roles: ['Compliance'] });

    const res = await app.request(
      `/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}/yank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'leak', severity: 'high' }),
      },
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ yanked: true, blocked_hash: CONTENT_HASH });

    const version = getSkillVersion(db!, SKILL, VERSION);
    expect(version?.yanked_at).not.toBeNull();
    expect(version?.yanked_by).toBe('carol');
    expect(version?.yank_reason).toBe('leak');

    const blocked = getBlockedHash(db!, CONTENT_HASH);
    expect(blocked?.source).toBe('yanked');
    expect(blocked?.reason).toBe('leak');
    expect(blocked?.blocked_by).toBe('carol');

    expect(resolveLatestVersion(db!, SKILL)).toBeUndefined();

    const auditRow = db!
      .prepare(
        "SELECT action, actor, actor_type, skill_name, version, detail FROM audit_events WHERE action = 'version.yanked'",
      )
      .get() as
      | {
          action: string;
          actor: string;
          actor_type: string;
          skill_name: string;
          version: string;
          detail: string;
        }
      | undefined;
    expect(auditRow).toBeDefined();
    expect(auditRow!.actor).toBe('carol');
    expect(auditRow!.actor_type).toBe('compliance');
    expect(auditRow!.skill_name).toBe(SKILL);
    expect(auditRow!.version).toBe(VERSION);
    expect(JSON.parse(auditRow!.detail)).toEqual({ reason: 'leak', severity: 'high' });

    expect(forgejo!.commits).toHaveLength(1);
    expect(forgejo!.commits[0]).toMatchObject({
      owner: OWNER,
      name: SKILL,
      path: `skills/${OWNER}/${SKILL}/YANKED.md`,
      message: `yank ${SKILL}@${VERSION}`,
      idempotencyKey: `yank-${SKILL}-${VERSION}`,
    });
    expect(forgejo!.commits[0].content.toString('utf8')).toBe(`# Yanked ${VERSION}\nleak\n`);
  });

  it('returns 403 separation_of_duties_violation when Compliance principal equals published_by', async () => {
    const app = makeApp(db!, forgejo!, { sub: 'alice', roles: ['Compliance'] });

    const res = await app.request(
      `/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}/yank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'leak', severity: 'high' }),
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'separation_of_duties_violation' });

    const version = getSkillVersion(db!, SKILL, VERSION);
    expect(version?.yanked_at).toBeNull();
    expect(getBlockedHash(db!, CONTENT_HASH)).toBeUndefined();
    expect(forgejo!.commits).toHaveLength(0);
  });

  it('returns 403 insufficient_permissions when principal lacks Compliance role', async () => {
    const app = makeApp(db!, forgejo!, { sub: 'carol', roles: ['Submitter'] });

    const res = await app.request(
      `/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}/yank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'leak', severity: 'high' }),
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'insufficient_permissions' });
    expect(forgejo!.commits).toHaveLength(0);
  });

  it('returns 404 when the version does not exist', async () => {
    const app = makeApp(db!, forgejo!, { sub: 'carol', roles: ['Compliance'] });

    const res = await app.request(
      `/api/v1/skills/${OWNER}/${SKILL}/versions/9.9.9/yank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'leak', severity: 'high' }),
      },
    );

    expect(res.status).toBe(404);
    expect(forgejo!.commits).toHaveLength(0);
  });

  it('returns 400 when the body is missing reason or severity', async () => {
    const app = makeApp(db!, forgejo!, { sub: 'carol', roles: ['Compliance'] });

    const res = await app.request(
      `/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}/yank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '' }),
      },
    );

    expect(res.status).toBe(400);
    expect(forgejo!.commits).toHaveLength(0);
  });

  it('invokes triggerMarketplaceSync exactly once with the yanked skill name', async () => {
    const triggerMarketplaceSync = vi.fn().mockResolvedValue(undefined);
    const app = makeApp(db!, forgejo!, { sub: 'carol', roles: ['Compliance'] }, {
      triggerMarketplaceSync,
    });

    const res = await app.request(
      `/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}/yank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'leak', severity: 'high' }),
      },
    );

    expect(res.status).toBe(201);
    expect(triggerMarketplaceSync).toHaveBeenCalledTimes(1);
    expect(triggerMarketplaceSync).toHaveBeenCalledWith(SKILL);
  });

  it('swallows triggerMarketplaceSync errors so a sync failure does not roll back the yank', async () => {
    const triggerMarketplaceSync = vi
      .fn()
      .mockRejectedValue(new Error('marketplace forgejo unavailable'));
    const app = makeApp(db!, forgejo!, { sub: 'carol', roles: ['Compliance'] }, {
      triggerMarketplaceSync,
    });

    const res = await app.request(
      `/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}/yank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'leak', severity: 'high' }),
      },
    );

    expect(res.status).toBe(201);
    expect(triggerMarketplaceSync).toHaveBeenCalledTimes(1);

    const version = getSkillVersion(db!, SKILL, VERSION);
    expect(version?.yanked_at).not.toBeNull();
  });
});

function makeApp(
  db: Database.Database,
  forgejo: FakeForgejoClient,
  identity: Identity,
  extra: { triggerMarketplaceSync?: (skillName: string) => Promise<void> } = {},
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('identity', identity);
    await next();
  });
  app.route(
    '/api/v1/skills',
    createYankRoutes({
      db,
      forgejo: forgejo as unknown as ForgejoClient,
      triggerMarketplaceSync: extra.triggerMarketplaceSync,
    }),
  );
  return app;
}

function seedPublishedVersion(
  db: Database.Database,
  input: { publishedBy: string },
): void {
  const submissionId = 'sub-prior';
  db.prepare(
    `
      INSERT INTO submissions (
        id, manifest_json, classification, content_hash,
        submitted_at, submitted_by, status_phase, status_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    submissionId,
    '{}',
    'md-only',
    CONTENT_HASH,
    '2026-05-20T00:00:00.000Z',
    input.publishedBy,
    'published',
    '{"phase":"published","publishedAt":"2026-05-20T00:00:00.000Z","mergeCommit":"prior"}',
  );

  db.prepare(
    `
      INSERT INTO skill_versions (
        owner, skill_name, version, content_hash, submission_id,
        published_at, published_by, approved_by, pr_number, merge_commit,
        scan_report_id, yanked_at, yanked_by, yank_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    OWNER,
    SKILL,
    VERSION,
    CONTENT_HASH,
    submissionId,
    '2026-05-20T00:00:00.000Z',
    input.publishedBy,
    null,
    1,
    'prior-merge',
    null,
    null,
    null,
    null,
  );
}

class FakeForgejoClient {
  commits: Array<{
    owner: string;
    name: string;
    path: string;
    content: Buffer;
    message: string;
    idempotencyKey: string;
  }> = [];

  async commitFileToMain(input: {
    owner: string;
    name: string;
    path: string;
    content: Buffer;
    message: string;
    idempotencyKey: string;
  }): Promise<{ sha: string }> {
    this.commits.push(input);
    return { sha: `sha-${this.commits.length}` };
  }
}
