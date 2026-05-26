import type { ScanReport, Submission, SubmissionStatus } from '@asr/core';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { AuthVariables } from '../../auth/types.js';
import { getSubmissionById, rowToSubmission } from '../../db/repositories/submissions.js';
import { apiError } from '../errors.js';

export type ScanSubmissionLoader = (
  id: string,
) => Promise<Submission | undefined> | Submission | undefined;

export interface ScanRouteOptions {
  loadSubmission: ScanSubmissionLoader;
}

export function registerScanRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: ScanRouteOptions,
): void {
  const { loadSubmission } = options;

  app.get('/api/v1/submissions/:id/scan', async (c) => {
    const submissionId = c.req.param('id');
    const submission = await loadSubmission(submissionId);
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
    }

    const status = submission.status;
    const report = extractReport(status);
    if (report) {
      return c.json(report, 200);
    }

    if (status.phase === 'scanning') {
      return c.json(
        { status: { phase: 'scanning' as const, scanJobId: status.scanJobId } },
        202,
      );
    }

    return c.json({ status }, 202);
  });
}

export function createSqliteSubmissionLoader(db: Database.Database): ScanSubmissionLoader {
  return (id) => {
    const row = getSubmissionById(db, id);
    return row ? rowToSubmission(row) : undefined;
  };
}

function extractReport(status: SubmissionStatus): ScanReport | undefined {
  if ('report' in status && status.report) {
    return status.report;
  }
  return undefined;
}
