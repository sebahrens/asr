import { ForgejoClient, type AuditAction, type ScanReport, type ScreeningReport, type SkillManifest, type Submission } from '@asr/core';
import { describe, expect, it } from 'vitest';
import {
  approvalPipeline,
  HitlAuthorizationError,
  hitlNodes,
  resumeApprovalPipeline,
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
} from './approvalPipeline.js';

describe('approvalPipeline', () => {
  it('exposes the classify/push-to-forgejo/publish skeleton with idempotent compute nodes', () => {
    const blueprint = approvalPipeline.toBlueprint();
    expect(blueprint.id).toBe('skill-approval');

    const nodeIds = blueprint.nodes.map((node) => node.id);
    expect(nodeIds).toEqual(expect.arrayContaining(['classify', 'push-to-forgejo', 'publish']));

    for (const id of ['classify', 'push-to-forgejo', 'publish'] as const) {
      const node = blueprint.nodes.find((candidate) => candidate.id === id);
      expect(node?.params?.idempotent).toBe(true);
    }

    expect(blueprint.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'classify', target: 'push-to-forgejo' }),
    ]));
  });

  it('drives a code-containing submission through HITL, scan, review, and publish', async () => {
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const scanReport = makeScanReport('review_required');
    const screeningReport = makeScreeningReport();
    const dependencies = makeDependencies(forgejo, audit, scanReport, screeningReport);

    const started = await runApprovalPipeline(makeContext({
      files: [{ path: 'SKILL.md', contentBase64: b64('# test') }, { path: 'scripts/check.ts', contentBase64: b64('export {};') }],
    }), dependencies);
    expect(started.status).toBe('awaiting');
    expect(started.context._awaitingNodeIds).toEqual(['questionnaire']);

    const questionnaire = await resumeApprovalPipeline(started.serializedContext, {
      actor: 'submitter-1',
      responses: [{ questionId: 'network', answer: false }],
    }, 'questionnaire', dependencies);
    expect(questionnaire.status).toBe('awaiting');
    expect(questionnaire.context.scanReport).toMatchObject({ verdict: 'review_required' });
    expect(questionnaire.context.screeningReport).toEqual(screeningReport);
    expect(questionnaire.context._awaitingNodeIds).toEqual(['confirmation']);

    const confirmation = await resumeApprovalPipeline(questionnaire.serializedContext, {
      actor: 'submitter-1',
      confirmed: true,
    }, 'confirmation', dependencies);
    expect(confirmation.status).toBe('awaiting');
    expect(confirmation.context._awaitingNodeIds).toEqual(['review']);

    const published = await resumeApprovalPipeline(confirmation.serializedContext, {
      actor: 'reviewer-1',
      roles: ['Compliance'],
      decision: 'approved',
    }, 'review', dependencies);

    expect(published.status).toBe('completed');
    expect(published.context.status).toBe('published');
    expect(published.context.mergeCommit).toBe('merge-sha');
    expect(forgejo.opened).toMatchObject({ autoApprove: false });
    expect(forgejo.mergeCalls).toBe(1);
    expect(forgejo.publishCalls).toBe(1);
    expect(forgejo.publishedArtifact).toMatchObject({
      owner: 'submitter-1',
      name: 'demo-skill',
      version: '1.0.0',
    });
    expect(audit.map((entry) => entry.action)).toEqual([
      'workflow.classify.completed',
      'workflow.pushed_to_forgejo',
      'workflow.questionnaire.completed',
      'workflow.scan.started',
      'workflow.scan.completed',
      'workflow.screening.completed',
      'workflow.confirmation.received',
      'workflow.review.approved',
      'workflow.published',
    ]);
  });

  it('does not merge or publish again when the publish node sees an already-published context', async () => {
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const dependencies = makeDependencies(forgejo, audit, makeScanReport('pass'));

    const result = await runApprovalPipeline(makeContext({
      classification: 'md-only',
      branchName: 'submit/sub-1',
      prNumber: 42,
      status: 'published',
      mergeCommit: 'merge-sha',
      files: [{ path: 'SKILL.md', contentBase64: b64('# test') }],
    }), dependencies);

    expect(result.status).toBe('completed');
    expect(result.context.status).toBe('published');
    expect(forgejo.opened).toBeUndefined();
    expect(forgejo.mergeCalls).toBe(0);
    expect(forgejo.publishCalls).toBe(0);
    expect(audit.map((entry) => entry.action)).toEqual([
      'workflow.screening.completed',
      'workflow.review.approved',
    ]);
  });

  it('publishes md-only submissions without questionnaire, scan, confirmation, or review', async () => {
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    let scannerCalls = 0;
    const dependencies = makeDependencies(forgejo, audit, makeScanReport('pass'));
    dependencies.runScanner = async () => {
      scannerCalls += 1;
      return makeScanReport('pass');
    };

    const result = await runApprovalPipeline(makeContext({
      files: [{ path: 'SKILL.md', contentBase64: b64('# test') }, { path: 'assets/icon.svg', contentBase64: b64('<svg />') }],
    }), dependencies);

    expect(result.status).toBe('completed');
    expect(result.context.status).toBe('published');
    expect(result.context.classification).toBe('md-only');
    expect(result.context.questionnaire).toBeUndefined();
    expect(result.context.scanReport).toBeUndefined();
    expect(result.context.review).toBeUndefined();
    expect(scannerCalls).toBe(0);
    expect(forgejo.opened).toMatchObject({ autoApprove: true });
    expect(audit.map((entry) => entry.action)).toEqual([
      'workflow.classify.completed',
      'workflow.pushed_to_forgejo',
      'workflow.screening.completed',
      'workflow.review.approved',
      'workflow.published',
    ]);
  });

  it('runs code-path screening as advisory and continues to submitter confirmation when flagged', async () => {
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const screeningReport = makeScreeningReport({ status: 'flagged', findings: [makeScreeningFinding()] });
    const dependencies = makeDependencies(forgejo, audit, makeScanReport('pass'), screeningReport);

    const started = await runApprovalPipeline(makeContext({
      files: [{ path: 'SKILL.md', contentBase64: b64('# test') }, { path: 'scripts/check.ts', contentBase64: b64('export {};') }],
    }), dependencies);
    const questionnaire = await resumeApprovalPipeline(started.serializedContext, {
      actor: 'submitter-1',
      responses: [{ questionId: 'network', answer: false }],
    }, 'questionnaire', dependencies);

    expect(questionnaire.status).toBe('awaiting');
    expect(questionnaire.context.screeningReport).toEqual(screeningReport);
    expect(questionnaire.context._awaitingNodeIds).toEqual(['confirmation']);
    expect(audit).toContainEqual({
      action: 'workflow.screening.completed',
      detail: { status: 'flagged', findingCount: 1, truncated: false },
    });
  });

  it('auto-approves md-only submissions when screening is skipped', async () => {
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const dependencies = makeDependencies(forgejo, audit, makeScanReport('pass'), makeScreeningReport({ status: 'skipped' }));

    const result = await runApprovalPipeline(makeContext({
      files: [{ path: 'SKILL.md', contentBase64: b64('# test') }],
    }), dependencies);

    expect(result.status).toBe('completed');
    expect(result.context.status).toBe('published');
    expect(result.context.review).toBeUndefined();
    expect(forgejo.publishCalls).toBe(1);
  });

  it.each([
    ['flagged', makeScreeningReport({ status: 'flagged', findings: [makeScreeningFinding()] })],
    ['error', makeScreeningReport({ status: 'error' })],
    ['truncated', makeScreeningReport({ status: 'clean', truncated: true, findings: [makeScreeningFinding()] })],
  ] as const)('routes md-only submissions to compliance review when screening is %s', async (_case, screeningReport) => {
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const dependencies = makeDependencies(forgejo, audit, makeScanReport('pass'), screeningReport);

    const result = await runApprovalPipeline(makeContext({
      files: [{ path: 'SKILL.md', contentBase64: b64('# test') }],
    }), dependencies);

    expect(result.status).toBe('awaiting');
    expect(result.context.status).toBeUndefined();
    expect(result.context.screeningReport).toEqual(screeningReport);
    expect(result.context._awaitingNodeIds).toEqual(['review']);
    expect(forgejo.mergeCalls).toBe(0);
    expect(forgejo.publishCalls).toBe(0);
  });

  it('carries the expected HITL metadata on wait nodes', () => {
    const graph = approvalPipeline.toBlueprint();
    const confirmation = graph.nodes.find((node) => node.id === 'confirmation');
    const review = graph.nodes.find((node) => node.id === 'review');

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'questionnaire',
        params: { type: 'questionnaire', timeout: '7d' },
      }),
      expect.objectContaining({
        id: 'confirmation',
        params: expect.objectContaining({ type: 'scan-results', timeout: '14d' }),
      }),
      expect.objectContaining({
        id: 'review',
        params: expect.objectContaining({
          type: 'compliance-approval',
          timeout: '30d',
          requiredRole: 'Compliance',
        }),
      }),
    ]));
    expect(confirmation?.params?.allowedActors).toEqual(['submission.submittedBy']);
    expect(review?.params?.forbiddenActors).toEqual(['submission.submittedBy']);
    expect(confirmation?.params?.allowedActors).not.toBe('submitter');
    expect(review?.params?.forbiddenActors).not.toBe('submitter');
  });

  it('carries spec timeouts and SoD actor selectors on code-path HITL nodes', () => {
    expect(hitlNodes.questionnaire.timeout).toBe('7d');
    expect(hitlNodes.confirmation.timeout).toBe('14d');
    expect(hitlNodes.review.timeout).toBe('30d');
    expect(hitlNodes.review.requiredRole).toBe('Compliance');

    const ctxStub = {
      get<T = unknown>(key: string): T {
        if (key === 'submission') {
          return { submittedBy: 'u1' } as unknown as T;
        }
        throw new Error(`unexpected key ${key}`);
      },
    };
    expect(hitlNodes.confirmation.allowedActors(ctxStub)).toEqual(['u1']);
    expect(hitlNodes.review.forbiddenActors(ctxStub)).toEqual(['u1']);
  });

  it('rejects a submitter approving their own submission at the HITL engine boundary', async () => {
    const forgejo = new FakeForgejoClient();
    const audit: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const dependencies = makeDependencies(forgejo, audit, makeScanReport('review_required'));

    const started = await runApprovalPipeline(makeContext({
      files: [{ path: 'SKILL.md', contentBase64: b64('# test') }, { path: 'scripts/check.ts', contentBase64: b64('export {};') }],
    }), dependencies);
    const questionnaire = await resumeApprovalPipeline(started.serializedContext, {
      actor: 'submitter-1',
      responses: [],
    }, 'questionnaire', dependencies);
    const confirmation = await resumeApprovalPipeline(questionnaire.serializedContext, {
      actor: 'submitter-1',
      confirmed: true,
    }, 'confirmation', dependencies);

    await expect(resumeApprovalPipeline(confirmation.serializedContext, {
      actor: 'submitter-1',
      roles: ['Compliance'],
      decision: 'approved',
    }, 'review', dependencies)).rejects.toBeInstanceOf(HitlAuthorizationError);
    expect(forgejo.mergeCalls).toBe(0);
    expect(forgejo.publishCalls).toBe(0);
  });

  it('wires code-path edges and a rejected node short-circuit from scan', () => {
    const blueprint = approvalPipeline.toBlueprint();
    const nodeIds = blueprint.nodes.map((node) => node.id);
    expect(nodeIds).toEqual(expect.arrayContaining([
      'questionnaire',
      'scan',
      'screen',
      'confirmation',
      'review',
      'rejected',
    ]));

    const scanNodeBlueprint = blueprint.nodes.find((node) => node.id === 'scan');
    expect(scanNodeBlueprint?.params?.idempotent).toBe(true);
    const screenNodeBlueprint = blueprint.nodes.find((node) => node.id === 'screen');
    expect(screenNodeBlueprint?.params?.idempotent).toBe(true);
    const rejectedBlueprint = blueprint.nodes.find((node) => node.id === 'rejected');
    expect(rejectedBlueprint?.params?.idempotent).toBe(true);

    expect(blueprint.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'questionnaire', target: 'scan' }),
      expect.objectContaining({ source: 'scan', target: 'screen', action: 'continue' }),
      expect.objectContaining({ source: 'scan', target: 'rejected', action: 'block' }),
      expect.objectContaining({ source: 'screen', target: 'confirmation', action: 'continue' }),
      expect.objectContaining({ source: 'confirmation', target: 'review' }),
      expect.objectContaining({ source: 'review', target: 'publish' }),
    ]));
  });

  it('routes md-only submissions through an idempotent screening gate and auto-approve node into the shared publish node', () => {
    const blueprint = approvalPipeline.toBlueprint();

    const screenMd = blueprint.nodes.find((node) => node.id === 'screen-md');
    expect(screenMd).toBeDefined();
    expect(screenMd?.params?.idempotent).toBe(true);
    const autoApprove = blueprint.nodes.find((node) => node.id === 'auto-approve');
    expect(autoApprove).toBeDefined();
    expect(autoApprove?.params?.idempotent).toBe(true);

    const pushOutgoing = blueprint.edges.filter((edge) => edge.source === 'push-to-forgejo');
    expect(pushOutgoing).toHaveLength(2);
    expect(pushOutgoing).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'push-to-forgejo', target: 'screen-md', action: 'md-only' }),
      expect.objectContaining({ source: 'push-to-forgejo', target: 'questionnaire', action: 'code-containing' }),
    ]));

    const screenMdOutgoing = blueprint.edges.filter((edge) => edge.source === 'screen-md');
    expect(screenMdOutgoing).toHaveLength(2);
    expect(screenMdOutgoing).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'screen-md', target: 'auto-approve', action: 'auto-approve' }),
      expect.objectContaining({ source: 'screen-md', target: 'review', action: 'review' }),
    ]));

    const autoApproveOutgoing = blueprint.edges.filter((edge) => edge.source === 'auto-approve');
    expect(autoApproveOutgoing).toHaveLength(1);
    expect(autoApproveOutgoing[0]).toEqual(expect.objectContaining({ source: 'auto-approve', target: 'publish' }));
  });
});

