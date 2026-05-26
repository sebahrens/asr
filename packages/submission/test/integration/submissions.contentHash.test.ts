import { canonicalHash } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { AuthVariables } from '../../src/auth/types.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createSubmissionRoutes } from '../../src/http/submissions.js';

describe('POST /api/v1/submissions content-hash gate', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns 409 content_blocked with source when the canonical hash matches a blocked_hashes row', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const skillFiles = [
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
    ];
    const expectedHash = canonicalHash(
      skillFiles.map((file) => ({ path: file.path, content: Buffer.from(file.contents) })),
    );

    db.prepare(
      `INSERT INTO blocked_hashes (content_hash, skill_name, version, blocked_at, blocked_by, reason, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      expectedHash,
      'demo-skill',
      '1.0.0',
      '2026-05-24T00:00:00.000Z',
      'reviewer@example.com',
      'malicious content',
      'rejected',
    );

    const app = makeApp(db);
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData(skillFiles),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      details?: { source?: string; reason?: string };
    };
    expect(body.error).toBe('content_blocked');
    expect(body.details?.source).toBe('rejected');
    expect(body.details?.reason).toBe('malicious content');

    const submissionCount = db
      .prepare('SELECT COUNT(*) as c FROM submissions')
      .get() as { c: number };
    expect(submissionCount.c).toBe(0);
  });

  it('returns 409 content_blocked with duplicate_content when the hash matches an existing submission', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const skillFiles = [
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
    ];
    const expectedHash = canonicalHash(
      skillFiles.map((file) => ({ path: file.path, content: Buffer.from(file.contents) })),
    );

    db.prepare(
      `INSERT INTO submissions (id, manifest_json, classification, content_hash, submitted_at, submitted_by, status_phase, status_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'existing-sub-1',
      '{}',
      'md-only',
      expectedHash,
      '2026-05-24T00:00:00.000Z',
      'submitter@example.com',
      'submitted',
      '{"phase":"submitted"}',
    );

    const app = makeApp(db);
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData(skillFiles),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      details?: { reason?: string; existingSubmissionId?: string };
    };
    expect(body.error).toBe('content_blocked');
    expect(body.details?.reason).toBe('duplicate_content');
    expect(body.details?.existingSubmissionId).toBe('existing-sub-1');

    const submissionCount = db
      .prepare('SELECT COUNT(*) as c FROM submissions')
      .get() as { c: number };
    expect(submissionCount.c).toBe(1);
  });

  it('persists novel content with content_hash equal to canonicalHash(files)', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const skillFiles = [
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'novel-skill', version: '1.0.0', author: 'alice' }),
      },
    ];
    const expectedHash = canonicalHash(
      skillFiles.map((file) => ({ path: file.path, content: Buffer.from(file.contents) })),
    );

    const fakeForgejo = makeFakeForgejo();
    const app = makeApp(db, fakeForgejo);
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData(skillFiles),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      contentHash: string;
      status: { phase: string };
    };
    expect(body.contentHash).toBe(expectedHash);

    const row = db
      .prepare('SELECT id, content_hash FROM submissions WHERE id = ?')
      .get(body.id) as { id: string; content_hash: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.content_hash).toBe(expectedHash);
  });
});

function makeApp(db: Database.Database, forgejo?: unknown) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('identity', { sub: 'submitter-1', roles: ['Submitter'] });
    await next();
  });
  app.route(
    '/api/v1/submissions',
    createSubmissionRoutes({
      db,
      ...(forgejo ? { forgejo: forgejo as never } : {}),
    }),
  );
  return app;
}

function makeFakeForgejo() {
  return {
    async openSubmissionPR() {
      return { branch: 'submit/x', prNumber: 1, headSha: 'head-sha' };
    },
    async mergePR() {
      return { sha: 'merge-sha' };
    },
    async publishArtifact() {
      return 'https://forgejo.example/package/url';
    },
    async deleteBranch() {
      // no-op
    },
  };
}

function skillMdFixture(input: { name: string; version: string; author: string }): string {
  return `---
name: ${input.name}
version: ${input.version}
author: ${input.author}
description: A demo skill for content-hash gate testing
tags:
  - demo
kind: skill
permissions:
  network: false
  filesystem: none
  subprocess: false
  environment: []
---

# ${input.name}

Hello.
`;
}

async function buildFormData(
  entries: Array<{ path: string; contents: string }>,
): Promise<FormData> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.contents), entry.path);
  }
  zip.end();
  const zipBytes = await streamToBuffer(zip.outputStream);
  const formData = new FormData();
  formData.set(
    'file',
    new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
    'skill.zip',
  );
  return formData;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}
