import type { SkillKind, SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { insertSubmission } from '../db/repositories/submissions.js';
import { createRegistryRoutes } from './registry.js';

describe('registryRoutes', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('lists published skills with cache headers and cursor pagination', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });
    insertPublishedSubmission(db!, {
      id: 'submission-y',
      name: 'y',
      version: '1.0.0',
      tags: ['writing'],
      publishedAt: '2026-05-25T10:05:00.000Z',
    });

    const first = await app.request('/api/v1/skills?limit=1');

    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=60');
    await expect(first.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          owner: 'acme',
          name: 'y',
          latestVersion: '1.0.0',
        }),
      ],
      nextCursor: Buffer.from(JSON.stringify({ offset: 1 }), 'utf8').toString('base64'),
    });

    const second = await app.request('/api/v1/skills?limit=1&cursor=eyJvZmZzZXQiOjF9');

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      items: [expect.objectContaining({ name: 'x' })],
      nextCursor: null,
    });
  });

  it('returns published skill detail', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });

    const res = await app.request('/api/v1/skills/acme/x');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        owner: 'acme',
        name: 'x',
        latestVersion: '1.0.0',
        manifestLatest: expect.objectContaining({ name: 'x' }),
        versions: [expect.objectContaining({ version: '1.0.0' })],
      }),
    );
  });

  it('returns the registry not-found envelope for a missing skill', async () => {
    const app = makeApp();

    const res = await app.request('/api/v1/skills/acme/missing');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_found' });
  });

  it('redirects version downloads to the Forgejo generic package URL', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });

    const res = await app.request('/api/v1/skills/acme/x/v/1.0.0/download', { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      'https://forgejo.example.test/api/packages/acme/generic/x/1.0.0/skill.zip',
    );
    expect(res.headers.get('X-ASR-Yanked')).toBeNull();
  });

  it('marks yanked version download redirects', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
      yankedAt: '2026-05-25T10:05:00.000Z',
      yankReason: 'security incident',
    });

    const res = await app.request('/api/v1/skills/acme/x/v/1.0.0/download', { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('X-ASR-Yanked')).toBe('true');
  });

  it('returns the registry not-found envelope for a missing download version', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });

    const res = await app.request('/api/v1/skills/acme/x/v/2.0.0/download');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_found' });
  });

  function makeApp(): Hono {
    db = new Database(':memory:');
    runMigrations(db);

    const app = new Hono();
    app.route('/api/v1/skills', createRegistryRoutes({ db, forgejoUrl: 'https://forgejo.example.test/api/v1' }));
    return app;
  }
});

interface PublishedSubmissionFixture {
  id: string;
  name: string;
  version: string;
  tags?: string[];
  kind?: SkillKind;
  publishedAt: string;
  yankedAt?: string;
  yankReason?: string;
}

function insertPublishedSubmission(db: Database.Database, fixture: PublishedSubmissionFixture): void {
  insertSubmission(db, {
    id: fixture.id,
    manifestJson: JSON.stringify(
      manifest({
        name: fixture.name,
        version: fixture.version,
        tags: fixture.tags,
        kind: fixture.kind,
      }),
    ),
    classification: 'md-only',
    contentHash: `sha256:${fixture.id}`,
    submittedAt: fixture.publishedAt,
    submittedBy: 'submitter@example.com',
    prNumber: 42,
    statusPhase: 'published',
    statusJson: JSON.stringify({
      phase: 'published',
      publishedAt: fixture.publishedAt,
      mergeCommit: `merge-${fixture.id}`,
      skillMd: `# ${fixture.name}`,
      ...(fixture.yankedAt ? { yankedAt: fixture.yankedAt } : {}),
      ...(fixture.yankReason ? { yankReason: fixture.yankReason } : {}),
    }),
  });
}

function manifest(overrides: Partial<SkillManifest>): SkillManifest {
  const base: SkillManifest = {
    name: 'x',
    version: '1.0.0',
    author: 'acme',
    description: 'Skill x',
    tags: ['automation', 'review'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  };

  return { ...base, ...overrides };
}
