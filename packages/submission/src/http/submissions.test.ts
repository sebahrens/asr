import type { ScreeningReport, SkillManifest, Submission, SubmissionStatus } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { AuthVariables, Identity } from '../auth/types.js';
import { getBySubmission } from '../db/repositories/auditEvents.js';
import type { SubmissionInsertRow } from '../db/repositories/submissions.js';
import { saveWorkflowRun } from '../db/repositories/workflowRuns.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ApprovalPipelineContext } from '../workflow/approvalPipeline.js';
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

  it('returns 200 for the submitter owner', async () => {
    const submission = makeSubmission({ id: 'sub-1', submittedBy: 'submitter-1' });
    const app = makeLookupApp(submission, { sub: 'submitter-1', roles: ['Submitter'] });

    const res = await app.request('/api/v1/submissions/sub-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Submission;
    expect(body.id).toBe('sub-1');
  });

  it.each([
    ['Compliance', { sub: 'reviewer-1', roles: ['Compliance'] }],
    ['Admin', { sub: 'admin-1', roles: ['Admin'] }],
  ] satisfies Array<[string, Identity]>)('returns 200 for a %s caller', async (_role, identity) => {
    const submission = makeSubmission({ id: 'sub-1', submittedBy: 'submitter-1' });
    const app = makeLookupApp(submission, identity);

    const res = await app.request('/api/v1/submissions/sub-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Submission;
    expect(body.id).toBe('sub-1');
  });

  it('returns 403 for a non-owner submitter', async () => {
    const submission = makeSubmission({ id: 'sub-1', submittedBy: 'submitter-1' });
    const app = makeLookupApp(submission, { sub: 'submitter-2', roles: ['Submitter'] });

    const res = await app.request('/api/v1/submissions/sub-1');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'insufficient_permissions' });
  });

  it('returns 403 for an authenticated caller without an allowed role', async () => {
    const submission = makeSubmission({ id: 'sub-1', submittedBy: 'submitter-1' });
    const app = makeLookupApp(submission, { sub: 'submitter-1', roles: [] });

    const res = await app.request('/api/v1/submissions/sub-1');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'insufficient_permissions',
      required: 'Submitter,Compliance,Admin',
    });
  });
});

describe('GET /api/v1/submissions/:id/screening', () => {
  let db: Database.Database | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('returns the stored ScreeningReport to the submitter owner', async () => {
    const submission = seedSubmission(db!, {
      id: 'sub-1',
      submittedBy: 'submitter-1',
      status: { phase: 'compliance-review' },
    });
    const report = sampleScreeningReport(submission);
    seedWorkflowRun(db!, submission, report);

    const app = makeDbBackedApp(db!, { sub: 'submitter-1', roles: ['Submitter'] });
    const res = await app.request('/api/v1/submissions/sub-1/screening');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(report);
  });

  it('returns the stored ScreeningReport to Compliance reviewers', async () => {
    const submission = seedSubmission(db!, {
      id: 'sub-1',
      submittedBy: 'submitter-1',
      status: { phase: 'compliance-review' },
    });
    const report = sampleScreeningReport(submission);
    seedWorkflowRun(db!, submission, report);

    const app = makeDbBackedApp(db!, { sub: 'reviewer-1', roles: ['Compliance'] });
    const res = await app.request('/api/v1/submissions/sub-1/screening');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(report);
  });

  it('returns 404 when screening has not run for the submission', async () => {
    seedSubmission(db!, {
      id: 'sub-1',
      submittedBy: 'submitter-1',
      status: { phase: 'uploaded' },
    });

    const app = makeDbBackedApp(db!, { sub: 'submitter-1', roles: ['Submitter'] });
    const res = await app.request('/api/v1/submissions/sub-1/screening');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe('submission_not_found');
    expect(body.message).toBe('screening report not found');
  });

  it('rejects a different submitter', async () => {
    const submission = seedSubmission(db!, {
      id: 'sub-1',
      submittedBy: 'submitter-1',
      status: { phase: 'compliance-review' },
    });
    seedWorkflowRun(db!, submission, sampleScreeningReport(submission));

    const app = makeDbBackedApp(db!, { sub: 'submitter-2', roles: ['Submitter'] });
    const res = await app.request('/api/v1/submissions/sub-1/screening');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'insufficient_permissions' });
  });
});

