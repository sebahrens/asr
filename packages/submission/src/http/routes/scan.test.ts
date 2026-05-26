import type { ScanReport, SkillManifest, Submission, SubmissionStatus } from '@asr/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthVariables, Identity } from '../../auth/types.js';
import { registerScanRoute, type ScanSubmissionLoader } from './scan.js';

describe('GET /api/v1/submissions/:id/scan', () => {
  it('returns 200 with the verbatim ScanReport when the submission has a completed scan', async () => {
    const report: ScanReport = {
      submissionId: 'sub-scan-ok',
      scanId: 'scan-1',
      contentHash: 'sha256:abc',
      scannerImage: 'asr-scanner:1.0.0',
      startedAt: '2026-05-26T10:00:00.000Z',
      completedAt: '2026-05-26T10:00:45.000Z',
      durationMs: 45000,
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

    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: (id) =>
        id === 'sub-scan-ok'
          ? buildSubmission({
              id,
              submittedBy: 'submitter-1',
              status: { phase: 'scan-complete', report },
            })
          : undefined,
    });

    const res = await app.request('/api/v1/submissions/sub-scan-ok/scan');

    expect(res.status).toBe(200);
    const payload = (await res.json()) as ScanReport;
    expect(payload).toEqual(report);
  });

  it('returns 202 with the scanning status when the scan is still running', async () => {
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: (id) =>
        id === 'sub-scan-running'
          ? buildSubmission({
              id,
              submittedBy: 'submitter-1',
              status: { phase: 'scanning', scanJobId: 'scan-job-7' },
            })
          : undefined,
    });

    const res = await app.request('/api/v1/submissions/sub-scan-running/scan');

    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      status: { phase: string; scanJobId: string };
    };
    expect(payload.status.phase).toBe('scanning');
    expect(payload.status.scanJobId).toBe('scan-job-7');
  });

  it('returns 404 submission_not_found when the submission id is unknown', async () => {
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: () => undefined,
    });

    const res = await app.request('/api/v1/submissions/sub-missing/scan');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_found' });
  });

  interface MakeAppInput {
    identity: Identity;
    loadSubmission: ScanSubmissionLoader;
  }

  function makeApp(input: MakeAppInput): Hono<{ Variables: AuthVariables }> {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', input.identity);
      await next();
    });

    registerScanRoute(app, { loadSubmission: input.loadSubmission });

    return app;
  }
});

interface SubmissionFixture {
  id: string;
  submittedBy: string;
  status: SubmissionStatus;
}

function buildSubmission(input: SubmissionFixture): Submission {
  const manifest: SkillManifest = {
    name: 'demo-skill',
    version: '1.0.0',
    author: input.submittedBy,
    description: 'Demo skill awaiting scan retrieval',
    tags: ['demo'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
  };

  return {
    id: input.id,
    manifest,
    classification: 'code-containing',
    contentHash: 'sha256:demo',
    submittedAt: '2026-05-26T09:00:00.000Z',
    submittedBy: input.submittedBy,
    status: input.status,
  };
}
