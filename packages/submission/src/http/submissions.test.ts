import type { SkillManifest, Submission, SubmissionStatus } from '@asr/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { AuthVariables, Identity } from '../auth/types.js';
import type { SubmissionInsertRow } from '../db/repositories/submissions.js';
import {
  createSubmissionRoutes,
  type SubmissionLookup,
  type SubmissionPersist,
} from './submissions.js';

describe('POST /api/v1/submissions (zip upload)', () => {
  it('accepts an md-only zip and returns 201 with a ULID id and uploaded status', async () => {
    const persisted: SubmissionInsertRow[] = [];
    const persist: SubmissionPersist = (row) => {
      persisted.push(row);
    };
    const app = makeApp({ persist });
    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
    ]);
    const formData = new FormData();
    formData.set('file', new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }), 'skill.zip');

    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      id: string;
      status: { phase: string };
      manifest: { name: string; version: string };
      contentHash: string;
      createdAt: string;
    };

    expect(data.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(data.status).toEqual({ phase: 'uploaded' });
    expect(data.manifest.name).toBe('demo-skill');
    expect(data.manifest.version).toBe('1.0.0');
    expect(data.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(data.createdAt).toString()).not.toBe('Invalid Date');

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: data.id,
      classification: 'md-only',
      contentHash: data.contentHash,
      submittedBy: 'submitter-1',
      statusPhase: 'uploaded',
    });
    expect(JSON.parse(persisted[0]!.manifestJson)).toMatchObject({ name: 'demo-skill', version: '1.0.0' });
    expect(JSON.parse(persisted[0]!.statusJson)).toEqual({ phase: 'uploaded' });
  });

  it('returns 400 invalid_zip when the uploaded file is not a real zip', async () => {
    const persisted: SubmissionInsertRow[] = [];
    const app = makeApp({
      persist: (row) => {
        persisted.push(row);
      },
    });
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new TextEncoder().encode('not a zip at all, just bytes')], {
        type: 'application/octet-stream',
      }),
      'garbage.bin',
    );

    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('invalid_zip');
    expect(persisted).toHaveLength(0);
  });

  it('returns 422 invalid_manifest when SKILL.md is missing frontmatter', async () => {
    const persisted: SubmissionInsertRow[] = [];
    const app = makeApp({
      persist: (row) => {
        persisted.push(row);
      },
    });
    const zipBytes = await buildZip([
      { path: 'SKILL.md', contents: '# no frontmatter here' },
    ]);
    const formData = new FormData();
    formData.set('file', new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }), 'skill.zip');

    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });

    expect(res.status).toBe(422);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('invalid_manifest');
    expect(persisted).toHaveLength(0);
  });

  it('refuses to persist a submission for an empty-sub identity', async () => {
    const persisted: SubmissionInsertRow[] = [];
    const app = makeApp({
      identity: { sub: '', roles: ['Submitter'] },
      persist: (row) => {
        persisted.push(row);
      },
    });
    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
    ]);
    const formData = new FormData();
    formData.set('file', new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }), 'skill.zip');

    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
    expect(persisted).toHaveLength(0);
  });

  function makeApp(options: {
    persist: SubmissionPersist;
    lookup?: SubmissionLookup;
    identity?: Identity;
  }) {
    const app = new Hono<{ Variables: AuthVariables }>();
    const identity = options.identity ?? { sub: 'submitter-1', roles: ['Submitter'] };
    app.use('*', async (c, next) => {
      c.set('identity', identity);
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({ persist: options.persist, lookup: options.lookup }),
    );
    return app;
  }
});

describe('GET /api/v1/submissions/:id', () => {
  it('returns 200 with the submission after a successful POST', async () => {
    const store = new Map<string, Submission>();
    const persist: SubmissionPersist = (row) => {
      store.set(row.id, insertRowToSubmission(row));
    };
    const lookup: SubmissionLookup = (id) => store.get(id);

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'submitter-1', roles: ['Submitter'] });
      await next();
    });
    app.route('/api/v1/submissions', createSubmissionRoutes({ persist, lookup }));

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const postRes = await app.request('/api/v1/submissions', { method: 'POST', body: formData });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string };

    const getRes = await app.request(`/api/v1/submissions/${created.id}`);
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as Submission;
    expect(data.id).toBe(created.id);
    expect(data.status).toEqual({ phase: 'uploaded' });
    expect(data.classification).toBe('md-only');
    expect(data.manifest.name).toBe('demo-skill');
    expect(data.manifest.version).toBe('1.0.0');
    expect(data.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns 404 submission_not_found for an unknown id', async () => {
    const lookup: SubmissionLookup = () => undefined;
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'submitter-1', roles: ['Submitter'] });
      await next();
    });
    app.route('/api/v1/submissions', createSubmissionRoutes({ persist: () => {}, lookup }));

    const res = await app.request('/api/v1/submissions/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('submission_not_found');
  });
});

function insertRowToSubmission(row: SubmissionInsertRow): Submission {
  const manifest = JSON.parse(row.manifestJson) as SkillManifest;
  const status = JSON.parse(row.statusJson) as SubmissionStatus;
  return {
    id: row.id,
    manifest,
    classification: row.classification,
    contentHash: row.contentHash,
    submittedAt: row.submittedAt,
    submittedBy: row.submittedBy,
    ...(row.branchName != null ? { branchName: row.branchName } : {}),
    ...(row.prNumber != null ? { prNumber: row.prNumber } : {}),
    status,
  };
}

function skillMdFixture(input: { name: string; version: string; author: string }): string {
  return `---
name: ${input.name}
version: ${input.version}
author: ${input.author}
description: A demo skill for integration testing
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

async function buildZip(entries: Array<{ path: string; contents: string }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.contents), entry.path);
  }
  zip.end();
  return streamToBuffer(zip.outputStream);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}
