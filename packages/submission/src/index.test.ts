import { ForgejoClient, type AuditAction, type ScanReport, type SkillManifest, type Submission, type SubmissionStatus, type VersionDiff } from '@asr/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import type { app as App, createApp as CreateApp } from './index.js';
import type { SubmissionInsertRow } from './db/repositories/submissions.js';
import type { WorkflowSubmissionRecord, WorkflowSubmissionStore } from './http/workflow.js';
import {
  resumeApprovalPipeline,
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
} from './workflow/approvalPipeline.js';

let app: typeof App;
let createApp: typeof CreateApp;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');
  vi.stubEnv('MOCK_USER_SUB', 'mock-user');
  vi.stubEnv('MOCK_USER_ROLES', 'Submitter,Compliance');

  ({ app, createApp } = await import('./index.js'));
});

describe('app', () => {
  it('returns health status', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('returns health status on the API-prefixed readiness route', async () => {
    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('does not expose the obsolete healthz liveness route', async () => {
    const res = await app.request('/healthz');

    expect(res.status).toBe(404);
  });

  it('allows the local Vite app to call the API during mock-auth development', async () => {
    const res = await app.request('/api/v1/skills', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('does not reflect dev CORS origins when real auth is enabled', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_MODE', 'entra');
    vi.stubEnv('AZURE_TENANT_ID', 'tenant-id');
    vi.stubEnv('AZURE_CLIENT_ID', 'client-id');

    const { createApp: createRealAuthApp } = await import('./index.js');
    const realAuthApp = createRealAuthApp();
    const res = await realAuthApp.request('/api/v1/skills', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull();

    vi.stubEnv('AUTH_MODE', 'mock');
    vi.stubEnv('MOCK_USER_SUB', 'mock-user');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter,Compliance');
  });

  it('serves public registry skills on the route used by the web browse page', async () => {
    const res = await app.request('/api/v1/skills?q=security');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      items: [
        {
          owner: 'submitter-1',
          name: 'security-review',
          latestVersion: '1.0.0',
        },
      ],
    });
  });

  it('serves pending submissions on the route used by the review dashboard', async () => {
    const store = new TestWorkflowStore();
    const dependencies = makeDependencies(new FakeForgejoClient(), makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    await store.save({
      id: 'sub-1',
      submittedBy: 'submitter-1',
      serializedContext: '{}',
      context: {
        ...makeContext(),
        status: 'compliance-review',
        scanReport: makeScanReport('review_required'),
      },
    });

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const res = await submissionApp.request('/api/v1/submissions?status=pending');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      submissions: [
        {
          id: 'sub-1',
          skillName: 'demo-skill',
          owner: 'submitter-1',
          version: '1.0.0',
          status: 'pending review',
        },
      ],
    });
  });

  it('seeds the mock-development API with pending review submissions for the dashboard', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');

    const res = await app.request('/api/v1/submissions?status=pending');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      submissions: [
        {
          id: 'sub-1042',
          skillName: 'secure-code-review',
          owner: 'maria-chen',
          version: '1.4.0',
          status: 'pending review',
          risk: 'high',
          findings: 3,
        },
        {
          id: 'sub-1039',
          skillName: 'release-notes',
          owner: 'eli-warner',
          version: '0.8.2',
          status: 'pending review',
          risk: 'medium',
          findings: 1,
        },
      ],
    });
  });

  it('creates a zip submission on the canonical route and returns the same row by id', async () => {
    const store = new Map<string, Submission>();
    const persist = (row: SubmissionInsertRow) => {
      store.set(row.id, insertRowToSubmission(row));
    };
    const lookup = (id: string) => store.get(id);
    const submissionApp = createApp({
      submissions: { persist, lookup },
    });
    const zipBytes = await buildZip([{ path: 'SKILL.md', contents: skillMdFixture() }]);
    const body = new FormData();
    body.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    vi.stubEnv('MOCK_USER_SUB', 'submitter-42');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter');
    const created = await submissionApp.request('/api/v1/submissions', {
      method: 'POST',
      body,
    });

    expect(created.status).toBe(201);
    const data = await created.json() as { id: string; manifest: SkillManifest };
    expect(data.manifest).toMatchObject({
      author: 'alice',
      name: 'demo-skill',
      version: '1.0.0',
    });

    const fetched = await submissionApp.request(`/api/v1/submissions/${data.id}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      id: data.id,
      submittedBy: 'submitter-42',
      manifest: {
        author: 'alice',
        name: 'demo-skill',
        version: '1.0.0',
      },
      status: { phase: 'uploaded' },
    });
  });

  it('does not expose the removed skill-markdown submission shortcut', async () => {
    const store = new TestWorkflowStore();
    const forgejo = new FakeForgejoClient();
    const dependencies = makeDependencies(forgejo, makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });

    vi.stubEnv('MOCK_USER_SUB', 'submitter-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter');
    const body = new FormData();
    body.set('owner', 'alice');
    body.set('skillMd', `---
name: demo-skill
version: 1.0.0
author: alice
description: Demo skill
tags:
  - demo
kind: skill
permissions:
  network: false
  filesystem: none
  subprocess: false
  environment: []
---

# demo-skill
`);

    const created = await submissionApp.request('/api/v1/submissions', {
      method: 'POST',
      body,
    });

    expect(created.status).toBe(404);
    expect(store.list()).toHaveLength(0);
    expect(forgejo.openedSubmissionPRs).toBe(0);
    expect(forgejo.publishedArtifact).toBeUndefined();
  });

  it('rejects multipart and skill markdown submissions when the caller has no submitter role', async () => {
    const persistedRows: unknown[] = [];
    const store = new TestWorkflowStore();
    const dependencies = makeDependencies(new FakeForgejoClient(), makeScanReport('pass'));
    const submissionApp = createApp({
      submissions: {
        persist: (row) => {
          persistedRows.push(row);
        },
      },
      workflow: { store, dependencies, now: fixedNow },
    });

    vi.stubEnv('MOCK_USER_SUB', 'viewer-1');
    vi.stubEnv('MOCK_USER_ROLES', '');

    const multipartBody = new FormData();
    multipartBody.set(
      'file',
      new Blob([new Uint8Array(await buildZip([{ path: 'SKILL.md', contents: skillMdFixture() }]))], {
        type: 'application/zip',
      }),
      'skill.zip',
    );
    const multipartRes = await submissionApp.request('/api/v1/submissions', {
      method: 'POST',
      body: multipartBody,
    });

    const markdownBody = new FormData();
    markdownBody.set('owner', 'alice');
    markdownBody.set('skillMd', skillMdFixture());
    const markdownRes = await submissionApp.request('/api/v1/submissions', {
      method: 'POST',
      body: markdownBody,
    });

    expect(multipartRes.status).toBe(403);
    expect(await multipartRes.json()).toMatchObject({ error: 'insufficient_permissions' });
    expect(markdownRes.status).toBe(403);
    expect(await markdownRes.json()).toMatchObject({ error: 'insufficient_permissions' });
    expect(persistedRows).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  it('drives questionnaire, scan, confirm, and approve endpoints', async () => {
    const store = new TestWorkflowStore();
    const forgejo = new FakeForgejoClient();
    const scanReport = makeScanReport('review_required');
    const dependencies = makeDependencies(forgejo, scanReport);
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    await store.save(await seedAwaitingQuestionnaire(dependencies));

    vi.stubEnv('MOCK_USER_SUB', 'submitter-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter');
    const questionnaire = await submissionApp.request('/api/v1/submissions/sub-1/questionnaire', {
      method: 'POST',
      body: JSON.stringify({ responses: [{ questionId: 'network', answer: false }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(questionnaire.status).toBe(200);
    await expect(questionnaire.json()).resolves.toEqual({
      status: { phase: 'scanning', scanJobId: 'scan:sub-1' },
    });

    const scan = await submissionApp.request('/api/v1/submissions/sub-1/scan');
    expect(scan.status).toBe(200);
    await expect(scan.json()).resolves.toMatchObject({ scanId: scanReport.scanId, verdict: 'review_required' });

    const confirm = await submissionApp.request('/api/v1/submissions/sub-1/confirm', { method: 'POST' });
    expect(confirm.status).toBe(200);
    await expect(confirm.json()).resolves.toEqual({ status: { phase: 'compliance-review' } });

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const approve = await submissionApp.request('/api/v1/submissions/sub-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'looks good' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(approve.status).toBe(200);
    await expect(approve.json()).resolves.toEqual({
      status: {
        phase: 'published',
        publishedAt: '2026-05-24T00:00:00.000Z',
        mergeCommit: 'merge-sha',
      },
      publishedVersion: '1.0.0',
      registryUrl: '/skills/submitter-1/demo-skill',
    });
    expect(forgejo.publishedArtifact).toMatchObject({ owner: 'submitter-1', name: 'demo-skill', version: '1.0.0' });
  });

  it('accepts approval decisions on the versioned API route used by the web dashboard', async () => {
    const store = new TestWorkflowStore();
    const forgejo = new FakeForgejoClient();
    const dependencies = makeDependencies(forgejo, makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    await store.save(await seedAwaitingReview(dependencies));

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const approve = await submissionApp.request('/api/v1/submissions/sub-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'approved from review dashboard' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(approve.status).toBe(200);
    await expect(approve.json()).resolves.toMatchObject({
      status: {
        phase: 'published',
        mergeCommit: 'merge-sha',
      },
      publishedVersion: '1.0.0',
    });
    expect(forgejo.publishedArtifact).toMatchObject({ owner: 'submitter-1', name: 'demo-skill', version: '1.0.0' });
  });

  it('does not report placeholder workflow records as published on approval', async () => {
    const store = new TestWorkflowStore();
    const forgejo = new FakeForgejoClient();
    const dependencies = makeDependencies(forgejo, makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    await store.save({
      id: 'sub-placeholder',
      submittedBy: 'submitter-1',
      serializedContext: '{}',
      context: {
        ...makeContext(),
        submissionId: 'sub-placeholder',
        status: 'compliance-review',
      },
    });

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const approve = await submissionApp.request('/api/v1/submissions/sub-placeholder/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'approved from review dashboard' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(approve.status).toBe(409);
    await expect(approve.json()).resolves.toEqual({
      error: 'submission_not_ready',
      message: 'submission has not entered the approval pipeline',
    });
    expect(forgejo.publishedArtifact).toBeUndefined();
  });

  it('serves submission diff evidence on the versioned API route used by the web dashboard', async () => {
    const store = new TestWorkflowStore();
    const dependencies = makeDependencies(new FakeForgejoClient(), makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    const record = await seedAwaitingReview(dependencies);
    record.context.versionDiff = makeVersionDiff();
    await store.save(record);

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const diff = await submissionApp.request('/api/v1/submissions/sub-1/diff');

    expect(diff.status).toBe(200);
    await expect(diff.json()).resolves.toMatchObject({
      skillName: 'demo-skill',
      fromVersion: '0.9.0',
      toVersion: '1.0.0',
      filesModified: ['SKILL.md'],
    });
  });

  it('rejects approval by the submitter with separation-of-duties violation', async () => {
    const store = new TestWorkflowStore();
    const dependencies = makeDependencies(new FakeForgejoClient(), makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    await store.save(await seedAwaitingReview(dependencies));

    vi.stubEnv('MOCK_USER_SUB', 'submitter-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const approve = await submissionApp.request('/api/v1/submissions/sub-1/approve', { method: 'POST' });

    expect(approve.status).toBe(403);
    await expect(approve.json()).resolves.toEqual({ error: 'separation_of_duties_violation' });
  });

  it('requires a 10-500 character rejection reason', async () => {
    const store = new TestWorkflowStore();
    const dependencies = makeDependencies(new FakeForgejoClient(), makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    await store.save(await seedAwaitingReview(dependencies));

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const reject = await submissionApp.request('/api/v1/submissions/sub-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'short' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(reject.status).toBe(400);
  });

  it('does not expose unversioned submission routes', async () => {
    const store = new TestWorkflowStore();
    const dependencies = makeDependencies(new FakeForgejoClient(), makeScanReport('pass'));
    const submissionApp = createApp({ workflow: { store, dependencies, now: fixedNow } });
    await store.save(await seedAwaitingReview(dependencies));

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const list = await submissionApp.request('/submissions?status=pending');
    const approve = await submissionApp.request('/submissions/sub-1/approve', { method: 'POST' });

    expect(list.status).toBe(404);
    expect(approve.status).toBe(404);
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

class TestWorkflowStore implements WorkflowSubmissionStore {
  private readonly records = new Map<string, WorkflowSubmissionRecord>();

  get(id: string): WorkflowSubmissionRecord | undefined {
    return this.records.get(id);
  }

  list(): WorkflowSubmissionRecord[] {
    return Array.from(this.records.values());
  }

  save(record: WorkflowSubmissionRecord): void {
    this.records.set(record.id, record);
  }
}

class FakeForgejoClient {
  openedSubmissionPRs = 0;
  publishedArtifact?: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
  };

  async openSubmissionPR(input: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }) {
    this.openedSubmissionPRs += 1;
    return { branch: `submit/${input.submissionId}`, prNumber: 42, headSha: 'head-sha' };
  }

  async mergePR() {
    return { sha: 'merge-sha' };
  }

  async publishArtifact(input: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
  }) {
    this.publishedArtifact = input;
    return 'https://forgejo.example/api/packages/alice/generic/demo-skill/1.0.0/skill.zip';
  }

  async deleteBranch() {}
}

function makeDependencies(forgejo: FakeForgejoClient, scanReport: ScanReport): ApprovalPipelineDependencies {
  return {
    svc(token) {
      if (token === ForgejoClient) {
        return forgejo as never;
      }
      throw new Error('unexpected service token');
    },
    audit(_action: AuditAction, _detail: Record<string, unknown>) {},
    async runScanner() {
      return scanReport;
    },
  };
}

async function seedAwaitingQuestionnaire(dependencies: ApprovalPipelineDependencies): Promise<WorkflowSubmissionRecord> {
  const result = await runApprovalPipeline(makeContext(), dependencies);
  return {
    id: 'sub-1',
    submittedBy: 'submitter-1',
    serializedContext: result.serializedContext,
    context: result.context,
  };
}

async function seedAwaitingReview(dependencies: ApprovalPipelineDependencies): Promise<WorkflowSubmissionRecord> {
  const questionnaire = await seedAwaitingQuestionnaire(dependencies);
  const scanned = await resumeApprovalPipeline(questionnaire.serializedContext, {
    actor: 'submitter-1',
    responses: [{ questionId: 'network', answer: false }],
  }, 'questionnaire', dependencies);
  const confirmed = await resumeApprovalPipeline(scanned.serializedContext, {
    actor: 'submitter-1',
    confirmed: true,
  }, 'confirmation', dependencies);

  return {
    id: 'sub-1',
    submittedBy: 'submitter-1',
    serializedContext: confirmed.serializedContext,
    context: confirmed.context,
  };
}

function makeContext(): ApprovalPipelineContext {
  const manifest: SkillManifest = {
    name: 'demo-skill',
    version: '1.0.0',
    author: 'alice',
    description: 'Demo skill',
    tags: ['demo'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  };
  const submission: Submission = {
    id: 'sub-1',
    manifest,
    classification: 'code-containing',
    contentHash: 'abc123',
    submittedAt: '2026-05-24T00:00:00.000Z',
    submittedBy: 'submitter-1',
    status: { phase: 'uploaded' },
  };

  return {
    submissionId: submission.id,
    submission,
    manifest,
    files: [{ path: 'SKILL.md', contentBase64: b64('# test') }, { path: 'scripts/check.ts', contentBase64: b64('export {};') }],
    contentHash: submission.contentHash,
    extractedDir: '/tmp/sub-1',
    zipBufferBase64: b64('zip'),
  };
}

function makeScanReport(verdict: ScanReport['verdict']): ScanReport {
  return {
    submissionId: 'sub-1',
    scanId: 'scan-1',
    contentHash: 'abc123',
    scannerImage: 'registry.example/asr-scanner:latest',
    startedAt: '2026-05-24T00:00:00.000Z',
    completedAt: '2026-05-24T00:00:01.000Z',
    durationMs: 1000,
    verdict,
    findings: [],
    toolResults: {
      gitleaks: { exitCode: 0, findingCount: 0 },
      trivy: { exitCode: 0, findingCount: 0 },
      foxguard: { exitCode: 0, findingCount: 0 },
      opengrep: { exitCode: 0, findingCount: 0 },
      veracode: { exitCode: 0, findingCount: 0, skipped: true },
    },
  };
}

function makeVersionDiff(): VersionDiff {
  return {
    skillName: 'demo-skill',
    fromVersion: '0.9.0',
    toVersion: '1.0.0',
    fromContentHash: 'old-hash',
    toContentHash: 'abc123',
    filesAdded: [],
    filesModified: ['SKILL.md'],
    filesRemoved: [],
    dependenciesAdded: {},
    dependenciesChanged: {},
    dependenciesRemoved: {},
    permissionsBefore: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsAfter: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsExpanded: false,
    manifestKindChanged: false,
    riskAssessment: 'low',
    computedAt: '2026-05-24T00:00:00.000Z',
  };
}

function fixedNow(): Date {
  return new Date('2026-05-24T00:00:00.000Z');
}

function skillMdFixture(): string {
  return `---
name: demo-skill
version: 1.0.0
author: alice
description: Demo skill
tags:
  - demo
kind: skill
permissions:
  network: false
  filesystem: none
  subprocess: false
  environment: []
---

# demo-skill
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

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}
