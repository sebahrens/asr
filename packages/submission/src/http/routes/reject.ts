import type { AuditAction, Submission } from '@asr/core';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { AuthVariables } from '../../auth/types.js';
import { getSubmissionById, rowToSubmission } from '../../db/repositories/submissions.js';
import { apiError } from '../errors.js';

const REASON_MIN = 10;
const REASON_MAX = 500;

export interface RejectReviewResult {
  rejectedAt: string;
}

export interface RejectReviewInput {
  submissionId: string;
  actor: string;
  reason: string;
}

export type RejectSignalDeliverer = (
  input: RejectReviewInput,
) => Promise<RejectReviewResult> | RejectReviewResult;

export type RejectAuditEmitter = (
  action: AuditAction,
  detail: Record<string, unknown>,
) => Promise<void> | void;

export type RejectSubmissionLoader = (
  id: string,
) => Promise<Submission | undefined> | Submission | undefined;

export interface RejectRouteOptions {
  loadSubmission: RejectSubmissionLoader;
  deliverReviewRejection: RejectSignalDeliverer;
  audit?: RejectAuditEmitter;
}

export function registerRejectRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: RejectRouteOptions,
): void {
  const { loadSubmission, deliverReviewRejection, audit } = options;

  app.post('/api/v1/submissions/:id/reject', async (c) => {
    const submissionId = c.req.param('id');
    const submission = await loadSubmission(submissionId);
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
    }

    const body = (await readJson(c.req.raw)) as { reason?: unknown } | undefined;
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    if (reason === undefined || reason.length < REASON_MIN || reason.length > REASON_MAX) {
      return apiError(c, 400, 'invalid_manifest', {
        message: `reason must be ${REASON_MIN}-${REASON_MAX} characters`,
        details: { reason: `must be a string between ${REASON_MIN} and ${REASON_MAX} characters` },
      });
    }

    const identity = c.get('identity');
    if (submission.submittedBy === identity.sub) {
      return apiError(c, 403, 'separation_of_duties_violation');
    }

    const result = await deliverReviewRejection({
      submissionId,
      actor: identity.sub,
      reason,
    });

    if (audit) {
      await audit('workflow.review.rejected', {
        submissionId,
        skillName: submission.manifest.name,
        version: submission.manifest.version,
        actor: identity.sub,
        reason,
      });
    }

    return c.json({
      status: {
        phase: 'rejected' as const,
        rejectedAt: result.rejectedAt,
        reason,
      },
    });
  });
}

export function createSqliteSubmissionLoader(db: Database.Database): RejectSubmissionLoader {
  return (id) => {
    const row = getSubmissionById(db, id);
    return row ? rowToSubmission(row) : undefined;
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