describe('DELETE /api/v1/submissions/:id', () => {
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;
  let db: Database.Database | undefined;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = 'k-test';
    process.env.AUDIT_HMAC_KEY_BYTES = Buffer.alloc(32, 0x42).toString('base64');
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db?.close();
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

  it('withdraws the submitter owned non-terminal submission and emits audit', async () => {
    seedSubmission(db!, {
      id: 'sub-1',
      submittedBy: 'submitter-1',
      status: { phase: 'uploaded' },
    });

    const app = makeDbBackedApp(db!, { sub: 'submitter-1', roles: ['Submitter'] });
    const res = await app.request('/api/v1/submissions/sub-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: { phase: 'withdrawn' },
    });

    const row = db!.prepare('SELECT status_phase, status_json FROM submissions WHERE id = ?').get('sub-1') as {
      status_phase: string;
      status_json: string;
    };
    expect(row.status_phase).toBe('withdrawn');
    expect(JSON.parse(row.status_json)).toMatchObject({ phase: 'withdrawn' });
    expect(getBySubmission(db!, 'sub-1').items).toMatchObject([
      {
        action: 'submission.withdrawn',
        actor: 'submitter-1',
        detail: { reason: 'submitter_withdrawal' },
      },
    ]);
  });

  it('rejects a different submitter', async () => {
    seedSubmission(db!, {
      id: 'sub-1',
      submittedBy: 'submitter-1',
      status: { phase: 'uploaded' },
    });

    const app = makeDbBackedApp(db!, { sub: 'submitter-2', roles: ['Submitter'] });
    const res = await app.request('/api/v1/submissions/sub-1', { method: 'DELETE' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'insufficient_permissions' });
  });

  it('rejects terminal submissions', async () => {
    seedSubmission(db!, {
      id: 'sub-1',
      submittedBy: 'submitter-1',
      status: {
        phase: 'published',
        publishedAt: '2026-05-30T00:00:00.000Z',
        mergeCommit: 'abc123',
      },
    });

    const app = makeDbBackedApp(db!, { sub: 'submitter-1', roles: ['Submitter'] });
    const res = await app.request('/api/v1/submissions/sub-1', { method: 'DELETE' });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_in_expected_state' });
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

function makeLookupApp(submission: Submission, identity: Identity) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('identity', identity);
    await next();
  });
  app.route(
    '/api/v1/submissions',
    createSubmissionRoutes({
      persist: () => {},
      lookup: (id) => (id === submission.id ? submission : undefined),
    }),
  );
  return app;
}

function makeSubmission(input: { id: string; submittedBy: string }): Submission {
  return {
    id: input.id,
    manifest: {
      name: 'demo-skill',
      version: '1.0.0',
      author: 'alice',
      description: 'A demo skill for integration testing',
      tags: ['demo'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'none',
        subprocess: false,
        environment: [],
      },
    },
    classification: 'md-only',
    contentHash: `${input.id}-hash`,
    submittedAt: '2026-05-30T00:00:00.000Z',
    submittedBy: input.submittedBy,
    status: { phase: 'uploaded' },
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

function makeDbBackedApp(db: Database.Database, identity: Identity) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('identity', identity);
    await next();
  });
  app.route('/api/v1/submissions', createSubmissionRoutes({ db }));
  return app;
}

function seedSubmission(
  db: Database.Database,
  input: { id: string; submittedBy: string; status: SubmissionStatus },
): Submission {
  const manifest: SkillManifest = {
    name: 'demo-skill',
    version: '1.0.0',
    author: 'alice',
    description: 'A demo skill for integration testing',
    tags: ['demo'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
  };
  const submittedAt = '2026-05-30T00:00:00.000Z';
  const contentHash = `${input.id}-hash`;
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
    input.id,
    JSON.stringify(manifest),
    'md-only',
    contentHash,
    submittedAt,
    input.submittedBy,
    input.status.phase,
    JSON.stringify(input.status),
  );

  return {
    id: input.id,
    manifest,
    classification: 'md-only',
    contentHash,
    submittedAt,
    submittedBy: input.submittedBy,
    status: input.status,
  };
}

function seedWorkflowRun(
  db: Database.Database,
  submission: Submission,
  screeningReport?: ScreeningReport,
): void {
  const context: ApprovalPipelineContext = {
    submissionId: submission.id,
    submission,
    manifest: submission.manifest,
    files: [],
    contentHash: submission.contentHash,
    extractedDir: '/tmp/asr-test',
    zipBufferBase64: '',
    classification: submission.classification,
    ...(screeningReport ? { screeningReport } : {}),
  };

  saveWorkflowRun(db, {
    id: submission.id,
    submittedBy: submission.submittedBy,
    serializedContext: JSON.stringify(context),
    context,
  });
}

function sampleScreeningReport(submission: Submission): ScreeningReport {
  return {
    submissionId: submission.id,
    contentHash: submission.contentHash,
    provider: 'openai',
    model: 'gpt-test',
    contextTokens: 512,
    status: 'flagged',
    truncated: false,
    startedAt: '2026-05-30T00:00:01.000Z',
    completedAt: '2026-05-30T00:00:02.000Z',
    durationMs: 1000,
    findings: [
      {
        category: 'description',
        severity: 'medium',
        message: 'The description omits generated network behavior.',
        file: 'scripts/network.ts',
      },
    ],
  };
}
