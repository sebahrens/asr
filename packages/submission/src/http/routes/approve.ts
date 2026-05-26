import type { AuditAction, Submission } from '@asr/core';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { AuthVariables } from '../../auth/types.js';
import { getSubmissionById, rowToSubmission } from '../../db/repositories/submissions.js';
import { apiError } from '../errors.js';

export interface ApproveReviewResult {
  publishedAt: string;
  mergeCommit: string;
}

export interface ApproveReviewInput {
  submissionId: string;
  actor: string;
  comment?: string;
}

export type ApproveSignalDeliverer = (
  input: ApproveReviewInput,
) => Promise<ApproveReviewResult> | ApproveReviewResult;

export type ApproveAuditEmitter = (
  action: AuditAction,
  detail: Record<string, unknown>,
) => Promise<void> | void;

export type ApproveSubmissionLoader = (
  id: string,
) => Promise<Submission | undefined> | Submission | undefined;

export interface ApproveRouteOptions {
  loadSubmission: ApproveSubmissionLoader;
  deliverReviewApproval: ApproveSignalDeliverer;
  audit?: ApproveAuditEmitter;
}

export function registerApproveRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: ApproveRouteOptions,
): void {
  const { loadSubmission, deliverReviewApproval, audit } = options;

  app.post('/api/v1/submissions/:id/approve', async (c) => {
    const submissionId = c.req.param('id');
    const submission = await loadSubmission(submissionId);
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
    }

    const identity = c.get('identity');
    if (submission.submittedBy === identity.sub) {
      return apiError(c, 403, 'separation_of_duties_violation');
    }

    const body = (await readJson(c.req.raw)) as { comment?: unknown } | undefined;
    const comment = typeof body?.comment === 'string' ? body.comment : undefined;

    const result = await deliverReviewApproval({
      submissionId,
      actor: identity.sub,
      ...(comment !== undefined ? { comment } : {}),
    });

    if (audit) {
      await audit('workflow.review.approved', {
        submissionId,
        skillName: submission.manifest.name,
        version: submission.manifest.version,
        actor: identity.sub,
        mergeCommit: result.mergeCommit,
        ...(comment !== undefined ? { comment } : {}),
      });
    }

    return c.json({
      status: {
        phase: 'published' as const,
        publishedAt: result.publishedAt,
        mergeCommit: result.mergeCommit,
      },
      publishedVersion: submission.manifest.version,
      registryUrl: `/skills/${submission.manifest.author}/${submission.manifest.name}`,
    });
  });
}

export function createSqliteSubmissionLoader(db: Database.Database): ApproveSubmissionLoader {
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
