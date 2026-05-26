import type { Submission, SubmissionStatus } from '@asr/core';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { AuthVariables } from '../../auth/types.js';
import { getSubmissionById, rowToSubmission } from '../../db/repositories/submissions.js';
import { apiError } from '../errors.js';

export interface ConfirmSignalInput {
  submissionId: string;
}

export type ConfirmSignalDeliverer = (
  input: ConfirmSignalInput,
) => Promise<void> | void;

export type ConfirmSubmissionLoader = (
  id: string,
) => Promise<Submission | undefined> | Submission | undefined;

export interface ConfirmRouteOptions {
  loadSubmission: ConfirmSubmissionLoader;
  deliverConfirmation: ConfirmSignalDeliverer;
}

export function registerConfirmRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: ConfirmRouteOptions,
): void {
  const { loadSubmission, deliverConfirmation } = options;

  app.post('/api/v1/submissions/:id/confirm', async (c) => {
    const submissionId = c.req.param('id');
    const submission = await loadSubmission(submissionId);
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
    }

    await deliverConfirmation({ submissionId });

    const status = { phase: 'compliance-review' } satisfies SubmissionStatus;
    return c.json({ status });
  });
}

export function createSqliteSubmissionLoader(db: Database.Database): ConfirmSubmissionLoader {
  return (id) => {
    const row = getSubmissionById(db, id);
    return row ? rowToSubmission(row) : undefined;
  };
}
