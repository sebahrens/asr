import { ForgejoClient, type AuditAction, type ScanReport, type SkillManifest, type Submission } from '@asr/core';
import { describe, expect, it, vi } from 'vitest';
import {
  resumeApprovalPipeline,
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
} from './approvalPipeline.js';

const state = vi.hoisted(() => ({ runScannerCalls: 0, verdict: 'pass' as ScanReport['verdict'] }));

vi.mock('../scan/runScanner.js', () => ({
  runScanner: vi.fn(async () => {
    state.runScannerCalls += 1;
    return makeScanReport(state.verdict);
  }),
}));

describe('approvalPipeline (integration)', () => {
  it('drives a code-containing submission classify->push->questionnaire->scan->confirmation->review->publish with mocked HITL+scan', async () => {
    state.runScannerCalls = 0;
    state.verdict = 'pass';
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const dependencies = makeDependencies(forgejo, audit);

    const started = await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'run.py', contentBase64: b64('print("hi")') },
      ],
    }), dependencies);

    expect(started.status).toBe('awaiting');
    expect(started.context.classification).toBe('code-containing');
    expect(started.context.branchName).toBe('submit/x');
    expect(started.context.prNumber).toBe(1);
    expect(started.context._awaitingNodeIds).toEqual(['questionnaire']);

    const questionnaire = await resumeApprovalPipeline(started.serializedContext, {
      actor: 'submitter-1',
      responses: [{ questionId: 'network', answer: false }],
    }, 'questionnaire', dependencies);

    expect(questionnaire.status).toBe('awaiting');
    expect(questionnaire.context._awaitingNodeIds).toEqual(['confirmation']);
    expect(questionnaire.context.scanReport).toMatchObject({ verdict: 'pass' });
    expect(state.runScannerCalls).toBe(1);

    const confirmation = await resumeApprovalPipeline(questionnaire.serializedContext, {
      actor: 'submitter-1',
      confirmed: true,
    }, 'confirmation', dependencies);

    expect(confirmation.status).toBe('awaiting');
    expect(confirmation.context._awaitingNodeIds).toEqual(['review']);

    const published = await resumeApprovalPipeline(confirmation.serializedContext, {
      actor: 'reviewer-1',
      decision: 'approved',
    }, 'review', dependencies);

    expect(published.status).toBe('completed');
    expect(published.context.status).toBe('published');
    expect(published.context.mergeCommit).toBe('abc');
    expect(published.context.questionnaire).toMatchObject({ actor: 'submitter-1' });
    expect(published.context.confirmation).toMatchObject({ actor: 'submitter-1', confirmed: true });
    expect(published.context.review).toMatchObject({ actor: 'reviewer-1', decision: 'approved' });
    expect(forgejo.opened).toMatchObject({ autoApprove: false });
    expect(forgejo.publishedArtifact).toMatchObject({ owner: 'alice', name: 'demo-skill', version: '1.0.0' });
    expect(forgejo.deletedBranch).toBe('submit/x');

    const actions = audit.map((entry) => entry.action);
    expect(actions).toEqual([
      'workflow.classify.completed',
      'workflow.pushed_to_forgejo',
      'workflow.questionnaire.completed',
      'workflow.scan.started',
      'workflow.scan.completed',
      'workflow.confirmation.received',
      'workflow.review.approved',
      'workflow.published',
    ]);
    expect(actions).toContain('workflow.review.approved');
  });

  it('skips questionnaire/scan/review for md-only submissions and never invokes runScanner', async () => {
    state.runScannerCalls = 0;
    state.verdict = 'pass';
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const dependencies = makeDependencies(forgejo, audit);

    const result = await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'README.md', contentBase64: b64('# readme') },
      ],
    }), dependencies);

    expect(result.status).toBe('completed');
    expect(result.context.classification).toBe('md-only');
    expect(result.context.status).toBe('published');
    expect(result.context.mergeCommit).toBe('abc');
    expect(result.context.questionnaire).toBeUndefined();
    expect(result.context.scanReport).toBeUndefined();
    expect(result.context.review).toBeUndefined();
    expect(state.runScannerCalls).toBe(0);
    expect(forgejo.opened).toMatchObject({ autoApprove: true });
    expect(forgejo.publishedArtifact).toMatchObject({ owner: 'alice', name: 'demo-skill', version: '1.0.0' });
    expect(forgejo.deletedBranch).toBe('submit/x');

    const actions = audit.map((entry) => entry.action);
    expect(actions).toEqual([
      'workflow.classify.completed',
      'workflow.pushed_to_forgejo',
      'workflow.review.approved',
      'workflow.published',
    ]);
    expect(actions).not.toContain('workflow.questionnaire.completed');
    expect(actions).not.toContain('workflow.scan.started');
    expect(actions).not.toContain('workflow.scan.completed');
    expect(actions).not.toContain('workflow.confirmation.received');
  });
});

class FakeForgejoClient {
  opened?: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  };

  publishedArtifact?: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
  };

  deletedBranch?: string;

  async openSubmissionPR(input: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }) {
    this.opened = input;
    return { branch: 'submit/x', prNumber: 1, headSha: 'h' };
  }

  async mergePR() {
    return { sha: 'abc' };
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

  async deleteBranch(branch: string) {
    this.deletedBranch = branch;
  }
}

function makeDependencies(
  forgejo: FakeForgejoClient,
  audit: Array<{ action: AuditAction; detail: Record<string, unknown> }>,
): ApprovalPipelineDependencies {
  return {
    svc(token) {
      if (token === ForgejoClient) {
        return forgejo as never;
      }
      throw new Error('unexpected service token');
    },
    audit(action, detail) {
      audit.push({ action, detail });
    },
  };
}

function makeContext(overrides: Partial<ApprovalPipelineContext>): ApprovalPipelineContext {
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
    files: [{ path: 'SKILL.md', contentBase64: b64('# test') }],
    contentHash: submission.contentHash,
    extractedDir: '/tmp/sub-1',
    zipBufferBase64: b64('zip'),
    ...overrides,
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

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}
