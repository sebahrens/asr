import type { ScanReport, ScreeningReport, SkillManifest, Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import type { ApprovalPipelineContext } from '../../workflow/approvalPipeline.js';
import { getWorkflowRun, saveWorkflowRun } from './workflowRuns.js';

describe('workflowRuns repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('round-trips scan and screening reports through the workflow context', () => {
    db = new Database(':memory:');
    runMigrations(db);

    const context = sampleContext();
    insertSubmission(db, context.submission);

    saveWorkflowRun(db, {
      id: context.submissionId,
      submittedBy: context.submission.submittedBy,
      serializedContext: JSON.stringify(context),
      context,
    });

    const saved = getWorkflowRun(db, context.submissionId);
    expect(saved?.context.scanReport).toEqual(context.scanReport);
    expect(saved?.context.screeningReport).toEqual(context.screeningReport);
    expect(saved?.submittedBy).toBe(context.submission.submittedBy);
  });
});

function insertSubmission(db: Database.Database, submission: Submission): void {
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
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    submission.id,
    JSON.stringify(submission.manifest),
    submission.classification,
    submission.contentHash,
    submission.submittedAt,
    submission.submittedBy,
    submission.status.phase,
    JSON.stringify(submission.status),
  );
}

function sampleContext(): ApprovalPipelineContext {
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
    id: 'sub_01',
    manifest,
    classification: 'code-containing',
    contentHash: 'sha256:abc123',
    submittedAt: '2026-05-24T10:00:00.000Z',
    submittedBy: 'alice-entra-sub',
    status: { phase: 'user-confirmation-pending' },
  };

  return {
    submissionId: submission.id,
    submission,
    manifest,
    files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# demo').toString('base64') }],
    contentHash: submission.contentHash,
    extractedDir: '/tmp/sub_01',
    zipBufferBase64: Buffer.from('zip').toString('base64'),
    classification: submission.classification,
    branchName: 'submit/sub_01',
    prNumber: 42,
    scanReport: sampleScanReport(submission),
    screeningReport: sampleScreeningReport(submission),
    status: 'user-confirmation-pending',
  };
}

function sampleScanReport(submission: Submission): ScanReport {
  return {
    submissionId: submission.id,
    scanId: 'scan_01',
    contentHash: submission.contentHash,
    scannerImage: 'asr-scanner:test',
    startedAt: '2026-05-24T10:00:00.000Z',
    completedAt: '2026-05-24T10:00:01.000Z',
    durationMs: 1000,
    verdict: 'pass',
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

function sampleScreeningReport(submission: Submission): ScreeningReport {
  return {
    submissionId: submission.id,
    contentHash: submission.contentHash,
    provider: 'none',
    model: 'none',
    contextTokens: 0,
    status: 'skipped',
    truncated: false,
    startedAt: '2026-05-24T10:00:00.000Z',
    completedAt: '2026-05-24T10:00:00.000Z',
    durationMs: 0,
    findings: [],
  };
}
