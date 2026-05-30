import { ForgejoClient, type ScanReport, type ScreeningReport, type SkillManifest, type Submission } from '@asr/core';
import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '../notify/transport.js';
import {
  resumeApprovalPipeline,
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
  type NotifierDependency,
} from './approvalPipeline.js';

const SUBMITTER_PRINCIPAL = 'maria.chen';
const SUBMITTER_EMAIL = 'submitter@example.com';
const REVIEWER_EMAIL = 'reviewer-pool@example.com';
const BASE_URL = 'https://asr.example';
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

describe('pipeline notify', () => {
  it('review_required emails exactly the reviewer with the deep link and no submitter PII', async () => {
    const transport = new InMemoryTransport();
    const { dependencies } = setup(transport, { verdict: 'review_required' });

    const started = await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'run.py', contentBase64: b64('print("hi")') },
      ],
    }), dependencies);
    expect(started.status).toBe('awaiting');

    await resumeApprovalPipeline(started.serializedContext, {
      actor: SUBMITTER_PRINCIPAL,
      responses: [{ questionId: 'network', answer: false }],
    }, 'questionnaire', dependencies);

    const reviewerMessages = transport.sent.filter((m) => m.to === REVIEWER_EMAIL);
    expect(reviewerMessages).toHaveLength(1);
    const reviewerMsg = reviewerMessages[0];
    expect(reviewerMsg.subject).toContain('scan review required');
    expect(reviewerMsg.body).toContain(`${BASE_URL}/submissions/sub-1`);
    expect(reviewerMsg.body).not.toContain(SUBMITTER_PRINCIPAL);
    expect(reviewerMsg.body).not.toContain(SUBMITTER_EMAIL);
    const addresses = reviewerMsg.body.match(EMAIL_RE) ?? [];
    expect(addresses).toEqual([]);
  });

  it('notifies the submitter at the questionnaire HITL entry on code-containing submissions', async () => {
    const transport = new InMemoryTransport();
    const { dependencies } = setup(transport);

    await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'run.py', contentBase64: b64('print("hi")') },
      ],
    }), dependencies);

    const submitterMessages = transport.sent.filter((m) => m.to === SUBMITTER_EMAIL);
    expect(submitterMessages).toHaveLength(1);
    expect(submitterMessages[0].subject).toContain('questionnaire');
    expect(submitterMessages[0].body).toContain(`${BASE_URL}/submissions/sub-1`);
  });

  it('does not send questionnaire_ready for md-only submissions', async () => {
    const transport = new InMemoryTransport();
    const { dependencies } = setup(transport);

    await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'README.md', contentBase64: b64('# readme') },
      ],
    }), dependencies);

    expect(transport.sent).toHaveLength(0);
  });

  it('notifies the submitter when the reviewer approves', async () => {
    const transport = new InMemoryTransport();
    const { dependencies } = setup(transport, { verdict: 'pass' });

    const started = await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'run.py', contentBase64: b64('print("hi")') },
      ],
    }), dependencies);

    const afterQuestionnaire = await resumeApprovalPipeline(started.serializedContext, {
      actor: SUBMITTER_PRINCIPAL,
      responses: [],
    }, 'questionnaire', dependencies);

    const afterConfirm = await resumeApprovalPipeline(afterQuestionnaire.serializedContext, {
      actor: SUBMITTER_PRINCIPAL,
      confirmed: true,
    }, 'confirmation', dependencies);

    await resumeApprovalPipeline(afterConfirm.serializedContext, {
      actor: 'reviewer-1',
      roles: ['Compliance'],
      decision: 'approved',
    }, 'review', dependencies);

    const approvalMessages = transport.sent.filter((m) =>
      m.to === SUBMITTER_EMAIL && m.subject.includes('approved'),
    );
    expect(approvalMessages).toHaveLength(1);
    expect(approvalMessages[0].body).toContain(`${BASE_URL}/submissions/sub-1`);
  });

  it('notifies the submitter when the reviewer rejects', async () => {
    const transport = new InMemoryTransport();
    const { dependencies } = setup(transport, { verdict: 'pass' });

    const started = await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'run.py', contentBase64: b64('print("hi")') },
      ],
    }), dependencies);

    const afterQuestionnaire = await resumeApprovalPipeline(started.serializedContext, {
      actor: SUBMITTER_PRINCIPAL,
      responses: [],
    }, 'questionnaire', dependencies);

    const afterConfirm = await resumeApprovalPipeline(afterQuestionnaire.serializedContext, {
      actor: SUBMITTER_PRINCIPAL,
      confirmed: true,
    }, 'confirmation', dependencies);

    await resumeApprovalPipeline(afterConfirm.serializedContext, {
      actor: 'reviewer-1',
      roles: ['Compliance'],
      decision: 'rejected',
      reason: 'policy violation: needs revisions',
    }, 'review', dependencies);

    const rejectionMessages = transport.sent.filter((m) =>
      m.to === SUBMITTER_EMAIL && m.subject.includes('rejected'),
    );
    expect(rejectionMessages).toHaveLength(1);
    expect(rejectionMessages[0].body).toContain(`${BASE_URL}/submissions/sub-1`);
  });

  it('does not block the workflow when notifier transport throws', async () => {
    const transport = {
      send: async () => {
        throw new Error('smtp down');
      },
    };
    const logged: Array<{ message: string; error: unknown }> = [];
    const notifier: NotifierDependency = {
      transport,
      baseUrl: BASE_URL,
      resolveSubmitterEmail: () => SUBMITTER_EMAIL,
      resolveReviewerEmail: () => REVIEWER_EMAIL,
      log: (message, error) => logged.push({ message, error }),
    };
    const { dependencies } = setup(transport as never, { notifier });

    const started = await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'run.py', contentBase64: b64('print("hi")') },
      ],
    }), dependencies);

    expect(started.status).toBe('awaiting');
    expect(started.context._awaitingNodeIds).toEqual(['questionnaire']);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('questionnaire_ready');
  });

  it('does not send when notifier is absent from dependencies', async () => {
    const dependencies = makeDependencies({ verdict: 'review_required' });
    const started = await runApprovalPipeline(makeContext({
      files: [
        { path: 'SKILL.md', contentBase64: b64('# test') },
        { path: 'run.py', contentBase64: b64('print("hi")') },
      ],
    }), dependencies);
    const after = await resumeApprovalPipeline(started.serializedContext, {
      actor: SUBMITTER_PRINCIPAL,
      responses: [],
    }, 'questionnaire', dependencies);
    expect(after.context.scanReport?.verdict).toBe('review_required');
  });
});