class FakeForgejoClient {
  mergeCalls = 0;
  publishCalls = 0;

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
    return { branch: `submit/${input.submissionId}`, prNumber: 42, headSha: 'head-sha' };
  }

  async mergePR() {
    this.mergeCalls += 1;
    return { sha: 'merge-sha' };
  }

  async publishArtifact(input: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
  }) {
    this.publishCalls += 1;
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
  scanReport: ScanReport,
  screeningReport: ScreeningReport = makeScreeningReport(),
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
    async runScanner() {
      return scanReport;
    },
    async runScreening() {
      return screeningReport;
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

function makeScreeningReport(overrides: Partial<ScreeningReport> = {}): ScreeningReport {
  return {
    submissionId: 'sub-1',
    contentHash: 'abc123',
    provider: 'none',
    model: 'none',
    contextTokens: 0,
    status: 'skipped',
    truncated: false,
    startedAt: '2026-05-24T00:00:00.000Z',
    completedAt: '2026-05-24T00:00:00.000Z',
    durationMs: 0,
    findings: [],
    ...overrides,
  };
}

function makeScreeningFinding(): ScreeningReport['findings'][number] {
  return {
    category: 'description',
    severity: 'medium',
    message: 'Declared behavior does not match observed behavior.',
  };
}

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}
