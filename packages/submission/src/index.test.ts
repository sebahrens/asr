import { ForgejoClient, type AuditAction, type ScanReport, type SkillManifest, type Submission, type VersionDiff } from '@asr/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { app as App, createApp as CreateApp } from './index.js';
import type { WorkflowSubmissionRecord, WorkflowSubmissionStore } from './http/workflow.js';
import {
  resumeApprovalPipeline,
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
} from './workflow/pipeline.js';

let app: typeof App;
let createApp: typeof CreateApp;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');

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

  it('serves public registry skills on the route used by the web browse page', async () => {
    const res = await app.request('/api/v1/skills?q=security');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      items: [
        {
          owner: 'asr',
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
          owner: 'alice',
          version: '1.0.0',
          status: 'pending review',
        },
      ],
    });
  });

  it('creates a dev submission from skill markdown and queues it for review', async () => {
    const store = new TestWorkflowStore();
    const submissionApp = createApp({ workflow: { store, now: fixedNow } });

    vi.stubEnv('MOCK_USER_SUB', 'submitter-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter');
    const body = new FormData();
    body.set('owner', 'alice');
    body.set('skillMd', `---
name: demo-skill
version: 1.0.0
description: Demo skill
tags:
  - demo
---

# demo-skill
`);

    const created = await submissionApp.request('/api/v1/submissions', {
      method: 'POST',
      body,
    });

    expect(created.status).toBe(201);
    const data = await created.json();
    expect(data).toMatchObject({
      manifest: {
        author: 'alice',
        name: 'demo-skill',
        version: '1.0.0',
      },
      status: { phase: 'uploaded' },
    });

    const queued = store.list()[0];
    expect(queued).toMatchObject({
      id: data.id,
      context: {
        status: 'compliance-review',
      },
    });
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
    const questionnaire = await submissionApp.request('/submissions/sub-1/questionnaire', {
      method: 'POST',
      body: JSON.stringify({ responses: [{ questionId: 'network', answer: false }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(questionnaire.status).toBe(200);
    await expect(questionnaire.json()).resolves.toEqual({
      status: { phase: 'scanning', scanJobId: 'scan:sub-1' },
    });

    const scan = await submissionApp.request('/submissions/sub-1/scan');
    expect(scan.status).toBe(200);
    await expect(scan.json()).resolves.toMatchObject({ scanId: scanReport.scanId, verdict: 'review_required' });

    const confirm = await submissionApp.request('/submissions/sub-1/confirm', { method: 'POST' });
    expect(confirm.status).toBe(200);
    await expect(confirm.json()).resolves.toEqual({ status: { phase: 'compliance-review' } });

    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    const approve = await submissionApp.request('/submissions/sub-1/approve', {
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
      registryUrl: '/skills/alice/demo-skill',
    });
    expect(forgejo.publishedArtifact).toMatchObject({ owner: 'alice', name: 'demo-skill', version: '1.0.0' });
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
    expect(forgejo.publishedArtifact).toMatchObject({ owner: 'alice', name: 'demo-skill', version: '1.0.0' });
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
    const approve = await submissionApp.request('/submissions/sub-1/approve', { method: 'POST' });

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
    const reject = await submissionApp.request('/submissions/sub-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'short' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(reject.status).toBe(400);
  });
});

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

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}
