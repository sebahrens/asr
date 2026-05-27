import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Submission } from '@asr/core';
import type { Identity } from '../../auth/types.js';
import type { Database } from '../../db/index.js';
import {
  listSubmissionsByStatusPhase,
  rowToSubmission,
} from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { requireToolRole } from '../roles.js';
import { wrapToolHandler, type WrapToolHandlerDeps } from '../server.js';

const REVIEW_QUEUE_PHASE = 'compliance-review';

const inputShape = {
  limit: z.number().int().min(1).max(100).default(20),
} as const;

export interface ReviewQueueEntry {
  id: string;
  skillName: string;
  owner: string;
  version: string;
  submittedAt: string;
  submittedBy: string;
  status: Submission['status'];
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

function toEntry(submission: Submission): ReviewQueueEntry {
  return {
    id: submission.id,
    skillName: submission.manifest.name,
    owner: submission.manifest.author,
    version: submission.manifest.version,
    submittedAt: submission.submittedAt,
    submittedBy: submission.submittedBy,
    status: submission.status,
  };
}

export function reviewQueueHandler(
  db: Database,
  { limit }: { limit: number },
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { submissions: ReviewQueueEntry[] };
} {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Compliance');

  const rows = listSubmissionsByStatusPhase(db, REVIEW_QUEUE_PHASE, limit);
  const submissions = rows.map(rowToSubmission).map(toEntry);

  return {
    content: [{ type: 'text', text: JSON.stringify({ submissions }, null, 2) }],
    structuredContent: { submissions },
  };
}

export function registerReviewQueue(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'review_queue',
    {
      description:
        'List submissions awaiting compliance review (oldest first). Compliance role required.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'review_queue',
      (args: { limit: number }, extra: unknown) => reviewQueueHandler(db, args, extra),
      deps,
    ),
  );
}
