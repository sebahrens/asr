import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Submission } from '@asr/core';
import type { Identity } from '../../auth/types.js';
import type { Database } from '../../db/index.js';
import {
  getSubmissionById,
  rowToSubmission,
} from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { requireToolRole } from '../roles.js';
import { wrapToolHandler, type WrapToolHandlerDeps } from '../server.js';

const inputShape = {
  submissionId: z.string(),
} as const;

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

export function submissionStatusHandler(
  db: Database,
  { submissionId }: { submissionId: string },
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { submission: Submission };
} {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Submitter');

  const row = getSubmissionById(db, submissionId);
  // Not-owned must collapse to the same error as not-found so a caller
  // cannot probe for other principals' submission ids.
  if (row === undefined || row.submitted_by !== principal.sub) {
    throw new McpToolError(
      MCP_ERROR.resource_not_found,
      'resource_not_found',
    );
  }

  const submission = rowToSubmission(row);
  return {
    content: [{ type: 'text', text: JSON.stringify({ submission }, null, 2) }],
    structuredContent: { submission },
  };
}

export function registerSubmissionStatus(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'submission_status',
    {
      description: 'Get the detailed status of one of your own submissions.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'submission_status',
      (args: { submissionId: string }, extra: unknown) =>
        submissionStatusHandler(db, args, extra),
      deps,
    ),
  );
}
