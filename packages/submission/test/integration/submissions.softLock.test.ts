import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { AuthVariables } from '../../src/auth/types.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createSubmissionRoutes } from '../../src/http/submissions.js';

describe('POST /api/v1/submissions per-version soft lock', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('accepts the first submission for name@version and writes a pending_versions row', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const app = makeApp(db, makeFailingForgejo());
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([
        {
          path: 'SKILL.md',
          contents: skillMdFixture({ name: 'demo', version: '1.0.0', author: 'alice' }),
        },
      ]),
    });

    expect(res.status).toBe(500);

    const submissionRow = db
      .prepare('SELECT COUNT(*) as c FROM submissions')
      .get() as { c: number };
    expect(submissionRow.c).toBe(1);

    const pendingRow = db
      .prepare(
        'SELECT skill_name, version FROM pending_versions WHERE skill_name = ? AND version = ?',
      )
      .get('demo', '1.0.0') as { skill_name: string; version: string } | undefined;
    expect(pendingRow).toBeUndefined();
  });

  it('rejects a second submission that targets an already-published name@version with 409', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const app = makeApp(db, makeFakeForgejo());
    const firstRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([
        {
          path: 'SKILL.md',
          contents: skillMdFixture({ name: 'demo', version: '1.0.0', author: 'alice' }),
        },
      ]),
    });
    expect(firstRes.status).toBe(201);

    const pendingRow = db
      .prepare(
        'SELECT skill_name, version FROM pending_versions WHERE skill_name = ? AND version = ?',
      )
      .get('demo', '1.0.0') as { skill_name: string; version: string } | undefined;
    expect(pendingRow).toEqual({ skill_name: 'demo', version: '1.0.0' });

    const secondRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([
        {
          path: 'SKILL.md',
          contents: skillMdFixture({
            name: 'demo',
            version: '1.0.0',
            author: 'alice',
            description: 'A slightly different description to change the content hash',
          }),
        },
      ]),
    });

    expect(secondRes.status).toBe(409);
    const body = (await secondRes.json()) as {
      error: string;
      details?: { name?: string; version?: string; next?: string; current?: string };
    };
    // The first submission published demo@1.0.0; resubmitting the same version is now caught
    // by the update-flow version-greater check (asr-ak7.3) before the per-version soft lock.
    expect(body.error).toBe('version_not_greater');
    expect(body.details?.name).toBe('demo');

    const submissionCount = db
      .prepare('SELECT COUNT(*) as c FROM submissions')
      .get() as { c: number };
    expect(submissionCount.c).toBe(1);
  });

  it('accepts a different version of the same skill while the first version is locked', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const app = makeApp(db, makeFakeForgejo());
    const firstRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([
        {
          path: 'SKILL.md',
          contents: skillMdFixture({ name: 'demo', version: '1.0.0', author: 'alice' }),
        },
      ]),
    });
    expect(firstRes.status).toBe(201);

    const secondRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([
        {
          path: 'SKILL.md',
          contents: skillMdFixture({ name: 'demo', version: '1.1.0', author: 'alice' }),
        },
      ]),
    });
    expect(secondRes.status).toBe(201);

    const pendingCount = db
      .prepare(
        'SELECT COUNT(*) as c FROM pending_versions WHERE skill_name = ?',
      )
      .get('demo') as { c: number };
    expect(pendingCount.c).toBe(2);
  });
});

function makeApp(db: Database.Database, forgejo: unknown) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('identity', { sub: 'submitter-1', roles: ['Submitter'] });
    await next();
  });
  app.route(
    '/api/v1/submissions',
    createSubmissionRoutes({ db, forgejo: forgejo as never }),
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

function makeFailingForgejo() {
  return {
    async openSubmissionPR(): Promise<never> {
      throw new Error('simulated forgejo outage');
    },
    async mergePR(): Promise<never> {
      throw new Error('simulated forgejo outage');
    },
    async publishArtifact(): Promise<never> {
      throw new Error('simulated forgejo outage');
    },
    async deleteBranch(): Promise<void> {
      // no-op
    },
  };
}

function skillMdFixture(input: {
  name: string;
  version: string;
  author: string;
  description?: string;
}): string {
  return `---
name: ${input.name}
version: ${input.version}
author: ${input.author}
description: ${input.description ?? 'A demo skill for soft-lock testing'}
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