function setup(
  transport: InMemoryTransport,
  opts: { verdict?: ScanReport['verdict']; notifier?: NotifierDependency } = {},
): { dependencies: ApprovalPipelineDependencies } {
  const notifier: NotifierDependency = opts.notifier ?? {
    transport,
    baseUrl: BASE_URL,
    resolveSubmitterEmail: () => SUBMITTER_EMAIL,
    resolveReviewerEmail: () => REVIEWER_EMAIL,
  };
  const base = makeDependencies({ verdict: opts.verdict ?? 'pass' });
  return { dependencies: { ...base, notifier } };
}

function makeDependencies(opts: { verdict: ScanReport['verdict'] }): ApprovalPipelineDependencies {
  const forgejo = new FakeForgejoClient();
  return {
    svc(token) {
      if (token === ForgejoClient) {
        return forgejo as never;
      }
      throw new Error('unexpected service token');
    },
    audit() {},
    async runScanner() {
      return makeScanReport(opts.verdict);
    },
    async runScreening() {
      return makeScreeningReport();
    },
  };
}

function makeScreeningReport(): ScreeningReport {
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
  };
}

class FakeForgejoClient {
  async openSubmissionPR(input: { submissionId: string }) {
    return { branch: `submit/${input.submissionId}`, prNumber: 7, headSha: 'h' };
  }

  async mergePR() {
    return { sha: 'merge-sha' };
  }

  async publishArtifact() {
    return 'https://forgejo.example/pkg';
  }

  async deleteBranch() {
    // no-op
  }
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
    submittedBy: SUBMITTER_PRINCIPAL,
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
