import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Submission } from '@asr/core';
import { SeparationOfDutiesError, assertSeparation } from '../../auth/separation.js';
import type { Identity } from '../../auth/types.js';
import type { Database } from '../../db/index.js';
import {
  getSubmissionById,
  rowToSubmission,
} from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { requireToolRole } from '../roles.js';
import { wrapToolHandler, type WrapToolHandlerDeps } from '../server.js';

const REASON_MIN = 10;
const REASON_MAX = 500;

const inputShape = {
  submissionId: z.string(),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().optional(),
} as const;

export interface ReviewDecisionApproveInput {
  submissionId: string;
  actor: string;
  comment?: string;
}

export interface ReviewDecisionApproveResult {
  publishedAt: string;
  mergeCommit: string;
}

export interface ReviewDecisionRejectInput {
  submissionId: string;
  actor: string;
  reason: string;
}

export interface ReviewDecisionRejectResult {
  rejectedAt: string;
}

export type ApproveDeliverer = (
  input: ReviewDecisionApproveInput,
) => Promise<ReviewDecisionApproveResult> | ReviewDecisionApproveResult;

export type RejectDeliverer = (
  input: ReviewDecisionRejectInput,
) => Promise<ReviewDecisionRejectResult> | ReviewDecisionRejectResult;

export interface ReviewDecisionDeps {
  deliverReviewApproval: ApproveDeliverer;
  deliverReviewRejection: RejectDeliverer;
}

export type ReviewDecisionStatus =
  | {
      phase: 'published';
      publishedAt: string;
      mergeCommit: string;
    }
  | {
      phase: 'rejected';
      rejectedAt: string;
      reason: string;
    };

export interface ReviewDecisionResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: { status: ReviewDecisionStatus };
  isError?: boolean;
  [key: string]: unknown;
}

function principalFromExtra(extra: unknown): Identity {
  const principal = (
    extra as { authInfo?: { extra?: { principal?: Identity } } } | undefined
  )?.authInfo?.extra?.principal;
  if (!principal) {
    throw new McpToolError(
      MCP_ERROR.authentication_required,
      'authentication_required',
    );
  }
  return principal;
}

function loadSubmission(db: Database, id: string): Submission | undefined {
  const row = getSubmissionById(db, id);
  return row ? rowToSubmission(row) : undefined;
}

export async function reviewDecisionHandler(
  db: Database,
  deps: ReviewDecisionDeps,
  args: { submissionId: string; decision: 'approve' | 'reject'; reason?: string },
  extra: unknown,
): Promise<ReviewDecisionResult> {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Compliance');

  const submission = loadSubmission(db, args.submissionId);
  if (!submission) {
    throw new McpToolError(MCP_ERROR.resource_not_found, 'resource_not_found');
  }

  try {
    assertSeparation(submission.submittedBy, principal.sub);
  } catch (err) {
    if (err instanceof SeparationOfDutiesError) {
      return {
        content: [{ type: 'text', text: 'separation_of_duties_violation' }],
        isError: true,
      };
    }
    throw err;
  }

  if (args.decision === 'approve') {
    const approveInput: ReviewDecisionApproveInput = {
      submissionId: args.submissionId,
      actor: principal.sub,
      ...(args.reason !== undefined ? { comment: args.reason } : {}),
    };
    const result = await deps.deliverReviewApproval(approveInput);
    const status: ReviewDecisionStatus = {
      phase: 'published',
      publishedAt: result.publishedAt,
      mergeCommit: result.mergeCommit,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify({ status }, null, 2) }],
      structuredContent: { status },
    };
  }

  const reason = args.reason;
  if (
    reason === undefined ||
    reason.length < REASON_MIN ||
    reason.length > REASON_MAX
  ) {
    return {
      content: [
        {
          type: 'text',
          text: `invalid_reason: must be ${REASON_MIN}-${REASON_MAX} characters`,
        },
      ],
      isError: true,
    };
  }

  const rejectResult = await deps.deliverReviewRejection({
    submissionId: args.submissionId,
    actor: principal.sub,
    reason,
  });
  const status: ReviewDecisionStatus = {
    phase: 'rejected',
    rejectedAt: rejectResult.rejectedAt,
    reason,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify({ status }, null, 2) }],
    structuredContent: { status },
  };
}

export function registerReviewDecision(
  server: McpServer,
  db: Database,
  reviewDeps: ReviewDecisionDeps,
  wrapDeps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'review_decision',
    {
      description:
        'Approve or reject a submission (Compliance role only). Submitter and approver must differ.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'review_decision',
      (
        args: { submissionId: string; decision: 'approve' | 'reject'; reason?: string },
        extra: unknown,
      ) => reviewDecisionHandler(db, reviewDeps, args, extra),
      wrapDeps,
    ),
  );
}
