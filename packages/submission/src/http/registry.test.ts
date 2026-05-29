import type { SkillKind, SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { insertSkillVersion } from '../db/repositories/skillVersions.js';
import { insertSubmission } from '../db/repositories/submissions.js';
import { regenerateRegistryIndex } from '../jobs/registryIndex.js';
import { registryIndexHandler } from './registryIndex.js';
import { createRegistryRoutes } from './registry.js';

describe('registryRoutes', () => {
  let db: Database.Database | undefined;
  const tempRoots: string[] = [];

  afterEach(async () => {
    db?.close();
    db = undefined;
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

  it('resolves latest from skill_versions and includes yanked versions in detail', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x-110',
      name: 'x',
      version: '1.1.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });
    insertPublishedSubmission(db!, {
      id: 'submission-x-100',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-23T10:05:00.000Z',
    });
    insertPublishedSubmission(db!, {
      id: 'submission-x-120',
      name: 'x',
      version: '1.2.0',
      publishedAt: '2026-05-25T10:05:00.000Z',
    });
    insertSkillVersion(db!, {
      skill_name: 'x',
      version: '1.0.0',
      content_hash: 'sha256:x-100',
      submission_id: 'submission-x-100',
      published_at: '2026-05-23T10:05:00.000Z',
      published_by: 'submitter@example.com',
      approved_by: 'reviewer@example.com',
      pr_number: 1,
      merge_commit: 'merge-100',
      scan_report_id: null,
      yanked_at: null,
      yanked_by: null,
      yank_reason: null,
    });
    insertSkillVersion(db!, {
      skill_name: 'x',
      version: '1.1.0',
      content_hash: 'sha256:x-110',
      submission_id: 'submission-x-110',
      published_at: '2026-05-24T10:05:00.000Z',
      published_by: 'submitter@example.com',
      approved_by: 'reviewer@example.com',
      pr_number: 2,
      merge_commit: 'merge-110',
      scan_report_id: null,
      yanked_at: null,
      yanked_by: null,
      yank_reason: null,
    });
    insertSkillVersion(db!, {
      skill_name: 'x',
      version: '1.2.0',
      content_hash: 'sha256:x-120',
      submission_id: 'submission-x-120',
      published_at: '2026-05-25T10:05:00.000Z',
      published_by: 'submitter@example.com',
      approved_by: 'reviewer@example.com',
      pr_number: 3,
      merge_commit: 'merge-120',
      scan_report_id: null,
      yanked_at: '2026-05-26T08:00:00.000Z',
      yanked_by: 'compliance@example.com',
      yank_reason: 'security incident',
    });

    const res = await app.request('/api/v1/skills/acme/x');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { latestVersion: string; versions: Array<{ version: string; yanked: boolean }> };
    expect(body.latestVersion).toBe('1.1.0');
    expect(body.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: '1.2.0', yanked: true }),
        expect.objectContaining({ version: '1.1.0', yanked: false }),
        expect.objectContaining({ version: '1.0.0', yanked: false }),
      ]),
    );
  });

  it('returns non-yanked versions semver-sorted on the versions endpoint', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x-110',
      name: 'x',
      version: '1.1.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });
    insertPublishedSubmission(db!, {
      id: 'submission-x-100',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-23T10:05:00.000Z',
    });
    insertPublishedSubmission(db!, {
      id: 'submission-x-120',
      name: 'x',
      version: '1.2.0',
      publishedAt: '2026-05-25T10:05:00.000Z',
      yankedAt: '2026-05-26T08:00:00.000Z',
      yankReason: 'security incident',
    });

    const res = await app.request('/api/v1/skills/acme/x/versions');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body = (await res.json()) as Array<{ version: string; yanked: boolean }>;
    expect(body.map((version) => version.version)).toEqual(['1.1.0', '1.0.0']);
    expect(body.every((version) => version.yanked === false)).toBe(true);
  });

  it('returns a pinned version manifest and SKILL.md body', async () => {
    const app = makeApp();
    insertPublishedSubmission(db!, {
      id: 'submission-x',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });

    const res = await app.request('/api/v1/skills/acme/x/v/1.0.0');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    await expect(res.json()).resolves.toEqual({
      manifest: expect.objectContaining({ author: 'acme', name: 'x', version: '1.0.0' }),
      skillMd: '# x',
      version: expect.objectContaining({
        owner: 'acme',
        name: 'x',
        version: '1.0.0',
        yanked: false,
      }),
    });
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

  it('serves disk-backed registry.json with cache validators and excludes yanked versions', async () => {
    const app = makeApp();
    const tempRoot = await mkdtemp(join(tmpdir(), 'asr-registry-index-'));
    tempRoots.push(tempRoot);
    const indexPath = join(tempRoot, 'registry.json');
    insertPublishedSubmission(db!, {
      id: 'submission-x-100',
      name: 'x',
      version: '1.0.0',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });
    insertSkillVersion(db!, {
      skill_name: 'x',
      version: '1.0.0',
      content_hash: 'sha256:x-100',
      submission_id: 'submission-x-100',
      published_at: '2026-05-24T10:05:00.000Z',
      published_by: 'submitter@example.com',
      approved_by: 'reviewer@example.com',
      pr_number: 1,
      merge_commit: 'merge-100',
      scan_report_id: null,
      yanked_at: null,
      yanked_by: null,
      yank_reason: null,
    });
    insertPublishedSubmission(db!, {
      id: 'submission-x-110',
      name: 'x',
      version: '1.1.0',
      publishedAt: '2026-05-25T10:05:00.000Z',
    });
    insertSkillVersion(db!, {
      skill_name: 'x',
      version: '1.1.0',
      content_hash: 'sha256:x-110',
      submission_id: 'submission-x-110',
      published_at: '2026-05-25T10:05:00.000Z',
      published_by: 'submitter@example.com',
      approved_by: 'reviewer@example.com',
      pr_number: 2,
      merge_commit: 'merge-110',
      scan_report_id: null,
      yanked_at: '2026-05-26T10:00:00.000Z',
      yanked_by: 'compliance@example.com',
      yank_reason: 'security incident',
    });
    await regenerateRegistryIndex(db!, {
      path: indexPath,
      now: () => new Date('2026-05-27T10:00:00.000Z'),
    });

    app.get('/registry.json', (c) => registryIndexHandler(c, { db, path: indexPath }));
    const res = await app.request('/registry.json');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(res.headers.get('ETag')).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers.get('Last-Modified')).toBeTruthy();
    await expect(res.json()).resolves.toEqual({
      generatedAt: '2026-05-27T10:00:00.000Z',
      specVersion: '1',
      skills: [
        expect.objectContaining({
          owner: 'acme',
          name: 'x',
          latestVersion: '1.0.0',
          publishedAt: '2026-05-24T10:05:00.000Z',
        }),
      ],
    });

    const notModified = await app.request('/registry.json', {
      headers: { 'If-None-Match': res.headers.get('ETag')! },
    });
    expect(notModified.status).toBe(304);
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
