import { ForgejoClient, type AuditAction, type ScanReport, type SkillManifest, type Submission } from '@asr/core';
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

function fixedNow(): Date {
  return new Date('2026-05-24T00:00:00.000Z');
}

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}
