import type { ForgejoClient, SkillManifest, Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { AuthVariables } from '../auth/types.js';
import { runMigrations } from '../db/migrations/index.js';
import { createSubmissionRoutes } from './submissions.js';

describe('POST /api/v1/submissions (md-only auto-publish)', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('publishes an md-only submission inline and exposes published status via GET', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const forgejo = new FakeForgejoClient();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'alice', roles: ['Submitter'] });
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({ db, forgejo: forgejo as unknown as ForgejoClient }),
    );

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
      { path: 'README.md', contents: '# demo-skill\n' },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const postRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as {
      id: string;
      status: { phase: string; mergeCommit?: string };
    };
    expect(created.status.phase).toBe('published');
    expect(created.status.mergeCommit).toBe('abc');

    expect(forgejo.openCalls).toHaveLength(1);
    expect(forgejo.openCalls[0]).toMatchObject({
      submissionId: created.id,
      autoApprove: true,
    });
    expect(forgejo.openCalls[0].files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'SKILL.md',
    ]);
    expect(forgejo.mergeCalls).toEqual([1]);
    expect(forgejo.publishCalls).toHaveLength(1);
    expect(forgejo.publishCalls[0]).toMatchObject({
      owner: 'alice',
      name: 'demo-skill',
      version: '1.0.0',
    });
    expect(forgejo.deleteCalls).toEqual(['submit/x']);

    const getRes = await app.request(`/api/v1/submissions/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Submission;
    expect(fetched.classification).toBe('md-only');
    expect(fetched.status).toMatchObject({ phase: 'published', mergeCommit: 'abc' });
  });

  it('does not invoke publish for code-containing submissions and stays in uploaded', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const forgejo = new FakeForgejoClient();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'alice', roles: ['Submitter'] });
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({ db, forgejo: forgejo as unknown as ForgejoClient }),
    );

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
      { path: 'run.py', contents: 'print("hi")\n' },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const postRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string; status: { phase: string } };
    expect(created.status.phase).toBe('uploaded');
    expect(forgejo.openCalls).toHaveLength(0);

    const getRes = await app.request(`/api/v1/submissions/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Submission;
    expect(fetched.classification).toBe('code-containing');
    expect(fetched.status).toEqual({ phase: 'uploaded' });
  });
});

class FakeForgejoClient {
  openCalls: Array<{
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }> = [];
  mergeCalls: number[] = [];
  publishCalls: Array<{ owner: string; name: string; version: string; zipBuffer: Buffer }> = [];
  deleteCalls: string[] = [];

  async openSubmissionPR(input: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }) {
    this.openCalls.push(input);
    return { branch: 'submit/x', prNumber: 1, headSha: 'head-sha' };
  }

  async mergePR(prNumber: number) {
    this.mergeCalls.push(prNumber);
    return { sha: 'abc' };
  }

  async publishArtifact(input: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
  }) {
    this.publishCalls.push(input);
    return `https://forgejo.example/api/packages/${input.owner}/generic/${input.name}/${input.version}/skill.zip`;
  }

  async deleteBranch(branch: string) {
    this.deleteCalls.push(branch);
  }
}

function skillMdFixture(input: { name: string; version: string; author: string }): string {
  return `---
name: ${input.name}
version: ${input.version}
author: ${input.author}
description: Demo md-only skill for integration testing
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
