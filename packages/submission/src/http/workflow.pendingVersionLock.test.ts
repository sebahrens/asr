import { ForgejoClient, type AuditAction, type ScanReport, type SkillManifest, type Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthVariables } from '../auth/types.js';
import { runMigrations } from '../db/migrations/index.js';
import { insertSubmission } from '../db/repositories/submissions.js';
import { saveWorkflowRun } from '../db/repositories/workflowRuns.js';
import {
  resumeApprovalPipeline,
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
} from '../workflow/approvalPipeline.js';
import { acquirePendingVersion } from '../workflow/pendingVersionLock.js';
import { createWorkflowRoutes } from './workflow.js';

describe('workflow routes pending version lock release', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('releases pending_versions when a DB-backed approval publishes a paused workflow', async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const dependencies = makeDependencies(new FakeForgejoClient(), makeScanReport('pass'));
    const record = await seedAwaitingReview(dependencies);

    insertSubmission(db, {
      id: record.id,
      manifestJson: JSON.stringify(record.context.manifest),
      classification: 'code-containing',
      contentHash: record.context.contentHash,
      submittedAt: record.context.submission.submittedAt,
      submittedBy: record.submittedBy,
      statusPhase: 'compliance-review',
      statusJson: JSON.stringify({ phase: 'compliance-review' }),
    });
    expect(
      acquirePendingVersion(
        db,
        record.context.manifest.name,
        record.context.manifest.version,
        record.id,
      ),
    ).toBe(true);
    saveWorkflowRun(db, record, fixedNow());

    const app = makeApp(db, dependencies);
    const approve = await app.request(`/api/v1/submissions/${record.id}/approve`, {
      method: 'POST',
    });

    expect(approve.status).toBe(200);
    const pendingCount = db
      .prepare(
        'SELECT COUNT(*) as c FROM pending_versions WHERE skill_name = ? AND version = ?',
      )
      .get(record.context.manifest.name, record.context.manifest.version) as { c: number };
    expect(pendingCount.c).toBe(0);
  });
});

function makeApp(db: Database.Database, dependencies: ApprovalPipelineDependencies) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('identity', { sub: 'reviewer-1', roles: ['Compliance'] });
    await next();
  });
  app.route(
    '/api/v1/submissions',
    createWorkflowRoutes({ db, dependencies, now: fixedNow }),
  );
  return app;
}

async function seedAwaitingReview(
  dependencies: ApprovalPipelineDependencies,
) {
  const started = await runApprovalPipeline(makeContext(), dependencies);
  const questionnaire = await resumeApprovalPipeline(started.serializedContext, {
    actor: 'submitter-1',
    responses: [{ questionId: 'network', answer: false }],
  }, 'questionnaire', dependencies);
  const confirmed = await resumeApprovalPipeline(questionnaire.serializedContext, {
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
    files: [
      { path: 'SKILL.md', contentBase64: b64('# demo') },
      { path: 'scripts/check.ts', contentBase64: b64('export {};') },
    ],
    contentHash: submission.contentHash,
    extractedDir: '/tmp/asr-test',
    zipBufferBase64: b64('zip'),
  };
}

function makeDependencies(
  forgejo: FakeForgejoClient,
  scanReport: ScanReport,
): ApprovalPipelineDependencies {
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

class FakeForgejoClient {
  async openSubmissionPR() {
    return { branch: 'submit/sub-1', prNumber: 42, headSha: 'head-sha' };
  }

  async mergePR() {
    return { sha: 'merge-sha' };
  }

  async publishArtifact() {
    return 'https://forgejo.example/api/packages/alice/generic/demo-skill/1.0.0/skill.zip';
  }

  async deleteBranch() {}
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

function fixedNow() {
  return new Date('2026-05-24T00:00:00.000Z');
}

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}
